import * as z from 'zod';

//
// Schema
//

export const LocalSettingsSchema = z.object({
    // Developer settings (device-specific)
    debugMode: z.boolean().describe('Enable debug logging'),
    devModeEnabled: z.boolean().describe('Enable developer menu in settings'),
    voiceUpsellOverride: z.enum(['control', 'show-paywall-before-first-voice-chat', 'voice-onboarding-and-upsell']).nullable().describe('Developer-only local override for the voice-upsell PostHog flag'),
    commandPaletteEnabled: z.boolean().describe('Enable CMD+K command palette (web only)'),
    themePreference: z.enum(['light', 'dark', 'adaptive']).describe('Theme preference: light, dark, or adaptive (follows system)'),
    markdownCopyV2: z.boolean().describe('Replace native paragraph selection with long-press modal for full markdown copy'),
    consoleLoggingEnabled: z.boolean().describe('Enable console output in production builds'),
    verboseLogging: z.boolean().describe('Log all network requests and responses'),
    zenMode: z.boolean().describe('Hide all sidebars and non-essential UI for focused work'),
    // Right file sidebar: which panels the user has opened and which is active.
    // Persisted so the layout survives reloads and long absences.
    sidebarPanelsOpen: z.array(z.enum(['changes', 'allFiles', 'sideChat'])).describe('Open right-sidebar panels, in tab order'),
    sidebarPanelActive: z.enum(['changes', 'allFiles', 'sideChat']).nullable().describe('Currently active right-sidebar panel (null shows the picker)'),
    // Voice (DROVE-30). Device-local, not synced: a phone reads replies
    // aloud on the walk to the car, a desktop with the terminal right there
    // almost never should.
    readAloudEnabled: z.boolean().describe('Read assistant replies aloud as they arrive'),
    voiceDictationEnabled: z.boolean().describe('Show the press-and-hold talk button in the composer'),
    // Whether the sentence tap has ever been used on this device (DROVE-195).
    // Not a preference and not shown in Settings: it is what retires the hint
    // on the read-aloud toast. DROVE-163 changed the gesture from a double tap
    // to a single one and nothing announced it, so Clay kept reaching for the
    // old one and concluding the feature was broken. The toast tells him until
    // he has done it once, then stops.
    sentenceTapUsed: z.boolean().describe('The tap-a-sentence-to-read-from-there gesture has been used on this device'),
    // Haptics on THIS handset, off by default (DROVE-190). The wrist is the
    // surface meant to tap Clay; the phone buzzing for the same events is
    // duplicate noise, and it fires in his pocket while a reply is read
    // aloud. Device-local on purpose: the watch buzzes off the synced
    // droverAnnounceHaptic channel and no watch code reads this key. One
    // switch covers both notification and interaction haptics; see
    // utils/hapticKinds.ts for why there is not a second one.
    phoneHaptics: z.boolean().describe('Let this phone buzz: session announcements and touch feedback alike. The watch is unaffected'),
    // The channel demo doubles as onboarding (DROVE-75): shown once, on the
    // first authenticated launch, then reachable from Settings. Device-local
    // because the thing being learned is what THIS phone's buzz feels like.
    droverDemoSeenAt: z.number().nullable().describe('When the channel demo was first shown on this device; null until it has been'),
    // CLI version acknowledgments - keyed by machineId
    acknowledgedCliVersions: z.record(z.string(), z.string()).describe('Acknowledged CLI versions per machine'),
    // Collapsed Rig projects in the session list - keyed by project id
    collapsedProjects: z.record(z.string(), z.boolean()).describe('Collapsed state per sidebar project'),
});

//
// NOTE: Local settings are device-specific and should NOT be synced.
// These are preferences that make sense to be different on each device.
//

const LocalSettingsSchemaPartial = LocalSettingsSchema.passthrough().partial();

export type LocalSettings = z.infer<typeof LocalSettingsSchema>;

//
// Defaults
//

export const localSettingsDefaults: LocalSettings = {
    debugMode: false,
    devModeEnabled: false,
    voiceUpsellOverride: null,
    commandPaletteEnabled: false,
    themePreference: 'adaptive',
    markdownCopyV2: false,
    consoleLoggingEnabled: false,
    verboseLogging: false,
    zenMode: false,
    readAloudEnabled: false,
    voiceDictationEnabled: true,
    sentenceTapUsed: false,
    phoneHaptics: false,
    droverDemoSeenAt: null,
    sidebarPanelsOpen: [],
    sidebarPanelActive: null,
    acknowledgedCliVersions: {},
    collapsedProjects: {},
};
Object.freeze(localSettingsDefaults);

//
// Parsing
//

export function localSettingsParse(settings: unknown): LocalSettings {
    const parsed = LocalSettingsSchemaPartial.safeParse(settings);
    if (!parsed.success) {
        return { ...localSettingsDefaults };
    }
    return { ...localSettingsDefaults, ...parsed.data };
}

//
// Applying changes
//

export function applyLocalSettings(settings: LocalSettings, delta: Partial<LocalSettings>): LocalSettings {
    return { ...localSettingsDefaults, ...settings, ...delta };
}
