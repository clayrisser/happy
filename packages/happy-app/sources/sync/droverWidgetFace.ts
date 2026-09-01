/**
 * WHAT THE PHONE WIDGET SAYS, decided on the phone (DROVE-260).
 *
 * A widget does not run the app. WidgetKit renders it from whatever was last
 * written into the app group, in a process that cannot reach the store, the
 * socket or the bus. So every judgement the face makes has to be made HERE,
 * where the derivations already live, and handed over finished — the same
 * split DROVE-129 settled for the wrist and DROVE-257 had to settle twice.
 *
 * This file therefore derives NOTHING of its own. The tint is
 * `statusDotColors`, looked up by a `StatusDotState` that `statusDotState`
 * resolved; the account figure, when a size is large enough to carry one, is
 * `usageFill`. A colour table or a percentage computed in this file would be
 * the fifth copy of a thing that already has four consumers, and the wrist's
 * grey-vs-red disconnected dot is what that costs.
 *
 * THE ONE JUDGEMENT THAT CANNOT BE MADE HERE is whether the face is still
 * true, because "still" is a time the phone did not know when it wrote. That
 * is split: the THRESHOLDS are below, and the widget evaluates them against
 * its own render date. `sessionStateWire.spec.ts` pins the Swift enums to the
 * phone's; `droverWidgetFace.spec.ts` pins these numbers the same way.
 */

import {
    statusDotColors,
    statusDotLabels,
    type StatusDotState,
} from '@/components/statusDotState';

/** Just the gate facts the face needs. Trimmed from `DroverGate` on purpose. */
export interface WidgetGateFacts {
    id: string;
    title: string;
    /** Epoch ms. The oldest gate is the one the face names. */
    createdAt: number;
}

/** Just the session facts the face needs, as `collectSessions` already sends. */
export interface WidgetSessionFacts {
    id: string;
    /** `sessionDotState`'s answer, resolved on the phone. Never re-derived. */
    dot: StatusDotState;
    /** Subagents running right now; absent when the session never said. */
    subagents?: number;
}

export interface WidgetFaceInput {
    gates: WidgetGateFacts[];
    sessions: WidgetSessionFacts[];
    /** When this was resolved. Stamped into the face, not read off a clock. */
    now: number;
}

/**
 * Everything `.systemSmall` draws, and nothing it does not.
 *
 * Four fields, because four is what fits. There is no room here for the
 * account bar, the session list, or the status line — see the proposal in
 * docs/plans/drover-widgets.md for why each was left out rather than folded.
 */
export interface DroverWidgetFace {
    /** Gates waiting on him. The whole reason the widget exists. */
    count: number;
    /**
     * The state the tint is FOR, kept beside the tint so a test can check the
     * pair rather than trusting a hex on its own.
     */
    dot: StatusDotState;
    /** `statusDotColors[dot]`. Assigned, never chosen. */
    tintHex: string;
    /** The big line. A number when something waits, a word when nothing does. */
    headline: string;
    /** The small line under it. Empty when there is nothing worth the row. */
    detail: string;
    /**
     * When this was resolved, epoch ms; the widget writes it as ISO-8601.
     *
     * Carried INSIDE the face rather than read off `DroverSnapshot.updatedAt`
     * beside it. The two blobs are written by different paths — the wrist
     * publish writes the snapshot, a push that only needs to move the widget
     * writes just this — so a face paired with someone else's timestamp would
     * be aged by an unrelated write, or worse, freshened by one.
     */
    updatedAt: number;
}

/**
 * HOW LONG "CLEAR" MAY BE SHOWN AS A FACT. One hour.
 *
 * This is the asymmetry the whole staleness design turns on, and it is the
 * opposite way round from the wrist's single `staleAfter`.
 *
 * The widget's copy is written when the silent content-available push arrives
 * (droverBackgroundNotification.ts), which the CLI sends exactly when the set
 * of gates CHANGES. So an old snapshot carrying a count is old for an innocent
 * reason: nothing has been raised or resolved, and the count is probably still
 * true — Clay asleep on an unanswered gate looks exactly like this. An old
 * snapshot carrying ZERO is the dangerous one, because the event that would
 * have corrected it is precisely the push that never arrived. Apple documents
 * roughly two or three background pushes an hour and promises none of them.
 *
 * One hour is one budget window. Past it, a dropped raise is as likely an
 * explanation for the silence as a genuinely quiet machine, and a green tick
 * is no longer something the widget is in a position to claim.
 */
export const WIDGET_CLEAR_TRUSTED_MS = 60 * 60 * 1000;

/**
 * HOW LONG A COUNT MAY BE SHOWN AS A FACT. Six hours.
 *
 * Longer than `WIDGET_CLEAR_TRUSTED_MS` for the reason above: a count survives
 * silence, a zero does not. It is not unbounded, because a machine that has
 * been off since this morning leaves a "2 waiting" that will never be answered
 * and never be corrected, and DROVE-255 is the standing reminder of what a
 * fresh-looking figure over a dead measurement costs.
 *
 * Six hours is the one number here chosen by judgement rather than derived
 * from something: longer than a sitting, shorter than a night. It wants a week
 * of watching before it is called right.
 */
export const WIDGET_COUNT_TRUSTED_MS = 6 * 60 * 60 * 1000;

/**
 * How the widget may speak about the face it is holding.
 *
 * `trusted` is a fact. `dated` still shows the same shape — the count does not
 * vanish, which would be its own lie — but says how old it is and drops the
 * tint's authority. There is no third state: a widget that cannot say anything
 * useful should say that, and `dated` already does.
 */
export type WidgetTrust = 'trusted' | 'dated';

/**
 * Whether the face may be stated flatly, given how old it is and what it says.
 *
 * Takes both times rather than reading a clock so the widget can pass its own
 * render date, which is the moment WidgetKit is drawing for and not the moment
 * this ran.
 */
export function widgetTrust(input: {
    count: number;
    updatedAt: number;
    now: number;
}): WidgetTrust {
    const age = input.now - input.updatedAt;
    if (!Number.isFinite(age) || age < 0) return 'dated';
    const budget = input.count > 0 ? WIDGET_COUNT_TRUSTED_MS : WIDGET_CLEAR_TRUSTED_MS;
    return age > budget ? 'dated' : 'trusted';
}

/**
 * WHICH DOT WINS when several sessions have different ones.
 *
 * Worst first, and "worst" means most deserving of the one glance the widget
 * gets. `waiting` tops it because a gate waiting on him is the thing this
 * surface exists for; the two disconnected states come next because a session
 * that is gone is a fault; `compacting` and `working` are healthy and say so;
 * `connected` is the floor.
 *
 * This is an ORDERING over the existing vocabulary, not a new vocabulary. It
 * adds no state and renames none, so the pin test that holds the Swift to
 * `StatusDotState` still holds the whole widget.
 */
const dotRank: Record<StatusDotState, number> = {
    waiting: 0,
    disconnected: 1,
    recentlyDisconnected: 2,
    compacting: 3,
    working: 4,
    connected: 5,
};

export function worstDot(sessions: WidgetSessionFacts[]): StatusDotState | null {
    let worst: StatusDotState | null = null;
    for (const session of sessions) {
        if (worst === null || dotRank[session.dot] < dotRank[worst]) worst = session.dot;
    }
    return worst;
}

/** Subagents out across every session, which is what "workers" means here. */
export function workerCount(sessions: WidgetSessionFacts[]): number {
    return sessions.reduce((total, s) => total + (s.subagents ?? 0), 0);
}

/**
 * The face, resolved.
 *
 * Two shapes and no more, because the widget answers one question and the
 * answer is yes or no.
 *
 * SOMETHING WAITS: the count, big, amber. The oldest gate's title underneath,
 * because when there is one gate the title IS the decision, and when there are
 * five the oldest is the one that has been ignored longest.
 *
 * NOTHING WAITS: no number at all. The remaining question is whether his work
 * is alive, which the dot vocabulary already answers in one hue, and the line
 * says how much is out. A zero rendered as a zero is a figure competing with
 * the figure that matters.
 */
export function droverWidgetFace(input: WidgetFaceInput): DroverWidgetFace {
    const gates = [...input.gates].sort((a, b) => a.createdAt - b.createdAt);
    if (gates.length > 0) {
        return {
            count: gates.length,
            dot: 'waiting',
            tintHex: statusDotColors.waiting,
            headline: String(gates.length),
            detail: gates[0].title,
            updatedAt: input.now,
        };
    }
    // No sessions is not the same as no gates. A phone that has never synced
    // and a machine with nothing running both land here, and neither is an
    // all-clear worth a green tick.
    const dot = worstDot(input.sessions) ?? 'disconnected';
    const workers = workerCount(input.sessions);
    return {
        count: 0,
        dot,
        tintHex: statusDotColors[dot],
        headline: statusDotLabels[dot],
        detail: workers === 0 ? '' : workers === 1 ? '1 worker' : `${workers} workers`,
        updatedAt: input.now,
    };
}
