import { routeHasHeadphones } from 'drover-speech';
import type { Speaker } from './speaker';

/**
 * Headphones coming out SAYS SO, and nothing else (DROVE-119, reversed by
 * DROVE-189).
 *
 * DROVE-119 read Clay's "if headphones disconnect, make sure by default you
 * mute, or you disable the reading things back" as a shutdown, and shipped
 * one: a pulled AirPod cut the sentence and switched read-aloud off. He has
 * since asked for the opposite in as many words, and he is right. An AirPod
 * drops, a case lids in a pocket, a car stereo hands back. None of those is
 * him asking for silence, and the recovery was a deliberate press of a button
 * he could not see. The room it was protecting is rarer than the pocket.
 *
 * What is left is the ANNOUNCEMENT: the toast says the sound moved to the
 * speaker, and he turns it off himself if he is in company. The interrupt is
 * still raised, because the gate still uses it to stop a latched mic; it
 * simply no longer stops the voice.
 *
 * Three things narrow what counts as a move worth announcing, and each one is
 * a case where saying anything would be noise:
 *
 *   - Only a move TO the built-in speaker. Headphones to CarPlay, or AirPods
 *     to a Bluetooth speaker the user chose, is not a leak; stopping there
 *     would be maddening.
 *   - Only while the PHONE is the speaker. When the watch is reading
 *     (DROVE-92), the phone's route says nothing about who can hear.
 *   - Only while something is actually being spoken. A route change between
 *     replies has nothing to leak, so there is nothing to say about it.
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
     * Name the route change. The gate decides what it means, and since
     * DROVE-189 it means the captures stop and the voice carries on.
     */
    interrupt: () => void;
    /** One line saying where the sound went. */
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
    /** How many times it has announced a move to the speaker; for the tests. */
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
        // Read-aloud stays ON (DROVE-189). The interrupt is for the captures;
        // the toast is for him.
        this.deps.interrupt();
        this.deps.announce();
    }
}
