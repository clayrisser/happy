/**
 * Who has the voice, and what a navigation or a toggle does to it (DROVE-297).
 *
 * Clay, stating the rule: "when I go to the phone and enable reading it pauses
 * all the other ones that are reading. More specifically, when you simply
 * navigate to another session, IF ITS READING IS ENABLED it switches to it and
 * pauses the other ones that are reading — but if it's not actively having
 * reading enabled, it does NOT pause what's currently reading."
 *
 * The plural is loose speech: there is one speaker on the phone, so there is
 * at most one session to pause. What the rule actually says is that ENABLEMENT
 * IS PER SESSION and the voice is TAKEN rather than followed. Navigation alone
 * silences nothing.
 *
 * This file is the whole rule and nothing else. It is pure because it has two
 * entry points that must not drift: the thumb (navigating, or the composer's
 * read-aloud control) and the terminal (DROVE-298's `drover read`, which steers
 * the phone's voice from the Mac). One rule, two callers, one function.
 *
 * It deliberately knows nothing about the reader: not the timeline, not the
 * held positions, not the engine. It answers "does the voice move, and off
 * whom", and `ReadAloudReader.applyMove` carries that out with the machinery
 * DROVE-289 already built.
 */

/** What happened to a session. */
export type ReadingRequest =
    /** He navigated to it, or the CLI asked for it by name. */
    | 'visit'
    /** Its reading was switched on. */
    | 'enable'
    /** Its reading was switched off. */
    | 'disable';

export interface ReadingVoice {
    /**
     * The session the voice is on RIGHT NOW, or null when nothing is reading.
     * Holding the voice includes being paused at a position: a paused session
     * has not given the voice up, it is holding it still.
     */
    readonly holder: string | null;
    /** The session the request is about. */
    readonly session: string;
    /**
     * Is reading enabled on `session`, as it stands BEFORE the request is
     * applied. For 'enable' and 'disable' this is the old value, which is why
     * a redundant toggle can be told from a real one.
     */
    readonly enabled: boolean;
}

/**
 * What the voice does about it.
 *
 * `take` is the whole feature: the session named gets the voice, and whoever
 * had it — `yielding` — pauses AT ITS POSITION. That pause is DROVE-233's,
 * taken per session by DROVE-289: nothing advances, nothing is dropped, and
 * coming back resumes on the same sentence. Never a stop, never a jump-ahead.
 */
export type VoiceMove =
    | { readonly kind: 'take'; readonly session: string; readonly yielding: string | null }
    | { readonly kind: 'release'; readonly session: string }
    | { readonly kind: 'keep' };

const keep: VoiceMove = { kind: 'keep' };

/**
 * The rule, in six lines.
 *
 * - DISABLE: only the session that HAS the voice gives it up, and giving it up
 *   is a release — the voice goes quiet and nothing else claims it. Turning one
 *   session off must not start another one talking; that would be audio nobody
 *   asked for, which is the failure this whole area keeps circling.
 * - ENABLE: takes the voice, wherever the request came from. This is invariant
 *   4 — "enabling reading on a session takes the voice the same way navigating
 *   to an enabled one does" — and it is what makes DROVE-298's `drover read
 *   <session>` mean something from a terminal.
 * - VISIT: takes the voice only if the target's reading is already enabled.
 *   Otherwise NOTHING happens, and that "nothing" is the point of the ticket:
 *   walking into a session he has not armed must not silence the one he is
 *   listening to.
 *
 * A visit can never release. Navigation alone silences nothing, so a visit to a
 * session whose reading is off is `keep` even in the impossible case where that
 * session somehow still held the voice.
 */
export function voiceMove(request: ReadingRequest, voice: ReadingVoice): VoiceMove {
    const { holder, session, enabled } = voice;
    if (request === 'disable') {
        return holder === session ? { kind: 'release', session } : keep;
    }
    if (request === 'visit' && !enabled) return keep;
    if (holder === session) return keep;
    return { kind: 'take', session, yielding: holder };
}

/**
 * What the session list draws, and what the composer's capsule shows.
 *
 * The visible half of the rule, and half the feature: a session that is armed
 * but has yielded the voice must not look the same as one that is switched off,
 * or the behaviour is mysterious rather than legible.
 *
 * - `off` — its reading is not enabled. Nothing will ever be said out of it
 *   until he turns it on.
 * - `reading` — it has the voice and is using it.
 * - `paused` — it has the voice and HE is holding it (DROVE-233's long press,
 *   a headphone squeeze, the lock screen). Only his gesture lifts it.
 * - `yielded` — armed, but another session has the voice. It keeps its place;
 *   returning to it resumes there.
 *
 * `paused` and `yielded` are both "amber, holding a position". They are told
 * apart because only one of them is HIS pause, and only that one survives a
 * return to the session.
 */
export type ReadingSessionState = 'off' | 'reading' | 'paused' | 'yielded';

export interface ReadingSessionFacts {
    readonly session: string;
    readonly holder: string | null;
    /** Is reading enabled on this session? */
    readonly enabled: boolean;
    /** Is the voice held by his own gesture? Only ever asked of the holder. */
    readonly paused: boolean;
}

export function readingSessionState(facts: ReadingSessionFacts): ReadingSessionState {
    if (!facts.enabled) return 'off';
    if (facts.holder !== facts.session) return 'yielded';
    return facts.paused ? 'paused' : 'reading';
}

/** Is anything at all going to be said out of this session? For the list. */
export function readingSessionArmed(state: ReadingSessionState): boolean {
    return state !== 'off';
}

/**
 * What the phone is reading right now, as one answer (DROVE-297, for
 * DROVE-298).
 *
 * `drover read` with no argument asks this and prints it, and it is a READ:
 * the phone is the single source of truth for what is speaking, so the CLI
 * asks and reports rather than keeping a picture of its own that two terminals
 * could race into disagreement.
 *
 * `defaultEnabled` is here for the terminal's third edge case: reading being
 * off by default is a thing to REPORT, not to quietly fix. Enabling audio on a
 * phone in his pocket from a Mac is a surprise, and surprises with audio are
 * the thing he has complained about all the way through this area.
 */
export interface ReadingReport {
    /** The session actually speaking or holding a place. Null when none is. */
    readonly session: string | null;
    /** `off` exactly when `session` is null. */
    readonly state: ReadingSessionState;
    /** The sentence at the synthesiser, or null between two of them. */
    readonly sentence: string | null;
    /** Does a session nobody has switched read at all? */
    readonly defaultEnabled: boolean;
}
