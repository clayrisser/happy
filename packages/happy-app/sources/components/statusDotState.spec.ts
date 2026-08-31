/**
 * THE DOT SAYS EVERYTHING NOW, so every state it can be in is pinned here
 * (DROVE-231).
 *
 * Clay's table, verbatim: green connected, blinking blue working, yellow
 * recently disconnected, red disconnected a while, blinking purple compacting.
 * Plus the one state his table does not cover and this strip has drawn since
 * DROVE-82: waiting on a permission or an answer.
 */
import { describe, expect, it } from 'vitest';
import { LIVE_STATUS_STALE_MS } from '@/utils/liveStatus';
import {
    DISCONNECT_RECENT_MS,
    STATUS_DOT_BLINK_HALF_MS,
    STATUS_DOT_BLINK_MS,
    statusDotBlinks,
    statusDotColors,
    statusDotLabels,
    statusDotState,
    type StatusDotState,
} from './statusDotState';

const now = 1_700_000_000_000;

const base = {
    online: true,
    lastSeenAt: now,
    mainWorking: false,
    toolRunning: false,
    atCompaction: false,
    waiting: false,
    now,
};

describe('Clay\'s table, state by state', () => {
    it('is green when connected and idle', () => {
        expect(statusDotState(base)).toBe('connected');
        expect(statusDotColors.connected).toBe('#34C759');
    });

    it('is blue and blinking while the main thread works', () => {
        const state = statusDotState({ ...base, mainWorking: true, toolRunning: true });
        expect(state).toBe('working');
        expect(statusDotColors.working).toBe('#007AFF');
        expect(statusDotBlinks(state)).toBe(true);
    });

    it('is purple and blinking while compacting', () => {
        const state = statusDotState({ ...base, mainWorking: true, atCompaction: true });
        expect(state).toBe('compacting');
        expect(statusDotColors.compacting).toBe('#AF52DE');
        expect(statusDotBlinks(state)).toBe(true);
    });

    it('is yellow just after the session drops', () => {
        const state = statusDotState({ ...base, online: false, now: now + DISCONNECT_RECENT_MS - 1 });
        expect(state).toBe('recentlyDisconnected');
        expect(statusDotColors.recentlyDisconnected).toBe('#FFCC00');
    });

    it('is red once it has been gone a while', () => {
        const state = statusDotState({ ...base, online: false, now: now + DISCONNECT_RECENT_MS });
        expect(state).toBe('disconnected');
        expect(statusDotColors.disconnected).toBe('#FF3B30');
    });

    it('is red, not yellow, when it never said when it was last seen', () => {
        expect(statusDotState({ ...base, online: false, lastSeenAt: null })).toBe('disconnected');
    });
});

describe('the three decisions, and what they are anchored to', () => {
    it('turns red at exactly the moment the strip stops trusting the snapshot', () => {
        // Not a round two minutes chosen for feel. It IS the staleness window,
        // imported, so the dot and the readout beside it cannot disagree about
        // whether the phone still believes what the session last said.
        expect(DISCONNECT_RECENT_MS).toBe(LIVE_STATUS_STALE_MS);
        expect(DISCONNECT_RECENT_MS).toBe(120_000);
    });

    it('calls it compacting only with a working main, no tool and a full context', () => {
        // The phone cannot see a compaction happen: happy-cli drops the
        // compaction summary out of the transcript and the snapshot has no
        // field for one. So it is inferred, and the inference needs all three.
        expect(statusDotState({ ...base, mainWorking: true, atCompaction: true })).toBe('compacting');
        expect(statusDotState({ ...base, mainWorking: true, atCompaction: true, toolRunning: true }))
            .toBe('working');
        expect(statusDotState({ ...base, mainWorking: true, atCompaction: false })).toBe('working');
        expect(statusDotState({ ...base, mainWorking: false, atCompaction: true })).toBe('connected');
    });

    it('blinks on one period, so the hue is the only difference between the two', () => {
        expect(STATUS_DOT_BLINK_MS).toBe(2000);
        expect(STATUS_DOT_BLINK_HALF_MS).toBe(STATUS_DOT_BLINK_MS / 2);
        expect(statusDotBlinks('working')).toBe(statusDotBlinks('compacting'));
    });

    it('blinks for busy and nothing else', () => {
        // The waiting state pulsed before DROVE-231 and does not now. A blink
        // means the session is burning tokens; three blinkers would make the
        // rhythm say nothing, and at 7pt the eye reads rhythm before hue.
        const still: StatusDotState[] = ['connected', 'waiting', 'recentlyDisconnected', 'disconnected'];
        for (const state of still) expect(statusDotBlinks(state), state).toBe(false);
    });
});

describe('precedence', () => {
    it('says disconnected over working, whatever a stale snapshot claims', () => {
        // Presence can drop while a snapshot taken thirty seconds ago still
        // says the main thread is busy. A blue dot on a session the phone
        // cannot reach is the strip lying about the one thing it is for.
        expect(statusDotState({ ...base, online: false, mainWorking: true })).toBe('recentlyDisconnected');
    });

    it('says working over waiting', () => {
        expect(statusDotState({ ...base, mainWorking: true, waiting: true })).toBe('working');
    });

    it('says waiting over idle', () => {
        expect(statusDotState({ ...base, waiting: true })).toBe('waiting');
        expect(statusDotColors.waiting).toBe('#FF9500');
    });
});

describe('the word is gone, so the label carries it', () => {
    it('names every state out loud', () => {
        const states: StatusDotState[] = [
            'connected', 'working', 'waiting', 'recentlyDisconnected', 'disconnected', 'compacting',
        ];
        for (const state of states) {
            expect(statusDotLabels[state], state).toBeTruthy();
            expect(statusDotColors[state], state).toMatch(/^#[0-9A-F]{6}$/);
        }
    });

    it('gives yellow and amber different hues, since they are different states', () => {
        expect(statusDotColors.recentlyDisconnected).not.toBe(statusDotColors.waiting);
    });
});
