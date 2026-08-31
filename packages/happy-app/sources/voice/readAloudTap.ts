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
 * TWO TAPS, NOT ONE (DROVE-235). DROVE-163 cut this down to a single tap on
 * the argument that a single tap on prose had meant nothing before, so there
 * was nothing to collide with. True, and beside the point: Clay asked for a
 * double tap twice, and a single tap on body text is the gesture a finger
 * makes by ACCIDENT. A tap to dismiss the keyboard, a tap to stop a scroll, a
 * mis-aimed tap at a link. Moving the read head is deliberate, so it costs a
 * deliberate gesture, and the cheapest gesture on the screen should stay the
 * one that does nothing.
 *
 * The collision with DROVE-149's wrap toggle is still settled by TARGET rather
 * than by count, which is why sharing the count is safe. A code or terminal
 * card is its own component and is handed no sentence press at all, so a
 * double tap inside a fence has only ever had one handler: the wrap toggle
 * keeps it. Its gesture is older and more local, and a code block is not
 * something he asks to be read from. A link keeps its own single press, and a
 * hold still raises copy.
 *
 * The block-level double tap stays gone, and that is what keeps ONE route to
 * the playhead (DROVE-146): two taps on a sentence would seek to it and then
 * be undone by a third seek to the top of the block. `readFromHere` below is
 * reached only as the sentence tap's own fallback, never from a gesture of its
 * own.
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
