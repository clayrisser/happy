/**
 * The flip controller (BASED-98).
 *
 * A flip moves a running session onto a different Claude account without
 * ending it. The child `claude` process is stopped, the transcript is carried
 * into the target account's config dir, and a new child is started with
 * `--resume <same id>` under the new CLAUDE_CONFIG_DIR. The happy process
 * never exits, so the Happy session id never changes and the phone shows one
 * continuous session that simply carried on.
 *
 * That last point is the whole design constraint. Restarting the WRAPPER
 * would be far simpler and is what a shell loop would do — and it would mint a
 * new Happy session every time, so the app would show a graveyard of dead
 * halves of one conversation. Everything here is client-side; the Happy server
 * relays end-to-end encrypted envelopes and has no idea a flip happened.
 *
 * Three ways in, one path out:
 *   - the bus (`drover flip`, a tmux key binding, the watch or phone through
 *     the bridge) broadcasts a `flip` frame on /v1/stream;
 *   - a `/flip` message typed at the session from the app;
 *   - a usage limit detected in the local transcript, which flips by itself.
 */

import { basename } from 'node:path'

import { logger } from '@/ui/logger'
import {
    type DroverAccount,
    currentAccount,
    defaultCooldownMs,
    pickTarget,
    setCooldown,
} from './accounts'
import { detectLimit, textOfTranscriptMessage } from './limits'
import { resolveFlipPrompt } from './prompt'
import { carryTranscript } from './transcript'

const DROVER_URL = process.env.DROVER_URL || 'http://127.0.0.1:7970'

export interface FlipRequest {
    /** Explicit account, or null for "next one with headroom". */
    account: string | null
    reason: string
    by: string
    /** Session-scoped prompt override. */
    prompt?: string | null
}

export type ApplyResult =
    | {
          kind: 'flipped'
          account: DroverAccount
          prompt: string
          note: string
          /** False when there was no conversation to carry, so the new child starts clean. */
          resume: boolean
      }
    | { kind: 'parked'; until: number; note: string }
    | { kind: 'refused'; note: string }

interface BusFlipFrame {
    target?: { sessionId?: string | null; pane?: string | null; cwd?: string | null; all?: boolean }
    account?: string | null
    prompt?: string | null
    reason?: string
    by?: string
}

/** `/flip`, `/flip alt`, `/flip alt do the thing`, `/flip -- do the thing`. */
export function parseFlipCommand(message: string): FlipRequest | null {
    const trimmed = message.trim()
    const m = trimmed.match(/^\/flip(?:\s+([\s\S]*))?$/i)
    if (!m) return null
    const rest = (m[1] ?? '').trim()
    if (!rest) return { account: null, reason: 'requested from the app', by: 'app' }
    if (rest.startsWith('--')) {
        return { account: null, reason: 'requested from the app', by: 'app', prompt: rest.slice(2).trim() || null }
    }
    const [first, ...others] = rest.split(/\s+/)
    const tail = others.join(' ').trim()
    return {
        account: first,
        reason: 'requested from the app',
        by: 'app',
        prompt: tail || null,
    }
}

export class FlipController {
    private pending: FlipRequest | null = null
    private abortChild: (() => void) | null = null
    private stream: AbortController | null = null
    private parkTimer: NodeJS.Timeout | null = null
    private parkWaiters: (() => void)[] = []
    private stopped = false

    /** Learned as the session comes up; used to match bus frames. */
    happySessionId: string | null = null
    claudeSessionId: string | null = null
    readonly pane: string | null = process.env.TMUX_PANE ?? null

    constructor(
        private readonly cwd: string,
        /** Say something the phone and the terminal can both see. */
        private readonly announce: (message: string) => void,
    ) {}

    // --- triggers -----------------------------------------------------------

    /** Subscribe to the bus so `drover flip`, tmux, the watch and the phone land here. */
    start(): void {
        if (this.stream) return
        void this.listen()
    }

    stop(): void {
        this.stopped = true
        this.stream?.abort()
        this.stream = null
        if (this.parkTimer) clearTimeout(this.parkTimer)
        this.releasePark()
    }

    private async listen(): Promise<void> {
        while (!this.stopped) {
            const ac = new AbortController()
            this.stream = ac
            try {
                const res = await fetch(`${DROVER_URL}/v1/stream`, {
                    headers: { Accept: 'text/event-stream' },
                    signal: ac.signal,
                })
                if (!res.ok || !res.body) throw new Error(`stream ${res.status}`)
                let buffer = ''
                // Node's fetch body is an async iterable of Uint8Array, which
                // the DOM lib's ReadableStream type does not advertise.
                for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
                    buffer += Buffer.from(chunk).toString('utf8')
                    let cut: number
                    while ((cut = buffer.indexOf('\n\n')) !== -1) {
                        this.onFrame(buffer.slice(0, cut))
                        buffer = buffer.slice(cut + 2)
                    }
                }
            } catch (err) {
                if (this.stopped) return
                logger.debug('[flip] bus stream dropped, retrying', err)
            }
            // The bus restarting must not silently cost this session its
            // remote triggers for the rest of its life.
            if (!this.stopped) await new Promise((r) => setTimeout(r, 2000))
        }
    }

    private onFrame(raw: string): void {
        let event = 'message'
        const data: string[] = []
        for (const line of raw.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim()
            else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
        }
        if (event !== 'flip' || data.length === 0) return
        try {
            const frame = JSON.parse(data.join('\n')) as BusFlipFrame
            if (!this.addressesMe(frame)) return
            this.request({
                account: frame.account ?? null,
                reason: frame.reason || 'requested',
                by: frame.by || 'bus',
                prompt: frame.prompt ?? null,
            })
        } catch (err) {
            logger.debug('[flip] unparseable flip frame', err)
        }
    }

    private addressesMe(frame: BusFlipFrame): boolean {
        const t = frame.target
        if (!t) return false
        if (t.all) return true
        if (t.sessionId) return t.sessionId === this.happySessionId || t.sessionId === this.claudeSessionId
        if (t.pane) return !!this.pane && t.pane === this.pane
        if (t.cwd) return t.cwd === this.cwd
        return false
    }

    /** Offer transcript text for limit detection. Cheap enough to call per message. */
    noteTranscriptMessage(message: unknown): void {
        if (this.pending) return
        const read = textOfTranscriptMessage(message)
        if (!read) return
        // Only the harness's own synthetic notices auto-flip. Claude writing
        // the words "usage limit" in an answer must never move the session to
        // another account behind Clay's back; an explicit flip still can.
        if (!read.synthetic) return
        const hit = detectLimit(read.text)
        if (!hit) return

        const current = currentAccount()
        const until = hit.resetsAt ?? Date.now() + defaultCooldownMs
        if (current) setCooldown(current.name, until, hit.quote)
        logger.debug(`[flip] usage limit detected: ${hit.quote}`)
        this.announce(
            `Cattle Drover: ${current?.name ?? 'this account'} hit its usage limit` +
                (hit.resetsAt ? `, resets ${new Date(until).toLocaleTimeString()}` : '') +
                '. Flipping.',
        )
        this.request({ account: null, reason: 'usage limit', by: 'auto' })
    }

    /** Queue a flip and stop the child so the launcher's loop can act on it. */
    request(req: FlipRequest): void {
        // Logged on the way IN as well as at each decision below: a flip that
        // silently does nothing is the worst failure this can have, because
        // from the outside it is indistinguishable from one that never
        // arrived. Every path from here to a relaunch now says so.
        logger.debug(
            `[flip] request accepted: account=${req.account ?? '(next with headroom)'} reason=${req.reason} by=${req.by}`,
        )
        this.pending = req
        this.releasePark()
        if (!this.abortChild) {
            logger.debug('[flip] no abort handler registered — the child will not be stopped')
        }
        this.abortChild?.()
    }

    take(): FlipRequest | null {
        const req = this.pending
        this.pending = null
        return req
    }

    setAbortHandler(fn: (() => void) | null): void {
        this.abortChild = fn
    }

    // --- the flip itself ----------------------------------------------------

    /**
     * Work out where to go and move the transcript there. Returns what the
     * launcher should do next; it owns the relaunch, because it owns the loop.
     */
    apply(req: FlipRequest, claudeSessionId: string | null): ApplyResult {
        const from = currentAccount()
        const choice = pickTarget(from?.name, req.account)
        logger.debug(
            `[flip] applying: from=${from?.name ?? '(unknown)'} choice=${choice.kind}` +
                (choice.kind === 'account' ? ` -> ${choice.account.name}` : '') +
                ` claudeSessionId=${claudeSessionId ?? '(none)'}`,
        )

        if (choice.kind === 'none') {
            return {
                kind: 'refused',
                note: req.account
                    ? `Cattle Drover: no account named "${req.account}" in the registry.`
                    : 'Cattle Drover: no other account to flip to — add one to accounts.json.',
            }
        }

        if (choice.kind === 'parked') {
            return {
                kind: 'parked',
                until: choice.until,
                note:
                    'Cattle Drover: every account is out of headroom. Parked until ' +
                    `${new Date(choice.until).toLocaleTimeString()}, then resuming on ${choice.account.name}.`,
            }
        }

        const target = choice.account
        if (from && target.name === from.name) {
            return { kind: 'refused', note: `Cattle Drover: already on ${target.name}.` }
        }

        const carried = claudeSessionId
            ? carryTranscript({
                  sessionId: claudeSessionId,
                  workingDirectory: this.cwd,
                  fromConfigDir: from?.configDir ?? process.env.CLAUDE_CONFIG_DIR ?? '',
                  toConfigDir: target.configDir,
              })
            : { ok: true, nothingToCarry: true }
        if (!carried.ok) {
            return { kind: 'refused', note: `Cattle Drover: ${carried.reason}` }
        }
        const resume = !carried.nothingToCarry

        const prompt = resolveFlipPrompt({
            from: from?.name,
            to: target.name,
            reason: req.reason,
            cwd: this.cwd,
            session: claudeSessionId,
            override: req.prompt,
            account: target,
        })

        return {
            kind: 'flipped',
            account: target,
            prompt,
            resume,
            note:
                `Cattle Drover: ${from?.name ?? 'this session'} → ${target.name} (${req.reason}, by ${req.by}), ` +
                (resume
                    ? `resuming ${basename(this.cwd)}${carried.subagents ? ' with subagents' : ''}.`
                    : `starting fresh in ${basename(this.cwd)} — nothing had been said yet.`),
        }
    }

    /**
     * Hold the session alive while every account cools off, then let it go.
     * Resolves early if someone flips by hand in the meantime — a park is a
     * decision about headroom, never a lock on the session.
     */
    async park(until: number): Promise<void> {
        const ms = Math.max(0, until - Date.now())
        logger.debug(`[flip] parked for ${Math.round(ms / 1000)}s`)
        await new Promise<void>((resolve) => {
            this.parkWaiters.push(resolve)
            this.parkTimer = setTimeout(() => this.releasePark(), ms)
        })
    }

    private releasePark(): void {
        if (this.parkTimer) {
            clearTimeout(this.parkTimer)
            this.parkTimer = null
        }
        const waiters = this.parkWaiters
        this.parkWaiters = []
        for (const w of waiters) w()
    }

    say(message: string): void {
        this.announce(message)
    }
}
