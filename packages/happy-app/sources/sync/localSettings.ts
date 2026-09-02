import * as z from 'zod';

//
// Schema
//

/**
 * How far read-aloud got in one session on THIS device (DROVE-193).
 *
 * Clay force-quits and reopens the app constantly, because that is how every
 * OTA reaches him, and every launch used to start the reply over from the
 * top. DROVE-126's spoken-once invariant is a field on the in-process
 * timeline, so a fresh process has no timeline, no `queuedChunks`, and every
 * sentence looks unread. This is that invariant written down.
 *
 * WHAT IS KEYED, and it is not a sentence index. The timeline is rebuilt on
 * every launch out of whatever pages the fetch happens to return, and each
 * message is re-split from its text, so index 47 in the old process points
 * at something else entirely in the new one. `key` is the message's own
 * identity — the same key the reader's dedupe already uses, prefixed
 * `aside:` or `thinking:` for the two non-prose strands so a title cannot be
 * confused with a sentence of the reply — and `ordinal` is the position
 * within it. A message id comes from the server and survives a re-fetch; an
 * ordinal only has to survive ITS OWN message being re-split, and a message
 * that is not still streaming does not re-split at all.
 *
 * `createdAt` is the ordering the timeline itself sorts by, and it is what
 * makes "everything older than this was spoken too" decidable from one
 * entry instead of a set of every id ever said.
 *
 * `at` is when the mark was written. Only the prune reads it.
 */
export const ReadAloudResumeMarkSchema = z.object({
    key: z.string(),
    createdAt: z.number(),
    ordinal: z.number(),
    at: z.number(),
});

export type ReadAloudResumeMark = z.infer<typeof ReadAloudResumeMarkSchema>;

/**
 * How many sessions keep a read position. One mark per session, not a set of
 * every sentence ever spoken, and the oldest is dropped once there are more
 * than this — so the store is bounded by a number rather than by how long he
 * has owned the phone.
 */
export const readAloudResumeLimit = 32;

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
    // Where read-aloud got to in each session, on THIS handset (DROVE-193).
    // Device-local for the reason the switch above it is: what he heard on
    // the phone on the walk to the car is not what the watch said in his ear,
    // and a synced position would have one surface skip what the other read.
    // Bounded to `readAloudResumeLimit` entries and dropped with the session.
    readAloudResume: z.record(z.string(), ReadAloudResumeMarkSchema).describe('Where read-aloud got to per session on this device'),
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
    readAloudResume: {},
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

//
// Read positions (DROVE-193)
//

/**
 * Write one session's read position, keeping the store bounded.
 *
 * A plain function so the bound is testable without a store: the caller owns
 * WHEN a mark is written, this owns how many are kept. Returns the record
 * unchanged when nothing moved, so a no-op write cannot churn the store.
 */
export function applyReadAloudResume(
    marks: Record<string, ReadAloudResumeMark>,
    sessionId: string,
    mark: Omit<ReadAloudResumeMark, 'at'>,
    at: number,
): Record<string, ReadAloudResumeMark> {
    const current = marks[sessionId];
    if (current !== undefined
        && current.key === mark.key
        && current.createdAt === mark.createdAt
        && current.ordinal === mark.ordinal) {
        return marks;
    }
    const next: Record<string, ReadAloudResumeMark> = { ...marks, [sessionId]: { ...mark, at } };
    const ids = Object.keys(next);
    if (ids.length <= readAloudResumeLimit) return next;
    // Oldest first, and the session just written is the newest by
    // construction, so it can never be the one dropped.
    ids.sort((a, b) => (next[a]?.at ?? 0) - (next[b]?.at ?? 0));
    for (const id of ids.slice(0, ids.length - readAloudResumeLimit)) delete next[id];
    return next;
}

/** The session is gone, so its position goes with it (DROVE-193). */
export function pruneReadAloudResume(
    marks: Record<string, ReadAloudResumeMark>,
    sessionId: string,
): Record<string, ReadAloudResumeMark> {
    if (marks[sessionId] === undefined) return marks;
    const { [sessionId]: _dropped, ...rest } = marks;
    return rest;
}
