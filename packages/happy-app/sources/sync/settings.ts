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

// Soft wrap for monospace cards: terminal cards (CommandView) and fenced code
// blocks, each toggled by a double-tap on the card. One preference with two
// targets, so one nested value rather than two flat keys. Both fields
// optional: a partial object from another app version merges instead of
// failing the whole settings parse.
//
// Wrapping is the default (DROVE-149). Horizontal scrolling is the exception
// you reach for when column alignment matters, so the stored value names the
// kinds that SCROLL and an absent kind wraps.
//
// The key is new rather than a flipped default on DROVE-95's codeWrap,
// because settings sync POSTs the whole settings object: every account that
// changed any setting after DROVE-95 already has codeWrap {terminal: false,
// code: false} on the server, and a flipped default would read as "off" for
// all of them. An older app version ignores codeScroll and keeps its own
// behavior, which is what it had anyway.
export const CODE_WRAP_KINDS = ['terminal', 'code'] as const;
export type CodeWrapKind = typeof CODE_WRAP_KINDS[number];
export const CodeWrapSchema = z.object({
    terminal: z.boolean().optional(),
    code: z.boolean().optional(),
});
export type CodeWrap = z.infer<typeof CodeWrapSchema>;
export const CodeScrollSchema = CodeWrapSchema;
export type CodeScroll = z.infer<typeof CodeScrollSchema>;

// Stream-talk voice (DROVE-97): which installed voice reads replies aloud,
// how fast and how high, and how much unspoken audio may pile up behind a
// reply still being written before it skips ahead (DROVE-108, which replaced
// a threshold on a sentence's AGE that fired on every long reply because
// speech is always slower than generation). One nested value, like codeWrap, so a partial
// object from another app version merges instead of failing the parse. The
// voice identifier is per-device in practice (an iPad may not have the
// iPhone's voice installed), so a missing voice falls back to the best
// installed one rather than to silence.
//
// DROVE-116 made the delivery four plain statements instead of one speed and
// one threshold: the normal speed, the fast speed, when to speed up, and when
// to jump. Clay: "you pick the speed you want it normally but then as it gets
// behind you pick the fast speed", and "we can also set when it jumps".
export const StreamTalkSchema = z.object({
    voiceId: z.string().nullable().optional(),
    rate: z.number().optional(),
    catchUpRate: z.number().optional(),
    pitch: z.number().optional(),
    maxBacklogSeconds: z.number().optional(),
    jumpBacklogSeconds: z.number().optional(),
});
export type StreamTalk = z.infer<typeof StreamTalkSchema>;

/**
 * AVSpeechUtterance takes a rate from 0 to 1 and the default of 0.5 reads
 * slower than most people want for prose they are half-listening to. The
 * slider covers the range that still sounds like a person.
 */
export const streamTalkRateRange = { min: 0.4, max: 0.6 } as const;
/**
 * The absolute rate the engine may be driven to, above the speed slider's own
 * maximum (DROVE-116).
 *
 * The slider bounds what the USER picks for ordinary prose. It must not also
 * bound what catching up may add on top, which is the bug that made the whole
 * catch-up a no-op: speechEngine clamped `rate * rateScale` back into
 * streamTalkRateRange, so at the slider's own maximum the product clamped
 * straight back to it and the voice never sped up at all. Anyone who likes
 * fast speech, which is exactly the person who wants catch-up, silently got
 * none of it. AVSpeechUtterance accepts up to 1.0 and the native module clamps
 * there; 0.85 is the fastest that still parses as speech rather than a chipmunk.
 */
export const streamTalkRateCeiling = 0.85;
/** The fast speed may sit anywhere from the normal floor up to that ceiling. */
export const streamTalkCatchUpRateRange = { min: streamTalkRateRange.min, max: streamTalkRateCeiling } as const;
/** AVSpeechUtterance.pitchMultiplier accepts 0.5 to 2.0. */
export const streamTalkPitchRange = { min: 0.5, max: 2.0 } as const;
/**
 * Seconds of UNSPOKEN AUDIO the voice may have queued behind a reply that is
 * still being written before it starts reading FASTER. Not a delay, and it
 * never applies to a finished reply, which is read to the end (DROVE-108).
 */
export const streamTalkBacklogRange = { min: 10, max: 30 } as const;
/**
 * Seconds of unspoken audio past which the tail is dropped outright.
 *
 * Its own setting since DROVE-116, rather than twice the speed-up threshold.
 * That derivation was not merely timid, it was self-defeating: the cut fired
 * at the same number the ramp STARTED at, so the ramp between the two never
 * ran and the voice jumped without ever having sped up. Kept strictly above
 * the speed-up threshold by resolveStreamTalk, so there is always a band in
 * which reading faster is tried first.
 */
export const streamTalkJumpRange = { min: 15, max: 120 } as const;

export const streamTalkDefaults: Required<StreamTalk> = {
    voiceId: null,
    rate: 0.52,
    // 1.5x the normal default, which is where audiobook listeners sit and is
    // well past the 1.15x ceiling DROVE-108 shipped with.
    catchUpRate: 0.78,
    pitch: 1.0,
    maxBacklogSeconds: 15,
    jumpBacklogSeconds: 45,
};

// The eyes-free audio cue system (DROVE-112): the ambient heartbeat, the
// one-shot earcons, and the spoken one-line titles of tool calls, terminal
// calls and agent spawns. One nested object, like streamTalk and codeWrap, so
// a partial from another app version merges instead of failing the parse.
//
// `muted` is a bag of cue ids rather than a switch per cue, because the cue
// table grows and a schema that has to grow with it turns every new sound into
// a settings migration. An id nothing recognises is simply never looked up.
export const AudioCuesSchema = z.object({
    on: z.boolean().optional(),
    heartbeat: z.boolean().optional(),
    volume: z.number().optional(),
    workingIntervalSeconds: z.number().optional(),
    waitingIntervalSeconds: z.number().optional(),
    muted: z.array(z.string()).optional(),
    speakTitles: z.boolean().optional(),
    speakAgentTitles: z.boolean().optional(),
    speakToolTitles: z.boolean().optional(),
    speakThinking: z.boolean().optional(),
    speakGates: z.boolean().optional(),
    titlesPerRun: z.number().optional(),
    toolCuesPerMinute: z.number().optional(),
    agentCuesPerMinute: z.number().optional(),
});
export type AudioCues = z.infer<typeof AudioCuesSchema>;

/**
 * Cue loudness AS A FRACTION OF THE VOICE (DROVE-341).
 *
 * 1 is the top because 1 means "as loud as a spoken sentence", which is what
 * Clay asked for and is also the sensible ceiling: a beep that shouts over the
 * voice is the opposite bug. Each cue then sits at its own level under that,
 * pinned in dB in sources/voice/cueLoudness.ts.
 *
 * This used to be described as sitting "on top of each cue's own gain", and it
 * was doing worse than that: the setting was multiplied into the rendered
 * samples AND into the player's volume, so the level came out squared.
 */
export const audioCueVolumeRange = { min: 0, max: 1 } as const;
/**
 * How often the ordinary WORKING pulse repeats. The floor is two seconds
 * because anything faster stops being ambient and starts being an alarm; the
 * ceiling is a minute, which is "tell me it is still alive" and little more.
 */
export const audioCueWorkingIntervalRange = { min: 2, max: 60 } as const;
/** How often a WAITING pulse repeats. Faster than working, by design. */
export const audioCueWaitingIntervalRange = { min: 1, max: 30 } as const;
/**
 * How many tool titles inside one RUN of consecutive tool calls are spoken
 * before the rest of the run goes unnamed. A run of thirty greps must not
 * become thirty spoken lines; two or three is enough to know what is going on.
 * Agent spawns are exempt, because that is the one Clay most wants to hear.
 */
export const audioCueTitlesPerRunRange = { min: 0, max: 10 } as const;
/**
 * Cap on EARCONS per minute, per lane. ZERO MEANS NO CAP, and zero is the
 * default (DROVE-174).
 *
 * DROVE-112 capped tool cues at 6 a minute and dropped the excess in silence,
 * which is exactly what Clay then asked to be undone: "when in reading mode,
 * every response and tool call should have a sound". A cap that silently eats
 * what he asked to hear is worse than no cap, so it is now a visible setting
 * that defaults to off. The rate is still bounded, by two things that do not
 * lie about it: a cue is dropped if it cannot be heard within four seconds of
 * the thing it is about, and it may only sound in a gap in the speech.
 */
export const audioCueRateRange = { min: 0, max: 240 } as const;

export const audioCuesDefaults: Required<AudioCues> = {
    on: true,
    heartbeat: true,
    // Level with the voice (DROVE-341). It was 0.35, and with the squared-gain
    // bug on top of it the heartbeat played about sixteen dB under a spoken
    // sentence -- Clay's "I have to blast the audio just to hear the beeping".
    // A default that means "the same level as the voice" is the only one that
    // answers the complaint out of the box.
    volume: 1,
    workingIntervalSeconds: 6,
    waitingIntervalSeconds: 3,
    muted: [],
    speakTitles: true,
    speakAgentTitles: true,
    speakToolTitles: true,
    // Thinking is read by default (DROVE-181). It is what the model is doing
    // for most of a long turn, and hearing it is the difference between a
    // silent minute and knowing the answer is coming.
    speakThinking: true,
    // A gate waiting on him is read aloud by default (DROVE-188). This is the
    // one cue that has to say WHAT is waiting: `git diff` and `rm -rf` are the
    // same beep.
    speakGates: true,
    titlesPerRun: 3,
    // No cap, both lanes. See audioCueRateRange.
    toolCuesPerMinute: 0,
    agentCuesPerMinute: 0,
};

/**
 * How much faster and higher a spoken TITLE is read than reply prose
 * (DROVE-112).
 *
 * Not a setting, and deliberately: the point is that a tool call never sounds
 * like Claude talking, and a slider that can be dragged back to 1.0 would let
 * that distinction be silently switched off. Volume would have been the
 * obvious third axis and is not available — DroverSpeechModule takes a rate,
 * a pitch and a voice, and no per-utterance volume — so rate and pitch carry
 * it, with the earcon in front doing the rest.
 */
export const asideRateScale = 1.22;
export const asidePitchScale = 1.18;
/**
 * How the model THINKING sounds against the model answering (DROVE-181).
 *
 * The opposite direction from an aside, and deliberately. An aside is one line
 * and can afford to be quick and bright; a thought is a paragraph, sometimes
 * a minute of them, and reading a paragraph fast and high is exhausting.
 * Lower and a shade slower reads as an undertone, which is what a thought is.
 * Volume would have been the obvious axis and the native module still takes
 * none per utterance, so pitch carries it, the way it carries the aside.
 *
 * Not a setting, for the same reason the aside's numbers are not: the point is
 * that thinking never sounds like the answer, and a slider that can be dragged
 * back to 1.0 would switch that distinction off without saying so.
 */
export const thinkingPitchScale = 0.85;
export const thinkingRateScale = 0.96;
/**
 * The absolute rate an aside may reach, above the speed slider's own maximum.
 * The slider bounds what the USER picks for prose; it should not stop a title
 * being read as the quick footnote it is.
 *
 * It is now literally the same engine-safe ceiling the catch-up uses
 * (DROVE-116), and that is the whole guard against the two stacking: a title
 * spoken while the voice is far behind gets rate x catch-up x aside, and this
 * caps the product at the fastest ordinary prose can go rather than letting
 * the two multipliers compound into something unintelligible.
 */
export const asideRateCeiling = streamTalkRateCeiling;

/**
 * The rate one utterance is actually spoken at.
 *
 * Here rather than in speechEngine because this one expression is the whole of
 * DROVE-116 and the whole of the aside's voice, and neither is testable behind
 * a native module. `rateScale` is the reader's catch-up multiplier, 1 at rest.
 *
 * The floor is the speed slider's own minimum. The CEILING is the absolute
 * engine-safe rate, NOT the slider's maximum, and that is the fix: clamping
 * the product back into the slider's range meant that at the top of the slider
 * `rate x anything` clamped straight back to the rate, so the catch-up did
 * nothing at all for the person most likely to want it. The slider bounds what
 * the user CHOOSES; it must not bound what the reader adds on top.
 *
 * An aside is a tool-call title (DROVE-112) and shares that ceiling, which is
 * what stops the two multipliers compounding: a title spoken while the voice
 * is far behind is capped at the same rate as the fastest prose rather than
 * being taken to rate x catch-up x aside.
 */
export function resolveSpokenRate(rate: number, rateScale: number, aside: boolean): number {
    const scaled = rate * rateScale * (aside ? asideRateScale : 1);
    const ceiling = aside ? asideRateCeiling : streamTalkRateCeiling;
    return Math.min(ceiling, Math.max(streamTalkRateRange.min, scaled));
}
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
    // Keep the legacy key for synced settings compatibility. It controls the
    // harness badges in the session list.
    showFlavorIcons: z.boolean().describe('Whether to show harness icons in the session list'),
    showHarnessIconInSessionHeader: z.boolean().describe('Whether to show the harness icon in the session header'),
    userMessageBubbleColor: z.string().describe('User message bubble color preset'),
    /**
     * DEAD as of DROVE-230, kept so a phone that already stored it still
     * parses. Nothing reads it. It reversed the quota bars, and a preference
     * that reverses a mark is a preference that makes the mark unreadable:
     * Clay, who specified these bars, read his own sheet and asked "Oh so 0%
     * means nothing left?". The direction is now the mark's, one way, and the
     * toggle went with it.
     */
    usageLimitShowRemaining: z.boolean().describe('Deprecated (DROVE-230); the quota bars fill as usage is consumed'),
    codeWrap: CodeWrapSchema.describe('Legacy opt-in soft wrap for monospace cards (no longer used; see codeScroll)'),
    codeScroll: CodeScrollSchema.describe('Which monospace kinds scroll horizontally instead of wrapping, toggled by double-tap'),
    streamTalk: StreamTalkSchema.describe('Read-aloud voice: chosen voice identifier, pitch, the normal and catch-up speaking rates, and the backlogs at which the voice speeds up and at which it jumps ahead'),
    speakReplies: SpeakRepliesSchema.describe('Which device speaks replies aloud: phone, watch, or auto (the one whose audio route has headphones, else the phone)'),
    audioCues: AudioCuesSchema.describe('Eyes-free audio cues: the ambient heartbeat, the one-shot earcons, and the spoken titles of tool calls and agent spawns'),
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
    // Runs of one tool fold into one row whatever this says (DROVE-84); on
    // it also wraps each finished turn in one "Worked 2m" row.
    groupToolCalls: z.boolean().describe('Fold each finished turn into one expandable work row in chat'),
    // Shell rows and minimal tools are one line whatever this says; on it
    // folds the tools that have a card (edit diffs, agent cards) as well.
    compactToolCalls: z.boolean().describe('Render tool calls that have a card as compact one-line rows too'),
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
    showFlavorIcons: false,
    showHarnessIconInSessionHeader: true,
    userMessageBubbleColor: DEFAULT_USER_MESSAGE_BUBBLE_COLOR,
    usageLimitShowRemaining: false,
    codeWrap: { terminal: false, code: false },
    codeScroll: {},
    streamTalk: { ...streamTalkDefaults },
    speakReplies: { on: speakRepliesDefault },
    audioCues: { ...audioCuesDefaults },
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
// Code wrap (DROVE-95, default flipped to wrapped in DROVE-149)
//

/** A kind wraps unless it was explicitly turned over to horizontal scrolling. */
export function isCodeWrapOn(settings: Pick<Settings, 'codeScroll'>, kind: CodeWrapKind): boolean {
    return settings.codeScroll?.[kind] !== true;
}

/** The delta that flips one kind and leaves the other as it was. */
export function toggleCodeWrap(settings: Pick<Settings, 'codeScroll'>, kind: CodeWrapKind): Pick<Settings, 'codeScroll'> {
    return {
        codeScroll: {
            ...(settings.codeScroll ?? {}),
            // Scrolling becomes whatever wrapping is now, so a first double-tap
            // on an untouched card turns wrapping off.
            [kind]: isCodeWrapOn(settings, kind),
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
    const rate = clamp(raw.rate, streamTalkDefaults.rate, streamTalkRateRange);
    const maxBacklogSeconds = clamp(raw.maxBacklogSeconds, streamTalkDefaults.maxBacklogSeconds, streamTalkBacklogRange);
    return {
        voiceId: typeof raw.voiceId === 'string' && raw.voiceId.length > 0 ? raw.voiceId : null,
        rate,
        // The fast speed is never slower than the normal one. A pair that
        // crossed over would read the backlog and then slow DOWN, and the UI
        // enforces the same floor on the slider so the two cannot disagree.
        catchUpRate: Math.max(rate, clamp(raw.catchUpRate, streamTalkDefaults.catchUpRate, streamTalkCatchUpRateRange)),
        pitch: clamp(raw.pitch, streamTalkDefaults.pitch, streamTalkPitchRange),
        maxBacklogSeconds,
        // Strictly above the speed-up threshold, so there is always a band in
        // which the voice reads faster before anything is thrown away.
        jumpBacklogSeconds: Math.max(
            maxBacklogSeconds + 1,
            clamp(raw.jumpBacklogSeconds, streamTalkDefaults.jumpBacklogSeconds, streamTalkJumpRange),
        ),
    };
}

/** The delta that changes some stream-talk fields and keeps the rest. */
export function updateStreamTalk(settings: Pick<Settings, 'streamTalk'>, patch: Partial<StreamTalk>): Pick<Settings, 'streamTalk'> {
    return { streamTalk: { ...resolveStreamTalk(settings), ...patch } };
}

//
// Eyes-free audio cues (DROVE-112)
//

/**
 * The cue settings with every field present and inside its range.
 *
 * `muted` is filtered to strings and deduped rather than trusted: it is the
 * one field another app version can put arbitrary content in, and a bad entry
 * there would otherwise reach the mixer's lookup.
 */
export function resolveAudioCues(settings: Pick<Settings, 'audioCues'>): Required<AudioCues> {
    const raw = settings.audioCues ?? {};
    const muted = Array.isArray(raw.muted)
        ? [...new Set(raw.muted.filter((id): id is string => typeof id === 'string'))]
        : [];
    return {
        on: raw.on ?? audioCuesDefaults.on,
        heartbeat: raw.heartbeat ?? audioCuesDefaults.heartbeat,
        volume: clamp(raw.volume, audioCuesDefaults.volume, audioCueVolumeRange),
        workingIntervalSeconds: clamp(
            raw.workingIntervalSeconds,
            audioCuesDefaults.workingIntervalSeconds,
            audioCueWorkingIntervalRange,
        ),
        waitingIntervalSeconds: clamp(
            raw.waitingIntervalSeconds,
            audioCuesDefaults.waitingIntervalSeconds,
            audioCueWaitingIntervalRange,
        ),
        muted,
        speakTitles: raw.speakTitles ?? audioCuesDefaults.speakTitles,
        speakAgentTitles: raw.speakAgentTitles ?? audioCuesDefaults.speakAgentTitles,
        speakToolTitles: raw.speakToolTitles ?? audioCuesDefaults.speakToolTitles,
        speakThinking: raw.speakThinking ?? audioCuesDefaults.speakThinking,
        speakGates: raw.speakGates ?? audioCuesDefaults.speakGates,
        titlesPerRun: Math.round(clamp(raw.titlesPerRun, audioCuesDefaults.titlesPerRun, audioCueTitlesPerRunRange)),
        toolCuesPerMinute: Math.round(
            clamp(raw.toolCuesPerMinute, audioCuesDefaults.toolCuesPerMinute, audioCueRateRange),
        ),
        agentCuesPerMinute: Math.round(
            clamp(raw.agentCuesPerMinute, audioCuesDefaults.agentCuesPerMinute, audioCueRateRange),
        ),
    };
}

/** The delta that changes some cue fields and keeps the rest. */
export function updateAudioCues(
    settings: Pick<Settings, 'audioCues'>,
    patch: Partial<AudioCues>,
): Pick<Settings, 'audioCues'> {
    return { audioCues: { ...resolveAudioCues(settings), ...patch } };
}

/** The delta that silences one cue, or un-silences it. */
export function muteAudioCue(
    settings: Pick<Settings, 'audioCues'>,
    id: string,
    muted: boolean,
): Pick<Settings, 'audioCues'> {
    const current = resolveAudioCues(settings).muted;
    const next = muted
        ? [...new Set([...current, id])]
        : current.filter((entry) => entry !== id);
    return updateAudioCues(settings, { muted: next });
}

//
// Which device speaks (DROVE-92)
//

/** The speaker choice, with anything unknown or missing read as auto. */
export function resolveSpeakReplies(settings: Pick<Settings, 'speakReplies'>): SpeakerChoice {
    const on = settings.speakReplies?.on;
    return (speakerChoices as readonly string[]).includes(on ?? '') ? (on as SpeakerChoice) : speakRepliesDefault;
}
