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

/** How good a voice sounds, in the order iOS ranks them (DROVE-97). */
export type SpeechVoiceQuality = 'default' | 'enhanced' | 'premium';

/** One installed synthesiser voice, as `listVoices()` reports it. */
export interface SpeechVoice {
    /** Stable across launches; what the setting stores. */
    identifier: string;
    name: string;
    /** BCP 47 tag as iOS reports it, e.g. `en-US`. */
    language: string;
    quality: SpeechVoiceQuality;
    /** A Personal Voice the user recorded (iOS 17+). */
    personal?: boolean;
}

export interface SpeakOptions {
    /** 0 to 1, AVSpeechUtterance.rate; 0.5 is the platform default. */
    rate?: number;
    /** 0.5 to 2.0, AVSpeechUtterance.pitchMultiplier. */
    pitch?: number;
    /**
     * A voice identifier from `listVoices()`. Native falls back to the best
     * installed voice for `language` when this is unset or not installed.
     */
    voiceId?: string | null;
    /** BCP 47 tag the text is in; drives the native fallback pick. */
    language?: string | null;
}

type NativeSpeakOptions = {
    rate: number;
    pitch: number;
    voiceId: string | null;
    language: string | null;
};

type DroverSpeechModuleType = {
    /** Resolves true when the utterance was spoken to the end, false when cut. */
    speak: (text: string, options: NativeSpeakOptions) => Promise<boolean>;
    listVoices: () => Promise<SpeechVoice[]>;
    stop: () => Promise<void>;
    isSpeaking: () => boolean;
    /**
     * Optional: builds up to 11 have no such function. The output port types
     * of the current audio route, as AVAudioSession names them (DROVE-92).
     */
    audioRoute?: () => string[];
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

export const defaultSpeechPitch = 1.0;

export async function speakUtterance(text: string, options: SpeakOptions = {}): Promise<boolean> {
    if (!native) return false;
    return native.speak(text, {
        rate: options.rate ?? defaultSpeechRate,
        pitch: options.pitch ?? defaultSpeechPitch,
        voiceId: options.voiceId ?? null,
        language: options.language ?? null,
    });
}

/**
 * Every voice installed on the device, in no particular order. Empty on a
 * build with no speech module, so a caller that finds nothing offers the
 * platform default rather than an error.
 */
export async function listVoices(): Promise<SpeechVoice[]> {
    if (!native) return [];
    try {
        return await native.listVoices();
    } catch {
        return [];
    }
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

/**
 * AVAudioSession port types that mean something is in or on the ears
 * (DROVE-92). Wired ("Headphones", USB-C), and the three Bluetooth profiles
 * AirPods and the like show up as. A car stereo, AirPlay and the built-in
 * speaker are routes, but not headphones, and the watch rule is about
 * headphones: Apple plays audio on the device the headphones are paired to.
 */
export const headphonePortTypes = [
    'Headphones',
    'BluetoothA2DPOutput',
    'BluetoothHFP',
    'BluetoothLE',
    'USBAudio',
] as const;

/** Whether a list of output port types, as `audioRoute()` returns them, has headphones in it. */
export function routeHasHeadphones(ports: readonly string[]): boolean {
    return ports.some((port) => (headphonePortTypes as readonly string[]).includes(port));
}

/**
 * The output port types of the phone's current audio route. Empty on a build
 * without the function, which reads as "no headphones" and so keeps speech
 * on the phone, which is what every build before this did.
 */
export function audioRoute(): string[] {
    if (!native || typeof native.audioRoute !== 'function') return [];
    try {
        return native.audioRoute();
    } catch {
        return [];
    }
}

/**
 * Whether the native module can REPORT on a dictation while it runs: the
 * partial transcripts the composer fills from, and the `onDictationEnded`
 * that says Apple finalised on its own (DROVE-105).
 *
 * There is no way to ask a module which events it declares, so this reads
 * the build stamp that IS visible from JS: `audioRoute()` shipped in the
 * same binary as `onDictationEnded` and `onDictationLevel` (TestFlight build
 * 12, DROVE-92 landing beside DROVE-74), and no earlier build has it. A
 * module without it is build 11 or older, where a latched mic sits looking
 * live over a recogniser Apple already finished with and every stop pays a
 * two-second timeout. The composer refuses to open the mic there rather than
 * record into nothing. When the Swift grows a real capability call, this
 * narrows to that and the proxy goes.
 */
export function dictationReportsProgress(): boolean {
    if (!native) return false;
    return typeof native.audioRoute === 'function';
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
