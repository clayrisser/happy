/**
 * Double tap a section to read from there (DROVE-146).
 *
 * Clay: "It will go back up if you double tap. Double tap a section and
 * that's what changes the reading, not scrolling."
 *
 * This replaces DROVE-114's coupling of the chat list's visible range to the
 * reading position. That coupling was one way in each direction and still
 * managed to go wrong, because the reader could only ever be as right as the
 * last thing the list said, and a list that stops reporting is
 * indistinguishable from a user parked up in the history. So scrolling is
 * free again and the position moves on a gesture, which is a fact rather than
 * an inference.
 *
 * The decision is here, importing nothing, so both guards are testable: the
 * tap only moves the voice when read-aloud is on, and only from the surface it
 * is reading. A subagent transcript or a side panel scrolls and is tapped on
 * its own and must not steer the session's voice.
 */
export interface ReadAloudTapTarget {
    readonly isEnabled: boolean;
    readonly focusedSessionId: string | null;
    seekTo(createdAt: number): void;
}

/** True when the tap moved reading. */
export function readFromHere(
    target: ReadAloudTapTarget,
    sessionId: string,
    createdAt: number,
): boolean {
    if (!target.isEnabled) return false;
    if (target.focusedSessionId !== sessionId) return false;
    target.seekTo(createdAt);
    return true;
}
