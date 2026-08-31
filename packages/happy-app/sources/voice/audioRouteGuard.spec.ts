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
    interrupt: ReturnType<typeof vi.fn>;
    disable: ReturnType<typeof vi.fn>;
    announce: ReturnType<typeof vi.fn>;
    /** Mutable so a test can turn read-aloud off between two readings. */
    state: { speaking: boolean; enabled: boolean; speaker: Speaker };
}

function harness(over: Partial<Harness['state']> = {}): Harness {
    const state = { speaking: true, enabled: true, speaker: 'phone' as Speaker, ...over };
    const interrupt = vi.fn();
    const disable = vi.fn(() => { state.enabled = false; });
    const announce = vi.fn();
    const deps: AudioRouteGuardDeps = {
        route: () => [],
        isSpeaking: () => state.speaking,
        isEnabled: () => state.enabled,
        speaker: () => state.speaker,
        interrupt,
        disable,
        announce,
    };
    return { guard: new AudioRouteGuard(deps), interrupt, disable, announce, state };
}

/**
 * Clay: "if headphones disconnect, make sure by default you mute, or you
 * disable the reading things back." The route names come from
 * AVAudioSession; what counts as the room is decided here (DROVE-119).
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
    it('headphones to the speaker: cuts the utterance, turns it off, says why', () => {
        const h = harness();
        h.guard.observe(headphones);
        expect(h.interrupt).not.toHaveBeenCalled();
        h.guard.observe(speaker);
        expect(h.interrupt).toHaveBeenCalledTimes(1);
        expect(h.disable).toHaveBeenCalledTimes(1);
        expect(h.announce).toHaveBeenCalledTimes(1);
        expect(h.guard.stopCount).toBe(1);
    });

    it('cuts BEFORE it flips the setting, so nothing is spoken in between', () => {
        const h = harness();
        const order: string[] = [];
        h.interrupt.mockImplementation(() => order.push('interrupt'));
        h.disable.mockImplementation(() => { order.push('disable'); h.state.enabled = false; });
        h.announce.mockImplementation(() => order.push('announce'));
        h.guard.observe(headphones);
        h.guard.observe(speaker);
        expect(order).toEqual(['interrupt', 'disable', 'announce']);
    });

    it('headphones to CarPlay stops nothing', () => {
        const h = harness();
        h.guard.observe(airpods);
        h.guard.observe(carplay);
        expect(h.interrupt).not.toHaveBeenCalled();
        expect(h.disable).not.toHaveBeenCalled();
        expect(h.announce).not.toHaveBeenCalled();
    });

    it('the speaker to headphones stops nothing and re-enables nothing', () => {
        const h = harness({ enabled: false });
        h.guard.observe(speaker);
        h.guard.observe(headphones);
        expect(h.interrupt).not.toHaveBeenCalled();
        expect(h.disable).not.toHaveBeenCalled();
        expect(h.state.enabled).toBe(false);
    });

    it('reconnecting after a stop leaves it off: turning it back on is a press', () => {
        const h = harness();
        h.guard.observe(headphones);
        h.guard.observe(speaker);
        expect(h.state.enabled).toBe(false);
        h.guard.observe(headphones);
        expect(h.state.enabled).toBe(false);
        expect(h.guard.stopCount).toBe(1);
    });

    it('the watch is the speaker: a phone route change stops nothing (DROVE-92)', () => {
        const h = harness({ speaker: 'watch' });
        h.guard.observe(headphones);
        h.guard.observe(speaker);
        expect(h.interrupt).not.toHaveBeenCalled();
        expect(h.disable).not.toHaveBeenCalled();
    });

    it('a change while nothing is being spoken disables nothing', () => {
        const h = harness({ speaking: false });
        h.guard.observe(headphones);
        h.guard.observe(speaker);
        expect(h.disable).not.toHaveBeenCalled();
        expect(h.state.enabled).toBe(true);
    });

    it('a second reading of the same speaker route does not fire again', () => {
        const h = harness();
        h.guard.observe(headphones);
        h.guard.observe(speaker);
        h.guard.observe(speaker);
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
        const interrupt = vi.fn();
        const guard = new AudioRouteGuard({
            route: () => ports,
            isSpeaking: () => state.speaking,
            isEnabled: () => state.enabled,
            speaker: () => state.speaker,
            interrupt,
            disable: () => { state.enabled = false; },
            announce: () => {},
        });
        guard.observe();
        ports = speaker;
        guard.observe();
        expect(interrupt).toHaveBeenCalledTimes(1);
    });
});
