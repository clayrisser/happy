import { applyVisibleRange, type VisibleRange } from './readAloudSeek';
import { readAloud } from './readAloudService';

/**
 * The view-to-queue direction of the playhead (DROVE-114): the chat list says
 * what is on screen, and that IS where reading is.
 *
 * Everything with a decision in it lives in readAloudSeek.ts, which imports
 * nothing. All this adds is the one reader the app owns, and the rule about
 * who is allowed to move it: only the session read-aloud is actually reading.
 * A second chat mounted beside it (the tablet panel, a subagent transcript)
 * scrolls on its own and must not seek the voice.
 */
export function reportVisibleRange(sessionId: string, range: VisibleRange | null): void {
    if (readAloud.focusedSessionId !== sessionId) return;
    // Reported even while read-aloud is off, so that turning it on inside a
    // transcript the user has scrolled back into starts from where they are
    // looking rather than from the bottom. With nothing queued the seek is a
    // no-op, so this costs nothing until there is something to say.
    applyVisibleRange(readAloud, range);
}
