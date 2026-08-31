import type { SpeakOptions, SpeechEngine } from './readAloud';

/**
 * The engine, wrapped so the cue mixer knows when the voice has the route
 * (DROVE-112).
 *
 * This is the whole of "speech always wins". The mixer holds a boolean and
 * this is the only thing that sets it, because this is the only place that
 * sees the exact edges of an utterance: the reader's `isSpeaking` is a
 * property somebody has to remember to poll, and the playhead goes null in
 * gaps that are not silence.
 *
 * `depth` rather than a boolean because a straggler from before a cut settles
 * under the next utterance often enough that a plain flag would clear the
 * route while the voice was still talking. Counting can only be wrong for as
 * long as an orphan promise takes to settle, and it errs towards quiet.
 */

export interface SpeechWatcher {
    setSpeaking: (speaking: boolean) => void;
}

export function createCuedSpeechEngine(inner: SpeechEngine, watcher: SpeechWatcher): SpeechEngine {
    let depth = 0;
    const enter = () => {
        depth += 1;
        if (depth === 1) watcher.setSpeaking(true);
    };
    const leave = () => {
        depth = Math.max(0, depth - 1);
        if (depth === 0) watcher.setSpeaking(false);
    };
    return {
        async speak(text: string, options?: SpeakOptions) {
            enter();
            try {
                return await inner.speak(text, options);
            } finally {
                leave();
            }
        },
        stop() {
            // Not counted down here: the utterance's own promise settles on a
            // stop and does the leaving. Doing it twice would let a cue start
            // over a second utterance that had already begun.
            return inner.stop();
        },
    };
}
