import { describe, expect, it } from 'vitest';
import { flipStreamTalk, streamTalkButton, streamTalkIcon } from './streamTalk';
import { applyLocalSettings, localSettingsDefaults, localSettingsParse } from '@/sync/localSettings';
import { settingsDefaults } from '@/sync/settings';
import { en } from '@/text/_default';

describe('streamTalkButton', () => {
    it('is hidden when the surface has no reader', () => {
        const button = streamTalkButton(undefined);
        expect(button.shown).toBe(false);
        expect(button.on).toBe(false);
    });

    it('draws a filled speaker when stream-talk is on', () => {
        const button = streamTalkButton(true);
        expect(button).toEqual({
            shown: true,
            on: true,
            icon: 'volume-high',
            labelKey: 'agentInput.streamTalk.on',
        });
    });

    it('draws a slashed speaker when stream-talk is off', () => {
        const button = streamTalkButton(false);
        expect(button).toEqual({
            shown: true,
            on: false,
            icon: 'volume-mute-outline',
            labelKey: 'agentInput.streamTalk.off',
        });
    });

    it('uses the same icon rule the sheet and the settings row can share', () => {
        expect(streamTalkIcon(true)).toBe('volume-high');
        expect(streamTalkIcon(false)).toBe('volume-mute-outline');
    });
});

describe('flipStreamTalk', () => {
    it('turns it on and says so', () => {
        expect(flipStreamTalk(false)).toEqual({ readAloudEnabled: true, toastKey: 'agentInput.streamTalk.on' });
    });

    it('turns it off and says so', () => {
        expect(flipStreamTalk(true)).toEqual({ readAloudEnabled: false, toastKey: 'agentInput.streamTalk.off' });
    });

    it('flips the one local key the sheet and Settings > Voice flip', () => {
        // The composer button, the channel sheet row and the settings switch
        // all write localSettings.readAloudEnabled through useLocalSettingMutable;
        // there is no second key for the composer to drift from.
        expect(localSettingsDefaults.readAloudEnabled).toBe(false);
        const on = applyLocalSettings(localSettingsDefaults, { readAloudEnabled: flipStreamTalk(false).readAloudEnabled });
        expect(on.readAloudEnabled).toBe(true);
        expect(localSettingsParse(on).readAloudEnabled).toBe(true);
        const off = applyLocalSettings(on, { readAloudEnabled: flipStreamTalk(on.readAloudEnabled).readAloudEnabled });
        expect(off.readAloudEnabled).toBe(false);
    });
});

/**
 * DROVE-100: the toast has to say which of the two audio settings moved, or
 * the button reads as the one on the channel sheet that speaks prompts.
 */
describe('the toast names what it flipped', () => {
    it('says it is reading replies, not a bare on', () => {
        expect(en.agentInput.streamTalk.on).toBe('Reading replies aloud');
        expect(en.agentInput.streamTalk.off).toBe('Not reading replies aloud');
    });

    it('uses the same words as the read-replies row on the channel sheet', () => {
        expect(en.agentInput.channels.readReplies).toBe('Read replies aloud');
        expect(en.agentInput.streamTalk.on).toContain('replies aloud');
    });

    it('never flips the drover audio channel', () => {
        // The button writes readAloudEnabled and nothing else; droverAnnounceAudio
        // is synced and only the "Speak prompts when they arrive" row moves it.
        const flipped = flipStreamTalk(false);
        expect(Object.keys(flipped)).toEqual(['readAloudEnabled', 'toastKey']);
        expect(settingsDefaults.droverAnnounceAudio).toBe(false);
    });
});
