/**
 * The session's dot, published to the drover bus so the TERMINAL can draw it
 * (DROVE-247).
 *
 * Clay photographed his own pane — `✳ Actualizing… (20s · ↓ 424 tokens)` with
 * the bottom-left of the composer green — and asked why it was not the pulsing
 * blue the phone had been showing since DROVE-231. The answer measured for the
 * ticket is that nothing in the terminal was drawing a drover dot at ALL: the
 * green he pointed at is Claude Code's own composer chrome, `tmux/drover.conf`
 * sets no status format, and his own tmux.conf puts the status line at the TOP
 * with `status-left ""`. So this is not a colour being wrong. It is the third
 * surface never having been built.
 *
 * SAME SHAPE AS DROVE-257, AND THE SAME FIX. That ticket found the compacting
 * dot green because the state never arrived, and it did not paper over it with
 * an inference — it published the fact from the one place that can see it. The
 * state does not arrive here either: the drover bus's session registry carries
 * a LIFECYCLE (`live-interactive` / `idle` / `ended`) and nothing about whether
 * the main thread is busy. Measured on Clay's live bus, `GET /v1/sessions`
 * returns no working, thinking or compacting field on any row.
 *
 * The one process that can see it is THIS one. happy-cli drives the pane, owns
 * the fd 3 thinking counter, owns the compaction latch, and already computes a
 * `LiveStatus` once a second for the phone. So the dot is published from the
 * same sink, on the same facts, resolved by the same table.
 *
 * ONE TABLE, NOT A THIRD. `statusDotState` and `statusDotColors` moved to
 * `@slopus/happy-wire` for this (see statusDot.ts there): the app imports them
 * through a re-export at their old path, and this file imports them directly.
 * The palette travels WITH the state on every publish, so cattle-drover renders
 * hues it was handed and has no colour table of its own to drift.
 *
 * WHAT THIS FILE DOES NOT DECIDE, deliberately — two of the six states belong
 * to the bus and are applied there, in the precedence `statusDotState` already
 * fixes:
 *
 *   - `disconnected` / `recentlyDisconnected`. A process cannot report that it
 *     stopped talking. `staleMs` rides along so the bus ages the last publish
 *     against the SAME threshold the phone uses rather than inventing one.
 *   - `waiting`. The bus IS the pending-prompt broker; it knows about a
 *     question or a permission this process has handed off. It sits BELOW
 *     `working` in `statusDotState`, so the bus applies it only to a session
 *     this file called `connected`.
 *
 * FAIL-OPEN, like every other drover producer. A bus that is down costs a
 * caught promise. Nothing here is ever awaited by the session.
 */

import {
    LIVE_STATUS_STALE_MS,
    statusDotBlinks,
    statusDotColors,
    statusDotLabels,
    statusDotState,
    type StatusDotState,
} from '@slopus/happy-wire'

import { logger } from '@/ui/logger'

const droverUrl = (): string => process.env.DROVER_URL || 'http://127.0.0.1:7970'

/** The facts this process can see about its own session. */
export interface DotFacts {
    /**
     * The main thread is working.
     *
     * Three terms, exactly as the phone's strip reads them (DROVE-243/244/257):
     * the live snapshot's `main`, the fd 3 thinking counter for the seconds
     * before a snapshot exists, and a compaction — which is the main thread
     * working and is the one state where nothing else says so.
     */
    mainWorking: boolean
    /** A tool is running. A compaction is a model call with no tool under it. */
    toolRunning: boolean
    /** The compaction latch is open (DROVE-257). */
    compacting: boolean
}

/**
 * The state, from the facts.
 *
 * `atCompaction` is FALSE here and that is not a shortcut. It is the term
 * DROVE-231 inferred a compaction from before the CLI could say so, and
 * DROVE-257 measured it reading false for the whole pass anyway. It exists for
 * a session whose CLI is too old to publish `compacting`; this file IS that
 * publisher, so the observed fact is always present and the fallback would only
 * ever be a second, worse opinion.
 *
 * `online` is TRUE for the same kind of reason: this runs inside the session, so
 * it cannot witness its own absence. The bus ages the publish instead.
 */
export function dotStateFor(facts: DotFacts, now: number = Date.now()): StatusDotState {
    return statusDotState({
        online: true,
        mainWorking: facts.mainWorking,
        toolRunning: facts.toolRunning,
        atCompaction: false,
        compacting: facts.compacting,
        waiting: false,
        now,
    })
}

/** What goes on the wire, and what cattle-drover renders from. */
export interface DotPublishBody {
    state: StatusDotState
    /** When this state was resolved, epoch ms. Absolute, like everything else. */
    at: number
    /**
     * How long the bus may believe this publish. `LIVE_STATUS_STALE_MS`, sent
     * rather than duplicated so the terminal's yellow turns red on the same
     * threshold as the phone's.
     */
    staleMs: number
    /** `statusDotColors`, whole. The renderer is handed its hues, never a table. */
    palette: Record<StatusDotState, string>
    /** `statusDotLabels`, for anything that needs a word instead of a glyph. */
    labels: Record<StatusDotState, string>
    /** The states DROVE-231 blinks. The terminal decides what to DO about them. */
    blinks: StatusDotState[]
}

export function dotPublishBody(state: StatusDotState, at: number = Date.now()): DotPublishBody {
    return {
        state,
        at,
        staleMs: LIVE_STATUS_STALE_MS,
        palette: { ...statusDotColors },
        labels: { ...statusDotLabels },
        blinks: (Object.keys(statusDotColors) as StatusDotState[]).filter(statusDotBlinks),
    }
}

export interface DotPublisher {
    /** Resolve and send, if the state actually moved. */
    sync(facts: DotFacts, now?: number): void
    /** The last state sent, or null before the first publish. */
    last(): StatusDotState | null
    dispose(): void
}

/**
 * ON CHANGE ONLY, and that is the whole reason this is a class and not a fetch.
 *
 * `onLiveStatus` fires about once a second for the life of the session. The dot
 * has six values and spends minutes at a time on one of them, so publishing
 * every tick would be some thousands of loopback POSTs an hour to say nothing
 * changed — and the bus would journal each one. A state transition is a handful
 * of publishes a turn.
 *
 * The disposed flag matters for the same reason the compaction latch has a
 * ceiling: a session tearing down must not leave a `working` in flight that
 * lands after the row went idle.
 */
export function createDotPublisher(
    /**
     * READ AT SEND TIME, never captured. `session.sessionId` is null until the
     * `SessionStart` hook names the Claude session, and a resume renames it —
     * the registry is keyed by that same id, so a captured copy would post the
     * dot to a row nobody is looking at. No id means no publish and no state
     * remembered, so the first real one still goes out.
     */
    sessionId: () => string | null,
    send: (id: string, body: DotPublishBody) => Promise<void> = postToBus,
): DotPublisher {
    let last: StatusDotState | null = null
    let disposed = false
    return {
        sync(facts, now = Date.now()) {
            if (disposed) return
            const id = sessionId()
            if (!id) return
            const state = dotStateFor(facts, now)
            if (state === last) return
            last = state
            void send(id, dotPublishBody(state, now)).catch((err) => {
                logger.debug(`[drover] dot publish failed (bus down is fine): ${err}`)
            })
        },
        last: () => last,
        dispose() {
            disposed = true
        },
    }
}

async function postToBus(sessionId: string, body: DotPublishBody): Promise<void> {
    const res = await fetch(`${droverUrl()}/v1/sessions/${sessionId}/dot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(2000),
    })
    if (!res.ok) throw new Error(`bus answered ${res.status}`)
}
