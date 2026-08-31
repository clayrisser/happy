import { describe, expect, it } from 'vitest';

import {
    BUILT_IN_MODES,
    BUILT_IN_MODE_ORDER,
    CHANNEL_TOGGLE_KEYS,
    LEGACY_DELIVERY,
    announceFor,
    audioRows,
    deliveryOf,
    listModes,
    modeFor,
    modesFromPolicy,
    newGateEntries,
    settingsPatchFor,
    spokenAnnouncement,
    togglesForMode,
    togglesFromPolicy,
    togglesFromSettings,
    wakeDeserved,
    type ChannelToggles,
} from './droverChannels';
import type { DroverGateEntry } from './droverGates';
import { applySettings, settingsDefaults } from './settings';
import { applyLocalSettings, localSettingsDefaults } from './localSettings';
import { en } from '@/text/_default';

const allOn: ChannelToggles = { announceVisual: true, announceHaptic: true, announceAudio: true, answerAudio: 'off' };
const shipped: ChannelToggles = { announceVisual: true, announceHaptic: true, announceAudio: false, answerAudio: 'off' };

function entry(over: Partial<DroverGateEntry> & { delivery?: DroverGateEntry['event'] extends infer E ? E extends { delivery?: infer D } ? D : never : never } = {}): DroverGateEntry {
    const { delivery, ...rest } = over;
    return {
        gate: {
            id: 'bridge:ev-1',
            title: 'Run the tests',
            reason: 'Bash',
            preview: 'pnpm test',
            kind: 'permission',
            createdAt: '2026-08-31T00:00:00.000Z',
            options: [{ id: 'allow', label: 'Allow' }, { id: 'deny', label: 'Deny' }],
        },
        sessionId: 'bridge',
        requestId: 'ev-1',
        tool: 'Bash',
        args: { command: 'pnpm test' },
        todo: false,
        event: { kind: 'permission', title: 'Run the tests', ...(delivery !== undefined ? { delivery } : {}) },
        ...rest,
    };
}

describe('the four modes are saved combinations', () => {
    it('ships the same four rows the bus does, in Clay\'s order', () => {
        expect(Object.keys(BUILT_IN_MODES).sort()).toEqual(['direct', 'eyes-free-audio', 'hands-free-voice', 'silent-haptic']);
        expect([...BUILT_IN_MODE_ORDER]).toEqual(['silent-haptic', 'eyes-free-audio', 'direct', 'hands-free-voice']);
        // Silent haptic is haptic announce plus VISUAL answer: audio never answers it.
        expect(BUILT_IN_MODES['silent-haptic']).toEqual({ announceVisual: false, announceHaptic: true, announceAudio: false, answerAudio: 'off' });
        // Eyes-free and hands-free are ONE channel combination; only the input differs.
        const { answerAudio: a, ...eyes } = BUILT_IN_MODES['eyes-free-audio'];
        const { answerAudio: b, ...hands } = BUILT_IN_MODES['hands-free-voice'];
        expect(eyes).toEqual(hands);
        expect([a, b]).toEqual(['click', 'speech']);
    });

    it('derives the mode from the switches and never stores it', () => {
        expect(modeFor(BUILT_IN_MODES['direct'])).toBe('direct');
        expect(modeFor(togglesForMode('silent-haptic')!)).toBe('silent-haptic');
        // A hand-set combination that matches no row is no mode, not a stale label.
        expect(modeFor(shipped)).toBeNull();
        expect(modeFor(allOn)).toBeNull();
        expect(togglesForMode('flying')).toBeNull();
    });

    it('offers a fifth combination saved on the bus with no code change', () => {
        const driving: ChannelToggles = { announceVisual: false, announceHaptic: true, announceAudio: true, answerAudio: 'click' };
        const modes = { ...BUILT_IN_MODES, driving };
        expect(listModes(modes).map((m) => m.name)).toEqual(['silent-haptic', 'eyes-free-audio', 'direct', 'hands-free-voice', 'driving']);
        expect(modeFor(driving, modes)).toBe('driving');
        // With nothing from a bus, the built-ins stand.
        expect(listModes(null).map((m) => m.name)).toEqual([...BUILT_IN_MODE_ORDER]);
        expect(listModes({}).map((m) => m.name)).toEqual([...BUILT_IN_MODE_ORDER]);
    });

    it('reads the bus\'s keys off a policy block and ignores what is not a switch', () => {
        expect(togglesFromPolicy({ announceVisual: false, announceHaptic: 'false', answerAudio: 'loud', onLimit: 'auto' }))
            .toEqual({ announceVisual: false });
        expect(togglesFromPolicy(null)).toEqual({});
        expect(modesFromPolicy({ modes: { night: { announceVisual: false, announceHaptic: true, announceAudio: false, answerAudio: 'off' }, broken: { announceVisual: true } } }))
            .toEqual({ night: { announceVisual: false, announceHaptic: true, announceAudio: false, answerAudio: 'off' } });
        expect(modesFromPolicy({})).toBeNull();
    });

    it('maps the phone\'s prefixed keys to the bus\'s and back', () => {
        const toggles = togglesFromSettings({ droverAnnounceVisual: false, droverAnnounceHaptic: true, droverAnnounceAudio: false, droverAnswerAudio: 'off' });
        expect(toggles).toEqual(BUILT_IN_MODES['silent-haptic']);
        expect(settingsPatchFor({ announceAudio: true, answerAudio: 'click' })).toEqual({ droverAnnounceAudio: true, droverAnswerAudio: 'click' });
        expect(settingsPatchFor({})).toEqual({});
        // A store with no settings loaded reads as shipped, never as a crash.
        expect(togglesFromSettings(undefined)).toEqual({ announceVisual: true, announceHaptic: true, announceAudio: false, answerAudio: 'off' });
        expect(CHANNEL_TOGGLE_KEYS).toHaveLength(4);
    });
});

describe('what the phone does for a new gate', () => {
    it('reads the event\'s delivery first: no haptic stamped means no buzz however the switch sits', () => {
        const visualOnly = entry({ delivery: { announce: ['visual'], answer: ['visual'], audioInput: null } });
        expect(announceFor(visualOnly, allOn)).toEqual({ haptic: false, speak: null, audioInput: null });
    });

    it('then the phone\'s own switch: the local mute takes an announcement away and never adds one', () => {
        const both = entry({ delivery: { announce: ['haptic', 'audio'], answer: ['visual'], audioInput: null } });
        expect(announceFor(both, allOn).haptic).toBe(true);
        expect(announceFor(both, allOn).speak).toContain('Permission request: Run the tests.');
        expect(announceFor(both, { ...allOn, announceHaptic: false }).haptic).toBe(false);
        expect(announceFor(both, { ...allOn, announceAudio: false }).speak).toBeNull();
    });

    it('treats a card with no delivery as announced on a screen, the way every old bus was', () => {
        expect(deliveryOf(undefined)).toBe(LEGACY_DELIVERY);
        expect(announceFor(entry(), allOn)).toEqual({ haptic: false, speak: null, audioInput: null });
    });

    it('reports the audio input only while audio may answer, so a listener arms off one field', () => {
        const click = entry({ delivery: { announce: ['audio'], answer: ['visual', 'audio'], audioInput: 'click' } });
        expect(announceFor(click, allOn).audioInput).toBe('click');
        const stale = entry({ delivery: { announce: ['audio'], answer: ['visual'], audioInput: 'click' } });
        expect(announceFor(stale, allOn).audioInput).toBeNull();
    });

    it('speaks the kind, the title and the numbered options', () => {
        const question = entry({
            tool: 'AskUserQuestion',
            gate: {
                id: 'bridge:q', title: 'Which lane', reason: '', preview: '', kind: 'question', createdAt: '2026-08-31T00:00:00.000Z',
                options: [{ id: 'a', label: 'Keep it' }, { id: 'b', label: 'Drop it' }, { id: 'c', label: 'Ask later' }],
            },
            event: { kind: 'question', title: 'Which lane' },
        });
        expect(spokenAnnouncement(question)).toBe('Question: Which lane. 3 options: 1, Keep it. 2, Drop it. 3, Ask later.');
        expect(spokenAnnouncement(entry())).toBe('Permission request: Run the tests. 2 options: 1, Allow. 2, Deny.');
        const bare = entry({ gate: { id: 'x', title: 'rm -rf build', reason: '', preview: '', kind: 'permission', createdAt: '2026-08-31T00:00:00.000Z' }, event: { kind: 'permission', title: 'rm -rf build' } });
        expect(spokenAnnouncement(bare)).toBe('Permission request: rm -rf build. Allow or deny.');
        const todo = entry({ todo: true, event: { kind: 'todo', title: 'Sign the lease' }, gate: { id: 't', title: 'Sign the lease', reason: '', preview: '', kind: 'todo', createdAt: '2026-08-31T00:00:00.000Z', options: [{ id: 'done', label: 'Done' }, { id: 'drop', label: 'Drop it' }] } });
        expect(spokenAnnouncement(todo)).toBe('Needs you: Sign the lease. 2 options: 1, Done. 2, Drop it.');
    });

    it('announces only what was not there before', () => {
        const a = entry();
        const b = entry({ gate: { ...entry().gate, id: 'bridge:ev-2' } });
        expect(newGateEntries(new Set(['bridge:ev-1']), [a, b]).map((e) => e.gate.id)).toEqual(['bridge:ev-2']);
        expect(newGateEntries(new Set(), [])).toEqual([]);
    });
});

describe('waking the wrist', () => {
    it('spends a wake only for a gate announced on haptic, with the phone\'s haptic switch on', () => {
        const haptic = entry({ delivery: { announce: ['haptic'], answer: ['visual'], audioInput: null } });
        const visual = entry({ delivery: { announce: ['visual'], answer: ['visual'], audioInput: null } });
        expect(wakeDeserved([haptic], allOn)).toBe(true);
        expect(wakeDeserved([visual], allOn)).toBe(false);
        expect(wakeDeserved([haptic], { announceHaptic: false })).toBe(false);
        expect(wakeDeserved([visual, haptic], allOn)).toBe(true);
    });

    it('keeps waking for a card from a bus older than the field, which is the buzz Clay has today', () => {
        expect(wakeDeserved([entry()], allOn)).toBe(true);
        expect(wakeDeserved([entry()], { announceHaptic: false })).toBe(false);
    });
});

/**
 * DROVE-100. Two settings both read "Audio", Clay turned on the one he could
 * reach and nothing spoke. They stay two settings; only the labels changed.
 */
describe('audioRows', () => {
    it('renders both rows, prompts first, replies second', () => {
        const rows = audioRows({ announceAudio: false, readAloudEnabled: false });
        expect(rows.map((row) => row.key)).toEqual(['speakPrompts', 'readReplies']);
        expect(rows.map((row) => row.setting)).toEqual(['droverAnnounceAudio', 'readAloudEnabled']);
        expect(rows.map((row) => row.scope)).toEqual(['synced', 'local']);
    });

    it('labels each row with what it actually does, and never a bare Audio', () => {
        const rows = audioRows({ announceAudio: true, readAloudEnabled: true });
        const labels = rows.map((row) => en.agentInput.channels[row.key === 'speakPrompts' ? 'speakPrompts' : 'readReplies']);
        expect(labels).toEqual(['Speak prompts when they arrive', 'Read replies aloud']);
        expect(labels).not.toContain('Audio');
    });

    it('shows exactly one row per setting', () => {
        const rows = audioRows({ announceAudio: true, readAloudEnabled: false });
        expect(rows).toHaveLength(2);
        expect(new Set(rows.map((row) => row.setting)).size).toBe(2);
    });

    it('draws each row off its own value, not the other one', () => {
        const promptsOnly = audioRows({ announceAudio: true, readAloudEnabled: false });
        expect(promptsOnly[0].value).toBe(true);
        expect(promptsOnly[0].icon).toBe('volume-high-outline');
        expect(promptsOnly[1].value).toBe(false);
        expect(promptsOnly[1].icon).toBe('chatbubble-outline');

        const repliesOnly = audioRows({ announceAudio: false, readAloudEnabled: true });
        expect(repliesOnly[0].value).toBe(false);
        expect(repliesOnly[0].icon).toBe('volume-mute-outline');
        expect(repliesOnly[1].value).toBe(true);
        expect(repliesOnly[1].icon).toBe('chatbubble-ellipses-outline');
    });
});

describe('the two audio settings are independent', () => {
    it('ships with both off', () => {
        expect(settingsDefaults.droverAnnounceAudio).toBe(false);
        expect(localSettingsDefaults.readAloudEnabled).toBe(false);
    });

    it('speaking prompts never touches read-replies', () => {
        const before = localSettingsDefaults.readAloudEnabled;
        const next = applySettings(settingsDefaults, settingsPatchFor({ announceAudio: true }));
        expect(next.droverAnnounceAudio).toBe(true);
        expect(localSettingsDefaults.readAloudEnabled).toBe(before);
        expect(Object.keys(settingsPatchFor({ announceAudio: true }))).toEqual(['droverAnnounceAudio']);
    });

    it('read-replies never touches the drover audio channel', () => {
        const settings = applySettings(settingsDefaults, settingsPatchFor({ announceAudio: false }));
        const local = applyLocalSettings(localSettingsDefaults, { readAloudEnabled: true });
        expect(local.readAloudEnabled).toBe(true);
        expect(settings.droverAnnounceAudio).toBe(false);
        expect(togglesFromSettings(settings).announceAudio).toBe(false);
    });

    it('both on at once is a real combination, not one switch drawn twice', () => {
        const settings = applySettings(settingsDefaults, settingsPatchFor({ announceAudio: true }));
        const local = applyLocalSettings(localSettingsDefaults, { readAloudEnabled: true });
        const rows = audioRows({
            announceAudio: togglesFromSettings(settings).announceAudio,
            readAloudEnabled: local.readAloudEnabled,
        });
        expect(rows.map((row) => row.value)).toEqual([true, true]);
    });
});
