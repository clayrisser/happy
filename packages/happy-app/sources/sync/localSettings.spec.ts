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

/**
 * Phone haptics ship OFF and stay however Clay left them (DROVE-190).
 *
 * The switch is new, so every install that existed before it has a settings
 * file with no `phoneHaptics` key at all. Two things have to be true of that
 * file, and neither is obvious enough to leave to the schema's good manners:
 * it must read as OFF, and reading it must not cost the user the settings
 * they DID set. `LocalSettingsSchema` declares every key required, and only
 * the `.passthrough().partial()` wrapper in `localSettingsParse` stops a
 * missing key failing the parse and resetting the lot to defaults. Swap that
 * wrapper for the strict schema and every old install loses everything,
 * silently. This is the test that fails when someone does.
 */
describe('phone haptics survive the upgrade that introduced them', () => {
    it('ships off, which is the whole point of the ticket', () => {
        expect(localSettingsDefaults.phoneHaptics).toBe(false);
    });

    it('a settings file written before the switch existed reads as off', () => {
        const before = { themePreference: 'dark' as const, readAloudEnabled: true };
        expect(localSettingsParse(before).phoneHaptics).toBe(false);
    });

    it('and adding the key costs that file none of its other settings', () => {
        // The clobber this guards: a required key added to the schema turning
        // an old file into a parse failure, which localSettingsParse answers
        // with a wholesale reset.
        const before = {
            themePreference: 'dark' as const,
            readAloudEnabled: true,
            voiceDictationEnabled: false,
            zenMode: true,
        };
        const reloaded = localSettingsParse(before);
        expect(reloaded.themePreference).toBe('dark');
        expect(reloaded.readAloudEnabled).toBe(true);
        expect(reloaded.voiceDictationEnabled).toBe(false);
        expect(reloaded.zenMode).toBe(true);
    });

    it('a user who turned it on keeps it on across the restart', () => {
        const chosen = applyLocalSettings(localSettingsDefaults, { phoneHaptics: true });
        const reloaded = localSettingsParse(JSON.parse(JSON.stringify(chosen)));
        expect(reloaded.phoneHaptics).toBe(true);
    });

    it('and can turn it back off again, which must not read as absent', () => {
        // `false` is a value here, not a gap: the parse spreads defaults first
        // and stored keys over them, so an explicit false has to win the same
        // way an explicit true does.
        const chosen = applyLocalSettings(localSettingsDefaults, { phoneHaptics: false });
        expect(localSettingsParse(JSON.parse(JSON.stringify(chosen))).phoneHaptics).toBe(false);
    });

    it('falls back to off when the stored value is not a boolean', () => {
        expect(localSettingsParse({ phoneHaptics: 'yes' }).phoneHaptics).toBe(false);
    });
});
