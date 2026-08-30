import { isDroverSpeechAvailable, speakUtterance, stopSpeaking } from 'drover-speech';
import type { SpeechEngine } from './readAloud';

/**
 * Native speech engine for read-aloud (DROVE-30).
 *
 * Thin on purpose: everything about WHAT to say lives in speakable.ts and
 * everything about WHEN lives in readAloud.ts, so swapping AVSpeechSynthesizer
 * for a cloud voice later is a change to this file alone.
 */
export const speechEngine: SpeechEngine = {
    speak(text: string) {
        return speakUtterance(text);
    },
    stop() {
        return stopSpeaking();
    },
};

/** False on a build with no native speech module — Android today. */
export const canReadAloud = (): boolean => isDroverSpeechAvailable();
