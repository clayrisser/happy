import { routeHasHeadphones } from 'drover-speech';
import type { Speaker } from './speaker';

/**
 * Headphones coming out stops read-aloud and turns it off (DROVE-119).
 *
 * Clay: "if headphones disconnect, make sure by default you mute, or you
 * disable the reading things back." It is the rule iOS already has for
 * music, and for the same reason: a route vanishing means the listener's
 * assumption about who can hear just changed. With read-aloud on, a pulled
 * AirPod turns a private reply into the phone announcing it to the room,
 * mid-sentence.
 *
 * This watches the route and calls read-aloud's existing `interrupt`, rather
 * than reaching into its queue, so it stays independent of the reader's
 * internals. Three things narrow it, and each one is a case where stopping
 * would be wrong:
 *
 *   - Only a move TO the built-in speaker. Headphones to CarPlay, or AirPods
 *     to a Bluetooth speaker the user chose, is not a leak; stopping there
 *     would be maddening.
 *   - Only while the PHONE is the speaker. When the watch is reading
 *     (DROVE-92), the phone's route says nothing about who can hear.
 *   - Only while something is actually being spoken. A route change between
 *     replies has nothing to leak, so it takes nothing away.
 *
 * Reconnecting does not undo it. Turning read-aloud back on stays a
 * deliberate press of the speaker button, which is what "disable" rather
 * than "pause" means.
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
    /** Cut the utterance in flight, mid-word. */
    interrupt: () => void;
    /** Turn read-aloud off, so the next reply does not start speaking either. */
    disable: () => void;
    /** One line saying why it stopped. */
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
    /** How many times it has stopped a reply; for the tests and for logs. */
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
        // Cut first, then turn it off. The order is the whole point: the
        // setting flipping unmounts the guard and eventually quiets the
        // reader through React, and "eventually" is a sentence out loud.
        this.deps.interrupt();
        this.deps.disable();
        this.deps.announce();
    }
}
