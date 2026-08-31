import { describe, expect, it } from 'vitest';

import { channelReadout, findDroverSettings, readoutIsEmpty } from './channelReadout';

/**
 * The readout reads DROVE-72's keys off whatever has landed (DROVE-75). On a
 * tip where nothing has, every row says "not set" rather than inventing a
 * default; the moment a source carries a key, that key shows.
 */
describe('the channel readout', () => {
    it('says not set for everything when no source has the keys', () => {
        const readout = channelReadout(undefined, null, {}, { onLimit: 'prompt' });
        expect(readout).toEqual({
            visual: 'not set',
            haptic: 'not set',
            audio: 'not set',
            answerAudio: 'not set',
            mode: 'not set',
        });
        expect(readoutIsEmpty(readout)).toBe(true);
    });

    it('reads the five flat keys DROVE-72 defines', () => {
        const readout = channelReadout({
            announceVisual: true,
            announceHaptic: false,
            announceAudio: true,
            answerAudio: 'click',
            mode: 'eyes-free-audio',
        });
        expect(readout).toEqual({
            visual: 'on',
            haptic: 'off',
            audio: 'on',
            answerAudio: 'click',
            mode: 'eyes-free-audio',
        });
        expect(readoutIsEmpty(readout)).toBe(false);
    });

    it('takes each key from the first source that has it', () => {
        const readout = channelReadout(
            { announceHaptic: false },
            { announceHaptic: true, announceVisual: true, mode: 'direct' },
        );
        expect(readout.haptic).toBe('off');
        expect(readout.visual).toBe('on');
        expect(readout.mode).toBe('direct');
    });

    it('tells an explicit null mode from an absent one', () => {
        // DROVE-72: a PATCH to any of the four keys sets `mode` back to null.
        // That is a real state, not a missing key.
        expect(channelReadout({ mode: null }).mode).toBe('none');
        expect(channelReadout({}).mode).toBe('not set');
    });

    it('does not read a garbage value as a toggle', () => {
        expect(channelReadout({ announceVisual: 'yes' }).visual).toBe('not set');
        expect(channelReadout({ announceVisual: 1 }).visual).toBe('not set');
        expect(channelReadout({ announceVisual: 'true' }).visual).toBe('on');
        expect(channelReadout({ answerAudio: 7 }).answerAudio).toBe('not set');
    });
});

describe('finding the bridge mirror in the store', () => {
    it('returns the first droverSettings object hung off any agentState', () => {
        const sessions = {
            a: { agentState: null },
            b: { agentState: { controlledByUser: true } },
            c: { agentState: { droverSettings: { announceHaptic: true } } },
        };
        expect(findDroverSettings(sessions)).toEqual({ announceHaptic: true });
    });

    it('is undefined on today\'s tip, where no session carries the key', () => {
        expect(findDroverSettings({ a: { agentState: { requests: {} } } })).toBeUndefined();
        expect(findDroverSettings({})).toBeUndefined();
        expect(findDroverSettings(undefined)).toBeUndefined();
    });
});
