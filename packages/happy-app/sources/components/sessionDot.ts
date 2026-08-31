/**
 * ONE DOT, WHEREVER A SESSION IS DRAWN (DROVE-243).
 *
 * Clay, circling the dot on a session row: "Shouldn't this dot match the dot in
 * the session." It did not. DROVE-231 gave the status strip's dot the whole
 * vocabulary he specified — green connected, blue working, yellow just dropped,
 * red gone a while, purple compacting, amber waiting on him — and the dot on a
 * session ROW stayed its own thing: a five-entry colour table copied into
 * SessionsList and again into ActiveSessionsGroupCompact, with a third in
 * `useSessionStatus`. One of those copies painted `textSecondary` GREY on a
 * connected idle session, which is how a live session came to wear grey in the
 * list while its own strip drew blue.
 *
 * So this file is the adapter and nothing else. `statusDotState` still decides
 * the state and `statusDotColors` still paints it (DROVE-231); all that was
 * ever missing was one honest way to turn a `Session` into that function's
 * input. Same move DROVE-230 made when `usageFill` became the single place
 * headroom becomes a mark for the sheet, the strip and the watch.
 *
 * The pure half takes `now` explicitly so the thresholds can be pinned without
 * a clock; the one hook at the bottom is only the clock.
 */
import * as React from 'react';
import { resolveSessionState } from '@/sync/sessionState';
import type { Session } from '@/sync/storageTypes';
import { isLiveStatusFresh, liveStatusMain } from '@/utils/liveStatus';
import { contextReading } from './contextCompaction';
import {
    statusDotBlinks,
    statusDotColors,
    statusDotLabels,
    statusDotState,
    type StatusDotState,
} from './statusDotState';
import { useTickingNow } from './useTickingNow';

/**
 * Everything the dot needs to know about a session, and nothing that ticks.
 *
 * It is `StatusDotInput` less `now`, on purpose: the facts are read where the
 * session object lives (the store's row projection, or a hook holding one) and
 * the CLOCK is applied where it is drawn. That split is what lets a list row
 * carry its dot as five booleans and a timestamp instead of subscribing to the
 * whole session and re-rendering on every heartbeat.
 */
export interface SessionDotFacts {
    /** `presence === 'online'`. */
    online: boolean;
    /**
     * When the phone last heard from it, epoch ms; null while it is up.
     *
     * Null rather than the real timestamp on a live session, because the state
     * resolver never reads it there and a heartbeat that moved this number
     * would churn every memoised row once a second for nothing.
     */
    lastSeenAt: number | null;
    /** The main thread is working. */
    mainWorking: boolean;
    /** A tool is running. Compaction is a model call with no tool under it. */
    toolRunning: boolean;
    /** The context has reached the compaction point. */
    atCompaction: boolean;
    /**
     * The CLI says a compaction is running right now (DROVE-257).
     *
     * The observed fact, not the guess: `metadata.liveStatus.compacting`, off
     * the `PreCompact` hook. Absent on a CLI too old to publish it, and the
     * `atCompaction` inference above is what stands in until it arrives.
     */
    compacting: boolean;
    /** Blocked on Clay: a permission prompt, or a question. */
    waiting: boolean;
}

/** A session with no facts to offer yet: connected and idle, which draws green. */
export const idleSessionDotFacts: SessionDotFacts = {
    online: true,
    lastSeenAt: null,
    mainWorking: false,
    toolRunning: false,
    atCompaction: false,
    compacting: false,
    waiting: false,
};

/**
 * The facts, read off the store's own session object.
 *
 * `now` is here only for the live snapshot's staleness check. It is NOT the
 * clock that turns yellow into red: that one belongs to whoever draws the dot,
 * because a row can sit on screen for minutes without the store touching it.
 *
 * WHY `thinking` COUNTS AS WORKING HERE and does not on the strip. The strip
 * takes `mainWorking` from the live snapshot alone, so a session whose CLI
 * publishes no snapshot — an old one, a Rig session, the seconds before the
 * first publish — draws green there while it works. A LIST cannot afford that:
 * `thinking` is the only thing many rows ever get, and a row that goes green
 * mid-turn is the same lie in the other direction. Both facts come from the one
 * resolver (`resolveSessionState`), so when DROVE-244 settles what the strip's
 * thinking state means the two converge without a second edit here.
 */
export function sessionDotFacts(session: Session, now: number): SessionDotFacts {
    const online = session.presence === 'online';
    const state = resolveSessionState({
        agentState: session.agentState,
        thinking: session.thinking,
        isOnline: online,
    });
    const live = session.metadata?.liveStatus ?? null;
    const fresh = !!live && isLiveStatusFresh(live, now);
    const main = fresh ? liveStatusMain(live!, now, null) : null;
    // DROVE-257: the compaction, when the CLI is new enough to say so. Gated
    // on the same freshness check as `main` — a snapshot too old to draw a
    // clock from is too old to claim a two-minute pass is still running.
    const compacting = fresh && !!live!.compacting;
    // The transcript's own context against the model's window, from the same
    // reading the strip's gauge draws (contextCompaction.ts). `latestUsage` is
    // on the Session itself, so every row has it; the open session's strip
    // reads the message reducer's copy, which is at most one turn fresher.
    const context = contextReading(
        session.latestUsage?.contextSize,
        session.latestUsage?.contextWindow,
    );
    return {
        online,
        lastSeenAt: online
            ? null
            : typeof session.presence === 'number'
                ? session.presence
                : session.activeAt ?? null,
        // A compaction IS the main thread working, and it is the one state
        // where nothing else says so (DROVE-257).
        mainWorking: main !== null || state === 'thinking' || compacting,
        toolRunning: !!main && !main.working,
        atCompaction: context?.atCompaction ?? false,
        compacting,
        waiting: state === 'permission_required' || state === 'input_required',
    };
}

/** The state, from the facts plus the clock. DROVE-231's resolver, unchanged. */
export function sessionDotState(facts: SessionDotFacts, now: number): StatusDotState {
    return statusDotState({ ...facts, now });
}

/** What a surface actually draws. */
export interface SessionDotPresentation {
    state: StatusDotState;
    /** `statusDotColors`, never a second table. */
    color: string;
    isPulsing: boolean;
    /** What a screen reader hears, since a dot has no text of its own. */
    label: string;
}

/**
 * WHAT A ROW DOES ABOUT THE BLINK: it takes the hue and NOT the animation.
 *
 * The blink is DROVE-231's one word for "burning tokens right now", and it
 * earns its place on the strip because there is exactly one of it and it is
 * about the session Clay is inside. A list is the opposite case on every count:
 *
 *   - Twenty rows with four of them pulsing is a screen that moves, and the job
 *     of the list is to let him FIND the one session that wants him. Motion
 *     spent on the four that are merely busy is motion taken from that.
 *   - The blink carries nothing the hue does not already say. Blue is working
 *     and purple is compacting whether or not they move, and neither colour is
 *     used for anything else in the app.
 *   - The row has louder signals for attention already, and they outrank a
 *     7pt pulse: the flat list shimmers a working title and puts a 20pt dot in
 *     the timestamp slot when something is blocked, and the grouped row prints
 *     the state in words beside the dot.
 *
 * REDUCED MOTION is honoured either way. `StatusDot` stops dead at full opacity
 * under `useReducedMotion` (DROVE-231), and a row passes `isPulsing: false`, so
 * there is nothing left to reduce. That is belt and braces, not the reason.
 */
/**
 * OVERRULED BY CLAY, and the reasoning above is kept because it is still the
 * argument against, not because it won.
 *
 * He asked twice for this dot to match the one in the session, and then asked
 * why it does not pulse. Matching is the whole point of the ticket: a dot that
 * means one thing in a list and another inside the session is worse than no
 * dot, and "same colours, different motion" is a second dialect of the same
 * vocabulary. The cost the paragraphs above describe is real and he owns it.
 *
 * Note it is quieter than it sounds: only `working` and `compacting` blink, so
 * a list is as busy as the number of sessions actually running, not as busy as
 * the list is long.
 */
export const SESSION_ROW_DOT_BLINKS = true;

/**
 * The dot for a row in a list: the shared hue, steady.
 */
export function sessionRowDot(facts: SessionDotFacts, now: number): SessionDotPresentation {
    const state = sessionDotState(facts, now);
    return {
        state,
        color: statusDotColors[state],
        // Per state, not a flat true: only `working` and `compacting` blink
        // inside the session, so a row that blinked on green would be a third
        // dialect rather than the match Clay asked for.
        isPulsing: SESSION_ROW_DOT_BLINKS && statusDotBlinks(state),
        label: statusDotLabels[state],
    };
}

/**
 * The dot for a surface that is ABOUT one session: the session card, and the
 * strip. One dot on the screen, so it blinks exactly as the strip's does.
 */
export function sessionDotPresentation(facts: SessionDotFacts, now: number): SessionDotPresentation {
    const state = sessionDotState(facts, now);
    return {
        state,
        color: statusDotColors[state],
        isPulsing: statusDotBlinks(state),
        label: statusDotLabels[state],
    };
}

/**
 * HOW OFTEN A ROW RE-READS THE CLOCK. Fifteen seconds, and only while down.
 *
 * The only thing time changes for a dot is yellow becoming red at
 * `DISCONNECT_RECENT_MS`, which is two minutes, so 15s is eight times finer
 * than the threshold it has to catch. The strip re-reads every 5s because there
 * is one strip; a list can have a screenful of dropped rows and each one would
 * carry its own interval, so the cheaper number is the right one here. A live
 * row starts no interval at all, which is nearly all of them.
 */
export const SESSION_DOT_TICK_MS = 15_000;

/** The row's dot, with the one clock it needs. */
export function useSessionRowDot(facts: SessionDotFacts): SessionDotPresentation {
    const now = useTickingNow(!facts.online, SESSION_DOT_TICK_MS);
    return React.useMemo(() => sessionRowDot(facts, now), [facts, now]);
}
