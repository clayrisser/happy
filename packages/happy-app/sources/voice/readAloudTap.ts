import type { ReadAloudDetourSentence } from './readAloud';

/**
 * Tap a sentence to read from there (DROVE-146, sharpened by DROVE-163).
 *
 * Clay, first: "It will go back up if you double tap. Double tap a section and
 * that's what changes the reading, not scrolling." Then: "Whatever SENTENCE I
 * tap is where you start reading."
 *
 * This replaces DROVE-114's coupling of the chat list's visible range to the
 * reading position. That coupling was one way in each direction and still
 * managed to go wrong, because the reader could only ever be as right as the
 * last thing the list said, and a list that stops reporting is
 * indistinguishable from a user parked up in the history. So scrolling is
 * free again and the position moves on a gesture, which is a fact rather than
 * an inference.
 *
 * ONE TAP, NOT TWO, and here is why. DROVE-146 picked a double tap because the
 * target was a whole message body and a double tap kept it clear of other
 * gestures. Neither half of that still holds:
 *
 *   - The gestures are separated by TARGET, not by tap count. DROVE-149's wrap
 *     toggle is a double tap on a code or terminal card, and those are their
 *     own components nested inside the reply; a link has its own press; a hold
 *     still raises copy. A single tap on plain prose meant nothing before this,
 *     so there is nothing for it to collide with.
 *   - A double tap is the wrong gesture for a precise target anyway. Hitting
 *     the same sentence twice inside 350 ms is harder than hitting it once,
 *     and getting it wrong the second time silently moves the reading
 *     somewhere else. Precision and a repeat gesture pull against each other.
 *
 * So prose takes a single tap now, and the block-level double tap is gone with
 * it: two taps on a sentence would otherwise seek twice and then be undone by
 * a third seek to the top of the block.
 *
 * The decision is here, taking only a type from elsewhere, so all of it is
 * testable: the tap only moves the voice when read-aloud is on, and only from
 * a surface belonging to the session it is reading. A side panel showing
 * another session scrolls and is tapped on its own and must not steer the
 * voice.
 *
 * A SUBAGENT SCREEN IS SUCH A SURFACE, and DROVE-195 is what that turned out
 * to mean. It belongs to the session, so both guards pass, but its transcript
 * came from somewhere the reader has never read and its sentences are not in
 * the timeline. The sentence tap therefore missed, fell back to the block, and
 * seeked the SESSION to whatever it happened to have at that createdAt: a tap
 * that moved the reading somewhere he never pointed at. So the two are
 * separate entry points now, and the subagent's one hands its sentences over
 * rather than naming a position the reader cannot resolve.
 */
export interface ReadAloudTapTarget {
    readonly isEnabled: boolean;
    readonly focusedSessionId: string | null;
    seekTo(createdAt: number): void;
    /** True when the tapped sentence was found in the queue (DROVE-163). */
    seekToSentence(messageId: string, sentence: string): boolean;
    /** Read a transcript the reader is not following, then come back (DROVE-195). */
    readDetour(sentences: readonly ReadAloudDetourSentence[]): boolean;
}

/** Both guards, shared by the two entry points below. */
function steers(target: ReadAloudTapTarget, sessionId: string): boolean {
    if (!target.isEnabled) return false;
    if (target.focusedSessionId !== sessionId) return false;
    return true;
}

/** True when the tap moved reading. Resolves to the block (DROVE-146). */
export function readFromHere(
    target: ReadAloudTapTarget,
    sessionId: string,
    createdAt: number,
): boolean {
    if (!steers(target, sessionId)) return false;
    target.seekTo(createdAt);
    return true;
}

/**
 * True when the tap moved reading, to the sentence that was touched
 * (DROVE-163).
 *
 * Falls back to the block when the queue has no such sentence: read-aloud was
 * off when that reply landed, or the renderer shows something the speaker
 * dropped. Falling back is the DROVE-146 behaviour, so the worst case of a
 * failed hit test is the behaviour that shipped before it.
 */
export function readSentenceFromHere(
    target: ReadAloudTapTarget,
    sessionId: string,
    messageId: string,
    sentence: string,
    createdAt: number,
): boolean {
    if (!steers(target, sessionId)) return false;
    if (target.seekToSentence(messageId, sentence)) return true;
    target.seekTo(createdAt);
    return true;
}

/**
 * True when the tap moved reading into a transcript the reader is not
 * following (DROVE-195).
 *
 * The sentences are resolved by the caller, because only the surface drawing
 * that transcript has it. What is decided here is the same pair of guards the
 * session's tap gets, plus the one that is new: no sentences means there is
 * nothing under the finger to read, and the voice is left exactly where it is
 * rather than seeking to a position invented from a createdAt.
 */
export function readDetourFromHere(
    target: ReadAloudTapTarget,
    sessionId: string,
    sentences: readonly ReadAloudDetourSentence[],
): boolean {
    if (!steers(target, sessionId)) return false;
    if (sentences.length === 0) return false;
    return target.readDetour(sentences);
}
