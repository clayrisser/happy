import * as z from 'zod';
import { AgentDefaultOverridesSchema } from './agentDefaults';
import { DEFAULT_USER_MESSAGE_BUBBLE_COLOR } from '../utils/userMessageBubbleColor';

//
// Settings Schema
//

// Current schema version for backward compatibility
export const SUPPORTED_SCHEMA_VERSION = 2;


// How the home session list lays out: one activity-sorted flat list, or the
// project-card hierarchy grouped by machine and repository.
export const SESSION_LIST_GROUPING_MODES = ['flat', 'project'] as const;
export type SessionListGrouping = typeof SESSION_LIST_GROUPING_MODES[number];

// Soft wrap for monospace cards (DROVE-95): terminal cards (CommandView) and
// fenced code blocks, each toggled by a double-tap on the card. One preference
// with two targets, so one nested value rather than two flat keys. Both fields
// optional: a partial object from another app version merges instead of
// failing the whole settings parse. Default off, the horizontal scroll.
export const CODE_WRAP_KINDS = ['terminal', 'code'] as const;
export type CodeWrapKind = typeof CODE_WRAP_KINDS[number];
export const CodeWrapSchema = z.object({
    terminal: z.boolean().optional(),
    code: z.boolean().optional(),
});
export type CodeWrap = z.infer<typeof CodeWrapSchema>;

// Stream-talk voice (DROVE-97): which installed voice reads replies aloud,
// how fast and how high, and how far behind the text the voice may fall
// before it skips ahead. One nested value, like codeWrap, so a partial
// object from another app version merges instead of failing the parse. The
// voice identifier is per-device in practice (an iPad may not have the
// iPhone's voice installed), so a missing voice falls back to the best
// installed one rather than to silence.
export const StreamTalkSchema = z.object({
    voiceId: z.string().nullable().optional(),
    rate: z.number().optional(),
    pitch: z.number().optional(),
    maxLagSeconds: z.number().optional(),
});
export type StreamTalk = z.infer<typeof StreamTalkSchema>;

/**
 * AVSpeechUtterance takes a rate from 0 to 1 and the default of 0.5 reads
 * slower than most people want for prose they are half-listening to. The
 * slider covers the range that still sounds like a person.
 */
export const streamTalkRateRange = { min: 0.4, max: 0.6 } as const;
/** AVSpeechUtterance.pitchMultiplier accepts 0.5 to 2.0. */
export const streamTalkPitchRange = { min: 0.5, max: 2.0 } as const;
/** Seconds the voice may lag the text before it drops the backlog. */
export const streamTalkLagRange = { min: 10, max: 30 } as const;

export const streamTalkDefaults: Required<StreamTalk> = {
    voiceId: null,
    rate: 0.52,
    pitch: 1.0,
    maxLagSeconds: 15,
};
// The three feedback channels and how audio may answer (DROVE-72). Clay's
// four ways of working (silent haptic, eyes-free audio, direct, hands-free
// voice) are saved COMBINATIONS of these four keys, never code paths, and a
// mode is derived from them rather than stored: a label that can disagree with
// the switches under it is worse than none. Flat, one key per switch, so a
// device that knows only some of them merges the rest untouched.
//
// These are THIS PHONE's switches, the same way the wrist has its own: a
// buzz Clay cannot silence from the device in his hand is the failure the
// local layer exists to prevent. Every write is also mirrored to the bus on
// each connected Mac (droverChannels.mirrorToMachines), which is where the
// event's `delivery` is stamped for the terminal, the push and the wrist.
export const DROVER_ANSWER_AUDIO = ['off', 'click', 'speech', 'both'] as const;
export type DroverAnswerAudio = typeof DROVER_ANSWER_AUDIO[number];

// Which device speaks a reply (DROVE-92): the phone, the watch, or whichever
// one currently has headphones on its audio route, else the phone. A string
// rather than an enum so a value from a newer app version parses instead of
// failing the whole settings object; resolveSpeakReplies maps anything it
// does not know back to auto.
export const speakerChoices = ['phone', 'watch', 'auto'] as const;
export type SpeakerChoice = typeof speakerChoices[number];
export const SpeakRepliesSchema = z.object({
    on: z.string().optional(),
});
export type SpeakReplies = z.infer<typeof SpeakRepliesSchema>;
export const speakRepliesDefault: SpeakerChoice = 'auto';

export const SettingsSchema = z.object({
    // Schema version for compatibility detection
    schemaVersion: z.number().default(SUPPORTED_SCHEMA_VERSION).describe('Settings schema version for compatibility checks'),

    viewInline: z.boolean().describe('Legacy inline tool-call preference (no longer used)'),
    inferenceOpenAIKey: z.string().nullish().describe('OpenAI API key for inference'),
    expandTodos: z.boolean().describe('Legacy todo expansion preference (no longer used)'),
    showLineNumbers: z.boolean().describe('Legacy diff line-number preference (no longer used)'),
    showLineNumbersInToolViews: z.boolean().describe('Whether to show line numbers in tool view diffs'),
    wrapLinesInDiffs: z.boolean().describe('Legacy diff line-wrapping preference (no longer used)'),
    diffStyle: z.enum(['unified', 'split']).describe('Diff view style (split is web-only)'),
    analyticsOptOut: z.boolean().describe('Whether to opt out of anonymous analytics'),
    experiments: z.boolean().describe('Enable current experiments: the Rig session file browser and the Usage settings page'),
    alwaysShowContextSize: z.boolean().describe('Always show context size in agent input'),
    agentInputEnterToSend: z.boolean().describe('Whether pressing Enter submits/sends in the agent input (web)'),
    // Kept as a free string for cross-version sync; normalized on read by
    // normalizeAvatarStyle so unknown values fall back to brutalist.
    avatarStyle: z.string().describe('Generated avatar style: brutalist, pixelated, or gradient'),
    avatarMonochrome: z.boolean().describe('Render generated avatars in black and white'),
    sessionListGrouping: z.enum(SESSION_LIST_GROUPING_MODES).describe('Home session list layout: flat activity list or grouped by project'),
    // Cattle Drover account filter (BASED-98). Empty string = show every
    // account; otherwise only sessions stamped with this account. A free
    // string rather than an enum: accounts are user-defined and sync across
    // devices that may not know the same set.
    droverAccountFilter: z.string().describe('Show only Cattle Drover sessions for this account; empty shows all'),
    // Keep the legacy key for synced settings compatibility. It controls the
    // harness badges in the session list.
    showFlavorIcons: z.boolean().describe('Whether to show harness icons in the session list'),
    showHarnessIconInSessionHeader: z.boolean().describe('Whether to show the harness icon in the session header'),
    userMessageBubbleColor: z.string().describe('User message bubble color preset'),
    usageLimitShowRemaining: z.boolean().describe('Show plan rate limits as quota remaining instead of quota used'),
    codeWrap: CodeWrapSchema.describe('Soft-wrap monospace text in terminal cards and code blocks, toggled by double-tap'),
    streamTalk: StreamTalkSchema.describe('Read-aloud voice: chosen voice identifier, rate, pitch and the lag threshold before skipping ahead'),
    speakReplies: SpeakRepliesSchema.describe('Which device speaks replies aloud: phone, watch, or auto (the one whose audio route has headphones, else the phone)'),
    droverAnnounceVisual: z.boolean().describe('Visual channel: the alert push and the gum client announce a Cattle Drover prompt'),
    droverAnnounceHaptic: z.boolean().describe('Haptic channel: the phone taps and the wrist buzzes when a Cattle Drover prompt arrives'),
    droverAnnounceAudio: z.boolean().describe('Audio channel: a Cattle Drover prompt is spoken aloud when it arrives'),
    droverAnswerAudio: z.enum(DROVER_ANSWER_AUDIO).describe('How audio may answer a prompt: off, a headphone click, dictation, or both'),

    // Drives the archive-visibility toggle: it hides archived sessions, not
    // merely disconnected ones. The key keeps its original name because these
    // settings sync between devices and app versions field by field, with no
    // rename migration to carry an old key across.
    hideInactiveSessions: z.boolean().describe('Hide archived sessions in the main list'),
    sortSessionsByActivity: z.boolean().describe('Legacy session sort preference (no longer used)'),
    // Resume is capability-driven; this legacy rollout key still protects the
    // newer fork/duplicate RPC on older daemons.
    expResumeSession: z.boolean().describe('Enable session fork and duplicate actions'),
    fileDiffsSidebar: z.boolean().describe('Show the file diffs sidebar next to the chat on desktop'),
    groupToolCalls: z.boolean().describe('Collapse consecutive tool calls into grouped containers in chat'),
    compactToolCalls: z.boolean().describe('Render non-interactive tool calls as compact one-line rows'),
    reviewPromptAnswered: z.boolean().describe('Whether the review prompt has been answered'),
    reviewPromptLikedApp: z.boolean().nullish().describe('Whether user liked the app when asked'),
    voiceAssistantLanguage: z.string().nullable().describe('Preferred language for voice assistant (null for auto-detect)'),
    voiceCustomAgentId: z.string().nullable().describe('Custom ElevenLabs agent ID (null to use Happy default)'),
    voiceBypassToken: z.boolean().describe('Bypass Happy server token and connect directly to ElevenLabs (requires custom agent ID)'),
    preferredLanguage: z.string().nullable().describe('Preferred UI language (null for auto-detect from device locale)'),
    recentMachinePaths: z.array(z.object({
        machineId: z.string(),
        path: z.string()
    })).describe('Last 10 machine-path combinations, ordered by most recent first'),
    lastUsedAgent: z.string().nullable().describe('Last selected agent type for new sessions'),
    lastUsedPermissionMode: z.string().nullable().describe('Last selected permission mode for new sessions'),
    lastUsedModelMode: z.string().nullable().describe('Last selected model mode for new sessions'),
    agentDefaultOverrides: AgentDefaultOverridesSchema.describe('User-selected agent defaults. Missing values use code defaults and are not sent as agent metadata.'),
    // Dismissed CLI warning banners (supports both per-machine and global dismissal)
    dismissedCLIWarnings: z.object({
        perMachine: z.record(z.string(), z.object({
            claude: z.boolean().optional(),
            codex: z.boolean().optional(),
            gemini: z.boolean().optional(),
            openclaw: z.boolean().optional(),
        })).default({}),
        global: z.object({
            claude: z.boolean().optional(),
            codex: z.boolean().optional(),
            gemini: z.boolean().optional(),
            openclaw: z.boolean().optional(),
        }).default({}),
    }).default({ perMachine: {}, global: {} }).describe('Tracks which CLI installation warnings user has dismissed (per-machine or globally)'),
});

//
// NOTE: Settings must be a flat object with no to minimal nesting, one field == one setting,
// you can name them with a prefix if you want to group them, but don't nest them.
// You can nest if value is a single value (like image with url and width and height)
// Settings are always merged with defaults and field by field.
//
// This structure must be forward and backward compatible. Meaning that some versions of the app
// could be missing some fields or have a new fields. Everything must be preserved and client must
// only touch the fields it knows about.
//

const SettingsSchemaPartial = SettingsSchema.partial();

export type Settings = z.infer<typeof SettingsSchema>;

//
// Defaults
//

export const settingsDefaults: Settings = {
    schemaVersion: SUPPORTED_SCHEMA_VERSION,
    viewInline: false,
    inferenceOpenAIKey: null,
    expandTodos: true,
    showLineNumbers: true,
    showLineNumbersInToolViews: false,
    wrapLinesInDiffs: true,
    diffStyle: 'unified',
    analyticsOptOut: false,
    experiments: false,
    alwaysShowContextSize: false,
    agentInputEnterToSend: true,
    avatarStyle: 'brutalist',
    avatarMonochrome: false,
    sessionListGrouping: 'flat',
    droverAccountFilter: '',
    showFlavorIcons: false,
    showHarnessIconInSessionHeader: true,
    userMessageBubbleColor: DEFAULT_USER_MESSAGE_BUBBLE_COLOR,
    usageLimitShowRemaining: false,
    codeWrap: { terminal: false, code: false },
    streamTalk: { ...streamTalkDefaults },
    speakReplies: { on: speakRepliesDefault },
    // Visual and haptic on, matching the bus's built-in defaults: the push and
    // the wrist buzz are what Clay already has. Audio off until DROVE-73's
    // measurements say what answering by click costs.
    droverAnnounceVisual: true,
    droverAnnounceHaptic: true,
    droverAnnounceAudio: false,
    droverAnswerAudio: 'off',

    hideInactiveSessions: true,
    sortSessionsByActivity: true,
    expResumeSession: true,
    fileDiffsSidebar: false,
    groupToolCalls: false,
    // Full tool views by default: edit diffs render inline in the chat.
    compactToolCalls: false,
    reviewPromptAnswered: false,
    reviewPromptLikedApp: null,
    voiceAssistantLanguage: null,
    voiceCustomAgentId: null,
    voiceBypassToken: false,
    preferredLanguage: null,
    recentMachinePaths: [],
    lastUsedAgent: null,
    lastUsedPermissionMode: null,
    lastUsedModelMode: null,
    agentDefaultOverrides: {},
    dismissedCLIWarnings: { perMachine: {}, global: {} },
};
Object.freeze(settingsDefaults);

//
// Resolving
//

export function settingsParse(settings: unknown): Settings {
    // Handle null/undefined/invalid inputs
    if (!settings || typeof settings !== 'object') {
        return { ...settingsDefaults };
    }

    const parsed = SettingsSchemaPartial.safeParse(settings);
    if (!parsed.success) {
        // For invalid settings, preserve unknown fields but use defaults for known fields
        const unknownFields = { ...(settings as any) };
        // Remove all known schema fields from unknownFields
        const knownFields = Object.keys(SettingsSchema.shape);
        knownFields.forEach(key => delete unknownFields[key]);
        return { ...settingsDefaults, ...unknownFields };
    }

    // Migration: Convert old 'zh' language code to 'zh-Hans'
    if (parsed.data.preferredLanguage === 'zh') {
        console.log('[Settings Migration] Converting language code from "zh" to "zh-Hans"');
        parsed.data.preferredLanguage = 'zh-Hans';
    }

    // Merge defaults, parsed settings, and preserve unknown fields
    const unknownFields = { ...(settings as any) };
    // Remove known fields from unknownFields to preserve only the unknown ones
    Object.keys(parsed.data).forEach(key => delete unknownFields[key]);

    return { ...settingsDefaults, ...parsed.data, ...unknownFields };
}

//
// Applying changes
// NOTE: May be something more sophisticated here around defaults and merging, but for now this is fine.
//

export function applySettings(settings: Settings, delta: Partial<Settings>): Settings {
    // Original behavior: start with settings, apply delta, fill in missing with defaults
    const result = { ...settings, ...delta };

    // Fill in any missing fields with defaults
    Object.keys(settingsDefaults).forEach(key => {
        if (!(key in result)) {
            (result as any)[key] = (settingsDefaults as any)[key];
        }
    });

    return result;
}

export function settingsToSyncPayload(settings: Settings): Partial<Settings> {
    const result: Partial<Settings> = { ...settings };
    const compactAgentOverrides = Object.fromEntries(
        Object.entries(settings.agentDefaultOverrides ?? {}).filter(([, value]) => (
            value && typeof value === 'object' && Object.keys(value).length > 0
        )),
    ) as Settings['agentDefaultOverrides'];
    if (Object.keys(compactAgentOverrides).length === 0) {
        delete result.agentDefaultOverrides;
    } else {
        result.agentDefaultOverrides = compactAgentOverrides;
    }
    return result;
}

//
// Code wrap (DROVE-95)
//

export function isCodeWrapOn(settings: Pick<Settings, 'codeWrap'>, kind: CodeWrapKind): boolean {
    return settings.codeWrap?.[kind] === true;
}

/** The delta that flips one kind and leaves the other as it was. */
export function toggleCodeWrap(settings: Pick<Settings, 'codeWrap'>, kind: CodeWrapKind): Pick<Settings, 'codeWrap'> {
    return {
        codeWrap: {
            ...(settings.codeWrap ?? {}),
            [kind]: !isCodeWrapOn(settings, kind),
        },
    };
}

//
// Stream-talk voice (DROVE-97)
//

function clamp(value: number | undefined, fallback: number, range: { min: number; max: number }): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
    return Math.min(range.max, Math.max(range.min, value));
}

/**
 * The stream-talk settings with every field present and inside its range,
 * whatever a synced partial object from another app version left out or
 * pushed past the slider.
 */
export function resolveStreamTalk(settings: Pick<Settings, 'streamTalk'>): Required<StreamTalk> {
    const raw = settings.streamTalk ?? {};
    return {
        voiceId: typeof raw.voiceId === 'string' && raw.voiceId.length > 0 ? raw.voiceId : null,
        rate: clamp(raw.rate, streamTalkDefaults.rate, streamTalkRateRange),
        pitch: clamp(raw.pitch, streamTalkDefaults.pitch, streamTalkPitchRange),
        maxLagSeconds: clamp(raw.maxLagSeconds, streamTalkDefaults.maxLagSeconds, streamTalkLagRange),
    };
}

/** The delta that changes some stream-talk fields and keeps the rest. */
export function updateStreamTalk(settings: Pick<Settings, 'streamTalk'>, patch: Partial<StreamTalk>): Pick<Settings, 'streamTalk'> {
    return { streamTalk: { ...resolveStreamTalk(settings), ...patch } };
}

//
// Which device speaks (DROVE-92)
//

/** The speaker choice, with anything unknown or missing read as auto. */
export function resolveSpeakReplies(settings: Pick<Settings, 'speakReplies'>): SpeakerChoice {
    const on = settings.speakReplies?.on;
    return (speakerChoices as readonly string[]).includes(on ?? '') ? (on as SpeakerChoice) : speakRepliesDefault;
}
