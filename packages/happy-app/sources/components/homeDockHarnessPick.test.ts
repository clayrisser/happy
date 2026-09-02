/**
 * A HARNESS PICK ON THE NEW-SESSION SHEET LANDS, OR IS REFUSED OUT LOUD
 * (DROVE-394).
 *
 * Clay, on the sheet's harness menu: he tapped Claude Code and the tick
 * stayed on Codex.
 *
 * WHAT DROPPED IT. `HomeDock` built the harness rows with `disabled` and a
 * reason for anything this computer's daemon did not report installed, then
 * handed the iOS context menu bare `{ key, label }` pairs. The menu offered
 * the row as any other. The pick was written to the draft; the availability
 * effect (`resolveChoiceAgent`) read the same report, found the harness
 * unavailable, and wrote the first installed one straight back. Two writes,
 * one frame, nothing on screen to say why.
 *
 * So the pick is decided by `resolveHarnessPick` off the same rows the sheet
 * draws, the rows are `ComposerPickerSheet`'s (the session capsule's own
 * sheet, where a disabled row is drawn with its reason and takes no press),
 * and this spec walks each harness the way a finger would: pick it, and see
 * the composer follow — its placeholder and the capsule's segment set —
 * mounted from the same catalog `HomeDock` reads through `homeComposerCapsule`.
 */
import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const { host, theme } = vi.hoisted(() => ({
    host: (name: string) => (props: any) => React.createElement(name, props, props.children),
    theme: {
        dark: true,
        colors: {
            text: '#ffffff',
            textSecondary: '#aaaaaa',
            surface: '#111111',
            surfaceHigh: '#222222',
            surfacePressedOverlay: '#333333',
            divider: '#333333',
            radio: { active: '#0a84ff', inactive: '#666666', dot: '#0a84ff' },
            glass: {
                border: 'rgba(255,255,255,0.12)',
                background: '#000000',
                backgroundStrong: '#000000',
                backgroundSubtle: 'rgba(255,255,255,0.08)',
                tint: 'rgba(16,16,16,0.08)',
                divider: '#444444',
            },
        },
    },
}));

vi.mock('react-native', () => ({
    Platform: { OS: 'ios', select: (o: any) => ('ios' in o ? o.ios : o.default) },
    StyleSheet: {
        create: (i: any) => i,
        flatten: (s: any) => (Array.isArray(s) ? Object.assign({}, ...s.map((x: any) => x ?? {})) : s ?? {}),
        hairlineWidth: 0.5,
        absoluteFill: {},
        absoluteFillObject: {},
    },
    View: host('View'),
    Text: host('Text'),
    Pressable: host('Pressable'),
    Modal: host('Modal'),
    Switch: host('Switch'),
    useWindowDimensions: () => ({ width: 393, height: 852 }),
    AccessibilityInfo: {
        isReduceTransparencyEnabled: () => Promise.resolve(false),
        addEventListener: () => ({ remove: () => {} }),
    },
}));
// The sheet's shell pulls in the gesture, keyboard and safe-area natives; only
// its ROW is mounted here, so the shell's imports are stubs.
vi.mock('react-native-gesture-handler', () => ({
    Gesture: { Pan: () => ({}) },
    GestureDetector: host('GestureDetector'),
    GestureHandlerRootView: host('GestureHandlerRootView'),
}));
vi.mock('react-native-keyboard-controller', () => ({
    useReanimatedKeyboardAnimation: () => ({ height: { value: 0 }, progress: { value: 0 } }),
}));
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('expo-blur', () => ({ BlurView: host('BlurView') }));
vi.mock('expo-linear-gradient', () => ({ LinearGradient: host('LinearGradient') }));
vi.mock('react-native-reanimated', () => ({
    default: {
        View: host('AnimatedView'),
        createAnimatedComponent: (component: any) => component,
    },
    useSharedValue: () => ({ value: 1 }),
    useAnimatedStyle: () => ({}),
    withSpring: (value: any) => value,
    withTiming: (value: any) => value,
    cancelAnimation: () => {},
    Easing: { out: () => () => 0, quad: () => 0 },
}));
vi.mock('expo-glass-effect', () => ({
    GlassView: host('GlassView'),
    isGlassEffectAPIAvailable: () => true,
}));
vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({ theme }),
    StyleSheet: { create: (i: any) => (typeof i === 'function' ? i(theme) : i) },
}));
vi.mock('@/utils/platform', () => ({ isRunningOnMac: () => false }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: host('Ionicons') }));
vi.mock('react-native-svg', () => ({
    default: host('Svg'), Circle: host('Circle'), Line: host('Line'), Path: host('Path'),
}));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));

import { ComposerSessionControls } from './ComposerSessionControls';
import { ComposerPickerRow } from './ComposerPickerSheet';
import {
    getEffortLevelsForModel,
    getHardcodedModelModes,
    getHardcodedPermissionModes,
} from './modelModeOptions';
import { resolveHomeDockPromptPlaceholder } from './homeDockInteraction';
import { homeComposerCapsule, homeHarnessOptions, resolveHarnessPick } from './homeComposer';
import { collectMachineChoices, resolveChoiceAgent } from '@/sync/machineChoices';
import { getHarnessName } from '@/utils/harnessCatalog';
import type { NewSessionAgentType } from '@/sync/persistence';
import type { Machine } from '@/sync/storageTypes';

beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

const translate = ((key: string) => key) as never;

/** One Happy CLI daemon, reporting what it found on its PATH. */
function computer(cliAvailability: Record<string, boolean>) {
    const machine = {
        id: 'cli-machine',
        metadata: { host: 'studio.234.bitspur.com', cliAvailability },
        active: true,
        activeAt: Date.now(),
    } as unknown as Machine;
    return collectMachineChoices([machine])[0];
}

const HARNESSES: NewSessionAgentType[] = ['claude', 'codex', 'cursor'];
const PLACEHOLDERS: Partial<Record<NewSessionAgentType, string>> = {
    claude: 'Ask Claude Code',
    codex: 'Ask Codex',
    cursor: 'Ask Cursor',
};

/**
 * The capsule for a harness, from the catalog `HomeDock` reads: the first
 * permission mode, the first model, and the effort scale that model offers.
 */
function capsuleFor(agent: NewSessionAgentType) {
    const permissionOptions = getHardcodedPermissionModes(agent, translate);
    const modelOptions = getHardcodedModelModes(agent, translate);
    const model = modelOptions[0] ?? null;
    const effortOptions = getEffortLevelsForModel(agent, model?.key ?? 'default');
    return homeComposerCapsule({
        agent: { key: agent, name: getHarnessName(agent) },
        permission: permissionOptions[0] ?? null,
        permissionOptions,
        model,
        modelOptions,
        effort: effortOptions[0] ?? null,
        effortOptions,
        effortPickerOptions: effortOptions,
    });
}

/** The capsule's drawn segments, in order, as VoiceOver names them. */
function segmentsFor(agent: NewSessionAgentType): string[] {
    const capsule = capsuleFor(agent);
    let renderer: any;
    act(() => {
        renderer = create(React.createElement(ComposerSessionControls, {
            label: capsule.label,
            modeKey: capsule.modeKey,
            effortIndex: capsule.effortIndex,
            effortCount: capsule.effortCount,
            canOpen: capsule.canOpen,
            readAloud: {
                glyph: 'volume-mute-outline',
                fill: 'none',
                on: false,
                accessibilityLabel: 'Read aloud',
                onPress: () => {},
            },
            onPress: () => {},
        } as never));
    });
    const labels: string[] = [];
    const walk = (node: any) => {
        if (!node || typeof node !== 'object') return;
        if (typeof node.props?.accessibilityLabel === 'string') labels.push(node.props.accessibilityLabel);
        (node.children ?? []).forEach(walk);
    };
    walk(renderer.toJSON());
    return labels;
}

describe('a harness pick on the new-session sheet lands (DROVE-394)', () => {
    const everything = computer({ claude: true, codex: true, cursor: true });

    it.each(HARNESSES)('picking %s makes the composer follow', (agent) => {
        const options = homeHarnessOptions(everything, 'codex');
        const pick = resolveHarnessPick(options, agent);
        expect(pick, 'the pick is taken').toBe(agent);
        // The availability effect, which used to undo the menu's pick, agrees.
        expect(resolveChoiceAgent(everything, pick!)).toBe(agent);
        expect(resolveHomeDockPromptPlaceholder(agent, getHarnessName(agent))).toBe(PLACEHOLDERS[agent]);
        const segments = segmentsFor(agent);
        // What every harness draws: the padlock, the speaker and its name.
        expect(segments[0]).toBe('Permission mode');
        expect(segments[1]).toBe('Read aloud');
        expect(segments[segments.length - 1]).toBe('Model');
        // The dial only where the harness offers levels: Claude has them,
        // Cursor's default model has none (DROVE-101, DROVE-358).
        expect(segments.includes('Reasoning effort'), `${agent} dial`)
            .toBe(agent !== 'cursor');
    });

    it('draws the model segment with the harness’s name where it lists no models', () => {
        const capsule = capsuleFor('cursor');
        expect(capsule.label.model).toBe('Cursor');
        expect(capsule.effortCount).toBe(0);
    });
});

describe('the pick Clay lost: a harness this computer has not reported (DROVE-394)', () => {
    const noClaude = computer({ codex: true, cursor: true });

    it('is on the list, disabled, with the reason', () => {
        const claude = homeHarnessOptions(noClaude, 'codex').find((option) => option.key === 'claude');
        expect(claude).toBeTruthy();
        expect(claude!.disabled).toBe(true);
        expect(claude!.description).toBe('Not installed on this machine');
    });

    it('is refused as a pick, so nothing is written to be undone', () => {
        const options = homeHarnessOptions(noClaude, 'codex');
        expect(resolveHarnessPick(options, 'claude')).toBe(null);
        expect(resolveHarnessPick(options, 'not-a-harness')).toBe(null);
        // The bounce that made the old menu look broken, named: the draft
        // said claude, the effect said codex, and the tick never moved.
        expect(resolveChoiceAgent(noClaude, 'claude')).toBe('codex');
    });

    it('is drawn on the shared picker sheet as a row that takes no press', () => {
        const onPress = vi.fn();
        const claude = homeHarnessOptions(noClaude, 'codex').find((option) => option.key === 'claude')!;
        let renderer: any;
        act(() => {
            renderer = create(React.createElement(ComposerPickerRow, {
                option: claude,
                selected: false,
                onPress,
            }));
        });
        const row = renderer.toJSON();
        expect(row.props.disabled).toBe(true);
        expect(row.props.accessibilityState).toEqual({ checked: false, disabled: true });
        expect(row.props.accessibilityHint).toBe('Not installed on this machine');
        expect(onPress).not.toHaveBeenCalled();
    });

    it('lets the harnesses the computer does report be picked', () => {
        const options = homeHarnessOptions(noClaude, 'codex');
        expect(resolveHarnessPick(options, 'cursor')).toBe('cursor');
        expect(resolveHarnessPick(options, 'codex')).toBe('codex');
    });
});
