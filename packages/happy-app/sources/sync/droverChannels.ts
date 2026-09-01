/**
 * The three feedback channels, as the phone reasons about them (DROVE-72).
 *
 * Two orthogonal axes, ruled by Clay on the ticket. Axis one is WHO you are
 * talking to: direct (the session) or boss mode (the thing that talks about
 * sessions). Axis two is the three channels, each with two directions:
 *
 *   channel   announce (out to Clay)              answer (in from Clay)
 *   visual    app card, gum popup, watch screen   tap, keyboard
 *   audio     spoken aloud                        voice, headphone click
 *   haptic    wrist buzz, phone taptic            none
 *
 * Haptic is announce-only. You cannot answer with a buzz, so "silent haptic"
 * is haptic announce plus VISUAL answer, and visual is the floor of answer
 * that no setting removes. The four modes are saved combinations of the four
 * switches, never code paths, which is why a mode is DERIVED here from the
 * switches rather than stored beside them: a label that can disagree with
 * the switches under it is worse than none.
 *
 * Pure, on purpose. No React, no native module, no storage: the composer
 * sheet, the settings screen and the announce runtime all decide through
 * these functions, and a node test can prove every decision without a phone.
 */

import type { DroverAnswerAudio } from './settings';
import type { DroverGateEntry } from './droverGates';

export const ANNOUNCE_CHANNELS = ['visual', 'haptic', 'audio'] as const;
export type AnnounceChannel = typeof ANNOUNCE_CHANNELS[number];
export const ANSWER_CHANNELS = ['visual', 'audio'] as const;
export type AnswerChannel = typeof ANSWER_CHANNELS[number];

/** What the bus stamps on every event: see cattle-drover engine/channels.js. */
export interface DroverDelivery {
    announce: string[];
    answer: string[];
    audioInput?: string | null;
}

/**
 * What an event with no `delivery` reads as: every subscriber's assumption
 * before there was a field. Announced on a screen, answered on a screen.
 */
export const LEGACY_DELIVERY: DroverDelivery = Object.freeze({
    announce: ['visual'],
    answer: ['visual'],
    audioInput: null,
});

export function deliveryOf(event: { delivery?: DroverDelivery | null } | null | undefined): DroverDelivery {
    return event?.delivery ?? LEGACY_DELIVERY;
}

/** The four switches a mode spells out. Same keys as the bus, minus the prefix. */
export interface ChannelToggles {
    announceVisual: boolean;
    announceHaptic: boolean;
    announceAudio: boolean;
    answerAudio: DroverAnswerAudio;
}

export type ChannelToggleKey = keyof ChannelToggles;
export const CHANNEL_TOGGLE_KEYS: ChannelToggleKey[] = ['announceVisual', 'announceHaptic', 'announceAudio', 'answerAudio'];

/**
 * Clay's four ways of working, as the bus ships them (engine/settings.js
 * BUILT_IN_DEFAULTS.modes). Kept in step by hand and checked by the spec
 * against the same rows, because the bus is the source of truth and the phone
 * only needs these when no bus has answered yet.
 *
 * Eyes-free audio and hands-free voice are the SAME channel combination and
 * differ only in how the audio answerer listens. That is the honest finding
 * of the taxonomy: click-versus-speech is an input method, not a channel.
 */
export const BUILT_IN_MODES: Record<string, ChannelToggles> = Object.freeze({
    'direct': { announceVisual: true, announceHaptic: false, announceAudio: false, answerAudio: 'off' },
    'silent-haptic': { announceVisual: false, announceHaptic: true, announceAudio: false, answerAudio: 'off' },
    'eyes-free-audio': { announceVisual: false, announceHaptic: false, announceAudio: true, answerAudio: 'click' },
    'hands-free-voice': { announceVisual: false, announceHaptic: false, announceAudio: true, answerAudio: 'speech' },
});

/** The order the picker lists them in, Clay's own numbering. */
export const BUILT_IN_MODE_ORDER = ['silent-haptic', 'eyes-free-audio', 'direct', 'hands-free-voice'] as const;

export const MODE_COPY: Record<string, { title: string; subtitle: string }> = {
    'silent-haptic': { title: 'Silent haptic', subtitle: 'The wrist buzzes; you tap.' },
    'eyes-free-audio': { title: 'Eyes-free audio', subtitle: 'Read aloud; you click.' },
    'direct': { title: 'Direct', subtitle: 'Phone or watch shows it; you tap.' },
    'hands-free-voice': { title: 'Hands-free voice', subtitle: 'Spoken to you, and you speak back.' },
};

export function modeTitle(name: string): string {
    return MODE_COPY[name]?.title ?? name;
}

/**
 * Which saved mode the switches currently spell, or null when none does.
 * Derived, never stored: the switches are the truth and the label follows.
 */
export function modeFor(
    toggles: ChannelToggles,
    modes: Record<string, ChannelToggles | null | undefined> = BUILT_IN_MODES,
): string | null {
    for (const [name, row] of Object.entries(modes)) {
        if (!row) continue;
        if (CHANNEL_TOGGLE_KEYS.every((k) => row[k] === toggles[k])) return name;
    }
    return null;
}

/** The switches a named mode sets, or null for a name nobody saved. */
export function togglesForMode(
    name: string,
    modes: Record<string, ChannelToggles | null | undefined> = BUILT_IN_MODES,
): ChannelToggles | null {
    const row = modes[name];
    return row ? { ...row } : null;
}

/**
 * The modes to offer: the bus's rows when a bus has answered (a fifth
 * combination saved in a terminal shows up here with no code change), else
 * the four built-ins. Built-ins first in Clay's order, then anything custom
 * by name, so the picker reads the same on every device.
 */
export function listModes(
    modes: Record<string, ChannelToggles | null | undefined> | null | undefined,
): { name: string; toggles: ChannelToggles }[] {
    const source = modes && Object.keys(modes).length ? modes : BUILT_IN_MODES;
    const out: { name: string; toggles: ChannelToggles }[] = [];
    for (const name of BUILT_IN_MODE_ORDER) {
        const row = source[name];
        if (row) out.push({ name, toggles: { ...row } });
    }
    for (const name of Object.keys(source).sort()) {
        if ((BUILT_IN_MODE_ORDER as readonly string[]).includes(name)) continue;
        const row = source[name];
        if (row) out.push({ name, toggles: { ...row } });
    }
    return out;
}

/**
 * The bus's own delivery keys off a policy block, when it carries them.
 * Loose on the way in because an older CLI's `values()` kept only the five
 * flip keys, and a phone reading such a block must not invent switches.
 */
export function togglesFromPolicy(values: Record<string, unknown> | null | undefined): Partial<ChannelToggles> {
    const out: Partial<ChannelToggles> = {};
    if (!values) return out;
    for (const key of ['announceVisual', 'announceHaptic', 'announceAudio'] as const) {
        if (typeof values[key] === 'boolean') out[key] = values[key] as boolean;
    }
    const answer = values.answerAudio;
    if (answer === 'off' || answer === 'click' || answer === 'speech' || answer === 'both') out.answerAudio = answer;
    return out;
}

export function modesFromPolicy(values: Record<string, unknown> | null | undefined): Record<string, ChannelToggles> | null {
    const raw = values?.modes;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const out: Record<string, ChannelToggles> = {};
    for (const [name, row] of Object.entries(raw as Record<string, unknown>)) {
        if (!row || typeof row !== 'object') continue;
        const t = togglesFromPolicy(row as Record<string, unknown>);
        if (CHANNEL_TOGGLE_KEYS.every((k) => k in t)) out[name] = t as ChannelToggles;
    }
    return Object.keys(out).length ? out : null;
}

/** What this phone ships with: the same as the bus's built-in defaults. */
export const SHIPPED_TOGGLES: ChannelToggles = Object.freeze({
    announceVisual: true,
    announceHaptic: true,
    announceAudio: false,
    answerAudio: 'off',
});

/**
 * The phone's settings keys carry a prefix; the bus's do not. Tolerant of a
 * store with no settings loaded yet (a headless background launch, a test
 * that mocked only the sessions): the shipped switches stand rather than a
 * crash in the feed.
 */
export function togglesFromSettings(settings: {
    droverAnnounceVisual?: boolean;
    droverAnnounceHaptic?: boolean;
    droverAnnounceAudio?: boolean;
    droverAnswerAudio?: DroverAnswerAudio;
} | null | undefined): ChannelToggles {
    return {
        announceVisual: settings?.droverAnnounceVisual ?? SHIPPED_TOGGLES.announceVisual,
        announceHaptic: settings?.droverAnnounceHaptic ?? SHIPPED_TOGGLES.announceHaptic,
        announceAudio: settings?.droverAnnounceAudio ?? SHIPPED_TOGGLES.announceAudio,
        answerAudio: settings?.droverAnswerAudio ?? SHIPPED_TOGGLES.answerAudio,
    };
}

export function settingsPatchFor(patch: Partial<ChannelToggles>): {
    droverAnnounceVisual?: boolean;
    droverAnnounceHaptic?: boolean;
    droverAnnounceAudio?: boolean;
    droverAnswerAudio?: DroverAnswerAudio;
} {
    return {
        ...(patch.announceVisual !== undefined ? { droverAnnounceVisual: patch.announceVisual } : {}),
        ...(patch.announceHaptic !== undefined ? { droverAnnounceHaptic: patch.announceHaptic } : {}),
        ...(patch.announceAudio !== undefined ? { droverAnnounceAudio: patch.announceAudio } : {}),
        ...(patch.answerAudio !== undefined ? { droverAnswerAudio: patch.answerAudio } : {}),
    };
}

/**
 * The two audio rows, in the order every audio surface shows them (DROVE-100).
 *
 * Two settings both used to read "Audio" and they are not the same thing, so
 * turning on the one Clay could reach did nothing he could hear. They are
 * separate on purpose and stay separate: this returns the row per setting,
 * with the label that says which is which, and nothing here writes anything.
 *
 *   droverAnnounceAudio  synced, mirrored to every Mac. A Cattle Drover
 *                        prompt is spoken when it arrives.
 *   readAloudEnabled     local to this device. Assistant replies are spoken
 *                        as they stream (stream-talk, voice/streamTalk.ts).
 *
 * One row per setting, never two rows for one, and a row never touches the
 * other's key. The sheet, Settings > Channels and Settings > Voice all draw
 * from this, so no screen can invent a third name for either.
 */
export type AudioRowKey = 'speakPrompts' | 'readReplies';

export interface AudioRow {
    key: AudioRowKey;
    /** The one setting the row flips. Nothing else moves when it does. */
    setting: 'droverAnnounceAudio' | 'readAloudEnabled';
    /** Synced to the Macs, or local to this handset. */
    scope: 'synced' | 'local';
    labelKey: 'agentInput.channels.speakPrompts' | 'agentInput.channels.readReplies';
    subtitleKey: 'agentInput.channels.speakPromptsSubtitle' | 'agentInput.channels.readRepliesSubtitle';
    icon: 'volume-high-outline' | 'volume-mute-outline' | 'chatbubble-ellipses-outline' | 'chatbubble-outline';
    value: boolean;
}

export function audioRows(input: { announceAudio: boolean; readAloudEnabled: boolean }): AudioRow[] {
    return [
        {
            key: 'speakPrompts',
            setting: 'droverAnnounceAudio',
            scope: 'synced',
            labelKey: 'agentInput.channels.speakPrompts',
            subtitleKey: 'agentInput.channels.speakPromptsSubtitle',
            icon: input.announceAudio ? 'volume-high-outline' : 'volume-mute-outline',
            value: input.announceAudio,
        },
        {
            key: 'readReplies',
            setting: 'readAloudEnabled',
            scope: 'local',
            labelKey: 'agentInput.channels.readReplies',
            subtitleKey: 'agentInput.channels.readRepliesSubtitle',
            icon: input.readAloudEnabled ? 'chatbubble-ellipses-outline' : 'chatbubble-outline',
            value: input.readAloudEnabled,
        },
    ];
}

/**
 * What the phone does for a gate it has not seen before.
 *
 * Off the event's `delivery` first, which is the bus's stamp from the
 * settings the raising session was under, then this phone's own switches,
 * which are the local mute: the wrist has one for the same reason, and a
 * buzz Clay cannot silence from the device in his hand is the failure the
 * local layer exists to prevent. Intersection, never union: a phone switch
 * can only take an announcement away, never add one the bus did not stamp.
 *
 * Visual is not decided here. The card, the inbox pill and the push already
 * ARE the visual announce, and DROVE-74's rule is that visual-off must not
 * hide the card, only the alert.
 *
 * `audioInput` is reported and not acted on: arming a headphone-click or a
 * dictation listener is DROVE-73's, and its measurements say click-answer is
 * not a passive background mode. The seam is here so that listener reads one
 * field when it lands.
 */
export interface AnnouncePlan {
    haptic: boolean;
    /** The sentence to speak, or null for silence. */
    speak: string | null;
    audioInput: string | null;
}

export function announceFor(entry: DroverGateEntry, local: ChannelToggles): AnnouncePlan {
    const delivery = deliveryOf(entry.event);
    const announce = delivery.announce;
    const haptic = announce.includes('haptic') && local.announceHaptic;
    const audio = announce.includes('audio') && local.announceAudio;
    return {
        haptic,
        speak: audio ? spokenAnnouncement(entry) : null,
        audioInput: delivery.answer.includes('audio') ? delivery.audioInput ?? null : null,
    };
}

/**
 * The sentence the audio channel speaks for a prompt: what kind of thing it
 * is, its title, and the options by number so a click or a word can pick
 * one. One voice, DROVE-30's; the read-aloud reader speaks it.
 */
export function spokenAnnouncement(entry: DroverGateEntry): string {
    const kind = entry.event?.kind ?? (entry.todo ? 'todo' : entry.tool === 'AskUserQuestion' ? 'question' : 'permission');
    const title = (entry.event?.title || entry.gate.title || '').trim();
    const options = (entry.gate.options ?? []).map((o) => o.label).filter(Boolean);
    const lead = kind === 'question' ? 'Question'
        : kind === 'todo' ? 'Needs you'
            : 'Permission request';
    const parts = [title ? `${lead}: ${title}.` : `${lead}.`];
    if (kind === 'permission' && options.length === 0) {
        parts.push('Allow or deny.');
    } else if (options.length) {
        const numbered = options.map((label, i) => `${i + 1}, ${label}`);
        parts.push(`${options.length === 1 ? 'One option' : `${options.length} options`}: ${numbered.join('. ')}.`);
    }
    return parts.join(' ');
}

/** The entries in `current` that `known` did not hold, by gate id. */
export function newGateEntries(known: ReadonlySet<string>, current: DroverGateEntry[]): DroverGateEntry[] {
    return current.filter((entry) => !known.has(entry.gate.id));
}

/**
 * Whether a background wake of the wrist is worth spending for these new
 * gates (droverWatchFeed). A wake exists to BUZZ, so it is spent only when
 * some new gate is announced on haptic and this phone's haptic switch is on.
 * A gate with no `delivery` at all keeps the old behaviour and wakes, because
 * that is a bus older than the field and the buzz is what Clay has today.
 */
export function wakeDeserved(newEntries: { event?: { delivery?: DroverDelivery | null } | null }[], local: Pick<ChannelToggles, 'announceHaptic'>): boolean {
    if (!local.announceHaptic) return false;
    return newEntries.some((entry) => {
        const delivery = entry.event?.delivery;
        return !delivery || delivery.announce.includes('haptic');
    });
}
