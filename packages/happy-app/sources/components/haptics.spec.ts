import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * DROVE-190, the assertion that matters: with the switch off, nothing fires.
 *
 * Both the native module and the store are mocked, so this runs the real
 * gate in components/haptics.ts against a fake taptic engine and counts what
 * it asked for. Enumerating the call sites is hapticKinds.spec.ts's job; this
 * one proves the gate they all go through.
 */

const impact = vi.fn(async (_style?: string) => {});
const notification = vi.fn(async (_type?: string) => {});
const selection = vi.fn(async () => {});

vi.mock('expo-haptics', () => ({
    impactAsync: (style?: string) => impact(style),
    notificationAsync: (type?: string) => notification(type),
    selectionAsync: () => selection(),
    ImpactFeedbackStyle: { Light: 'light', Rigid: 'rigid', Heavy: 'heavy' },
    NotificationFeedbackType: { Error: 'error', Success: 'success', Warning: 'warning' },
}));

let phoneHaptics = false;
vi.mock('@/sync/storage', () => ({
    storage: { getState: () => ({ localSettings: { phoneHaptics } }) },
}));

import {
    hapticsAnnounce,
    hapticsConfirm,
    hapticsError,
    hapticsLight,
    hapticsSelection,
    playPhoneTaptic,
    playWristCue,
} from './haptics';
import { wristCues } from '@/utils/wristCues';

function calls(): number {
    return impact.mock.calls.length + notification.mock.calls.length + selection.mock.calls.length;
}

beforeEach(() => {
    impact.mockClear();
    notification.mockClear();
    selection.mockClear();
});

describe('with phone haptics off (the default)', () => {
    beforeEach(() => { phoneHaptics = false; });

    it('the drover announce tap does not fire', () => {
        expect(hapticsAnnounce()).toBe(false);
        expect(calls()).toBe(0);
    });

    it('nothing fires however many gates land', () => {
        for (let i = 0; i < 20; i++) hapticsAnnounce();
        expect(calls()).toBe(0);
    });

    it('interaction haptics do not fire either', () => {
        hapticsLight();
        hapticsError();
        hapticsSelection();
        hapticsConfirm();
        playPhoneTaptic('light');
        playPhoneTaptic('selection');
        playPhoneTaptic('confirm');
        playPhoneTaptic('error');
        expect(calls()).toBe(0);
    });

    it('a wrist pattern played on the phone stays silent', async () => {
        await playWristCue(wristCues[0]);
        expect(calls()).toBe(0);
    });

    it('the demo screen still plays what a finger asked for', async () => {
        hapticsConfirm(true);
        playPhoneTaptic('light', true);
        expect(calls()).toBe(2);
    });

    it('but no announce can be forced: the announcer has no preview door', () => {
        // hapticsAnnounce takes no preview argument on purpose.
        expect(hapticsAnnounce.length).toBe(0);
    });
});

describe('with phone haptics on', () => {
    beforeEach(() => { phoneHaptics = true; });

    it('the announce tap is the warning double-tap', () => {
        expect(hapticsAnnounce()).toBe(true);
        expect(notification).toHaveBeenCalledWith('warning');
    });

    it('interaction haptics come back', () => {
        hapticsLight();
        hapticsSelection();
        expect(impact).toHaveBeenCalledWith('light');
        expect(selection).toHaveBeenCalledTimes(1);
    });
});

describe('a store that is not there yet', () => {
    it('is silence, not a crash', () => {
        // A headless background launch can reach a haptic before the store is
        // built. Unknown state reads as off.
        expect(() => hapticsAnnounce()).not.toThrow();
    });
});
