import { requireOptionalNativeModule, type EventSubscription } from 'expo-modules-core';

/**
 * On-device speech out and speech in for Cattle Drover (DROVE-30).
 *
 * Apple only, and optional: Android, web and any build made before this module
 * existed still import this file, and a missing native module is not an error,
 * it is "this device cannot talk". Callers ask `isDroverSpeechAvailable()`
 * rather than checking Platform.
 */

export interface DictationSupport {
    /** The device can transcribe locally, with no audio leaving it. */
    supported: boolean;
    /** The recogniser is reachable right now (it can be busy or offline). */
    available?: boolean;
    locale?: string;
    /** Why not, when `supported` is false — shown to the user verbatim. */
    reason?: string;
}

type DroverSpeechModuleType = {
    /** Resolves true when the utterance was spoken to the end, false when cut. */
    speak: (text: string, rate: number) => Promise<boolean>;
    stop: () => Promise<void>;
    isSpeaking: () => boolean;
    dictationSupport: (localeTag: string | null) => Promise<DictationSupport>;
    startDictation: (localeTag: string | null) => Promise<boolean>;
    /** Resolves with the final transcript. */
    stopDictation: () => Promise<string>;
    cancelDictation: () => Promise<void>;
    addListener: {
        (eventName: 'onDictationPartial', listener: (event: { text: string }) => void): EventSubscription;
        /** The recogniser stopped with no stop pending (DROVE-30). Build 10 and later. */
        (eventName: 'onDictationEnded', listener: (event: { text: string; reason: string }) => void): EventSubscription;
        /** Input RMS 0..1 per PCM buffer, at most 20 a second (DROVE-74). Build 10 and later. */
        (eventName: 'onDictationLevel', listener: (event: { level: number }) => void): EventSubscription;
    };
};

const native = requireOptionalNativeModule<DroverSpeechModuleType>('DroverSpeech');

export const isDroverSpeechAvailable = () => native !== null;

/**
 * AVSpeechUtteranceDefaultSpeechRate is 0.5 and reads slower than most people
 * want for prose they are half-listening to. Measured by ear, not by spec.
 */
export const defaultSpeechRate = 0.52;

export async function speakUtterance(text: string, rate = defaultSpeechRate): Promise<boolean> {
    if (!native) return false;
    return native.speak(text, rate);
}

export async function stopSpeaking(): Promise<void> {
    if (!native) return;
    try {
        await native.stop();
    } catch {
        // Stopping is best-effort by nature: the synthesiser may already have
        // finished, and a throw here would take down whatever interrupted it.
    }
}

export function isSpeaking(): boolean {
    if (!native) return false;
    try {
        return native.isSpeaking();
    } catch {
        return false;
    }
}

export async function getDictationSupport(localeTag?: string): Promise<DictationSupport> {
    if (!native) return { supported: false, reason: 'this build has no speech module' };
    try {
        return await native.dictationSupport(localeTag ?? null);
    } catch (error) {
        return { supported: false, reason: String(error) };
    }
}

/**
 * The one dictation in flight, from the start call until stop or cancel
 * settles. Native runs its permission prompts asynchronously, so a second
 * press in that window used to reach it as a second start; native now rejects
 * that, but a rejection there reads to the composer as a mic that failed when
 * it is in fact live. So the second start joins the first instead, and a stop
 * that arrives before the start has settled waits for it, so the microphone
 * it stops is the one that was actually opened (DROVE-96).
 */
let dictationInFlight: Promise<boolean> | null = null;

export async function startDictation(localeTag?: string): Promise<boolean> {
    if (!native) throw new Error('this build has no speech module');
    if (dictationInFlight) return dictationInFlight;
    const started = native.startDictation(localeTag ?? null);
    dictationInFlight = started;
    try {
        return await started;
    } catch (error) {
        if (dictationInFlight === started) dictationInFlight = null;
        throw error;
    }
}

/** Let a pending start settle before acting on it; its failure is its own. */
async function awaitDictationStart(): Promise<void> {
    const pending = dictationInFlight;
    if (!pending) return;
    try {
        await pending;
    } catch {
        // A start that failed has nothing to stop; the caller carries on.
    }
}

export async function stopDictation(): Promise<string> {
    if (!native) return '';
    await awaitDictationStart();
    try {
        return await native.stopDictation();
    } finally {
        dictationInFlight = null;
    }
}

export async function cancelDictation(): Promise<void> {
    if (!native) return;
    await awaitDictationStart();
    try {
        await native.cancelDictation();
    } catch {
        // Same reasoning as stopSpeaking: tearing down must not throw.
    } finally {
        dictationInFlight = null;
    }
}

export function addDictationPartialListener(listener: (text: string) => void) {
    if (!native) return { remove: () => {} };
    return native.addListener('onDictationPartial', (event) => listener(event.text));
}

/**
 * The recogniser stopped on its own, Apple finalised after a long silence
 * or gave up with "no speech detected", while nobody had asked it to
 * (DROVE-30). A latched mic has to hear this, or it sits there looking live
 * over a dead task until its idle clock runs out. A binary whose module
 * predates the event simply never fires it; subscribing costs nothing.
 */
export function addDictationEndedListener(listener: (text: string, reason: string) => void) {
    if (!native) return { remove: () => {} };
    try {
        return native.addListener('onDictationEnded', (event) => listener(event.text, event.reason));
    } catch {
        return { remove: () => {} };
    }
}

/**
 * The input level while dictation runs, for the waveform (DROVE-74). Raw RMS
 * of each PCM buffer in 0..1, throttled to twenty a second in the tap. On a
 * build without the event nothing arrives and the strip stays a flat line,
 * which is the honest picture: it means "no level is being measured", not
 * "you are silent".
 */
export function addDictationLevelListener(listener: (level: number) => void) {
    if (!native) return { remove: () => {} };
    try {
        return native.addListener('onDictationLevel', (event) => listener(event.level));
    } catch {
        return { remove: () => {} };
    }
}
