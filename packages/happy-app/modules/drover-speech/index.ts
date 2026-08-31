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

/**
 * A press on the lock screen or on the headphones, as iOS classes it.
 *
 * `play` and `pause` are the lock screen's two buttons; a headphone sends
 * `toggle` for one press and `next` for two (DROVE-225). What each one MEANS
 * is decided in sources/voice/headphonePress.ts, not here: this module
 * reports, it does not interpret.
 */
export type RemoteCommandName = 'play' | 'pause' | 'toggle' | 'next' | 'previous';

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
    /**
     * Optional: builds up to 12 have no such function. Its presence is the
     * build stamp for `onAudioRouteChange` (DROVE-119).
     */
    watchesAudioRoute?: () => boolean;
    /**
     * Optional: builds up to 12 have neither. Its presence is the build stamp
     * for `holdSession`, `onSpeechInterruption` and `onRemoteCommand`
     * (DROVE-189). A bundle running on an older binary gets false and keeps
     * the old behaviour rather than claiming a protection it does not have.
     */
    handlesInterruptions?: () => boolean;
    /**
     * Optional: its presence is the build stamp for the DOUBLE PRESS arriving
     * as `next` on `onRemoteCommand` (DROVE-225). Build 13 has
     * `handlesInterruptions` and still disables `nextTrackCommand`, so the two
     * stamps are genuinely different builds and cannot share one.
     */
    handlesMicCommand?: () => boolean;
    /** Keep the audio session while nothing is speaking. See DROVE-189. */
    holdSession?: (hold: boolean) => Promise<void>;
    /**
     * Whether the card's lifetime is this binary's (DROVE-233). Build 15 and
     * later; its own stamp for the reason `handlesMicCommand` has one.
     */
    handlesReadingState?: () => boolean;
    /** Read-aloud is on, paused or off, for the lock screen. See DROVE-233. */
    setReadingState?: (state: string) => Promise<void>;
    dictationSupport: (localeTag: string | null) => Promise<DictationSupport>;
    startDictation: (localeTag: string | null) => Promise<boolean>;
    /** Resolves with the final transcript. */
    stopDictation: () => Promise<string>;
    cancelDictation: () => Promise<void>;
    addListener: {
        /**
         * `text` is everything heard since the microphone opened, across every
         * recognition task inside it. `task` names the task it came from and
         * is absent on builds up to 12 (DROVE-140).
         */
        (eventName: 'onDictationPartial', listener: (event: { text: string; task?: number }) => void): EventSubscription;
        /** The recogniser stopped with no stop pending (DROVE-30). Build 10 and later. */
        (eventName: 'onDictationEnded', listener: (event: { text: string; reason: string; task?: number }) => void): EventSubscription;
        /** Input RMS 0..1 per PCM buffer, at most 20 a second (DROVE-74). Build 10 and later. */
        (eventName: 'onDictationLevel', listener: (event: { level: number }) => void): EventSubscription;
        /** The output route moved: the new output port types, and why (DROVE-119). Build 13 and later. */
        (eventName: 'onAudioRouteChange', listener: (event: { outputs: string[]; reason: string }) => void): EventSubscription;
        (eventName: 'onSpeechInterruption', listener: (event: { state: 'began' | 'ended'; resumed?: boolean }) => void): EventSubscription;
        /**
         * A press on the lock screen or on the headphones. iOS counts the
         * presses: single is `toggle`, double is `next` (DROVE-225), triple
         * would be `previous` and is not enabled. `next` arrives only on a
         * build with `handlesMicCommand`.
         */
        (eventName: 'onRemoteCommand', listener: (event: { command: RemoteCommandName }) => void): EventSubscription;
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
 * Whether this binary tells JS when the audio route MOVES (DROVE-119), as
 * opposed to only answering `audioRoute()` when asked.
 *
 * Same build-stamp trick as `dictationReportsProgress`, and for the same
 * reason: a module cannot be asked which events it declares, so JS asks for
 * the function that shipped in the same binary. False means the only way to
 * notice an AirPod coming out is to poll, which leaves up to a poll's worth
 * of the reply playing out loud. The guard says so rather than claiming a
 * protection it does not have.
 */
export function audioRouteChangeReported(): boolean {
    if (!native) return false;
    return typeof native.watchesAudioRoute === 'function';
}

/**
 * The audio route moved. `outputs` is the NEW route's port types, the same
 * names `audioRoute()` returns. On a build without the event nothing ever
 * arrives and the subscription is an empty shell.
 */
export function addAudioRouteChangeListener(listener: (outputs: string[], reason: string) => void) {
    if (!native) return { remove: () => {} };
    try {
        return native.addListener('onAudioRouteChange', (event) => listener(event.outputs, event.reason));
    } catch {
        return { remove: () => {} };
    }
}

/**
 * Whether this binary handles AVAudioSession interruptions and takes
 * `holdSession` (DROVE-189).
 *
 * The same build stamp `audioRouteChangeReported` is. False means an
 * interruption still leaves the reader dead and the session is still dropped
 * on a drained queue, which is the state every build up to 12 is in; the
 * caller keeps the old behaviour rather than calling into nothing.
 */
export function speechInterruptionsHandled(): boolean {
    if (!native) return false;
    return typeof native.handlesInterruptions === 'function';
}

/**
 * Hold the audio session open while nothing is speaking, or let it go
 * (DROVE-189).
 *
 * An app with the audio background mode stays alive only while its session is
 * ACTIVE. Read-aloud released it on every drained queue, so backgrounding the
 * app and waiting for the next reply meant iOS suspended the process and the
 * reply arrived at an app that was not running. A no-op on a build without it.
 */
export async function holdAudioSession(hold: boolean): Promise<void> {
    if (!native || typeof native.holdSession !== 'function') return;
    try {
        await native.holdSession(hold);
    } catch {
        // A session the OS would not give up is not worth taking the reader
        // down for; the foreground behaviour is unchanged either way.
    }
}

/**
 * What read-aloud is doing, for the lock screen (DROVE-233).
 *
 * The same three values `readAloudTransport` deals in, sent across so the
 * now-playing card exists for as long as read-aloud is ON rather than only
 * while a sentence is in flight or the session is held. Clay on build 14
 * photographed a lock screen with no card at all, which is that gap.
 */
export type ReadingState = 'off' | 'reading' | 'paused';

/**
 * Whether this binary owns the card's lifetime, or the old build does
 * (DROVE-233).
 *
 * Its own stamp rather than a reuse of `speechInterruptionsHandled`, for the
 * reason DROVE-225 gave for `remoteMicCommandAvailable`: they ship in
 * different builds. False is build 14 and earlier, where the card appears only
 * while the app is backgrounded with read-aloud on. `setReadingState` is a
 * no-op there and `holdAudioSession` carries on doing what it did.
 */
export function readingStateReported(): boolean {
    if (!native) return false;
    return typeof native.handlesReadingState === 'function';
}

/** Tell the lock screen what the reader is doing. A no-op on an older build. */
export async function setReadingState(state: ReadingState): Promise<void> {
    if (!native || typeof native.setReadingState !== 'function') return;
    try {
        await native.setReadingState(state);
    } catch {
        // A card that would not update is not worth taking the reader down for.
    }
}

/** An interruption began or ended. Nothing arrives on an older build. */
export function addSpeechInterruptionListener(
    listener: (state: 'began' | 'ended', resumed: boolean) => void,
) {
    if (!native) return { remove: () => {} };
    try {
        return native.addListener('onSpeechInterruption', (event) => listener(event.state, event.resumed === true));
    } catch {
        return { remove: () => {} };
    }
}

/**
 * Whether the double press reaches this app at all (DROVE-225).
 *
 * Build 13 sets `nextTrackCommand.isEnabled = false`, so on the binary
 * currently on Clay's phone a double press goes to whatever else is playing
 * and no JS can hear it. Its own stamp rather than `speechInterruptionsHandled`,
 * which build 13 already answers true to.
 */
export function remoteMicCommandAvailable(): boolean {
    if (!native) return false;
    return typeof native.handlesMicCommand === 'function';
}

/** Lock-screen or AirPod press. Nothing arrives on an older build. */
export function addRemoteCommandListener(listener: (command: RemoteCommandName) => void) {
    if (!native) return { remove: () => {} };
    try {
        return native.addListener('onRemoteCommand', (event) => listener(event.command));
    } catch {
        return { remove: () => {} };
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

/**
 * What the recogniser has heard so far (DROVE-140).
 *
 * THE CONTRACT, and it has one owner, the native module: `text` is EVERYTHING
 * HEARD SINCE THE MICROPHONE OPENED. A build that restarts a recognition task
 * internally after Apple finalises folds the earlier tasks into this itself
 * (`bankedTranscript + taskTranscript` in the Swift), so a listener REPLACES
 * what it holds and never appends this to itself.
 *
 * `task` names the recognition task the last words came from. It is
 * INFORMATIONAL: since the text already accumulates, a listener that banked on
 * a task change would count the same words twice, which is precisely what one
 * pause did to the shipped attempt at this ticket. Undefined on a build up to
 * 12, which never restarts a task at all.
 */
export function addDictationPartialListener(listener: (text: string, task?: number) => void) {
    if (!native) return { remove: () => {} };
    return native.addListener('onDictationPartial', (event) => listener(event.text, event.task));
}

/**
 * The recogniser's task stopped and nobody asked it to (DROVE-30). A latched
 * mic has to hear this, or it sits there looking live over a dead task until
 * its idle clock runs out. A binary whose module predates the event simply
 * never fires it; subscribing costs nothing.
 *
 * `reason` IS LOAD-BEARING, and dropping it is what left a hold with a pause
 * in it recording nothing (DROVE-140). `final` is Apple finalising an
 * utterance after a second or so of silence: the microphone is fine and the
 * user is mid-thought, so the caller banks what it has and opens the
 * microphone again. Every other reason is the recogniser's error string, which
 * means it cannot go on, and reopening into that is a restart loop.
 *
 * `text` covers everything heard since the microphone opened, the same
 * contract the partials keep. On a build that restarts the task internally a
 * pause does not arrive here at all.
 */
export function addDictationEndedListener(
    listener: (text: string, reason: string, task?: number) => void,
) {
    if (!native) return { remove: () => {} };
    try {
        return native.addListener(
            'onDictationEnded',
            (event) => listener(event.text, event.reason, event.task),
        );
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
