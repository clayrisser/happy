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
 *
 * A MESSAGE FROM BEFORE THE READER WAS ON is the session's own version of
 * that hole (DROVE-285). Clay: "when I scroll up and double tap because I
 * wanted it to go read something to me from the past, it doesn't read it."
 * The transcript is fetched once, mostly before the toggle, and `onHistory`
 * drops what goes past while the reader is off — so the tapped sentence was
 * not in the timeline, and the fallback seeked past the whole of history to
 * the live head. Both session taps therefore ensure the transcript from the
 * tap forward is ingested before they seek: pointing at it is the ask, the
 * ingest arrives marked spoken so it alone says nothing, and scrolling
 * without the gesture stays as silent as DROVE-226 demands.
 */
export interface ReadAloudTapTarget {
    readonly isEnabled: boolean;
    /** He paused it and it is holding its place (DROVE-233). */
    readonly isPaused: boolean;
    readonly focusedSessionId: string | null;
    /** A tap is an instruction to read, so it lifts a pause (DROVE-275). */
    setPaused(paused: boolean): void;
    /**
     * Pull the transcript at or after `createdAt` into the timeline before
     * the seek runs (DROVE-285). A message from before the reader was on was
     * never ingested, so the tap on it resolved to nothing; pointing at it is
     * the ask, and the ingest arrives marked spoken so it alone says nothing.
     */
    ensureHistoryFrom(createdAt: number): void;
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

/**
 * A tap on a sentence LIFTS A PAUSE (DROVE-275).
 *
 * What it did before is the bug, and it was silent, which is why it survived:
 * `steers` asked whether read-aloud was ON and never whether it was PAUSED, so
 * a double tap while paused ran the whole seek — cleared `spoken` from the
 * tapped sentence on, moved the cursor, cut the utterance — and then hit
 * `pump`, which returns immediately while paused. Nothing was said. The
 * gesture reported success, the tap was banked as used, and the place he had
 * paused on was gone. Two deliberate taps, no sound, and a lost position.
 *
 * Resuming is the answer rather than refusing, because it is what the gesture
 * MEANS. DROVE-146 settled that a deliberate tap is the one route to the
 * playhead; a tap is therefore "read from HERE", and a player that seeks on a
 * tap and then sits there paused is not a player anyone recognises. Every
 * audio app in the world starts playing when you touch a chapter.
 *
 * AFTER THE SEEK, never before. `setPaused(false)` pumps, so lifting the pause
 * first would speak a sentence from the OLD cursor before the seek moved it —
 * a word or two of the wrong place on every tap. Seeking first leaves `pump`
 * to no-op against the pause, and the resume then starts at the sentence he
 * actually touched.
 */
function resumeForTap(target: ReadAloudTapTarget): void {
    if (!target.isPaused) return;
    target.setPaused(false);
}

/** True when the tap moved reading. Resolves to the block (DROVE-146). */
export function readFromHere(
    target: ReadAloudTapTarget,
    sessionId: string,
    createdAt: number,
): boolean {
    if (!steers(target, sessionId)) return false;
    target.ensureHistoryFrom(createdAt);
    target.seekTo(createdAt);
    resumeForTap(target);
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
    // BEFORE the lookup, not as its fallback (DROVE-285). A sentence from
    // before the reader was on is not in the timeline to be found, and the
    // block fallback would then seek a timeline whose every entry is newer
    // than the tap — landing on the live head instead of the past he pointed
    // at, or on nothing at all. Ingesting first also keeps this ONE lookup:
    // the guards above already passed, so the tap is going to move reading
    // regardless, and the only question left is how precisely it lands.
    target.ensureHistoryFrom(createdAt);
    if (target.seekToSentence(messageId, sentence)) {
        resumeForTap(target);
        return true;
    }
    target.seekTo(createdAt);
    resumeForTap(target);
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
    if (!target.readDetour(sentences)) return false;
    // Same rule as the session's tap, and the same reason: a detour the reader
    // takes and then does not speak is the paused seek's silence wearing a
    // different name (DROVE-275).
    resumeForTap(target);
    return true;
}
