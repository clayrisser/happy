import { describe, expect, it, vi } from 'vitest';

// Same reason speaker.spec.ts mocks it: vitest reaches the local expo module
// through an alias but not through autolinking, and `requireOptionalNativeModule`
// has nothing to find here anyway. The headphone port list is the one from
// DROVE-92, which is the truth this guard is built on.
vi.mock('drover-speech', () => ({
    routeHasHeadphones: (ports: readonly string[]) => ports.some((port) => [
        'Headphones',
        'BluetoothA2DPOutput',
        'BluetoothHFP',
        'BluetoothLE',
        'USBAudio',
    ].includes(port)),
}));

import { AudioRouteGuard, classifyRoute, leaksToTheRoom, type AudioRouteGuardDeps } from './audioRouteGuard';
import type { Speaker } from './speaker';

const headphones = ['Headphones'];
const airpods = ['BluetoothA2DPOutput'];
const speaker = ['Speaker'];
const carplay = ['CarAudio'];
const airplay = ['AirPlay'];

interface Harness {
    guard: AudioRouteGuard;
    pause: ReturnType<typeof vi.fn>;
    interrupt: ReturnType<typeof vi.fn>;
    announce: ReturnType<typeof vi.fn>;
    /** Mutable so a test can turn read-aloud off between two readings. */
    state: { speaking: boolean; enabled: boolean; speaker: Speaker };
}

function harness(over: Partial<Harness['state']> = {}): Harness {
    const state = { speaking: true, enabled: true, speaker: 'phone' as Speaker, ...over };
    const pause = vi.fn();
    const interrupt = vi.fn();
    const announce = vi.fn();
    const deps: AudioRouteGuardDeps = {
        route: () => [],
        isSpeaking: () => state.speaking,
        isEnabled: () => state.enabled,
        speaker: () => state.speaker,
        pause,
        interrupt,
        announce,
    };
    return { guard: new AudioRouteGuard(deps), pause, interrupt, announce, state };
}

/**
 * The route names come from AVAudioSession; what counts as the room is
 * decided here (DROVE-119).
 *
 * DROVE-189 kept every line of this classification and changed only what
 * happens next, and DROVE-294 changed the verb again: the move to the
 * speaker now PAUSES the reading at its place. Clay, more than once: "When
 * headphones are disconnected it is supposed to PAUSE the playback."
 */
describe('classifyRoute', () => {
    it('wired headphones are headphones', () => {
        expect(classifyRoute(headphones)).toBe('headphones');
    });

    it('AirPods are headphones', () => {
        expect(classifyRoute(airpods)).toBe('headphones');
    });

    it('the phone loudspeaker is the room', () => {
        expect(classifyRoute(speaker)).toBe('built-in-speaker');
    });

    it('CarPlay is neither: it is external and it was chosen', () => {
        expect(classifyRoute(carplay)).toBe('other');
    });

    it('AirPlay is neither, for the same reason', () => {
        expect(classifyRoute(airplay)).toBe('other');
    });

    it('the earpiece is not the room, since it is held to an ear', () => {
        expect(classifyRoute(['Receiver'])).toBe('other');
    });

    it('an empty route is unknown, not the speaker', () => {
        expect(classifyRoute([])).toBe('other');
    });

    it('headphones alongside the speaker still count as headphones', () => {
        expect(classifyRoute(['Headphones', 'Speaker'])).toBe('headphones');
    });
});

describe('leaksToTheRoom', () => {
    const change = (over: Partial<Parameters<typeof leaksToTheRoom>[0]> = {}) => ({
        from: 'headphones' as const,
        to: 'built-in-speaker' as const,
        speaking: true,
        enabled: true,
        speaker: 'phone' as Speaker,
        ...over,
    });

    it('headphones to the phone speaker while speaking is a leak', () => {
        expect(leaksToTheRoom(change())).toBe(true);
    });

    it('an unknown starting route is a first reading, not a move', () => {
        expect(leaksToTheRoom(change({ from: null }))).toBe(false);
    });

    it('the speaker to headphones is not, and never re-enables anything', () => {
        expect(leaksToTheRoom(change({ from: 'built-in-speaker', to: 'headphones' }))).toBe(false);
    });

    it('headphones to CarPlay is not a leak', () => {
        expect(leaksToTheRoom(change({ to: 'other' }))).toBe(false);
    });

    it('nothing being spoken means nothing to leak', () => {
        expect(leaksToTheRoom(change({ speaking: false }))).toBe(false);
    });

    it('read-aloud already off has nothing to turn off', () => {
        expect(leaksToTheRoom(change({ enabled: false }))).toBe(false);
    });

    it('the watch speaking makes the phone route irrelevant (DROVE-92)', () => {
        expect(leaksToTheRoom(change({ speaker: 'watch' }))).toBe(false);
    });
});

describe('AudioRouteGuard', () => {
    /**
     * THE VERB DROVE-294 CORRECTS. DROVE-119 stopped the reading and switched
     * it off; DROVE-189 let it carry on out of the speaker under a toast.
     * Clay asked for neither, in as many words, more than once: "When
     * headphones are disconnected it is supposed to PAUSE the playback."
     * Every music app pauses on route loss, and now so does this.
     */
    it('headphones to the speaker: pauses the reading at its place', () => {
        const h = harness();
        h.guard.observe(headphones);
        expect(h.pause).not.toHaveBeenCalled();
        h.guard.observe(speaker);
        expect(h.pause).toHaveBeenCalledTimes(1);
        expect(h.interrupt).toHaveBeenCalledTimes(1);
        expect(h.announce).toHaveBeenCalledTimes(1);
        expect(h.guard.stopCount).toBe(1);
    });

    /**
     * THE ONE CLAY ASKED FOR (DROVE-189). DROVE-119 flipped
     * `readAloudEnabled` off here and this test asserted it did. He has since
     * said, plainly, that removing headphones must not disable read-aloud: an
     * AirPod that drops for a second should not need a deliberate press to get
     * the voice back. The guard has no way to disable anything any more, which
     * is stronger than a test. DROVE-294's pause keeps this: paused is a third
     * state, not a way to be off.
     */
    it('leaves read-aloud ON when the headphones come out', () => {
        const h = harness();
        h.guard.observe(headphones);
        h.guard.observe(speaker);
        expect(h.state.enabled).toBe(true);
    });

    it('silences first, tells the captures second, toasts last', () => {
        // The pause is the point of the whole feature, so it goes first: the
        // speaker is quiet before anything else is attended to. The captures
        // are next (a latched mic on the built-in microphone still has to
        // stop, DROVE-119's one lasting insight), and the toast is for him.
        const h = harness();
        const order: string[] = [];
        h.pause.mockImplementation(() => order.push('pause'));
        h.interrupt.mockImplementation(() => order.push('interrupt'));
        h.announce.mockImplementation(() => order.push('announce'));
        h.guard.observe(headphones);
        h.guard.observe(speaker);
        expect(order).toEqual(['pause', 'interrupt', 'announce']);
    });

    it('headphones to CarPlay says nothing', () => {
        const h = harness();
        h.guard.observe(airpods);
        h.guard.observe(carplay);
        expect(h.pause).not.toHaveBeenCalled();
        expect(h.interrupt).not.toHaveBeenCalled();
        expect(h.announce).not.toHaveBeenCalled();
    });

    it('the speaker to headphones says nothing, pauses nothing, re-enables nothing', () => {
        const h = harness({ enabled: false });
        h.guard.observe(speaker);
        h.guard.observe(headphones);
        expect(h.pause).not.toHaveBeenCalled();
        expect(h.interrupt).not.toHaveBeenCalled();
        expect(h.state.enabled).toBe(false);
    });

    it('reconnecting does NOT auto-resume: the pause is his to lift', () => {
        // Consistent with iOS music and with DROVE-289's rule that a pause he
        // holds only he lifts. The guard has no resume dependency at all,
        // which is stronger than a test — this pins that plugging back in
        // fires nothing, not even a second pause.
        const h = harness();
        h.guard.observe(headphones);
        h.guard.observe(speaker);
        h.guard.observe(headphones);
        expect(h.pause).toHaveBeenCalledTimes(1);
        expect(h.state.enabled).toBe(true);
        expect(h.guard.stopCount).toBe(1);
    });

    it('the watch is the speaker: a phone route change says nothing (DROVE-92)', () => {
        const h = harness({ speaker: 'watch' });
        h.guard.observe(headphones);
        h.guard.observe(speaker);
        expect(h.pause).not.toHaveBeenCalled();
        expect(h.interrupt).not.toHaveBeenCalled();
        expect(h.announce).not.toHaveBeenCalled();
    });

    it('a change while nothing is being spoken says nothing', () => {
        const h = harness({ speaking: false });
        h.guard.observe(headphones);
        h.guard.observe(speaker);
        expect(h.pause).not.toHaveBeenCalled();
        expect(h.announce).not.toHaveBeenCalled();
        expect(h.state.enabled).toBe(true);
    });

    it('a second reading of the same speaker route does not fire again', () => {
        const h = harness();
        h.guard.observe(headphones);
        h.guard.observe(speaker);
        h.guard.observe(speaker);
        expect(h.pause).toHaveBeenCalledTimes(1);
        expect(h.interrupt).toHaveBeenCalledTimes(1);
    });

    it('the first reading of a speaker-only route is a starting point, not a move', () => {
        const h = harness();
        h.guard.observe(speaker);
        expect(h.interrupt).not.toHaveBeenCalled();
        expect(h.guard.lastRoute).toBe('built-in-speaker');
    });

    it('reset forgets the route, so the next first reading cannot stop anything', () => {
        const h = harness();
        h.guard.observe(headphones);
        h.guard.reset();
        expect(h.guard.lastRoute).toBeNull();
        h.guard.observe(speaker);
        expect(h.interrupt).not.toHaveBeenCalled();
    });

    it('polls the route itself when the event carries none', () => {
        const state = { speaking: true, enabled: true, speaker: 'phone' as Speaker };
        let ports = headphones;
        const pause = vi.fn();
        const interrupt = vi.fn();
        const guard = new AudioRouteGuard({
            route: () => ports,
            isSpeaking: () => state.speaking,
            isEnabled: () => state.enabled,
            speaker: () => state.speaker,
            pause,
            interrupt,
            announce: () => { },
        });
        guard.observe();
        ports = speaker;
        guard.observe();
        expect(pause).toHaveBeenCalledTimes(1);
        expect(interrupt).toHaveBeenCalledTimes(1);
    });
});
