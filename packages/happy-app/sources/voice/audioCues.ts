import { cueAmplitudeFor, dbToAmplitude, morseTickDb } from './cueLoudness';

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
    /**
     * Loudness of THIS beat relative to the cue's own amplitude, 0 to 1, 1
     * unasked. Still a bare multiplier, and correctly so: it says how one beat
     * sits against the beat beside it, which is a question inside one sound.
     *
     * Added by DROVE-182, which needs one figure to hold two loudnesses: the
     * heartbeat's thump is the marker and the ticks after it are the count,
     * and the ticket's words are "the ticks are quieter and shorter than the
     * thump". A second cue would not do, because the two have to be one sound
     * with one rhythm.
     */
    gain?: number;
}

export type AudioCueKind = 'ambient' | 'event';

export type AudioCueId =
    /**
     * Working, nothing pending. The settings row for the whole family; the
     * heartbeat actually plays `working:<n>` (DROVE-182).
     */
    | 'working'
    /**
     * Working, with the subagent count said in Morse after the thump.
     * `working:0` is the thump alone (DROVE-209).
     */
    | `working:${number}`
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
    /**
     * ONE tool call started. One per CALL since DROVE-174; DROVE-112 folded a
     * run to a single tick and Clay asked for the opposite.
     */
    | 'toolCall'
    /** A reply arrived. Played before its first sentence, never over it. */
    | 'reply'
    /** The reader dropped its backlog and jumped to the newest sentence. */
    | 'skipAhead'
    /**
     * The microphone opened. Played BEFORE it opens, never over it
     * (DROVE-225).
     */
    | 'micOpen'
    /** The microphone closed and the words are in the composer (DROVE-225). */
    | 'micClosed'
    /**
     * A press that could not open the microphone (DROVE-225). The one cue
     * that exists so a press which did nothing does not SOUND like a press
     * that worked.
     */
    | 'micRefused'
    /**
     * The double press moved the voice to another session (DROVE-300).
     *
     * The skip is the one gesture whose result can be SILENCE and still be
     * correct: the session it lands on may be waiting on a reply and have
     * nothing to say for a minute. Without this the press is
     * indistinguishable from a dead button, which is the failure
     * headphonePress.ts names and the mic already spends three cues avoiding.
     */
    | 'sessionSkipped'
    /**
     * A double press with nowhere to go (DROVE-300). One session armed, or
     * none. Never a stop, and now never silent either.
     */
    | 'skipRefused';

export interface AudioCueSpec {
    id: AudioCueId;
    kind: AudioCueKind;
    beats: CueBeat[];
    /** Silence between beats. Long enough that two beats are two sounds. */
    gapMs: number;
    /**
     * PEAK AMPLITUDE the cue's samples are rendered at, 0 to 1, calibrated
     * against the voice in cueLoudness.ts (DROVE-341).
     *
     * Not a fraction of the volume setting, which is what the old `gain` was
     * and what made every cue play at the square of its intended level. The
     * setting is applied ONCE, by the player, and this is the whole of the
     * rest. Read cueGainDb for what each number claims and
     * scripts/measure-cue-loudness.sh for the check that it is true.
     */
    amplitude: number;
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
 * The heartbeat COUNTS the subagents, in Morse (DROVE-182, DROVE-209).
 *
 * Clay: "Counting for the Morse code, don't include the main thread."
 *
 * The first version of this ticket said one tick per agent, and that was the
 * weaker idea for the reason it already admitted: counting ticks past four by
 * ear does not work, which is why it had to invent a vague "roll meaning many"
 * for anything above four. Clay routinely runs eight to fifteen at once, so
 * "many" would have been the answer almost every time.
 *
 * Morse digits solve it exactly. Every digit is FIVE symbols, so the rhythm
 * stays regular whatever the number, and two digits cover everything he
 * actually runs. Rhythm is still the axis: tempo is the state (6s working
 * against 3s waiting on him) and pitch is the polish a pocket flattens.
 *
 *     1 .----   2 ..---   3 ...--   4 ....-   5 .....
 *     6 -....   7 --...   8 ---..   9 ----.   0 -----
 *
 * The 196 Hz thump stays, and its job changes slightly: it is now the MARKER
 * that a count is starting, not the main thread's own tick. Then the digits,
 * most significant first.
 *
 * THE COUNT IS SUBAGENTS ONLY. It is exactly the agent count the status row
 * draws (DROVE-155), passed straight through with no arithmetic on it, so the
 * ear and the screen say the same number and there is no offset anywhere to
 * discover. An earlier build added the main thread and that is gone, along
 * with the function that carried the +1.
 *
 * ZERO IS THE BARE THUMP, no digits. A lone session with no subagents is by
 * far the commonest state, and in Morse 0 is `-----`, five dahs, the LONGEST
 * figure on the scale. Spending the longest sound on the quietest state is
 * backwards, so zero gets the marker alone and the silence after it carries
 * "none". That is exactly what the heartbeat was before the count existed, so
 * nothing about the ordinary case changed pitch or shape; digits only appear
 * once there is something to count.
 *
 * TIMING, tuned so a digit is comfortably inside the cadence:
 *   dit 50ms, dah 150ms, one dit between symbols, three dits between digits,
 *   the thump 190ms with a 200ms gap after it.
 * So zero is 190ms, "1" (.----) is 850ms of digits and 1240ms of figure, and
 * "10" is 1950ms of digits and 2340ms of figure, the longest he will hear in
 * practice. At the default 6s cadence that leaves between 3.6 and 5.8 seconds
 * of silence after the figure, so it stays ambient rather than becoming a
 * drum machine.
 */
const morseDit = 50;
const morseDah = 150;
/** Between two symbols of one digit. One dit, as Morse has it. */
const morseSymbolGap = 50;
/** Between two digits. Three dits. */
const morseDigitGap = 150;
/** The marker that a count is starting, and the gap before the first digit. */
const countMarker: CueBeat = { hz: 196, ms: 190 };
const afterMarker: CueBeat = { hz: 0, ms: 200 };
/** The digits are quieter and shorter than the marker, as the ticket requires. */
const morseHz = 880;
const morseTickLevel = dbToAmplitude(morseTickDb);

/** Morse for one digit, `.` and `-`. Five symbols each, which is the point. */
export const morseDigits: Readonly<Record<string, string>> = {
    '0': '-----',
    '1': '.----',
    '2': '..---',
    '3': '...--',
    '4': '....-',
    '5': '.....',
    '6': '-....',
    '7': '--...',
    '8': '---..',
    '9': '----.',
};

/** The beats for a count, as Morse digits after the marker. */
export function morseBeats(count: number): CueBeat[] {
    // Zero is the marker alone: no digits, and the silence after it says
    // "none". See the note above for why 0 does not get its `-----`.
    if (count <= 0) return [countMarker];
    const beats: CueBeat[] = [countMarker, afterMarker];
    // Two digits is 99, which is far past anything real; a bigger number is
    // clamped rather than turned into a figure longer than the cadence.
    const digits = String(Math.min(99, Math.round(count)));
    for (let d = 0; d < digits.length; d++) {
        if (d > 0) beats.push({ hz: 0, ms: morseDigitGap });
        const symbols = morseDigits[digits[d]] ?? '';
        for (let i = 0; i < symbols.length; i++) {
            if (i > 0) beats.push({ hz: 0, ms: morseSymbolGap });
            beats.push({
                hz: morseHz,
                ms: symbols[i] === '-' ? morseDah : morseDit,
                gain: morseTickLevel,
            });
        }
    }
    return beats;
}

/**
 * The cue id for a count.
 *
 * A count is unbounded, so the working cues cannot all be rows in a table the
 * way every other cue is. `working:<n>` is built on demand and cached, and
 * plain `working` is the row settings shows and mutes: they are one sound with
 * one meaning and a different number in it.
 */
export function workingCueFor(count: number): AudioCueId {
    return `working:${Math.min(99, Math.max(0, Math.round(count)))}` as AudioCueId;
}

/** Every working variant is the SAME settings row; muting one mutes all. */
export function isWorkingCue(id: AudioCueId): boolean {
    return id === 'working' || id.startsWith('working:');
}

/**
 * The count inside a working cue id, or 1 for the plain row.
 *
 * The plain row is the settings entry, not a state: its preview plays ONE
 * subagent so pressing play demonstrates both halves of the sound, the thump
 * and a digit. Previewing zero would play the thump alone and teach nothing
 * about the count.
 */
export function workingCueCount(id: AudioCueId): number {
    if (!id.startsWith('working:')) return 1;
    const parsed = Number.parseInt(id.slice('working:'.length), 10);
    return Number.isFinite(parsed) ? Math.max(0, parsed) : 1;
}

function workingRow(id: AudioCueId): AudioCueSpec {
    const count = workingCueCount(id);
    return {
        id,
        kind: 'ambient',
        beats: morseBeats(count),
        // The rests inside the figure carry the spacing, so there is no
        // uniform gap on top of them.
        gapMs: 0,
        amplitude: cueAmplitudeFor('working'),
        rank: 0,
        title: 'Working',
        meaning: 'Something is running and nothing needs you. One low thump, then how many subagents are out, in Morse. The same number the status row shows. No subagents is the thump on its own.',
    };
}

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
        amplitude: cueAmplitudeFor('waitingNeedsYou'),
        rank: 4,
        title: 'Waiting: do something',
        meaning: 'An agent asked you to do something. Three short beeps, over and over.',
    },
    {
        id: 'waitingQuestion',
        kind: 'ambient',
        beats: [{ hz: 660, ms: 70 }, { hz: 880, ms: 70 }],
        gapMs: cueBeatGap,
        amplitude: cueAmplitudeFor('waitingQuestion'),
        rank: 3,
        title: 'Waiting: question',
        meaning: 'A session is blocked on an answer. Two beeps, the second higher.',
    },
    {
        id: 'waitingPermission',
        kind: 'ambient',
        beats: [{ hz: 660, ms: 70 }],
        gapMs: cueBeatGap,
        amplitude: cueAmplitudeFor('waitingPermission'),
        rank: 2,
        title: 'Waiting: permission',
        meaning: 'A yes/no gate on an action. One short beep on the fast clock.',
    },
    {
        id: 'waitingExpiry',
        kind: 'ambient',
        beats: [{ hz: 392, ms: 90 }, { hz: 294, ms: 130 }],
        gapMs: cueBeatGap,
        amplitude: cueAmplitudeFor('waitingExpiry'),
        rank: 1,
        title: 'Waiting: account limit',
        meaning: 'An account is running out of usage or auth. Two beeps, falling.',
    },
    workingRow('working'),
    {
        id: 'agentStart',
        kind: 'event',
        beats: [{ hz: 523, ms: 70 }, { hz: 784, ms: 90 }],
        gapMs: 40,
        amplitude: cueAmplitudeFor('agentStart'),
        rank: 0,
        title: 'Agent spawned',
        meaning: 'A subagent started. Two notes, rising.',
    },
    {
        id: 'agentDone',
        kind: 'event',
        beats: [{ hz: 784, ms: 70 }, { hz: 523, ms: 90 }],
        gapMs: 40,
        amplitude: cueAmplitudeFor('agentDone'),
        rank: 0,
        title: 'Agent finished',
        meaning: 'A subagent came back. The same two notes, falling.',
    },
    {
        id: 'agentFailed',
        kind: 'event',
        beats: [{ hz: 233, ms: 90 }, { hz: 175, ms: 140 }],
        gapMs: 60,
        amplitude: cueAmplitudeFor('agentFailed'),
        rank: 0,
        title: 'Agent failed',
        meaning: 'A subagent came back an error. Two low notes, falling further.',
    },
    {
        id: 'toolCall',
        kind: 'event',
        // 28ms, which is about as short as a pitched tick can be and still
        // read as a pitch rather than a click. Twenty of them in a burst take
        // well under a second of air between them and rattle (DROVE-174).
        beats: [{ hz: 1046, ms: 28 }],
        gapMs: 40,
        amplitude: cueAmplitudeFor('toolCall'),
        rank: 0,
        title: 'Tool call',
        meaning: 'A tool call started. One short quiet tick, one per call.',
    },
    {
        id: 'reply',
        kind: 'event',
        // Low and warm against agentStart's bright rise and toolCall's high
        // tick, so the three are told apart by register as well as by shape.
        beats: [{ hz: 349, ms: 55 }, { hz: 440, ms: 70 }],
        gapMs: 45,
        amplitude: cueAmplitudeFor('reply'),
        rank: 0,
        title: 'Reply arrived',
        meaning: 'A reply landed. Two soft low notes, played before its first sentence.',
    },
    {
        id: 'skipAhead',
        kind: 'event',
        beats: [{ hz: 1046, ms: 55 }, { hz: 1568, ms: 65 }],
        gapMs: 35,
        amplitude: cueAmplitudeFor('skipAhead'),
        rank: 0,
        title: 'Skipped ahead',
        meaning: 'Reading was behind and jumped to the newest sentence. A quick blip up.',
    },
    //
    // The microphone answers a press (DROVE-225).
    //
    // These three are the only cues that are a REPLY TO CLAY rather than news
    // about the agent, and they are shaped accordingly. Long beats and an
    // octave apart, so they are not mistaken for agentStart's third or
    // reply's fourth in a pocket, and the only rows in the table at 0 dB, level
    // with the voice itself (DROVE-341), because an acknowledgement he does not
    // hear is the failure the ticket exists to prevent. Rhythm still carries it
    // with the pitch thrown away: up, down, or the same note twice going
    // nowhere.
    {
        id: 'micOpen',
        kind: 'event',
        beats: [{ hz: 392, ms: 90 }, { hz: 784, ms: 110 }],
        gapMs: 30,
        amplitude: cueAmplitudeFor('micOpen'),
        rank: 0,
        title: 'Microphone opened',
        meaning: 'The mic is listening. Two notes an octave apart, rising. Played before the mic opens, so it is never in the recording.',
    },
    {
        id: 'micClosed',
        kind: 'event',
        beats: [{ hz: 784, ms: 90 }, { hz: 392, ms: 110 }],
        gapMs: 30,
        amplitude: cueAmplitudeFor('micClosed'),
        rank: 0,
        title: 'Microphone closed',
        meaning: 'The mic stopped and the words are in the composer. The same octave, falling.',
    },
    {
        id: 'micRefused',
        kind: 'event',
        beats: [{ hz: 196, ms: 120 }, { hz: 196, ms: 120 }],
        gapMs: 90,
        amplitude: cueAmplitudeFor('micRefused'),
        rank: 0,
        title: 'Microphone refused',
        meaning: 'A press that could not open the mic. The same low note twice, going nowhere.',
    },
    //
    // The double press answers too (DROVE-300).
    //
    // Replies to Clay like the three above, so the same 0 dB level with the
// voice (DROVE-341), and told
    // apart from them by BEAT COUNT: the mic speaks in twos, the skip in
    // threes. That is deliberate and it is the whole trick. A pocket flattens
    // pitch, so a fourth and a fifth two-note cue would be four and five ways
    // of saying the same thing; three beats is a different rhythm and rhythm
    // is what survives. The refusal then falls out of the same rule rather
    // than being invented: two notes going nowhere is the mic refusing, three
    // notes going nowhere is the skip refusing, and each refusal is its own
    // answer's shape with the movement taken out.
    {
        id: 'sessionSkipped',
        kind: 'event',
        beats: [{ hz: 523, ms: 60 }, { hz: 659, ms: 60 }, { hz: 784, ms: 80 }],
        gapMs: 30,
        amplitude: cueAmplitudeFor('sessionSkipped'),
        rank: 0,
        title: 'Skipped to the next session',
        meaning: 'A double press moved the voice to the next session with reading on. Three notes, climbing.',
    },
    {
        id: 'skipRefused',
        kind: 'event',
        beats: [{ hz: 196, ms: 120 }, { hz: 196, ms: 120 }, { hz: 196, ms: 120 }],
        gapMs: 90,
        amplitude: cueAmplitudeFor('skipRefused'),
        rank: 0,
        title: 'Nowhere to skip to',
        meaning: 'A double press with only one session reading, or none. The same low note three times, going nowhere.',
    },
];

const byId = new Map<AudioCueId, AudioCueSpec>(audioCues.map((cue) => [cue.id, cue]));
/** Working variants, built on demand and kept. See workingCueFor. */
const workingById = new Map<AudioCueId, AudioCueSpec>();

export function cueSpec(id: AudioCueId): AudioCueSpec {
    const spec = byId.get(id);
    if (spec) return spec;
    // A count is unbounded, so this one family is built rather than tabled.
    if (id.startsWith('working:')) {
        const built = workingById.get(id) ?? workingRow(id);
        workingById.set(id, built);
        return built;
    }
    // Exhaustive by construction otherwise: AudioCueId and the table are
    // edited together and audioCues.spec.ts fails the moment one grows
    // without the other.
    throw new Error(`unknown audio cue ${id}`);
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
