/**
 * The flip and model-fallback policy, carried to the app and written back from
 * it (DROVE-3).
 *
 * DROVE-4 landed the store and the HTTP surface in cattle-drover: a per-session
 * settings file the bus owns, `GET/PATCH /v1/settings/sessions/<id>` and
 * `/v1/settings/defaults`, documented in docs/flip-policy.md. Nothing reached
 * it but `drover settings` in a terminal. Clay, 2026-08-29: "we should support
 * the ability for the mobile app to control these settings, as that's gonna be
 * the most straightforward way to control settings that we want to set for
 * sessions." He is not at the terminal when a session runs out — that is the
 * whole reason Cattle Drover exists — so the terminal being the only writer
 * makes the setting unreachable exactly when it matters.
 *
 * The phone cannot reach the bus. It is loopback :7970 on the Mac and the app
 * is on a phone, so every read and write goes through THIS process, which is
 * already on the machine and already talking to both. Two directions:
 *
 *   read   a poll of the bus, stamped on `metadata.droverPolicy`, the same
 *          channel `droverUsage` rides. That is what makes AC4 work without
 *          any app-side persistence: the store is a file on the Mac, so
 *          closing the app and reopening it re-reads it, and a change Clay
 *          typed in the terminal shows up on the next poll.
 *   write  the `drover-policy` RPC, which PATCHes the bus and re-stamps
 *          immediately, so the app does not have to wait a poll to see its own
 *          change land.
 *
 * NO LOCAL COPY OF THE DEFAULTS. engine/settings.js owns the built-ins, the
 * validation and the merge; this file forwards and renders. A second copy here
 * is how `drover accounts` came to contradict the picker, and the app needs
 * `overrides` vs `machine` vs `builtIn` kept apart anyway — which the bus
 * already returns — to say whether a value was chosen or merely inherited.
 *
 * KEYED BY THE CLAUDE CODE SESSION ID, not the happy session id. That is the
 * key `drover settings` uses ($CLAUDE_CODE_SESSION_ID), the key the bus's own
 * session registry uses, and the key the policy engine reads at limit time. Two
 * key namespaces would mean a phone toggle and a typed command writing past
 * each other, which is the divergence lib/drover-settings.sh refuses one layer
 * down. The cost is that the id changes when Claude restarts — a flip, a
 * resume, a /clear — so the overrides are carried onto the new id; see
 * `sessionFound`.
 */

import { logger } from '@/ui/logger'

const DROVER_URL = () => process.env.DROVER_URL || 'http://127.0.0.1:7970'

export type OnLimit = 'auto' | 'prompt'
export type OnLimitTimeout = 'auto' | 'stop'
export type OnFamilyExhausted = 'stop' | 'fallback'
export type AnswerAudio = 'off' | 'click' | 'speech' | 'both'

/** One saved delivery combination (DROVE-72): a row in `modes`. */
export interface DeliveryMode {
    announceVisual: boolean
    announceHaptic: boolean
    announceAudio: boolean
    answerAudio: AnswerAudio
}

/**
 * The keys the store takes. Every one optional: a layer holds only what it
 * sets, and `effective` is the merge the bus did, not one done here.
 *
 * The delivery keys (DROVE-72) ride the same store and the same RPC: the
 * phone's three channel toggles PATCH `announce*`, and `mode` is a macro the
 * bus expands into the four channel keys. `values()` below used to keep only
 * the five flip keys, which would have stripped these on the read side and
 * left a phone toggle looking like it did nothing.
 */
export interface PolicyValues {
    onLimit?: OnLimit
    onLimitTimeout?: OnLimitTimeout
    onLimitPromptTtlMs?: number
    onFamilyExhausted?: OnFamilyExhausted
    familyFallback?: Record<string, string[]>
    announceVisual?: boolean
    announceHaptic?: boolean
    announceAudio?: boolean
    answerAudio?: AnswerAudio
    mode?: string | null
    modes?: Record<string, DeliveryMode | null>
}

/** A patch may also clear a key with an explicit null — "use the default". */
export type PolicyPatch = {
    [K in keyof PolicyValues]?: PolicyValues[K] | null
}

export interface DroverPolicy {
    capturedAt: number
    /** The store's key: the Claude Code session id, or null before Claude reports one. */
    sessionId: string | null
    effective: PolicyValues
    /** What THIS session set. Empty means every value is inherited. */
    overrides: PolicyValues
    /** machine defaults merged over the built-ins — what a new session gets. */
    defaults: PolicyValues
    /** The machine layer alone, so the app can say a default was moved. */
    machine: PolicyValues
    builtIn: PolicyValues
    updatedAt: number | null
    updatedBy: string | null
    /**
     * Why there is nothing to show. Present instead of the layers when the bus
     * is down — the app says "the bus is not answering" rather than rendering
     * built-in defaults as though they were live, which is the lie that makes a
     * toggle look like it worked.
     */
    unavailable?: string
}

const KEYS: (keyof PolicyValues)[] = [
    'onLimit',
    'onLimitTimeout',
    'onLimitPromptTtlMs',
    'onFamilyExhausted',
    'familyFallback',
    'announceVisual',
    'announceHaptic',
    'announceAudio',
    'answerAudio',
    'mode',
    'modes',
]

/** Keep only the known keys; the bus block also carries updatedAt/updatedBy. */
function values(raw: unknown): PolicyValues {
    const src = (raw ?? {}) as Record<string, unknown>
    const out: PolicyValues = {}
    for (const k of KEYS) if (k in src) (out as Record<string, unknown>)[k] = src[k]
    return out
}

const settingsUrl = (path: string) => `${DROVER_URL()}/v1/settings${path}`

interface BusReply {
    status: number
    body: Record<string, unknown> | null
    error?: string
}

async function call(url: string, init: RequestInit & { by?: string } = {}): Promise<BusReply> {
    const { by, ...rest } = init
    try {
        const res = await fetch(url, {
            ...rest,
            headers: {
                ...(rest.body ? { 'Content-Type': 'application/json' } : {}),
                ...(by ? { 'X-Drover-By': by } : {}),
                ...(rest.headers as Record<string, string> | undefined),
            },
        })
        let body: Record<string, unknown> | null = null
        try {
            body = (await res.json()) as Record<string, unknown>
        } catch {
            body = null
        }
        return { status: res.status, body }
    } catch (err) {
        // The bus being down is reported, never swallowed into a default. A
        // settings screen that shows "prompt" when it could not read anything
        // has told Clay his session is set to prompt when nobody knows.
        return { status: 0, body: null, error: err instanceof Error ? err.message : String(err) }
    }
}

/** The bus's `GET /v1/settings/sessions/<id>` block, shaped for metadata. */
function snapshotOf(sessionId: string | null, body: Record<string, unknown>, now: number): DroverPolicy {
    return {
        capturedAt: now,
        sessionId,
        effective: values(body.effective),
        overrides: values(body.overrides),
        defaults: values(body.defaults),
        machine: values(body.machine),
        builtIn: values(body.builtIn),
        updatedAt: typeof body.updatedAt === 'number' ? body.updatedAt : null,
        updatedBy: typeof body.updatedBy === 'string' ? body.updatedBy : null,
    }
}

function unavailable(sessionId: string | null, why: string, now: number): DroverPolicy {
    return {
        capturedAt: now,
        sessionId,
        effective: {},
        overrides: {},
        defaults: {},
        machine: {},
        builtIn: {},
        updatedAt: null,
        updatedBy: null,
        unavailable: why,
    }
}

/**
 * What this session is set to, and where each value came from.
 *
 * With no Claude session id yet there is no per-session block to read, so the
 * DEFAULTS are read instead and reported with empty overrides. That is honest:
 * a session Claude has not named yet genuinely behaves as the defaults, and it
 * is what the app shows in the seconds before the first turn.
 */
export async function readPolicy(sessionId: string | null, now = Date.now()): Promise<DroverPolicy> {
    if (sessionId) {
        const res = await call(settingsUrl(`/sessions/${encodeURIComponent(sessionId)}`))
        if (res.status === 200 && res.body) return snapshotOf(sessionId, res.body, now)
        return unavailable(sessionId, reasonFor(res), now)
    }
    const res = await call(settingsUrl('/defaults'))
    if (res.status === 200 && res.body) {
        const defaults = values(res.body.defaults)
        return {
            capturedAt: now,
            sessionId: null,
            effective: defaults,
            overrides: {},
            defaults,
            machine: {},
            builtIn: values(res.body.builtIn),
            updatedAt: null,
            updatedBy: null,
        }
    }
    return unavailable(null, reasonFor(res), now)
}

function reasonFor(res: BusReply): string {
    if (res.error) return `the drover bus at ${DROVER_URL()} is not answering (${res.error})`
    const err = res.body && typeof res.body.error === 'string' ? res.body.error : null
    return err ?? `the drover bus answered ${res.status}`
}

export interface PolicyWriteResult {
    ok: boolean
    /** The state after the write, so the caller can re-stamp without a second read. */
    policy: DroverPolicy
    /** The bus's own words when it refused. */
    error?: string
}

/**
 * Merge keys into one session's overrides. `null` clears a key back to the
 * default, which is what a control flipped to "use the default" sends — without
 * it the app would have to know the current default and write it in, freezing
 * every app release against whatever the default was that day.
 */
export async function writeSessionPolicy(
    sessionId: string,
    patch: PolicyPatch,
    by: string,
    now = Date.now(),
): Promise<PolicyWriteResult> {
    const res = await call(settingsUrl(`/sessions/${encodeURIComponent(sessionId)}`), {
        method: 'PATCH',
        body: JSON.stringify(patch),
        by,
    })
    if (res.status === 200 && res.body) {
        return { ok: true, policy: snapshotOf(sessionId, res.body, now) }
    }
    // A 400 here is the bus refusing an unknown key or a value outside its
    // enum. Reported verbatim rather than turned into a generic failure: a
    // settings screen that sends `onlimit` and is told "it did not work" cannot
    // be debugged from the phone.
    const why = reasonFor(res)
    logger.debug(`[flip] settings write refused: ${why}`)
    return { ok: false, policy: await readPolicy(sessionId, now), error: why }
}

/** Drop every override for a session, back to the machine defaults. */
export async function clearSessionPolicy(sessionId: string, now = Date.now()): Promise<PolicyWriteResult> {
    const res = await call(settingsUrl(`/sessions/${encodeURIComponent(sessionId)}`), { method: 'DELETE' })
    if (res.status === 200 && res.body) {
        return { ok: true, policy: snapshotOf(sessionId, res.body, now) }
    }
    return { ok: false, policy: await readPolicy(sessionId, now), error: reasonFor(res) }
}

/**
 * Move the machine defaults — the "app-level default" of DROVE-3's third AC.
 * A session with no override of its own follows these, and one with an override
 * keeps it, because the bus merges session over machine over built-in.
 */
export async function writeDefaultPolicy(
    patch: PolicyPatch,
    by: string,
    sessionId: string | null,
    now = Date.now(),
): Promise<PolicyWriteResult> {
    const res = await call(settingsUrl('/defaults'), {
        method: 'PATCH',
        body: JSON.stringify(patch),
        by,
    })
    if (res.status === 200 && res.body) {
        // Read the session back rather than synthesising it: moving a default
        // changes what THIS session is effectively set to whenever it has no
        // override for that key, and only the bus knows the merge.
        return { ok: true, policy: await readPolicy(sessionId, now) }
    }
    return { ok: false, policy: await readPolicy(sessionId, now), error: reasonFor(res) }
}

/**
 * How often the bus is asked without being prompted. This is what makes "the
 * app reflects a change made from the terminal" true: `drover settings set`
 * writes the file, and the next poll carries it to the phone. 30s matches the
 * usage reporter's poll, which watches the same kind of local state.
 */
const pollMs = 30_000

export interface PolicyReporterOptions {
    /** The Claude Code session id, asked fresh — it changes on a flip or resume. */
    sessionId: () => string | null
    /** Where the snapshot goes; runClaude points this at session metadata. */
    publish: (policy: DroverPolicy) => void
    now?: () => number
    pollMs?: number
}

/**
 * Keeps `metadata.droverPolicy` in step with the bus.
 *
 * Publishes on start and whenever the answer changes, so the app's settings
 * screen is live without polling from the phone. Unlike the usage reporter
 * there is no cheap local stamp to check first — the store is behind HTTP —
 * so every tick is one GET against a loopback server, which is the same cost
 * as the stat pass and against an endpoint nothing else polls.
 */
export class PolicyReporter {
    private readonly sessionId: () => string | null
    private readonly publish: (policy: DroverPolicy) => void
    private readonly now: () => number
    private readonly pollEvery: number

    private signature = ''
    private lastKey: string | null = null
    private timer: NodeJS.Timeout | null = null
    private stopped = false
    private inFlight = false

    constructor(opts: PolicyReporterOptions) {
        this.sessionId = opts.sessionId
        this.publish = opts.publish
        this.now = opts.now ?? Date.now
        this.pollEvery = opts.pollMs ?? pollMs
    }

    start(): void {
        if (this.stopped || this.timer) return
        void this.tick()
        this.timer = setInterval(() => void this.tick(), this.pollEvery)
        // Never the reason the process stays alive.
        this.timer.unref?.()
    }

    stop(): void {
        this.stopped = true
        if (this.timer) clearInterval(this.timer)
        this.timer = null
    }

    /**
     * Claude reported a session id. When it REPLACED one that had overrides,
     * carry them onto the new id.
     *
     * Claude Code mints a new session id on a resume, a fork and a /clear, and
     * a flip is a resume — so without this the first thing an auto-flip does is
     * discard the policy that told it to auto-flip, and the session silently
     * reverts to the defaults. The copy is skipped when the new id already has
     * overrides of its own, so a session Clay configured after the restart is
     * never overwritten by the one before it.
     */
    async sessionFound(next: string): Promise<void> {
        const previous = this.lastKey
        this.lastKey = next
        if (!previous || previous === next) {
            await this.tick()
            return
        }
        try {
            const before = await readPolicy(previous, this.now())
            const after = await readPolicy(next, this.now())
            const carry = Object.keys(before.overrides).length > 0
                && Object.keys(after.overrides).length === 0
                && !before.unavailable
                && !after.unavailable
            if (carry) {
                logger.debug(`[flip] carrying session policy from ${previous} to ${next}`)
                await writeSessionPolicy(next, before.overrides as PolicyPatch, 'flip-carry', this.now())
            }
        } catch (err) {
            logger.debug('[flip] policy carry failed (ignored)', err)
        }
        await this.tick()
    }

    /** Read now and publish if anything moved. Returns true when it published. */
    async tick(): Promise<boolean> {
        if (this.stopped || this.inFlight) return false
        this.inFlight = true
        try {
            const key = this.sessionId()
            if (this.lastKey === null && key) this.lastKey = key
            const policy = await readPolicy(key, this.now())
            // capturedAt moves every tick and is not a change; comparing the
            // rest keeps an idle session from re-stamping metadata every 30s.
            const { capturedAt: _ignored, ...rest } = policy
            const signature = JSON.stringify(rest)
            if (signature === this.signature) return false
            this.signature = signature
            this.publish(policy)
            return true
        } catch (err) {
            logger.debug('[flip] policy snapshot failed (ignored)', err)
            return false
        } finally {
            this.inFlight = false
        }
    }

    /** Publish this state at once — used after a write so the app sees it land. */
    publishNow(policy: DroverPolicy): void {
        if (this.stopped) return
        const { capturedAt: _ignored, ...rest } = policy
        this.signature = JSON.stringify(rest)
        this.publish(policy)
    }
}
