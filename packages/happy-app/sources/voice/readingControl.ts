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
 * WHY THE POLICY IS AN INTERFACE. The rule itself is DROVE-297's
 * `voiceMove()` in readingVoice.ts, carried out by the reader's
 * `setSessionEnabled` / `visit`. This file holds NO copy of it: it turns a
 * terminal's verb into one of those calls, checks the three things a terminal
 * must never cause, and reports what the phone says. The interface is what
 * lets that be tested without a reader, and what makes the two entry points
 * visibly one — a thumb on the composer control and `drover read <session>`
 * both end in `setEnabled`, which is `setSessionEnabled`, which is
 * `voiceMove`.
 *
 * A REFUSAL IS AN ANSWER. Reading off on the phone, a session the app has
 * never seen, nothing currently speaking: none of those is an error, and none
 * of them is a reason to do something adjacent instead. They come back as
 * `applied: false` with a sentence, and the terminal prints that sentence.
 * Turning read-aloud ON from a terminal is the one thing that never happens
 * here — starting audio on a device in a pocket is the surprise the ticket
 * exists to refuse.
 */

import type { ReadingReport, ReadingSessionState } from './readingVoice';

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
 * What a session's reader is doing. DROVE-297's four values, imported rather
 * than restated: `yielded` is enabled-but-silent because another session took
 * the voice, and it MUST be tellable from `off`. That distinction is the
 * visible half of the rule, and it has to mean the same thing on the phone's
 * list and in `drover read`'s table or the terminal is describing a different
 * feature.
 */
export type { ReadingSessionState } from './readingVoice';

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
 * The reader, as this file needs to ask it. Every member is a call DROVE-297
 * already exports; nothing here is a rule of its own.
 */
export interface ReadingPolicy {
    /** DROVE-297's `readAloud.readingReport()`: what is speaking, and the default. */
    report(): ReadingReport;
    /** Does the app know this session at all? An unknown one is refused by name. */
    knows(sessionId: string): boolean;
    /** `readAloud.isSessionEnabled` — is this one armed? */
    isEnabled(sessionId: string): boolean;
    /**
     * `readAloud.setSessionEnabled`, which is `voiceMove`. THE RULE IS THERE
     * AND ONLY THERE: enabling takes the voice and whoever had it pauses at
     * its position; disabling releases it and starts nothing else talking.
     * This file only chooses which of the two to ask for.
     */
    setEnabled(sessionId: string, enabled: boolean): void;
    /** The phone's own pause, holding position (DROVE-233/289). */
    setPaused(paused: boolean): void;
    /** Every session with a reading state worth reporting. */
    rows(): ReadingSessionRow[];
    titleOf(sessionId: string): string | null;
}

export function readingSnapshotOf(policy: ReadingPolicy): ReadingSnapshot {
    const now = policy.report();
    return {
        // The phone's DEFAULT, which is what `drover read` calls "off on the
        // phone". Per-session arming lives in the rows below, where it belongs
        // now that enablement is per session (DROVE-297).
        global: now.defaultEnabled ? 'on' : 'off',
        playing: now.state === 'reading',
        sessionId: now.session,
        title: now.session ? policy.titleOf(now.session) : null,
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

    if (cmd.verb === 'on' || cmd.verb === 'off') {
        const sessionId = cmd.sessionId ?? null;
        if (!sessionId) return refuse(`\`${cmd.verb}\` names a session and this one carried none`);
        // Refused BY NAME. The terminal already refused an id the bus has never
        // heard of; this is the other half — an id the bus knows and the phone
        // does not, which happens when a session has never reached this device.
        if (!policy.knows(sessionId)) return refuse('the phone does not know that session');
        if (cmd.verb === 'off') {
            policy.setEnabled(sessionId, false);
            return done();
        }
        // THE ONE GATE ON `on`, and the reason DROVE-297 put `defaultEnabled`
        // on its report. Arming a session a terminal names is arming a session
        // — fine, and invariant 4 says it takes the voice. Arming one on a
        // phone whose read-aloud is off ENTIRELY is starting audio in his
        // pocket from a Mac, which is the surprise this ticket refuses. An
        // already-armed session is untouched by the gate: turning it on by
        // hand was his decision and the terminal is only moving the voice.
        if (!policy.report().defaultEnabled && !policy.isEnabled(sessionId)) return refuse(OFF_REASON);
        policy.setEnabled(sessionId, true);
        return done();
    }

    // pause and resume act on THE VOICE, of which there is one. They are not
    // gated on the default: a session he armed by hand on a phone whose
    // default is off is still speaking, and refusing to hold it would be
    // refusing the one thing that makes something quieter.
    const holder = policy.report().session;
    if (cmd.verb === 'pause') {
        if (!holder) return refuse('nothing is reading, so there is nothing to hold');
        policy.setPaused(true);
        return done();
    }
    if (cmd.verb === 'resume') {
        if (!holder) return refuse('nothing is held, so there is nothing to carry on');
        policy.setPaused(false);
        return done();
    }
    // Unreachable through the bus, which refuses an unknown verb with 400. Here
    // so a future verb cannot be silently swallowed by this function instead.
    return refuse(`the phone does not understand \`${(cmd as { verb: string }).verb}\``);
}
