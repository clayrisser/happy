import { routeHasHeadphones } from 'drover-speech';
import type { Speaker } from './speaker';

/**
 * Headphones coming out PAUSES the reading at its place (DROVE-294, after
 * two wrong verbs).
 *
 * DROVE-119 read Clay's "if headphones disconnect, make sure by default you
 * mute, or you disable the reading things back" as a shutdown, and shipped
 * one: a pulled AirPod cut the sentence, threw the position away and switched
 * read-aloud off. DROVE-189 swung to the other extreme — announce the move
 * and let the reply carry on out of the phone's speaker. Clay asked for
 * neither, and said so more than once: "When headphones are disconnected it
 * is supposed to PAUSE the playback — I've told you this many times." Every
 * music app on iOS pauses on route loss and resumes where it was, and that is
 * the verb here now: the reading holds its exact position (DROVE-233's
 * pause), the reader stays ON, the amber face shows (DROVE-258), and nothing
 * plays from the speaker — which satisfies DROVE-119's safety goal better
 * than the stop ever did.
 *
 * Plugging back in does NOT auto-resume. Resume is his gesture — the button,
 * a headphone press, the lock screen — consistent with iOS music and with
 * DROVE-289's rule that a pause he holds only he lifts. The interrupt is
 * still raised, because the gate still uses it to stop a latched mic; the
 * toast still says what happened.
 *
 * Three things narrow what counts as a route loss worth acting on, and each
 * one is a case where pausing would be noise:
 *
 *   - Only a move TO the built-in speaker. Headphones to CarPlay, or AirPods
 *     to a Bluetooth speaker the user chose, is not a leak; pausing there
 *     would be maddening.
 *   - Only while the PHONE is the speaker. When the watch is reading
 *     (DROVE-92), the phone's route says nothing about who can hear.
 *   - Only while something is actually being spoken. A route change between
 *     replies has nothing to leak, so there is nothing to pause.
 */

/** What a route means for who can hear. */
export type RouteKind = 'headphones' | 'built-in-speaker' | 'other';

/**
 * The port type AVAudioSession gives the phone's own loudspeaker. The earpiece
 * ("Receiver") is deliberately not here: it is held to an ear, so it is not
 * the room. Everything else external (CarPlay's "CarAudio", "AirPlay",
 * "HDMI") is 'other' and never triggers a stop.
 */
export const builtInSpeakerPortType = 'Speaker';

export function classifyRoute(ports: readonly string[]): RouteKind {
    if (routeHasHeadphones(ports)) return 'headphones';
    if (ports.length > 0 && ports.every((port) => port === builtInSpeakerPortType)) {
        return 'built-in-speaker';
    }
    return 'other';
}

export interface RouteChange {
    /** What the route was, or null when nothing has been seen yet. */
    from: RouteKind | null;
    to: RouteKind;
    /** Is a sentence being spoken right now? */
    speaking: boolean;
    /** Is read-aloud switched on? */
    enabled: boolean;
    /** Which device is reading this reply (DROVE-92). */
    speaker: Speaker;
}

/**
 * Did this change just put a private reply on a loudspeaker in a room?
 *
 * Everything else is false, including an unknown starting route: the first
 * sample of a session says where the sound is, not that it moved.
 */
export function leaksToTheRoom(change: RouteChange): boolean {
    if (change.from !== 'headphones') return false;
    if (change.to !== 'built-in-speaker') return false;
    if (!change.enabled) return false;
    if (!change.speaking) return false;
    return change.speaker === 'phone';
}

export interface AudioRouteGuardDeps {
    /** The phone's current output port types. */
    route: () => string[];
    /** Is read-aloud speaking a sentence right now? */
    isSpeaking: () => boolean;
    /** Is read-aloud switched on? */
    isEnabled: () => boolean;
    /** Which device the next sentence would go to. */
    speaker: () => Speaker;
    /**
     * Hold the reading at its exact position (DROVE-294). The same pause the
     * long press, the headphone press and the lock screen use (DROVE-233),
     * which is what makes a resume from any of those surfaces continue at
     * the same sentence. The guard has no resume dependency on purpose:
     * reconnecting must not lift a pause only he holds (DROVE-289).
     */
    pause: () => void;
    /**
     * Name the route change for the captures. The gate decides what it
     * means: the captures stop (a latched mic on the built-in microphone was
     * DROVE-119's one lasting insight) and the voice is not stopped — it is
     * already paused by the line above.
     */
    interrupt: () => void;
    /** One line saying what happened. */
    announce: () => void;
}

/**
 * Holds the last route seen and acts on the move to the next one.
 *
 * Fed from two places by the service: the native route-change event where
 * the binary has one, and a poll where it does not. Both call `observe`, and
 * it is idempotent: a second report of the same speaker-only route after
 * read-aloud is already off finds `enabled` false and does nothing.
 */
export class AudioRouteGuard {
    private readonly deps: AudioRouteGuardDeps;
    private previous: RouteKind | null = null;
    /** How many times it has paused a reply on a route loss; for the tests. */
    private stopped = 0;

    constructor(deps: AudioRouteGuardDeps) {
        this.deps = deps;
    }

    get stopCount(): number {
        return this.stopped;
    }

    get lastRoute(): RouteKind | null {
        return this.previous;
    }

    /**
     * Forget the route. Called when the guard is torn down, so the next one
     * to start treats its first sample as a starting point rather than as a
     * move away from a route that may be minutes stale.
     */
    reset(): void {
        this.previous = null;
    }

    /** Take a reading. `ports` from the native event, or polled when absent. */
    observe(ports?: readonly string[]): void {
        const to = classifyRoute(ports ?? this.deps.route());
        const from = this.previous;
        this.previous = to;
        const change: RouteChange = {
            from,
            to,
            speaking: this.deps.isSpeaking(),
            enabled: this.deps.isEnabled(),
            speaker: this.deps.speaker(),
        };
        if (!leaksToTheRoom(change)) return;
        this.stopped += 1;
        // PAUSE, not stop, not carry-on (DROVE-294). Silence first, so the
        // speaker is quiet before anything else is attended to; the captures
        // second; the toast, describing a speaker already silent, last.
        // Read-aloud stays ON — paused is a third state (DROVE-233).
        this.deps.pause();
        this.deps.interrupt();
        this.deps.announce();
    }
}
