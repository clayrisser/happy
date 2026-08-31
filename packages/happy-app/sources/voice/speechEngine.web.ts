import type { SpeakOptions, SpeechEngine } from './readAloud';

/**
 * Web read-aloud (DROVE-30). The browser's own SpeechSynthesis, which is the
 * only text-to-speech a web build has — the native module is apple-only.
 */
function synth(): SpeechSynthesis | null {
    if (typeof window === 'undefined') return null;
    return window.speechSynthesis ?? null;
}

export const speechEngine: SpeechEngine = {
    speak(text: string, options?: SpeakOptions) {
        const speech = synth();
        if (!speech) return Promise.resolve();
        return new Promise<void>((resolve) => {
            const utterance = new SpeechSynthesisUtterance(text);
            // SpeechSynthesisUtterance.rate is 1 at rest, so the queue's
            // catch-up multiplier is the rate itself here (DROVE-108).
            const aside = options?.aside === true;
            utterance.rate = Math.min(2, Math.max(0.5, (options?.rateScale ?? 1) * (aside ? 1.22 : 1)));
            // A tool-call title, not the reply (DROVE-112). Higher and faster,
            // so it is plainly a footnote.
            if (aside) utterance.pitch = 1.18;
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
