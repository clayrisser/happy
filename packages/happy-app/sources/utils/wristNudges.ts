/**
 * The wrist's IN-APP haptics, mirrored for the phone (DROVE-384).
 *
 * `WristNudge.swift` is the source of truth — it is what the watch plays — and
 * `wristNudges.spec.ts` parses that file and fails the moment the two
 * disagree. Edit the Swift; the spec says what to copy. Same arrangement
 * wristCues.ts has with WristCue.swift, for the same reason: a phone cannot
 * run the Swift, and two vocabularies pretending to be one is the failure.
 *
 * WHY THE PHONE NEEDS THE TABLE AT ALL, since the wrist is what buzzes:
 * three of these moments only the PHONE can see. Read-aloud runs on the phone
 * even when the wrist is the speaker, so the reader starting, pausing and
 * skipping ahead reach the watch as a `cue` message and nowhere else. The
 * phone has to name them, and naming them from a table the spec pins to the
 * Swift is what stops the two ends drifting.
 *
 * A NUDGE IS NOT A CUE. A `WristCue` is news: ranked, deduped, and able to
 * survive a closed app as a notification. A nudge is feedback for something
 * happening in front of him — one beat, never ranked, and worth nothing at
 * all when the watch app is off screen.
 */

import type { WristBeat } from './wristCues';

/** Mirrors `WristNudge` in WristNudge.swift. The raw value is the wire name. */
export type WristNudgeName =
    | 'gateArrived'
    | 'needsYou'
    | 'answerSent'
    | 'answerRefused'
    | 'readingStarted'
    | 'readingPaused'
    | 'readingSkipped'
    | 'flipLanded';

export interface WristNudgeSpec {
    nudge: WristNudgeName;
    beat: WristBeat;
    /** Mirrors `dedupes`: whether an id is checked before it plays. */
    dedupes: boolean;
    /** Who sees the moment, and therefore who fires it. */
    from: 'wrist' | 'phone';
}

/**
 * The table, in the Swift's own order.
 *
 * `from` is not in the Swift, because the watch does not need to be told where
 * a nudge came from — it plays whatever reaches it. It is here so this file
 * can answer the one question the phone actually has: which of these am I
 * responsible for sending.
 */
export const wristNudges: readonly WristNudgeSpec[] = [
    { nudge: 'gateArrived', beat: 'notification', dedupes: false, from: 'wrist' },
    { nudge: 'needsYou', beat: 'notification', dedupes: true, from: 'wrist' },
    { nudge: 'answerSent', beat: 'success', dedupes: false, from: 'wrist' },
    { nudge: 'answerRefused', beat: 'failure', dedupes: false, from: 'wrist' },
    { nudge: 'readingStarted', beat: 'start', dedupes: false, from: 'phone' },
    { nudge: 'readingPaused', beat: 'stop', dedupes: false, from: 'phone' },
    { nudge: 'readingSkipped', beat: 'directionUp', dedupes: false, from: 'phone' },
    { nudge: 'flipLanded', beat: 'click', dedupes: false, from: 'wrist' },
];

export function wristNudgeSpec(nudge: WristNudgeName): WristNudgeSpec {
    const found = wristNudges.find((spec) => spec.nudge === nudge);
    if (!found) throw new Error(`no such wrist nudge: ${nudge}`);
    return found;
}

/** Mirrors `WristHush`. */
export type WristHush = 'notFrontmost' | 'channelOff' | 'alreadyDelivered';

export type WristNudgeDecision =
    | { play: WristBeat }
    | { hush: WristHush };

export interface WristNudgeConditions {
    /**
     * The SYNCED `droverAnnounceHaptic` channel switch. Never this handset's
     * own device-local haptic setting, which says nothing about a watch
     * (DROVE-190).
     */
    announceHaptic: boolean;
    /** The watch app is on screen. `WKInterfaceDevice.play` needs it. */
    frontmost: boolean;
    /** Some other path already carried this id to the wrist. */
    alreadyDelivered?: boolean;
    /** A finger pressed a Playground row asking to feel this. */
    demo?: boolean;
}

/**
 * Whether a nudge plays. Mirrors `WristNudgePolicy.decide`, clause for clause,
 * and the spec walks both.
 */
export function decideWristNudge(
    nudge: WristNudgeName,
    conditions: WristNudgeConditions,
): WristNudgeDecision {
    const spec = wristNudgeSpec(nudge);
    if (!conditions.frontmost) return { hush: 'notFrontmost' };
    if (conditions.demo) return { play: spec.beat };
    if (!conditions.announceHaptic) return { hush: 'channelOff' };
    if (spec.dedupes && conditions.alreadyDelivered) return { hush: 'alreadyDelivered' };
    return { play: spec.beat };
}

/**
 * The cue ids some OTHER path already carried, out of the ones this change
 * raised (DROVE-384).
 *
 * THE DEDUPE, and the reason it has to be computed here rather than on the
 * wrist. A todo can reach Clay's watch twice: as the push iOS mirrors onto it,
 * and as the snapshot this phone publishes over WatchConnectivity. Those are
 * two wires and neither can see the other — the watch app is never told a
 * mirrored push happened, and the push knows nothing about WatchConnectivity.
 *
 * The phone sees both, because every path that carries a cue claims its id
 * first in one on-disk ledger (`claimWristCues`, DROVE-224). `claimed` is what
 * came back from that claim: the ids THIS publish owns. Everything else in
 * `raised` was won by another path — the background task the silent wake push
 * launches — and is named on the snapshot so the wrist marks it played before
 * it diffs. One todo, one buzz, whichever wire got there first.
 *
 * Pure and separate from the ledger so a test can state the rule without a
 * disk: the ledger's job is to be atomic, this one's is to be right.
 */
export function wristAlreadyDelivered(raised: string[], claimed: string[]): string[] {
    if (raised.length === 0) return [];
    const mine = new Set(claimed);
    return raised.filter((id) => !mine.has(id));
}

/**
 * Pull the nudge table out of WristNudge.swift's source, for the spec that
 * pins this file to it. A small hand parser rather than a Swift toolchain,
 * exactly as `parseWristCueSwift` is: the lines it reads are
 * `case .answerSent: return .success` and their siblings.
 */
export function parseWristNudgeSwift(source: string): {
    beats: Record<string, WristBeat>;
    cases: string[];
    dedupes: string | null;
    clauses: string[];
} {
    const beats: Record<string, WristBeat> = {};
    const cases: string[] = [];
    let inNudge = false;
    for (const line of source.split('\n')) {
        if (/^enum WristNudge:/.test(line)) { inNudge = true; continue; }
        if (inNudge && /^\}/.test(line)) inNudge = false;
        if (inNudge) {
            const bare = /^\s{4}case (\w+)\s*$/.exec(line);
            if (bare) cases.push(bare[1]);
        }
        const beat = /case \.(\w+): return \.(\w+)$/.exec(line.trim());
        if (beat && !(beat[1] in beats)) beats[beat[1]] = beat[2] as WristBeat;
    }
    const dedupes = /var dedupes: Bool \{ self == \.(\w+) \}/.exec(source);
    // The decision, clause by clause, so the ORDER can be checked and not just
    // the outcomes: `demo` bypassing the channel is only correct because it is
    // read after the frontmost rule and before everything else.
    const body = /static func decide\([\s\S]*?\n    \}/.exec(source)?.[0] ?? '';
    const clauses = body
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('if ') || line.startsWith('return '));
    return { beats, cases, dedupes: dedupes ? dedupes[1] : null, clauses };
}
