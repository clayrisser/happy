import * as React from 'react';
import type { ReadAloudPlayhead } from './readAloud';
import { readAloud } from './readAloudService';

/**
 * The queue-to-view direction of the playhead (DROVE-114).
 *
 * A row subscribes here and is told the sentence being spoken out of ITS
 * message, as a string or null. It never sees the queue, the cursor or the
 * turn numbering, so the view cannot come to depend on any of that, and the
 * value it gets is a primitive, so a row whose sentence has not changed does
 * not re-render when the voice moves on inside another message.
 */
export interface PlayheadSource {
    readonly playhead: ReadAloudPlayhead | null;
    addPlayheadListener(listener: (playhead: ReadAloudPlayhead | null) => void): () => void;
}

/** The sentence being spoken out of `messageId`, or null if it is not this one. */
export function spokenSentenceOf(
    playhead: ReadAloudPlayhead | null,
    messageId: string,
): string | null {
    if (playhead === null) return null;
    if (playhead.messageId !== messageId) return null;
    return playhead.sentence;
}

/**
 * Subscribe a row to the sentence at the engine.
 *
 * Deliberately NOT a scroll: marking the spoken sentence must never move the
 * viewport, because the viewport is what decides where reading is. A marking
 * that scrolled would seek, and the seek would move the marking.
 */
export function useSpokenSentence(messageId: string, source: PlayheadSource = readAloud): string | null {
    const subscribe = React.useCallback(
        (onChange: () => void) => source.addPlayheadListener(onChange),
        [source],
    );
    const snapshot = React.useCallback(
        () => spokenSentenceOf(source.playhead, messageId),
        [messageId, source],
    );
    return React.useSyncExternalStore(subscribe, snapshot, snapshot);
}
