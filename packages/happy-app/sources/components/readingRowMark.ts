import type { AudioOutFill, AudioOutGlyph } from './composerAudioOut';
import type { ReadingSessionState } from '@/voice/readingVoice';

/**
 * The reading mark on a session row (DROVE-297).
 *
 * THE VISIBLE HALF OF THE RULE, and half the feature. Reading is per session
 * now and the voice is taken rather than followed, so a session can be armed
 * and silent because another one has the voice. A list that drew that the same
 * as switched-off would make the whole behaviour mysterious: he would turn
 * reading on in three sessions, hear one of them, and have no way to tell the
 * other two apart from the twenty that are off.
 *
 * NO NEW VOCABULARY. The glyph and the fill are `composerAudioOut`'s own, so
 * the mark on the row and the capsule inside the session cannot come to mean
 * different things — the same failure the whole voice directory is written
 * against. Each carrier answers exactly one question, which is DROVE-215's
 * rule and DROVE-236's reading of it:
 *
 *   THE GLYPH says whether it WILL speak. A speaker means yes, when its turn
 *   comes. Pause bars mean he stopped it and only his gesture starts it again.
 *   THE FILL says whether it IS speaking. Accent for the one session with the
 *   voice, DROVE-258's amber for one holding a place.
 *
 *     off       nothing drawn
 *     reading   speaker,  accent   — this is the voice
 *     yielded   speaker,  amber    — armed, another session took the voice
 *     paused    pause bars, amber  — HE is holding it (DROVE-233)
 *
 * OFF DRAWS NOTHING rather than a slashed speaker. Almost every row is off
 * almost all the time, and a mark on all of them is noise that says nothing —
 * the same argument that keeps a permanent hue off a control holding a value.
 */
export interface ReadingRowMark {
    readonly glyph: AudioOutGlyph;
    readonly fill: AudioOutFill;
    /** Which of the three the row is announcing, for the screen reader. */
    readonly state: Exclude<ReadingSessionState, 'off'>;
}

export function readingRowMark(state: ReadingSessionState): ReadingRowMark | null {
    if (state === 'off') return null;
    if (state === 'reading') return { glyph: 'volume-high', fill: 'accent', state };
    if (state === 'yielded') return { glyph: 'volume-high', fill: 'paused', state };
    return { glyph: 'pause', fill: 'paused', state };
}

/**
 * What a screen reader says. Three distinct lines, because the whole point of
 * the mark is that these three are not the same thing.
 */
export function readingRowMarkLabel(mark: ReadingRowMark): string {
    if (mark.state === 'reading') return 'Reading aloud';
    if (mark.state === 'yielded') return 'Reading on, another session has the voice';
    return 'Reading paused';
}
