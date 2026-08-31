/**
 * Scrolling as seeking (DROVE-114).
 *
 * Clay's rule, in his words: "If I scroll down you would start reading from
 * there, so whatever you're reading is always visible. When I scroll you jump
 * down to where I scrolled, or you jump up if I scroll up." And: "Go up to
 * something you already said, and you just wait till I scroll back down."
 *
 * So there is ONE position, not two. The usual fight between auto-follow and
 * manual scrolling exists because the app keeps a reading position and a
 * viewport and has to reconcile them; here the viewport IS the reading
 * position, and the transcript is a playhead.
 *
 * This module is the whole decision, and it is a pure function of two numbers
 * and a range, so the loop it could form is provable rather than argued about:
 *
 *   - It only ever seeks to `oldestCreatedAt`, a number that comes from the
 *     LIST, never from the reader. Nothing the voice does can move it.
 *   - After a seek the position is inside the range, so the next call returns
 *     null. `decideSeek` is idempotent, and the reader's own `seekTo` is a
 *     no-op when the position does not change, so even the pathological range
 *     with no sentences in it settles instead of oscillating.
 *   - Nothing here ever scrolls. The traffic is one way: list to queue for the
 *     position, queue to row for the marking, and the marking is a background
 *     colour, which changes no layout and so reports no new viewport.
 */

/** What the chat list can see, in the createdAt ordering both sides share. */
export interface VisibleRange {
    /** The oldest message on screen: the visual TOP of the chat. */
    oldestCreatedAt: number;
    /** The newest message on screen: the visual BOTTOM of the chat. */
    newestCreatedAt: number;
    /**
     * The view is resting at the newest message, so new content keeps
     * arriving into it. There is no bound while this holds.
     */
    atLiveEdge: boolean;
}

/**
 * Where reading should move to, or null to leave it alone.
 *
 * `position` is where the voice is now (`ReadAloudReader.readPosition`): the
 * sentence at the engine, or the last one said. Null means nothing has ever
 * been read, and then a scroll starts nothing: the user moving around a
 * transcript they have not asked to hear is not a request to hear it.
 */
export function decideSeek(position: number | null, range: VisibleRange | null): number | null {
    if (range === null) return null;
    if (position === null) return null;
    // Reading is on screen. This is the case that holds right after a seek,
    // and the reason a highlight cannot chase its own tail.
    if (position >= range.oldestCreatedAt && position <= range.newestCreatedAt) return null;
    // Below the screen: the only way to get there is to scroll UP, over
    // something already said. Read it again, from the top of the screen.
    if (position > range.newestCreatedAt) return range.oldestCreatedAt;
    // Above the screen, and here the two ways of getting there part company.
    // While the list is resting at the newest message it is FOLLOWING the
    // reply, not being scrolled: the voice is simply slower than the writing,
    // which is DROVE-108's problem and is answered there by reading faster and
    // saying "skipping ahead" out loud. Seeking here would cut a reply silently
    // in the middle, which is the exact thing DROVE-108 stopped doing.
    if (range.atLiveEdge) return null;
    // Scrolled down and stopped short of the bottom: read from what is now
    // visible. A fling to the bottom goes through this case on the way, so it
    // lands with the voice at the bottom too.
    return range.oldestCreatedAt;
}

/**
 * How far reading may run, or null for no bound.
 *
 * At the live edge there is no bound: the list is already following the
 * newest message, so anything that arrives is on screen by the time it could
 * be said. Parked anywhere else, the bottom of the screen is the end of what
 * may be read, which is what makes new content wait rather than drag the
 * voice (and the eye) down to it.
 */
export function decideBound(range: VisibleRange | null): number | null {
    if (range === null) return null;
    if (range.atLiveEdge) return null;
    return range.newestCreatedAt;
}

/**
 * What the queue looks like from the list's side. Only these three things, so
 * the wiring below can be tested without a synthesiser or a renderer.
 */
export interface PlayheadTarget {
    readonly readPosition: number | null;
    seekTo(createdAt: number): void;
    setReadableThrough(createdAt: number | null): void;
}

/**
 * Hand one viewport to the queue.
 *
 * The order is not arbitrary. The SEEK goes first, so the position is right
 * before the bound is allowed to release any speech; the other way round, a
 * scroll would get a syllable of the sentence it is scrolling away from.
 */
export function applyVisibleRange(target: PlayheadTarget, range: VisibleRange | null): void {
    const seek = decideSeek(target.readPosition, range);
    if (seek !== null) target.seekTo(seek);
    target.setReadableThrough(decideBound(range));
}
