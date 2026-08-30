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
    addListener: (
        eventName: 'onDictationPartial',
        listener: (event: { text: string }) => void,
    ) => EventSubscription;
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

export async function startDictation(localeTag?: string): Promise<boolean> {
    if (!native) throw new Error('this build has no speech module');
    return native.startDictation(localeTag ?? null);
}

export async function stopDictation(): Promise<string> {
    if (!native) return '';
    return native.stopDictation();
}

export async function cancelDictation(): Promise<void> {
    if (!native) return;
    try {
        await native.cancelDictation();
    } catch {
        // Same reasoning as stopSpeaking: tearing down must not throw.
    }
}

export function addDictationPartialListener(listener: (text: string) => void) {
    if (!native) return { remove: () => {} };
    return native.addListener('onDictationPartial', (event) => listener(event.text));
}
