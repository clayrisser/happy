/**
 * A command from a TERMINAL, applied to the phone's voice (DROVE-298).
 *
 * Clay: "I want to be able to control what's read from the CLI as well. NOT
 * that the CLI reads it, but that the CLI controls what the phone is reading —
 * what session the phone is reading."
 *
 * So the Mac never speaks. `drover read pause` posts an ask to the drover bus,
 * the bridge writes it into the bridge session's agent state, and THIS decides
 * what happens to it. The phone is the source of truth on purpose: two
 * terminals racing cannot desync the voice, because neither of them is
 * deciding anything.
 *
 * ONE RULE, TWO ENTRY POINTS. The wrist already does exactly this — DROVE-275
 * turns a watch press into `readAloud.setPaused()` in droverWatchFeed — and a
 * terminal is the third such remote, not a second policy. Nothing in this file
 * decides WHAT taking the voice means; that is `ReadingPolicy` below, which
 * DROVE-297 owns.
 *
 * WHY THE POLICY IS AN INTERFACE. DROVE-297 is landing per-session reading
 * enablement and the take-the-voice rule (navigate to an ENABLED session and
 * it takes the voice while the speaker pauses at its position; navigate to a
 * DISABLED one and nothing changes). That rule must have exactly one
 * implementation, reached identically by a thumb and by a terminal. Rather
 * than write a second copy while that lands, this file names the six questions
 * it needs answered and `livePolicy` in readingControlService.ts answers them
 * against whatever the reader can do today. When 297 lands, its per-session
 * enablement replaces livePolicy's body and NOTHING here changes.
 *
 * A REFUSAL IS AN ANSWER. Reading off on the phone, a session the app has
 * never seen, nothing currently speaking: none of those is an error, and none
 * of them is a reason to do something adjacent instead. They come back as
 * `applied: false` with a sentence, and the terminal prints that sentence.
 * Turning read-aloud ON from a terminal is the one thing that never happens
 * here — starting audio on a device in a pocket is the surprise the ticket
 * exists to refuse.
 */

/** What a terminal may ask for. Mirrors VERBS in cattle-drover's engine/reading.js. */
export type ReadingVerb = 'status' | 'on' | 'off' | 'pause' | 'resume';

export interface ReadingCommand {
    id: string;
    verb: ReadingVerb;
    /** A HAPPY session id: the bridge translates the drover id before this sees it. */
    sessionId?: string | null;
    by?: string;
    at: number;
    ttlMs: number;
}

/**
 * What a session's reader is doing, and the reason this is four values.
 *
 * `yielded` is enabled-but-silent because another session took the voice, and
 * it MUST be tellable from `off`. That distinction is the visible half of
 * DROVE-297's rule — it is what makes the behaviour legible instead of
 * mysterious, on the phone's list and in `drover read`'s table alike.
 */
export type ReadingSessionState = 'off' | 'speaking' | 'paused' | 'yielded';

export interface ReadingSessionRow {
    sessionId: string;
    enabled: boolean;
    state: ReadingSessionState;
    title?: string | null;
}

export interface ReadingSnapshot {
    global: 'on' | 'off';
    playing: boolean;
    sessionId: string | null;
    title: string | null;
    sentence: string | null;
    sessions: ReadingSessionRow[];
}

export interface ReadingVerdict {
    applied: boolean;
    reason?: string;
    state: ReadingSnapshot;
}

/**
 * The six questions applying a command needs answered, and the seam DROVE-297
 * fills. Everything here is about ONE reader with ONE voice.
 */
export interface ReadingPolicy {
    /** The phone's own read-aloud switch. Never set from a terminal. */
    globalEnabled(): boolean;
    /** The session with the voice right now, and whether it is actually speaking. */
    speaking(): { sessionId: string | null; playing: boolean; sentence: string | null };
    /** Does the app know this session at all? An unknown one is refused by name. */
    knows(sessionId: string): boolean;
    /**
     * Enable reading on this session AND give it the voice: DROVE-297's rules
     * 3 and 4. Whatever was speaking pauses AT ITS POSITION and keeps its
     * place; the arriving session resumes from its own. Never a stop, never a
     * jump ahead.
     */
    take(sessionId: string): void;
    /** Turn this session's reader off. Not a pause: `off` drops the held place. */
    disable(sessionId: string): void;
    /** The phone's own pause, holding position (DROVE-233/289). */
    setPaused(paused: boolean): void;
    /** Every session with a reading state worth reporting. */
    rows(): ReadingSessionRow[];
    titleOf(sessionId: string): string | null;
}

export function readingSnapshotOf(policy: ReadingPolicy): ReadingSnapshot {
    const now = policy.speaking();
    return {
        global: policy.globalEnabled() ? 'on' : 'off',
        playing: now.playing,
        sessionId: now.sessionId,
        title: now.sessionId ? policy.titleOf(now.sessionId) : null,
        sentence: now.sentence,
        sessions: policy.rows(),
    };
}

/**
 * Past its life, so it must not be applied.
 *
 * THE WHOLE POINT OF THE TTL. A command carries the life its terminal gave it,
 * which is that terminal's own patience to the millisecond. An app that was
 * closed when the ask went out and opens twenty minutes later must find a dead
 * letter, not an instruction — a phone that starts talking in a pocket long
 * after somebody gave up is exactly the surprise DROVE-298 was filed to
 * prevent. The bus expires it on its side; this is the same check on the side
 * that would actually make the noise.
 */
export function readingCommandExpired(cmd: ReadingCommand, now: number = Date.now()): boolean {
    if (!Number.isFinite(cmd.at) || !Number.isFinite(cmd.ttlMs) || cmd.ttlMs <= 0) return true;
    return now > cmd.at + cmd.ttlMs;
}

const OFF_REASON =
    'read aloud is off on the phone — turn it on in Settings > Voice, it is not a terminal’s to switch';

export function applyReadingCommand(
    cmd: ReadingCommand,
    policy: ReadingPolicy,
    now: number = Date.now(),
): ReadingVerdict {
    const refuse = (reason: string): ReadingVerdict => ({
        applied: false,
        reason,
        state: readingSnapshotOf(policy),
    });
    const done = (): ReadingVerdict => ({ applied: true, state: readingSnapshotOf(policy) });

    if (readingCommandExpired(cmd, now)) {
        return refuse('that ask had already expired when it got here; nothing was changed');
    }

    // `status` asks for nothing but the truth, and gets it whatever the phone
    // is set to. It is a round trip rather than a cached read because a
    // snapshot with no round trip cannot tell a phone that is awake and quiet
    // from one that has been shut for a week.
    if (cmd.verb === 'status') return done();

    if (!policy.globalEnabled()) return refuse(OFF_REASON);

    if (cmd.verb === 'on' || cmd.verb === 'off') {
        const sessionId = cmd.sessionId ?? null;
        if (!sessionId) return refuse(`\`${cmd.verb}\` names a session and this one carried none`);
        // Refused BY NAME. The terminal already refused an id the bus has never
        // heard of; this is the other half — an id the bus knows and the phone
        // does not, which happens when a session has never reached this device.
        if (!policy.knows(sessionId)) return refuse('the phone does not know that session');
        if (cmd.verb === 'on') policy.take(sessionId);
        else policy.disable(sessionId);
        return done();
    }

    const now_ = policy.speaking();
    if (cmd.verb === 'pause') {
        if (!now_.sessionId) return refuse('nothing is reading, so there is nothing to hold');
        policy.setPaused(true);
        return done();
    }
    if (cmd.verb === 'resume') {
        if (!now_.sessionId) return refuse('nothing is held, so there is nothing to carry on');
        policy.setPaused(false);
        return done();
    }
    // Unreachable through the bus, which refuses an unknown verb with 400. Here
    // so a future verb cannot be silently swallowed by this function instead.
    return refuse(`the phone does not understand \`${(cmd as { verb: string }).verb}\``);
}
