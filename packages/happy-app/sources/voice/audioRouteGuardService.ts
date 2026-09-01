import {
    addAudioRouteChangeListener,
    audioRoute,
    audioRouteChangeReported,
    isDroverSpeechAvailable,
} from 'drover-speech';
import { log } from '@/log';
import { storage } from '@/sync/storage';
import { t } from '@/text';
import { AudioRouteGuard } from './audioRouteGuard';
import { readAloud } from './readAloudService';
import { resolveSpeaker } from './speaker';

/**
 * The one route guard the app owns (DROVE-119), and the toast it raises.
 *
 * Started while read-aloud is on for an active session and stopped the moment
 * it is not, so nothing is watched on a device that is not talking. The
 * decision itself lives in audioRouteGuard.ts, with no natives in it; this is
 * the wiring.
 */

/**
 * How the route is being watched.
 *
 *   'event'  the binary posts `onAudioRouteChange`, so an AirPod coming out
 *            cuts the utterance as it happens.
 *   'poll'   TestFlight build 12 and earlier: `audioRoute()` is read on a
 *            timer, so up to `pollIntervalMs` of the reply can play out of
 *            the phone's speaker before it stops. Less than the protection
 *            the ticket asks for, and named that way rather than hidden.
 *   'none'   no speech module at all (Android, web, a build before DROVE-30).
 *            Nothing is read aloud on those, so there is nothing to guard.
 */
export type AudioRouteWatchMode = 'event' | 'poll' | 'none';

/**
 * Long enough not to matter on battery, short enough that the fallback still
 * stops the leak inside a word rather than inside a sentence.
 */
export const pollIntervalMs = 400;

export function audioRouteWatchMode(): AudioRouteWatchMode {
    if (!isDroverSpeechAvailable()) return 'none';
    return audioRouteChangeReported() ? 'event' : 'poll';
}

//
// The toast. Local to this module because the composer's own toast is state
// inside AgentInput and this fires from outside React entirely.
//

let toast: string | null = null;
let toastTimer: ReturnType<typeof setTimeout> | null = null;
const toastListeners = new Set<() => void>();

function publishToast(next: string | null): void {
    toast = next;
    for (const listener of toastListeners) listener();
}

export function readAloudRouteToast(): string | null {
    return toast;
}

export function subscribeReadAloudRouteToast(listener: () => void): () => void {
    toastListeners.add(listener);
    return () => { toastListeners.delete(listener); };
}

/** Shown for long enough to read one line, then gone on its own. */
export const toastDurationMs = 3200;

function announce(): void {
    if (toastTimer) clearTimeout(toastTimer);
    publishToast(t('agentInput.streamTalk.headphonesOff'));
    toastTimer = setTimeout(() => {
        toastTimer = null;
        publishToast(null);
    }, toastDurationMs);
}

//
// The guard.
//

const guard = new AudioRouteGuard({
    route: () => audioRoute(),
    isSpeaking: () => readAloud.isSpeaking,
    isEnabled: () => readAloud.isEnabled && storage.getState().localSettings.readAloudEnabled,
    speaker: () => resolveSpeaker(),
    // THE pause of DROVE-233, on purpose: the same state and position the
    // long press, the headphone press and the lock screen use, so an unplug
    // pause resumes from any of them at the same sentence (DROVE-294). The
    // keepalive and session posture while paused are therefore identical to
    // a long-press pause — nothing new is invented for the unplugged case.
    pause: () => readAloud.setPaused(true),
    interrupt: () => readAloud.interrupt('headphones-unplugged'),
    announce,
});

let refs = 0;
let subscription: { remove: () => void } | null = null;
let poll: ReturnType<typeof setInterval> | null = null;

/**
 * Watch the route while read-aloud is on. Returns the stop; refcounted,
 * because more than one chat can be mounted (the tablet side panel, an
 * embedded view) and they come and go on their own schedule.
 */
export function startAudioRouteGuard(): () => void {
    refs += 1;
    if (refs === 1) {
        const mode = audioRouteWatchMode();
        log.log(`[route-guard] watching by ${mode}`);
        guard.reset();
        // The first reading is a starting point, not a move: it sets what the
        // next change is compared against and can never stop anything itself.
        guard.observe();
        if (mode === 'event') {
            subscription = addAudioRouteChangeListener((outputs, reason) => {
                log.log(`[route-guard] route ${reason} -> ${outputs.join(',') || 'none'}`);
                guard.observe(outputs);
            });
        } else if (mode === 'poll') {
            poll = setInterval(() => guard.observe(), pollIntervalMs);
        }
    }
    let released = false;
    return () => {
        if (released) return;
        released = true;
        refs -= 1;
        if (refs > 0) return;
        subscription?.remove();
        subscription = null;
        if (poll !== null) clearInterval(poll);
        poll = null;
        guard.reset();
    };
}

/** For the tests and the dev screen: how many replies it has cut short. */
export function audioRouteGuardStopCount(): number {
    return guard.stopCount;
}
