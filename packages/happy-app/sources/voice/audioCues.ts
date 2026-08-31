/**
 * The eyes-free audio cue vocabulary (DROVE-112).
 *
 * Clay, with the phone in his pocket: "create a heartbeat that pulses when the
 * reading isn't talking yet we still have things working", then "a heartbeat
 * should behave differently depending on different states, like when we're
 * waiting on a question or not", then "we need other sounds, for example
 * whenever a subagent is triggered, or when a tool is called, or when it's
 * reading back to me and it jumps ahead because it got too far behind".
 *
 * So this is a TABLE, not a sound. Two kinds live in it:
 *
 *   - AMBIENT, a state you are in. A slow pulse that repeats while the state
 *     holds and stops the moment it does not. Working is one thing; waiting on
 *     Clay is another, and telling those two apart without looking is the
 *     whole point of the feature.
 *   - EVENT, a thing that just happened. One shot, and then quiet.
 *
 * Shaped like WristCue.swift on purpose, and for the same reason wristCues.ts
 * mirrors it: the wrist and the phone should describe the same world with the
 * same vocabulary rather than drifting into two dialects. Beat COUNT carries
 * the meaning there because a sleeve flattens texture; here beat count and
 * beat LENGTH carry it, because a pocket and a noisy room flatten pitch.
 * Pitch is the polish, never the distinction.
 *
 * Pure data and pure arithmetic. cueTone.ts turns a spec into samples,
 * audioCueMixer.ts decides when one is allowed to be heard, and cuePlayer.ts
 * is the only file that touches the device.
 */

/** One tone burst. `hz` at zero is a rest, which is how a gap gets a shape. */
export interface CueBeat {
    hz: number;
    ms: number;
}

export type AudioCueKind = 'ambient' | 'event';

export type AudioCueId =
    /** Working, nothing pending. The ordinary pulse. */
    | 'working'
    /** A yes/no gate is waiting on Clay. */
    | 'waitingPermission'
    /** A session is blocked on an answer. */
    | 'waitingQuestion'
    /** An agent asked Clay to do something (bus kind `todo`). */
    | 'waitingNeedsYou'
    /** An account is running out of usage or auth. */
    | 'waitingExpiry'
    /** A subagent spawned. */
    | 'agentStart'
    /** A subagent finished. */
    | 'agentDone'
    /** A subagent came back an error. */
    | 'agentFailed'
    /** A RUN of tool calls started. Never one per call; see the mixer. */
    | 'toolRun'
    /** The reader dropped its backlog and jumped to the newest sentence. */
    | 'skipAhead';

export interface AudioCueSpec {
    id: AudioCueId;
    kind: AudioCueKind;
    beats: CueBeat[];
    /** Silence between beats. Long enough that two beats are two sounds. */
    gapMs: number;
    /**
     * Loudness relative to the volume setting, 0 to 1. A tool tick is meant to
     * sit under a sentence; a waiting pulse is meant to be found.
     */
    gain: number;
    /** Higher wins when two ambient states hold at once. Mirrors WristCue.rank. */
    rank: number;
    /** The settings row. */
    title: string;
    /** What the sound means, on the settings row and in the preview list. */
    meaning: string;
}

/**
 * Beat gap. Shorter than the wrist's 0.35s because a tone is instant and a
 * taptic is not: two beeps 0.16s apart are plainly two beeps, and a cue that
 * takes a second to play is a cue that gets in the way.
 */
export const cueBeatGap = 160;

/**
 * The table.
 *
 * Ambient first, ranked the way the wrist ranks its cues, then the events.
 *
 * The ambient split Clay asked for reads like this out loud. WORKING is one
 * long, low, soft thump every few seconds: easy to stop noticing, and the
 * thing you notice by its ABSENCE when the session dies. Every WAITING pulse
 * is short, bright and repeated on a faster clock, and its beat count is the
 * same count the wrist buzzes for that gate kind, so the two surfaces agree.
 * Long-and-slow against short-and-fast is a rhythm difference, which is what
 * survives a pocket; the pitch difference on top of it is a bonus.
 *
 * IDLE has no row here on purpose. It is the absence of a state, and silence
 * is already the correct signal for it.
 */
export const audioCues: readonly AudioCueSpec[] = [
    {
        id: 'waitingNeedsYou',
        kind: 'ambient',
        beats: [{ hz: 740, ms: 70 }, { hz: 740, ms: 70 }, { hz: 740, ms: 70 }],
        gapMs: cueBeatGap,
        gain: 0.9,
        rank: 4,
        title: 'Waiting: do something',
        meaning: 'An agent asked you to do something. Three short beeps, over and over.',
    },
    {
        id: 'waitingQuestion',
        kind: 'ambient',
        beats: [{ hz: 660, ms: 70 }, { hz: 880, ms: 70 }],
        gapMs: cueBeatGap,
        gain: 0.9,
        rank: 3,
        title: 'Waiting: question',
        meaning: 'A session is blocked on an answer. Two beeps, the second higher.',
    },
    {
        id: 'waitingPermission',
        kind: 'ambient',
        beats: [{ hz: 660, ms: 70 }],
        gapMs: cueBeatGap,
        gain: 0.85,
        rank: 2,
        title: 'Waiting: permission',
        meaning: 'A yes/no gate on an action. One short beep on the fast clock.',
    },
    {
        id: 'waitingExpiry',
        kind: 'ambient',
        beats: [{ hz: 392, ms: 90 }, { hz: 294, ms: 130 }],
        gapMs: cueBeatGap,
        gain: 0.85,
        rank: 1,
        title: 'Waiting: account limit',
        meaning: 'An account is running out of usage or auth. Two beeps, falling.',
    },
    {
        id: 'working',
        kind: 'ambient',
        beats: [{ hz: 196, ms: 190 }],
        gapMs: cueBeatGap,
        gain: 0.45,
        rank: 0,
        title: 'Working',
        meaning: 'Something is running and nothing needs you. One low thump on the slow clock.',
    },
    {
        id: 'agentStart',
        kind: 'event',
        beats: [{ hz: 523, ms: 70 }, { hz: 784, ms: 90 }],
        gapMs: 40,
        gain: 0.8,
        rank: 0,
        title: 'Agent spawned',
        meaning: 'A subagent started. Two notes, rising.',
    },
    {
        id: 'agentDone',
        kind: 'event',
        beats: [{ hz: 784, ms: 70 }, { hz: 523, ms: 90 }],
        gapMs: 40,
        gain: 0.7,
        rank: 0,
        title: 'Agent finished',
        meaning: 'A subagent came back. The same two notes, falling.',
    },
    {
        id: 'agentFailed',
        kind: 'event',
        beats: [{ hz: 233, ms: 90 }, { hz: 175, ms: 140 }],
        gapMs: 60,
        gain: 0.8,
        rank: 0,
        title: 'Agent failed',
        meaning: 'A subagent came back an error. Two low notes, falling further.',
    },
    {
        id: 'toolRun',
        kind: 'event',
        beats: [{ hz: 1046, ms: 40 }],
        gapMs: 40,
        gain: 0.35,
        rank: 0,
        title: 'Tool calls started',
        meaning: 'A run of tool calls began. One quiet tick for the run, never one per call.',
    },
    {
        id: 'skipAhead',
        kind: 'event',
        beats: [{ hz: 1046, ms: 55 }, { hz: 1568, ms: 65 }],
        gapMs: 35,
        gain: 0.6,
        rank: 0,
        title: 'Skipped ahead',
        meaning: 'Reading was behind and jumped to the newest sentence. A quick blip up.',
    },
];

const byId = new Map<AudioCueId, AudioCueSpec>(audioCues.map((cue) => [cue.id, cue]));

export function cueSpec(id: AudioCueId): AudioCueSpec {
    const spec = byId.get(id);
    // Exhaustive by construction: AudioCueId and the table are edited together
    // and audioCues.spec.ts fails the moment one grows without the other.
    if (!spec) throw new Error(`unknown audio cue ${id}`);
    return spec;
}

/** How long a cue takes to play, beats plus the gaps between them. */
export function cueDurationMs(spec: AudioCueSpec): number {
    const beats = spec.beats.reduce((total, beat) => total + beat.ms, 0);
    return beats + Math.max(0, spec.beats.length - 1) * spec.gapMs;
}

/**
 * The ambient cue a pending gate deserves, by the bus `kind` the gate carries.
 *
 * The same mapping WristCue.forGateKind makes, including its fallback: a kind
 * this build has never heard of is still something waiting on a human, so it
 * pulses as a permission rather than going quiet. Silence is the worse
 * failure, and it is the exact failure this ticket exists to end.
 */
export function ambientForGateKind(kind: string): AudioCueId {
    switch (kind) {
        case 'todo': return 'waitingNeedsYou';
        case 'question': return 'waitingQuestion';
        case 'permission': return 'waitingPermission';
        case 'expiry': return 'waitingExpiry';
        default: return 'waitingPermission';
    }
}
