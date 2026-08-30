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
    type CoolingAccount,
    type DroverAccount,
    accountByName,
    currentAccount,
    defaultCooldownMs,
    pickTarget,
    readSettingsModel,
    accountByNewestTranscript,
    recallWhereabouts,
    rememberWhereabouts,
    setCooldown,
} from './accounts'
import { describeInFlight, emptyInFlight, type InFlightSnapshot } from './inflight'
import { detectLimit, familyLabel, familyOf, modelOfTranscriptMessage, textOfTranscriptMessage } from './limits'
import { resolveFlipPrompt } from './prompt'
import { carryTranscript } from './transcript'

const DROVER_URL = process.env.DROVER_URL || 'http://127.0.0.1:7970'

/**
 * How often a long park says it is still there.
 *
 * A park runs with NO claude child, so the terminal is a dead pane for as long
 * as it lasts. Measured 2026-08-28: every account was cooling, the session
 * parked for 17,630 seconds — four hours fifty — and said so exactly once, to
 * the phone. From the keyboard that is indistinguishable from a hang, which is
 * what Clay concluded, and he escaped by re-logging main into another account.
 */
const parkAnnounceMs = 15 * 60 * 1000

/**
 * How long a flip held back by running subagents waits to be confirmed
 * (BASED-135).
 *
 * Long enough that Clay can read why nothing happened and press the key
 * again; short enough that a flip he asked for half an hour ago cannot be
 * confirmed by an unrelated one now.
 */
const flipConfirmMs = 30 * 1000

/** Where a note goes so somebody at the KEYBOARD sees it. */
function writeToTerminal(message: string): void {
    try {
        // stderr, never stdout: stdout is the child's, and it is written only
        // between children — the claude TUI owns the terminal while it runs
        // and a stray write into it corrupts the screen.
        process.stderr.write(message + '\n')
    } catch (err) {
        logger.debug('[flip] could not write to the terminal', err)
    }
}

/** "2h 14m", "43m", "under a minute" — a wait a human can size up. */
function humanGap(ms: number): string {
    const minutes = Math.round(ms / 60_000)
    if (minutes < 1) return 'under a minute'
    if (minutes < 60) return `${minutes}m`
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** The two ways out of a park, said the same way everywhere they appear. */
const overrideHint =
    'Override now: `drover flip <account>` moves this session, or ' +
    '`drover --account <name> --resume` starts over on one. An explicit ' +
    'account ignores the cooldowns entirely — that is the escape hatch.'

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
    | {
          kind: 'parked'
          until: number
          note: string
          /** Who we wake up for, so the park heartbeat can name it. */
          account: DroverAccount
      }
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
    private parkHeartbeat: NodeJS.Timeout | null = null
    private parkWaiters: (() => void)[] = []
    private stopped = false

    /** Learned as the session comes up; used to match bus frames. */
    happySessionId: string | null = null
    claudeSessionId: string | null = null
    readonly pane: string | null = process.env.TMUX_PANE ?? null

    /**
     * Which account this session is on RIGHT NOW.
     *
     * This cannot be read from the environment more than once, and that is not
     * a nicety. `drover account` stamps DROVER_ACCOUNT and CLAUDE_CONFIG_DIR
     * into the process once, at spawn; a flip changes the account by writing
     * `session.claudeEnvVars` for the NEXT child, and the happy process's own
     * env is deliberately left alone. So after one flip the environment still
     * names the account we LEFT, and asking it again gets a confident wrong
     * answer — which made the second flip in any session:
     *
     *   - compute `from` as the original account, so a flip "to alt" while
     *     already on alt looked like a move instead of a no-op;
     *   - carry the transcript out of the ORIGINAL account's config dir,
     *     overwriting the newer one and losing everything said since the first
     *     flip;
     *   - record the cooldown against the wrong account on an auto-flip, so
     *     the account that actually ran out kept being chosen.
     *
     * Undefined until first read so the environment still seeds it.
     */
    private current: DroverAccount | undefined
    private currentKnown = false
    /** Set once this process has flipped, after which nothing on disk knows better. */
    private flippedHere = false

    /** The last REAL model this session ran, as a family. See modelFamily(). */
    private seenFamily: string | undefined
    /** What a limit notice said had run out, when it named a model. */
    private noticedFamily: string | undefined

    /**
     * Who is still running inside the child, asked at the moment we are about
     * to kill it (BASED-135). Null until the launcher wires it up, and null is
     * a real answer: no probe means behave exactly as this did before
     * subagents were counted at all.
     */
    private inFlight: (() => InFlightSnapshot) | null = null
    /** A manual flip held back by running subagents, waiting to be confirmed. */
    private heldFlip: { until: number; req: FlipRequest } | null = null

    private readonly toTerminal: (message: string) => void
    private readonly parkAnnounceMs: number
    private readonly flipConfirmMs: number

    constructor(
        private readonly cwd: string,
        /**
         * Reaches the PHONE, and only the phone: this is
         * session.sendSessionEvent, an encrypted envelope to the Happy server.
         * Nothing about it touches the terminal — see `toTerminal` in opts,
         * which is the other half and the one Clay was staring at.
         */
        private readonly announce: (message: string) => void,
        opts?: {
            /** Overridden in tests; defaults to stderr. */
            toTerminal?: (message: string) => void
            /** Overridden in tests; defaults to fifteen minutes. */
            parkAnnounceMs?: number
            /** Overridden in tests; defaults to thirty seconds. */
            flipConfirmMs?: number
        },
    ) {
        this.toTerminal = opts?.toTerminal ?? writeToTerminal
        this.parkAnnounceMs = opts?.parkAnnounceMs ?? parkAnnounceMs
        this.flipConfirmMs = opts?.flipConfirmMs ?? flipConfirmMs
    }

    /**
     * Which model family this session is running, or undefined.
     *
     * Undefined is a first-class answer: everything downstream falls back to
     * the strict, model-blind behaviour, so a wrong guess is the only thing
     * that can hurt and never guessing is always safe.
     *
     * In preference order, and each is measured rather than assumed:
     *   1. the last real assistant entry in the transcript. It is the only
     *      source that tracks a mid-session /model — one of Clay's transcripts
     *      holds 4621 fable turns and 3913 opus turns — and it already arrives
     *      here typed, so nothing had to be plumbed for it.
     *   2. the model a limit notice named. Only ever set on an auto-flip, but
     *      that is the exact moment the answer is needed.
     *   3. the account's settings.json. A startup default that lags a /model
     *      switch, so it is the seed for turn one and nothing more.
     *
     * Deliberately NOT here: an env var (none exists — no ANTHROPIC_MODEL or
     * CLAUDE_MODEL is set anywhere, and runClaude.ts:64 says a default there
     * was removed on purpose in #1721), and `lastModelUsage` in .claude.json,
     * which is written at SHUTDOWN, is cumulative across models with no
     * ordering, and after a flip lives in the wrong account's file entirely.
     */
    private modelFamily(): string | undefined {
        if (this.seenFamily) return this.seenFamily
        if (this.noticedFamily) return this.noticedFamily
        const here = this.here()
        return here ? familyOf(readSettingsModel(here)) : undefined
    }

    /** The account this session is on, environment first, then whatever we flipped to. */
    private here(): DroverAccount | undefined {
        if (!this.currentKnown) {
            this.current = currentAccount()
            this.currentKnown = true
        }
        // The environment is only right until the first flip, and a WRAPPER
        // restart resets us to it. So a recorded whereabouts for this very
        // Claude session in this very directory beats the stamp: it was
        // written by the flip that actually moved the transcript, whereas the
        // stamp is where the session was born. Skipped once this process has
        // flipped, because then nothing on disk knows better than we do.
        if (!this.flippedHere && this.claudeSessionId) {
            const remembered = recallWhereabouts(this.claudeSessionId, this.cwd)
            if (remembered && remembered !== this.current?.name) {
                logger.debug(
                    `[flip] whereabouts: ${this.claudeSessionId} was left on ${remembered}, ` +
                        `not ${this.current?.name ?? '(unknown)'} as the environment says`,
                )
                this.current = accountByName(remembered) ?? this.current
            }
            // DROVE-43. Both of the above describe the PAST — the stamp is
            // where the session was born, the record is where an earlier flip
            // left it — and neither survives quitting drover and starting it
            // again, because a bare `drover` lands on the ambient account and
            // updates neither. Clay hit that: the record said jamrizzi, the
            // session was on main, and every flip to jamrizzi came back
            // "already on jamrizzi" without moving, locking him out of the one
            // account with headroom. Where the transcript is GROWING cannot go
            // stale that way, so it has the last word.
            const writing = accountByNewestTranscript(this.claudeSessionId, this.cwd)
            if (writing && writing.name !== this.current?.name) {
                logger.debug(
                    `[flip] transcript: ${this.claudeSessionId} is writing under ${writing.name}, ` +
                        `not ${this.current?.name ?? '(unknown)'} — taking the transcript`,
                )
                this.current = writing
            }
        }
        return this.current
    }

    /**
     * The account this session is on right now, by name, for anyone outside
     * the controller who has to say so — the usage reporter (DROVE-47) marks
     * it `current` in every snapshot. Same answer here() gives the flip, so
     * the strip and the picker cannot name different accounts.
     */
    account(): string | undefined {
        return this.here()?.name
    }

    /**
     * Say which account this session started on, when the caller knows better
     * than the environment does (a session spawned with explicit env vars
     * rather than through the `drover account` wrapper).
     */
    startedOn(name: string | undefined): void {
        if (!name) return
        this.current = accountByName(name) ?? {
            name,
            configDir: process.env.CLAUDE_CONFIG_DIR || '',
        }
        this.currentKnown = true
    }

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
        // The model is read FIRST, ahead of every early-out below, because the
        // message that TRIGGERS an auto-flip can never carry it: the limit
        // notice is an assistant entry with model "<synthetic>". So the family
        // has to already be held from the last real turn by the time the
        // synthetic one arrives, and skipping this line while a flip is
        // pending would throw away the freshest one we ever get.
        const family = familyOf(modelOfTranscriptMessage(message))
        if (family) this.seenFamily = family

        if (this.pending) return
        const read = textOfTranscriptMessage(message)
        if (!read) return
        // Only the harness's own synthetic notices auto-flip. Claude writing
        // the words "usage limit" in an answer must never move the session to
        // another account behind Clay's back; an explicit flip still can.
        if (!read.synthetic) return
        const hit = detectLimit(read.text)
        if (!hit) return
        // The harness naming the model that ran out, at the instant it ran
        // out. Only a seed — a real turn we watched beats it every time.
        if (hit.family && !this.seenFamily) this.noticedFamily = hit.family

        const current = this.here()
        const until = hit.resetsAt ?? Date.now() + defaultCooldownMs
        // The family goes ON the ledger entry so a Fable limit cools Fable
        // rather than blacking the account out for Opus too. No family named
        // means the whole account is out, which is what this always recorded.
        if (current) setCooldown(current.name, until, hit.quote, hit.family ?? undefined)
        logger.debug(`[flip] usage limit detected${hit.family ? ` (${hit.family})` : ''}: ${hit.quote}`)
        this.announce(
            `Cattle Drover: ${current?.name ?? 'this account'} hit its ` +
                `${hit.family ? `${familyLabel(hit.family)} ` : 'usage '}limit` +
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

        // BASED-135: stopping the child is a SIGTERM, and async subagents live
        // inside it. Killing them loses their completion notifications
        // SILENTLY — the resumed conversation reads as though every agent
        // launched fine and never reported — so a flip has to say what it is
        // about to cost before it costs it.
        const busy = this.busy()
        if (busy.count > 0 && !this.confirmed(req, busy)) return

        this.pending = req
        this.releasePark()
        if (!this.abortChild) {
            logger.debug('[flip] no abort handler registered — the child will not be stopped')
        }
        this.abortChild?.()
    }

    /**
     * May this flip stop the child, given what is running inside it?
     *
     * Two answers, split on WHO asked, because the alternatives are different:
     *
     *   by === 'auto'   a real usage limit. The account is dead, so there is
     *                   no version of this where the agents finish — staying
     *                   put just means they fail one API call later. Flip, but
     *                   announce the loss FIRST so it is on the record instead
     *                   of being discovered an hour afterwards.
     *   anything else   a person or the bus asked. There IS an alternative:
     *                   wait. So the first request only says what it would
     *                   cost; a second request inside the window means the
     *                   answer is "do it anyway" and the second one wins.
     */
    private confirmed(req: FlipRequest, busy: InFlightSnapshot): boolean {
        const now = Date.now()
        if (req.by === 'auto') {
            this.heldFlip = null
            logger.debug(`[flip] usage limit flip abandoning ${busy.count} subagent(s): ${busy.ids.join(', ')}`)
            this.announce(
                `Cattle Drover: flipping on a usage limit with ${describeInFlight(busy)}. ` +
                    'They will not report back — this account has no headroom left, so waiting ' +
                    'for them only fails them one call later. Their partial work is under ' +
                    'tasks/<agentId>.output, and the arrival prompt points the new session at it.',
            )
            return true
        }

        if (this.heldFlip && this.heldFlip.until > now) {
            this.heldFlip = null
            logger.debug(`[flip] confirmed, abandoning ${busy.count} subagent(s): ${busy.ids.join(', ')}`)
            this.announce(
                `Cattle Drover: confirmed — flipping with ${describeInFlight(busy)}. ` +
                    'Their partial work is under tasks/<agentId>.output.',
            )
            return true
        }

        this.heldFlip = { until: now + this.flipConfirmMs, req }
        logger.debug(`[flip] held: ${busy.count} subagent(s) in flight — waiting for a repeat`)
        // `announce`, not `say`: the claude child owns the terminal for as long
        // as it is running, and a stray write into a live TUI corrupts the
        // screen. Same reason the mid-turn limit notice above uses it.
        this.announce(
            `Cattle Drover: not flipping yet — ${describeInFlight(busy)}. Moving accounts stops ` +
                'this Claude, which kills them and loses their results silently. Ask again ' +
                `within ${Math.round(this.flipConfirmMs / 1000)}s to flip anyway, or wait for them to finish.`,
        )
        return false
    }

    /** What the launcher's tracker says is running, or nothing if it is not wired up. */
    private busy(): InFlightSnapshot {
        try {
            return this.inFlight?.() ?? emptyInFlight
        } catch (err) {
            // A broken probe must never be the reason a flip cannot happen.
            logger.debug('[flip] in-flight probe failed', err)
            return emptyInFlight
        }
    }

    take(): FlipRequest | null {
        const req = this.pending
        this.pending = null
        return req
    }

    /**
     * Is a flip queued and not yet carried out?
     *
     * `take()` consumes, so a launcher that only wants to KNOW — remote mode
     * asking whether the abort it just saw was a flip or the user pressing
     * stop — has to ask this instead, or it eats the request it was checking
     * for and the flip disappears again (BASED-127).
     */
    hasPending(): boolean {
        return this.pending !== null
    }

    setAbortHandler(fn: (() => void) | null): void {
        this.abortChild = fn
    }

    /**
     * Say how to find out what is still running inside the child (BASED-135).
     *
     * Set by the launcher on the way in and cleared on the way out, because
     * the tracker belongs to one launcher call and this controller outlives
     * several of them.
     */
    setInFlightProbe(fn: (() => InFlightSnapshot) | null): void {
        this.inFlight = fn
    }

    // --- the flip itself ----------------------------------------------------

    /**
     * Work out where to go and move the transcript there. Returns what the
     * launcher should do next; it owns the relaunch, because it owns the loop.
     */
    apply(req: FlipRequest, claudeSessionId: string | null): ApplyResult {
        const from = this.here()
        const family = this.modelFamily()
        const choice = pickTarget(from?.name, req.account, Date.now(), family)
        logger.debug(
            `[flip] applying: from=${from?.name ?? '(unknown)'} model=${family ?? '(unknown)'} ` +
                `choice=${choice.kind}` +
                (choice.kind === 'account' ? ` -> ${choice.account.name}` : '') +
                ` claudeSessionId=${claudeSessionId ?? '(none)'}`,
        )

        if (choice.kind === 'nologin') {
            return {
                kind: 'refused',
                note:
                    `Cattle Drover: "${choice.account.name}" has never been logged in, so there is ` +
                    'nothing to flip onto — a session there opens Claude Code\'s first-run wizard, ' +
                    `which a wrapped session cannot answer. Log it in once: drover account add ${choice.account.name}`,
            }
        }

        if (choice.kind === 'none') {
            return {
                kind: 'refused',
                note: req.account
                    ? `Cattle Drover: no account named "${req.account}" in the registry.`
                    : 'Cattle Drover: no other LOGGED-IN account to flip to. Add one with ' +
                      '`drover account add <name>`, which logs it in as it creates it, or check ' +
                      '`drover account list` for rows marked "no login".',
            }
        }

        if (choice.kind === 'parked') {
            return {
                kind: 'parked',
                until: choice.until,
                account: choice.account,
                note: parkNote(choice, req),
            }
        }

        const target = choice.account
        const switchHint = choice.withoutModel
            ? ` Nothing has ${familyLabel(choice.withoutModel)} headroom, so switch models with ` +
              '`/model` or the next turn hits the same wall.'
            : ''

        if (from && target.name === from.name) {
            // Waking from a park onto our own account is the NORMAL end of a
            // park, not a mistake, so it says so rather than reading like a
            // refusal to do what was asked.
            const note =
                req.reason === 'cooldown expired'
                    ? `Cattle Drover: ${target.name} has headroom again — carrying on here.${switchHint}`
                    : choice.onlyOption
                        ? `Cattle Drover: every other account is out of headroom, so staying on ` +
                          `${target.name}.${switchHint} See \`drover accounts\` for when the next one is back.`
                        : `Cattle Drover: already on ${target.name}.`
            return { kind: 'refused', note }
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

        // Whatever was still running when the child was stopped. Read HERE,
        // after the exit, because the launcher clears the tracker as it
        // launches the next child rather than as the last one dies — precisely
        // so this call still has the list to hand.
        const stranded = this.busy().agents

        const prompt = resolveFlipPrompt({
            from: from?.name,
            to: target.name,
            reason: req.reason,
            cwd: this.cwd,
            session: claudeSessionId,
            override: req.prompt,
            account: target,
            stranded,
        })

        // We are on the target from here on. Recorded BEFORE the caller acts,
        // because the caller may never come back to tell us it worked. Written
        // to disk as well as held in memory: the memory dies with the wrapper
        // process and the next one would otherwise believe the spawn-time
        // stamp and carry a stale transcript back out of the old account.
        this.current = target
        this.currentKnown = true
        this.flippedHere = true
        if (claudeSessionId) rememberWhereabouts(claudeSessionId, this.cwd, target.name)

        return {
            kind: 'flipped',
            account: target,
            prompt,
            resume,
            note:
                `Cattle Drover: ${from?.name ?? 'this session'} → ${target.name} (${req.reason}, by ${req.by}), ` +
                (resume
                    ? `resuming ${basename(this.cwd)}${carried.subagents ? ' with subagents' : ''}.`
                    : `starting fresh in ${basename(this.cwd)} — nothing had been said yet.`) +
                switchHint,
        }
    }

    /**
     * Hold the session alive while every account cools off, then let it go.
     * Resolves early if someone flips by hand in the meantime — a park is a
     * decision about headroom, never a lock on the session.
     *
     * It also SAYS SO on the way through. A park runs with no claude child, so
     * for its whole length the terminal shows nothing at all, and the one note
     * at the start scrolls away in seconds. Four hours fifty of that is what
     * Clay read as a hung session.
     */
    async park(until: number, resumeOn?: string): Promise<void> {
        const ms = Math.max(0, until - Date.now())
        logger.debug(`[flip] parked for ${Math.round(ms / 1000)}s`)
        await new Promise<void>((resolve) => {
            this.parkWaiters.push(resolve)
            this.parkTimer = setTimeout(() => this.releasePark(), ms)
            if (ms > this.parkAnnounceMs) {
                this.parkHeartbeat = setInterval(() => {
                    const left = until - Date.now()
                    if (left <= 0) return
                    this.say(
                        `Cattle Drover: still parked — ${humanGap(left)} to go` +
                            `${resumeOn ? `, then ${resumeOn}` : ''} at ` +
                            `${new Date(until).toLocaleTimeString()}. ${overrideHint}`,
                    )
                }, this.parkAnnounceMs)
            }
        })
    }

    private releasePark(): void {
        if (this.parkTimer) {
            clearTimeout(this.parkTimer)
            this.parkTimer = null
        }
        if (this.parkHeartbeat) {
            clearInterval(this.parkHeartbeat)
            this.parkHeartbeat = null
        }
        const waiters = this.parkWaiters
        this.parkWaiters = []
        for (const w of waiters) w()
    }

    /**
     * Say it on BOTH surfaces — the phone AND the terminal.
     *
     * `announce` alone reaches only the phone, which is how the park went
     * invisible: every note was sent and Clay, at the keyboard, saw a dead
     * pane. Callers must only use this BETWEEN children; while claude owns the
     * terminal a write into it corrupts the TUI, which is why the mid-turn
     * limit notice in noteTranscriptMessage still uses `announce` directly.
     */
    say(message: string): void {
        this.announce(message)
        this.toTerminal(message)
    }
}

/**
 * Why we are parked, at enough length to act on.
 *
 * Every line here answers something Clay could not find out from the terminal
 * on 2026-08-28: which accounts are cooling, until when in HIS clock, whether
 * it is one model or the whole account, and what command overrides it. The
 * request is named too, because pressing prefix+F and getting the identical
 * sentence you were already looking at reads as the key doing nothing — that
 * silence is the actual bug, not the parking.
 */
function parkNote(
    choice: { until: number; account: DroverAccount; cooling: CoolingAccount[]; family?: string },
    req: FlipRequest,
): string {
    const out: string[] = []
    const shortOf = choice.family ? `${familyLabel(choice.family)} headroom` : 'headroom'

    if (req.reason === 'cooldown expired') {
        out.push(`Cattle Drover: still parked — nothing has ${shortOf} yet.`)
    } else if (req.by !== 'auto') {
        // A manual flip that lands in a park has to answer the person who
        // pressed the key, or it looks exactly like a flip that never arrived.
        out.push(
            `Cattle Drover: flip requested by ${req.by}, but no account has ${shortOf}. ` +
                'Staying parked.',
        )
    } else {
        out.push(`Cattle Drover: parked — no account has ${shortOf}.`)
    }

    // Every row here is blocked: pickTarget only parks once the soonest
    // candidate is still in the future, so there is no "has headroom" case.
    const width = Math.max(...choice.cooling.map((c) => c.name.length), 1)
    for (const c of choice.cooling) {
        const back = `back ${new Date(c.until).toLocaleTimeString()}`
        out.push(`  ${c.name.padEnd(width)}  ${back}${c.reason ? ` · ${c.reason}` : ''}`)
    }

    out.push(
        `Resuming on ${choice.account.name} by itself at ` +
            `${new Date(choice.until).toLocaleTimeString()} (${humanGap(choice.until - Date.now())}).`,
    )
    out.push(overrideHint)
    return out.join('\n')
}
