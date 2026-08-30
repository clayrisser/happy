import type { SpeechEngine } from './readAloud';

/**
 * Web read-aloud (DROVE-30). The browser's own SpeechSynthesis, which is the
 * only text-to-speech a web build has — the native module is apple-only.
 */
function synth(): SpeechSynthesis | null {
    if (typeof window === 'undefined') return null;
    return window.speechSynthesis ?? null;
}

export const speechEngine: SpeechEngine = {
    speak(text: string) {
        const speech = synth();
        if (!speech) return Promise.resolve();
        return new Promise<void>((resolve) => {
            const utterance = new SpeechSynthesisUtterance(text);
            // Both fire exactly once, and `cancel()` produces `error`, so a
            // stopped utterance settles instead of hanging the queue forever.
            utterance.onend = () => resolve();
            utterance.onerror = () => resolve();
            speech.speak(utterance);
        });
    },
    stop() {
        synth()?.cancel();
    },
};

export const canReadAloud = (): boolean => synth() !== null;
