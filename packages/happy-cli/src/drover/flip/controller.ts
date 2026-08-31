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

import { execFile } from 'node:child_process'
import { basename } from 'node:path'

import { logger } from '@/ui/logger'
import {
    type CoolingAccount,
    type DroverAccount,
    type Exhaustion,
    accountByName,
    currentAccount,
    defaultCooldownMs,
    explicitExhaustion,
    pickTarget,
    readSettingsModel,
    accountByNewestTranscript,
    recallWhereabouts,
    rememberWhereabouts,
    setCooldown,
    whenBack,
} from './accounts'
import { describeInFlight, emptyInFlight, type InFlightSnapshot } from './inflight'
import {
    downgradeNote,
    mayDowngradeModel,
    planDowngrade,
    policySuffix,
    switchPolicyOf,
    type DowngradePlan,
    type SwitchPolicy,
} from './downgrade'
import { detectLimit, familyLabel, familyOf, modelOfTranscriptMessage, textOfTranscriptMessage } from './limits'
import type { PolicyValues } from './policy'
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

/**
 * Put ONE line on the tmux status bar of the pane this session runs in.
 *
 * The terminal itself is not available while a flip is being decided: the
 * claude TUI owns it for as long as the child is running, and a stray write
 * corrupts the screen — which is why every mid-turn note here goes to
 * `announce`, the phone, and only the phone. That was fine for a note and is
 * not fine for a QUESTION. A warning Clay has to answer within thirty seconds
 * cannot live only on a device that is in his pocket (DROVE-64).
 *
 * The status bar is the one surface that reaches the keyboard without touching
 * the pane's contents, and it is already where a pick from `drover flip-menu`
 * reports — so the warning lands on the same line the choice was made from.
 *
 * Best effort throughout: no tmux, no pane, an old tmux without `-d`, and the
 * phone still got the whole thing.
 */
function writeToPane(message: string): void {
    const pane = process.env.TMUX_PANE
    if (!pane || !process.env.TMUX) return
    // The status bar is one line, and tmux reads the string as a FORMAT — a
    // literal # has to be doubled or it is eaten as the start of #{...}. Same
    // two rules libexec/drover-flip-menu learned the hard way.
    const line = message.replace(/\s+/g, ' ').trim().replace(/#/g, '##')

    // Written a second LATER, on purpose. Both flip keys route through
    // `drover flip-menu --pick`, which writes its own "drover: flip requested"
    // to this same status bar once `drover flip` returns — and that happens
    // AFTER we have already heard the frame on the bus, so writing at once
    // means the confirmation of the key press overwrites the warning about it.
    // Measured on the loopback bus: the POST plus the picker's live-session
    // check comes back in 20-30ms, so a second is comfortably clear of it and
    // still reads as instant. unref'd, so a pending note can never be the
    // reason the process will not exit.
    const at = setTimeout(() => {
        execFile('tmux', ['display-message', '-d', '10000', '-t', pane, line], (err) => {
            if (!err) return
            // tmux before 3.2 has no -d and answers with a usage error. Losing
            // the message to that would be worse than showing it briefly.
            execFile('tmux', ['display-message', '-t', pane, line], (err2) => {
                if (err2) logger.debug('[flip] could not reach the tmux status line', err2)
            })
        })
    }, 1000)
    at.unref()
}

/** "2h 14m", "43m", "under a minute" — a wait a human can size up. */
function humanGap(ms: number): string {
    const minutes = Math.round(ms / 60_000)
    if (minutes < 1) return 'under a minute'
    if (minutes < 60) return `${minutes}m`
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/**
 * "no Fable headroom until Thu 05:00 (8h 12m)" — said the same way in the
 * warning and in the confirmation that follows it (DROVE-64).
 *
 * `whenBack` is `drover accounts`' own spelling of a reset time, so the
 * sentence Clay reads here matches the row he picked from in the flip menu.
 */
function noHeadroom(stale: Exhaustion, now: number): string {
    const short = stale.family ? `${familyLabel(stale.family)} headroom` : 'headroom'
    return `no ${short} until ${whenBack(stale.until, now)} (${humanGap(stale.until - now)})`
}

/**
 * What to do about it other than wait — and, when there is nothing, saying so.
 *
 * Claude Code's own limit notice ends "switch models with /model", and that is
 * usually the real remedy: bitspur.com was out of Fable for four days and had
 * every other model going. Both answers are stated, because "another model is
 * fine there" and "nothing runs there" lead to opposite decisions and only one
 * of them was ever visible.
 */
function modelRemedy(stale: Exhaustion): string {
    if (!stale.family) return ''
    return stale.otherModel
        ? ' Another model still runs there, so `/model` is the fix that works now.'
        : ' Nothing else has headroom there either, so switching models will not help.'
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
          /** Set when the model dropped a rung as well as the account moving (DROVE-187). */
          downgrade?: DowngradePlan
      }
    | {
          kind: 'parked'
          until: number
          note: string
          /** Who we wake up for, so the park heartbeat can name it. */
          account: DroverAccount
          /**
           * Never set. Declared so the union carries the key on every branch
           * and a caller can ask `result.downgrade` without narrowing first —
           * a park is by definition the answer when no rung below runs either.
           */
          downgrade?: undefined
      }
    | {
          kind: 'refused'
          note: string
          /**
           * Set when we stayed on this account but dropped the model (DROVE-187).
           * `refused` is the launcher's word for "no account change"; it is not
           * a word for "nothing happened", and a downgrade rides it.
           */
          downgrade?: DowngradePlan
      }

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
    /** True when startedOn() was given a name: the wrapper stamped this process (DROVE-21). */
    private stamped = false

    /** The last REAL model this session ran, as a family. See modelFamily(). */
    private seenFamily: string | undefined
    /** The same turn's full model id, for the `[1m]` variant and the effort ceiling. */
    private seenModel: string | undefined
    /** What a limit notice said had run out, when it named a model. */
    private noticedFamily: string | undefined

    /**
     * The Account switching policy, cached from the bus (DROVE-187).
     *
     * apply() is synchronous and the store is behind HTTP, so it cannot be read
     * at the moment of the decision. The PolicyReporter already polls it every
     * 30s and stamps it on metadata; runClaude hands the same snapshot here, so
     * there is one reader of the bus and not two.
     *
     * Empty means nothing has been read yet, which switchPolicyOf turns into
     * `flip-then-downgrade` — the default, and the behaviour Clay is asking
     * for. A session whose bus is down must not be the one that does nothing.
     */
    private policyValues: PolicyValues = {}

    /**
     * The model and effort the session is set to, asked fresh. Used to keep a
     * `[1m]` context across a downgrade and to clamp an effort the new model
     * cannot take. Null probe means "nothing known", which is safe: an unknown
     * model keeps the whole effort scale rather than trimming it on a guess.
     */
    private pick: (() => { model?: string | null; effort?: string | null }) | null = null

    /**
     * A downgrade decided but not yet typed into the pane. Taken once by the
     * launcher on its way back up, because the metadata write that records it
     * does NOT come back through the client's own metadata event — see the
     * comment in apiSession.ts — so nothing else would ever act on it.
     */
    private pendingPick: { model: string; effort: string | null } | null = null

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
    private readonly toPane: (message: string) => void
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
            /** Overridden in tests; defaults to the tmux status bar. */
            toPane?: (message: string) => void
            /** Overridden in tests; defaults to fifteen minutes. */
            parkAnnounceMs?: number
            /** Overridden in tests; defaults to thirty seconds. */
            flipConfirmMs?: number
        },
    ) {
        this.toTerminal = opts?.toTerminal ?? writeToTerminal
        this.toPane = opts?.toPane ?? writeToPane
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
    /**
     * Public because the usage snapshot needs it (DROVE-173): headroom is
     * computed for the model this session is running, and this is the only
     * place that tracks it. Still the same three-source preference below.
     */
    modelFamily(): string | undefined {
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
        //
        // UNLESS the process was stamped (DROVE-21). bin/drover now derives
        // DROVER_ACCOUNT from this very record, or from a human typing
        // `-a <name>`, before the first spawn — so at start the stamp is the
        // record or better, and the child's CLAUDE_CONFIG_DIR really is the
        // stamped account. Letting an older record overrule it would put the
        // controller on jamrizzi while the child runs on main, which is the
        // DROVE-43 wedge from the other side. The record still wins for an
        // unstamped start (a daemon spawn), where nothing else knows.
        if (!this.flippedHere && this.claudeSessionId) {
            const remembered = this.stamped ? undefined : recallWhereabouts(this.claudeSessionId, this.cwd)
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
        this.stamped = true
    }

    /**
     * Claude has reported its session id.
     *
     * Written down at once (DROVE-21): the whereabouts record used to be
     * written only by a flip, so a session that never flipped was never
     * remembered and the next bare `drover` in its directory had nothing to
     * go on. Now every managed session leaves a record of where it was last
     * seen, and `at` is refreshed on every start so "the newest record for
     * this cwd" is the session Clay used most recently. here() is asked first
     * so what lands on disk is the corrected account, not a stale stamp.
     */
    sessionFound(claudeSessionId: string): void {
        this.claudeSessionId = claudeSessionId
        const here = this.here()
        if (here) rememberWhereabouts(claudeSessionId, this.cwd, here.name)
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
        const ran = modelOfTranscriptMessage(message)
        const family = familyOf(ran)
        if (family) {
            this.seenFamily = family
            if (typeof ran === 'string') this.seenModel = ran
        }

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

        // Two things a flip can cost that it used to spend without asking.
        // Both are settled HERE, before the child is stopped, so a flip that
        // gets held back costs nothing at all — that is the whole point of
        // deciding at this end rather than in apply().
        //
        // BASED-135: stopping the child is a SIGTERM, and async subagents live
        // inside it. Killing them loses their completion notifications
        // SILENTLY — the resumed conversation reads as though every agent
        // launched fine and never reported.
        //
        // DROVE-64: an account named on purpose skips the cooldown check, so a
        // flip onto one the ledger already knows is out was simply allowed. Two
        // of Clay's landed on bitspur.com at Fable weekly 100%, bounced off the
        // limit about 3.5 seconds later and auto-flipped back — two relaunches
        // to end up where he started, and a third press refused as a no-op.
        const busy = this.busy()
        const stale = this.exhaustedTarget(req)
        if (stale && !this.confirmed(req, stale)) return

        // The flip is going, so the cost is said at the moment it is actually
        // paid rather than on an ask that might still be refused above. Every
        // path reaches here -- Clay's keypress, the bus, and the auto flip a
        // usage limit fires at 4am -- so the flip nobody is watching announces
        // and hands over exactly like the one he pressed (DROVE-240).
        if (busy.count > 0) this.announceHandover(req, busy)

        this.pending = req
        this.releasePark()
        if (!this.abortChild) {
            logger.debug('[flip] no abort handler registered — the child will not be stopped')
        }
        this.abortChild?.()
    }

    /**
     * Is this flip aimed at an account that cannot run the model we are on?
     *
     * Only ever asked of a flip that NAMES an account. `account: null` means
     * "next one with headroom", which pickTarget already answers by skipping
     * every cooling account, and an auto flip never names one at all.
     *
     * Null whenever there is nothing worth warning about: no such account, no
     * cooldown for this model, or the "target" is the account we are already
     * on — apply() answers that one as "already on X" and relaunches nothing.
     */
    private exhaustedTarget(req: FlipRequest): Exhaustion | null {
        if (!req.account || req.by === 'auto') return null
        if (this.here()?.name === req.account) return null
        try {
            return explicitExhaustion(req.account, this.modelFamily())
        } catch (err) {
            // An unreadable ledger must never be the reason a flip cannot
            // happen. Same rule the in-flight probe follows.
            logger.debug('[flip] could not read the target account headroom', err)
            return null
        }
    }

    /**
     * May this flip stop the child, given what it would cost?
     *
     * RUNNING SUBAGENTS NO LONGER HOLD IT (DROVE-240). They used to: the first
     * ask named them and refused, and a second ask inside 30s went anyway.
     * Clay replaced that design before it grew a drain. His words: "I'm ok flipping
     * dropping them and then when it flips the prompt tells it how to resume".
     * So the flip goes at once, the agents die, and the loss is repaired at
     * the OTHER end by a handover: the arrival prompt tells the new session
     * what each one was doing, where its transcript is, and whether it had
     * already pushed a lane. See handover.ts. What the guard was spending on a
     * refusal is now spent on the handover instead, which is the same
     * information put to better use.
     *
     * A hold remains for exactly one thing, and it is not about subagents.
     * DROVE-64: a flip onto an account the ledger already knows is out of
     * headroom hits the same wall on its first turn and auto-flips straight
     * back, which is two relaunches to end up where it started. Waiting cannot
     * save a killed subagent, but it CAN save those two relaunches, so that
     * one is still worth a second press.
     */
    private confirmed(req: FlipRequest, stale: Exhaustion): boolean {
        const now = Date.now()
        if (req.by === 'auto') {
            this.heldFlip = null
            return true
        }

        if (this.heldFlip && this.heldFlip.until > now) {
            this.heldFlip = null
            logger.debug(`[flip] confirmed onto ${stale.account.name} with ${noHeadroom(stale, now)}`)
            this.warn(
                `Cattle Drover: confirmed — flipping onto ${stale.account.name} with ` +
                    `${noHeadroom(stale, now)}.${modelRemedy(stale)}`,
            )
            return true
        }

        this.heldFlip = { until: now + this.flipConfirmMs, req }
        logger.debug(
            `[flip] held: ${stale.account.name} has ${noHeadroom(stale, now)} — waiting for a repeat`,
        )
        this.warn(
            `Cattle Drover: not flipping to ${stale.account.name} yet — it has ` +
                `${noHeadroom(stale, now)}: ${stale.reason}. Landing there hits the same wall on the ` +
                'first turn and auto-flips straight back, which is two relaunches to end up here.' +
                `${modelRemedy(stale)} Ask again within ` +
                `${Math.round(this.flipConfirmMs / 1000)}s to flip anyway.`,
        )
        return false
    }

    /**
     * Say what this flip is about to drop, on the way past (DROVE-240).
     *
     * Not a question and not a refusal. By the time this runs the flip is
     * going, so the only job left is to put the cost on the record at the
     * moment it is paid rather than leaving Clay to notice an hour later that
     * five agents never reported.
     *
     * It says RE-DISPATCH, and it has to. A session resumes and a subagent
     * cannot, so promising a resume here would be a lie that costs someone an
     * afternoon of waiting for agents that are never coming back.
     */
    private announceHandover(req: FlipRequest, busy: InFlightSnapshot): void {
        logger.debug(
            `[flip] ${req.by === 'auto' ? 'usage limit flip' : 'flip'} stranding ` +
                `${busy.count} subagent(s): ${busy.ids.join(', ')}`,
        )
        const why =
            req.by === 'auto'
                ? 'This account has no headroom left, so waiting for them would only fail them one ' +
                  'API call later.'
                : ''
        this.announce(
            `Cattle Drover: flipping with ${describeInFlight(busy)}. ${why}` +
                'They are killed by the restart and cannot be resumed, because a subagent has no ' +
                'resume. ' +
                'The arrival prompt hands the new session what each was doing, where its transcript ' +
                'is, and whether it had already pushed a lane, so it can RE-DISPATCH them from where ' +
                'they stopped.',
        )
    }

    /**
     * Say it on the phone AND on the tmux status bar.
     *
     * `say()` cannot be used here and `announce()` is not enough. say() writes
     * to stderr, and the claude child owns the terminal for as long as it is
     * running, so a stray write corrupts a live TUI — which is why the
     * mid-turn limit notice uses announce() directly. But announce() alone
     * reaches only the phone, and a warning Clay has thirty seconds to answer
     * has to be readable from the keyboard he pressed the key on (DROVE-64).
     */
    private warn(message: string): void {
        this.announce(message)
        try {
            this.toPane(message)
        } catch (err) {
            logger.debug('[flip] could not put the warning on the pane', err)
        }
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

    /**
     * The Account switching policy, as the bus last reported it (DROVE-187).
     * Fed by the PolicyReporter's publish so there is one poll, not two.
     */
    setPolicy(values: PolicyValues | undefined): void {
        this.policyValues = values ?? {}
    }

    /** Where to ask what model and effort this session is set to. */
    setSelectionProbe(fn: (() => { model?: string | null; effort?: string | null }) | null): void {
        this.pick = fn
    }

    /** What the Account switching setting says, defaulting to flip-then-downgrade. */
    switchPolicy(): SwitchPolicy {
        return switchPolicyOf(this.policyValues.onFamilyExhausted)
    }

    /**
     * Take the model change a downgrade decided, once.
     *
     * The launcher asks on its way back up and types it into the pane. Once,
     * because a second launcher iteration must not retype a `/model` Clay may
     * have changed his mind about in the meantime.
     */
    takeDowngradePick(): { model: string; effort: string | null } | null {
        const pick = this.pendingPick
        this.pendingPick = null
        return pick
    }

    /** The model id this session is on, transcript first, then the app's pick. */
    private currentModel(): string | undefined {
        if (this.seenModel) return this.seenModel
        const asked = this.pick?.()?.model
        if (typeof asked === 'string' && asked.length > 0) return asked
        const here = this.here()
        return here ? readSettingsModel(here) ?? undefined : undefined
    }

    /** The effort this session is set to, or null when nothing picked one. */
    private currentEffort(): string | null {
        const asked = this.pick?.()?.effort
        return typeof asked === 'string' && asked.length > 0 ? asked : null
    }

    /**
     * Can anything run this family right now?
     *
     * Answered through pickTarget, deliberately, so headroom is derived in ONE
     * place. `withoutModel` is pickTarget's own way of saying "I settled for an
     * account that cannot run what you asked for", so a rung is only runnable
     * when the answer is an account with that flag absent.
     */
    private runnableFamily(now: number): (family: string) => boolean {
        // No `current` passed, deliberately. pickTarget excludes the account we
        // are ON from its candidates, which is right for "where do I move to"
        // and wrong for "can anything run this" — the account we are sitting on
        // is very often the one that can. Asked this way every logged-in
        // account counts, including ours.
        return (family: string) => {
            const p = pickTarget(undefined, null, now, family)
            return p.kind === 'account' && !p.withoutModel
        }
    }

    // --- the flip itself ----------------------------------------------------

    /**
     * Work out where to go and move the transcript there. Returns what the
     * launcher should do next; it owns the relaunch, because it owns the loop.
     */
    apply(req: FlipRequest, claudeSessionId: string | null): ApplyResult {
        const from = this.here()
        const family = this.modelFamily()
        const now = Date.now()
        const policy = this.switchPolicy()
        // The policy governs the AUTOMATIC choice. A named account is a human
        // overruling the machinery, and every other decision in this file
        // already treats that as final — refusing it here would make `/flip
        // alt` do nothing on a setting Clay forgot he had moved.
        const auto = !req.account

        // Nothing at all, and say which setting decided that. This is the one
        // value where the session genuinely stops, so it has to be unmistakable
        // rather than silent.
        if (auto && policy === 'nothing') {
            return {
                kind: 'refused',
                note:
                    `Cattle Drover: ${from?.name ?? 'this account'} ran out and nothing was changed` +
                    `${policySuffix(policy)}. Move by hand with \`/flip <account>\` or \`/model\`.`,
            }
        }

        const plan = (): DowngradePlan | null =>
            planDowngrade({
                family,
                model: this.currentModel(),
                effort: this.currentEffort(),
                familyFallback: this.policyValues.familyFallback ?? null,
                runnable: this.runnableFamily(now),
            })

        // Downgrade only: the account never moves, so do not even ask where it
        // would have moved to. Staying put is `refused` in this file's
        // vocabulary — the launcher's word for "no account change" — and the
        // downgrade rides along on it.
        if (auto && policy === 'downgrade-only') {
            const only = plan()
            if (only) {
                this.pendingPick = { model: only.model, effort: only.effort }
                return {
                    kind: 'refused',
                    downgrade: only,
                    note:
                        `${downgradeNote(only, policy)} Staying on ${from?.name ?? 'this account'}; ` +
                        'the account was not changed because that is what this setting says.',
                }
            }
            return {
                kind: 'refused',
                note:
                    `Cattle Drover: no lower model has headroom either, so nothing changed` +
                    `${policySuffix(policy)}. See \`drover accounts\` for when the next window is back.`,
            }
        }

        let downgrade: DowngradePlan | null = null
        let choice = pickTarget(from?.name, req.account, now, family)

        // Account first, model second. We are here only because the pass above
        // could not find an account that runs the model Clay is on — either it
        // parked, or it settled for one that is out of this family too, which
        // is exactly what `withoutModel` means. Both are the moment to drop a
        // rung rather than print a sentence asking him to.
        const stuck = choice.kind === 'parked' || (choice.kind === 'account' && !!choice.withoutModel)
        if (auto && stuck && mayDowngradeModel(policy)) {
            downgrade = plan()
            // Re-ask for the LOWER family. The answer may be this very account,
            // in which case nothing relaunches onto anywhere new and only the
            // model changes, or it may be another login that has the headroom.
            if (downgrade) choice = pickTarget(from?.name, null, now, downgrade.to)
        }

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
                note: parkNote(choice, req, policy, mayDowngradeModel(policy) ? 'tried' : 'not allowed'),
            }
        }

        const target = choice.account
        // What the tail of every sentence below says. Three cases, and each one
        // NAMES THE POLICY that chose it, because "it did nothing" and "it was
        // told to do nothing" look identical from the phone at 3am.
        //
        //   a downgrade happened          say what it dropped to and why
        //   nothing has this model, and   say so, and say which setting stopped
        //   we were not allowed to drop   us dropping — never just "use /model"
        //   everything is fine            say nothing extra
        const switchHint = downgrade
            ? ` ${downgradeNote(downgrade, policy)}`
            : choice.withoutModel
                ? ` Nothing has ${familyLabel(choice.withoutModel)} headroom` +
                  (mayDowngradeModel(policy)
                      ? ', and no lower model has any either'
                      : ', and the model was left alone') +
                  `${policySuffix(policy)}. Switch models with \`/model\` or the next turn hits the ` +
                  'same wall.'
                : ''
        if (downgrade) this.pendingPick = { model: downgrade.model, effort: downgrade.effort }

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
                        : `Cattle Drover: already on ${target.name}.${switchHint}`
            return { kind: 'refused', note, ...(downgrade ? { downgrade } : {}) }
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

        // The config dirs go with it so the handover can name the agent's own
        // `subagents/agent-<id>.jsonl` -- carryTranscript has just copied that
        // directory into the target, so the path handed over is one the new
        // session still owns rather than a symlink into the account it left.
        const prompt = resolveFlipPrompt({
            from: from?.name,
            to: target.name,
            reason: req.reason,
            cwd: this.cwd,
            session: claudeSessionId,
            override: req.prompt,
            account: target,
            stranded,
            configDir: target.configDir,
            ...(from?.configDir ? { fromConfigDir: from.configDir } : {}),
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
            ...(downgrade ? { downgrade } : {}),
            note:
                `Cattle Drover: ${from?.name ?? 'this session'} → ${target.name} (${req.reason}, by ${req.by}), ` +
                (resume
                    ? `resuming ${basename(this.cwd)}` +
                      // The SESSION resumes; the subagents do not, and saying
                      // "with subagents" here read as though they did
                      // (DROVE-240). They are re-dispatched by the new session
                      // off the transcripts the arrival prompt points at.
                      (stranded.length > 0
                          ? `, with ${stranded.length} subagent${stranded.length === 1 ? '' : 's'} to re-dispatch.`
                          : '.')
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
    policy: SwitchPolicy,
    /** Whether a model downgrade was even on the table, so the park can say so. */
    downgradeAttempt: 'tried' | 'not allowed',
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
    // A park is the answer of LAST resort, so it says what else was considered.
    // Without this line a park under `flip-only` and a park where every lower
    // model is also exhausted read identically, and they are different problems.
    out.push(
        downgradeAttempt === 'tried'
            ? `No lower model has headroom either${policySuffix(policy)}.`
            : `The model was left alone${policySuffix(policy)}.`,
    )
    out.push(overrideHint)
    return out.join('\n')
}
