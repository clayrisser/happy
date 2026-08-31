import { describe, expect, it, vi } from 'vitest';

vi.mock('drover-speech', () => ({ audioRoute: () => [], routeHasHeadphones: () => false }));
vi.mock('drover-watch', () => ({ getDroverWatchStatus: () => ({ reachable: false }) }));
vi.mock('@/sync/storage', () => ({ storage: { getState: () => ({ settings: {} }) } }));
vi.mock('./watchSpeaker', () => ({ watchRouteHasHeadphones: () => false }));

import { pickSpeaker, type SpeakerInput } from './speaker';

const input = (over: Partial<SpeakerInput> = {}): SpeakerInput => ({
    setting: 'auto',
    phoneRouteHasHeadphones: false,
    watchReachable: true,
    watchRouteHasHeadphones: false,
    ...over,
});

/**
 * Clay: "if I have headphones connected to my phone it should go through
 * that; however Apple handles audio inputs with the watch is what it should
 * do." Auto follows the headphones; a pinned device is a pinned device; and
 * exactly one device is ever named (DROVE-92).
 */
describe('pickSpeaker', () => {
    it('auto: the phone with nothing on either route', () => {
        expect(pickSpeaker(input())).toBe('phone');
    });

    it('auto: the phone when its route has headphones', () => {
        expect(pickSpeaker(input({ phoneRouteHasHeadphones: true }))).toBe('phone');
    });

    it('auto: the watch when only its route has headphones', () => {
        expect(pickSpeaker(input({ watchRouteHasHeadphones: true }))).toBe('watch');
    });

    it('auto: the phone when both routes have headphones, since it has the full stream', () => {
        expect(pickSpeaker(input({ phoneRouteHasHeadphones: true, watchRouteHasHeadphones: true }))).toBe('phone');
    });

    it('phone pinned: the phone whatever the routes say', () => {
        expect(pickSpeaker(input({ setting: 'phone', watchRouteHasHeadphones: true }))).toBe('phone');
    });

    it('watch pinned: the watch, headphones or not', () => {
        expect(pickSpeaker(input({ setting: 'watch' }))).toBe('watch');
        expect(pickSpeaker(input({ setting: 'watch', phoneRouteHasHeadphones: true }))).toBe('watch');
    });

    it('never the watch while it is unreachable, because a sentence sent there is not heard', () => {
        expect(pickSpeaker(input({ setting: 'watch', watchReachable: false }))).toBe('phone');
        expect(pickSpeaker(input({ watchRouteHasHeadphones: true, watchReachable: false }))).toBe('phone');
    });

    it('names exactly one device for every combination', () => {
        for (const setting of ['phone', 'watch', 'auto'] as const) {
            for (const phone of [false, true]) {
                for (const reachable of [false, true]) {
                    for (const watch of [false, true]) {
                        const picked = pickSpeaker({
                            setting,
                            phoneRouteHasHeadphones: phone,
                            watchReachable: reachable,
                            watchRouteHasHeadphones: watch,
                        });
                        expect(['phone', 'watch']).toContain(picked);
                    }
                }
            }
        }
    });
});
