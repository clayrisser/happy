import { describe, expect, it } from 'vitest';
import { applyLocalSettings, localSettingsDefaults, localSettingsParse } from './localSettings';

/**
 * The voice toggles are device-local and have to survive a restart, which for
 * local settings means surviving the save/parse round trip (DROVE-30).
 * applyLocalSettings writes through saveLocalSettings, and startup reads back
 * through localSettingsParse.
 */
describe('voice local settings', () => {
    it('starts silent, with dictation offered', () => {
        expect(localSettingsDefaults.readAloudEnabled).toBe(false);
        expect(localSettingsDefaults.voiceDictationEnabled).toBe(true);
    });

    it('survives the round trip a restart makes', () => {
        const chosen = applyLocalSettings(localSettingsDefaults, {
            readAloudEnabled: true,
            voiceDictationEnabled: false,
        });
        const reloaded = localSettingsParse(JSON.parse(JSON.stringify(chosen)));
        expect(reloaded.readAloudEnabled).toBe(true);
        expect(reloaded.voiceDictationEnabled).toBe(false);
    });

    it('reads an older settings file, from before these existed, as the defaults', () => {
        const before = { themePreference: 'dark' as const };
        const reloaded = localSettingsParse(before);
        expect(reloaded.readAloudEnabled).toBe(false);
        expect(reloaded.voiceDictationEnabled).toBe(true);
        expect(reloaded.themePreference).toBe('dark');
    });

    it('falls back to silent when the stored value is not a boolean', () => {
        const reloaded = localSettingsParse({ readAloudEnabled: 'yes' });
        expect(reloaded.readAloudEnabled).toBe(false);
    });
});
