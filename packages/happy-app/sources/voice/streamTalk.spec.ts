import { describe, expect, it } from 'vitest';
import { flipStreamTalk, streamTalkButton, streamTalkIcon } from './streamTalk';
import { applyLocalSettings, localSettingsDefaults, localSettingsParse } from '@/sync/localSettings';

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
