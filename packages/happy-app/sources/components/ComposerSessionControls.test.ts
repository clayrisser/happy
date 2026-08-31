/**
 * The composer's session capsule, mounted (DROVE-153, DROVE-176, DROVE-178).
 *
 * composerControlColour.spec.ts measures the colours and sessionPillLabel.spec.ts
 * pins the model's width budget. This is the render: that the three segments
 * come out in the order Clay asked for, that each opens its own picker on the
 * first tap and never a menu of the three (DROVE-111), and that the colour
 * each glyph is drawn in is the one the vocabulary says it should be.
 *
 * The model's three assertions moved here from AgentInputStatusRow.test.ts
 * when DROVE-178 moved the segment.
 */
import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const originalConsoleError = console.error;

beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...args: unknown[]) => {
        if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated')) return;
        originalConsoleError(message, ...args);
    });
});

afterAll(() => {
    vi.restoreAllMocks();
});

const { host } = vi.hoisted(() => ({
    host: (name: string) => (props: any) => React.createElement(name, props, props.children),
}));

vi.mock('react-native', () => ({
    StyleSheet: { hairlineWidth: 1 },
    Text: host('Text'),
    View: host('View'),
}));

vi.mock('react-native-svg', () => ({
    default: host('Svg'),
    Circle: host('Circle'),
    Line: host('Line'),
    Path: host('Path'),
}));

vi.mock('@expo/vector-icons', () => ({ Ionicons: host('Ionicons') }));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({ theme: { dark: true, colors: { text: 'text', divider: 'divider', glass: {} } } }),
    StyleSheet: { create: (factory: any) => factory({ colors: { text: 'text', divider: 'divider', glass: {} } }) },
}));

vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('./BubblePressable', () => ({ BubblePressable: host('BubblePressable') }));
vi.mock('./GlassChromeControl', () => ({ GlassChromeSurface: host('GlassChromeSurface') }));
vi.mock('./NativeSettingsMenu', () => ({ NativeSettingsMenu: host('NativeSettingsMenu') }));
// The popover reaches haptics and the store, which reach expo-modules-core.
// This file is about the capsule; EffortSliderPopover has its own module and
// effortSlider.spec.ts holds the rules it draws (DROVE-200).
vi.mock('./EffortSliderPopover', () => ({ EffortSliderPopover: host('EffortSliderPopover') }));

const { ComposerSessionControls } = await import('./ComposerSessionControls');
const { COMPOSER_CONTROL_PALETTE } = await import('./composerControlColour');

const palette = COMPOSER_CONTROL_PALETTE.dark;
const group = { key: 'g', title: 'g', options: [] } as any;

function mount(overrides: Record<string, unknown> = {}) {
    let renderer: any;
    act(() => {
        renderer = create(React.createElement(ComposerSessionControls, {
            label: { mode: 'Yolo', model: 'Opus 5 1M', effort: 'High', text: '' },
            modeKind: 'yolo',
            effortIndex: 3,
            effortCount: 6,
            onPress: () => {},
            modeGroups: [group],
            effortGroup: group,
            modelGroup: group,
            ...overrides,
        } as any));
    });
    return renderer;
}

function press(renderer: any, label: string) {
    return renderer.root.findAll(
        (node: any) => typeof node.type === 'string' && node.props?.accessibilityLabel === label,
    )[0];
}

describe('the session capsule', () => {
    it('is mode, effort and model in that order, inside one glass surface (DROVE-178)', () => {
        const renderer = mount();
        const surface = renderer.root.findByType('GlassChromeSurface' as any);
        // One interactive surface for the whole capsule, so DROVE-169's press
        // response covers the model segment without a second animation.
        expect(surface.props.interactive).toBe(true);
        const labels = renderer.root.findAll(
            (node: any) => typeof node.type === 'string' && !!node.props?.accessibilityLabel,
        ).map((node: any) => node.props.accessibilityLabel);
        expect(labels).toEqual(['Permission mode', 'Reasoning effort', 'Model']);
    });

    it('spells the model out in full, and never gains an ellipsis (DROVE-138, DROVE-178)', () => {
        const renderer = mount({ label: { mode: 'Yolo', model: 'Opus 5 1M', effort: 'High', text: '' } });
        const text = renderer.root.findAllByType('Text' as any)
            .find((node: any) => node.props.children === 'Opus 5 1M');
        expect(text).toBeTruthy();
        expect(text.props.ellipsizeMode).toBeUndefined();
        // Smaller before shorter: the failure DROVE-138 was filed about was
        // `Opus 5...`, so the segment scales the type instead of cutting it.
        expect(text.props.adjustsFontSizeToFit).toBe(true);
        expect(text.props.minimumFontScale).toBe(0.85);
    });

    it('opens the model picker on the first tap, never a menu of the three (DROVE-111)', () => {
        const opened: string[] = [];
        const renderer = mount({ onPress: (picker: string) => opened.push(picker) });
        act(() => {
            press(renderer, 'Model').props.onPress();
        });
        expect(opened).toEqual(['model']);
    });

    it('anchors the model picker as the native menu on iOS, still one tap', () => {
        const renderer = mount({ nativeMenus: true });
        const menus = renderer.root.findAllByType('NativeSettingsMenu' as any);
        expect(menus.map((menu: any) => menu.props.accessibilityLabel))
            .toEqual(['Permission mode, Yolo', 'Reasoning effort, High, 4 of 6', 'Model, Opus 5 1M']);
    });

    it('draws the capsule without the model when the session has no name for one', () => {
        const renderer = mount({ label: { mode: 'Yolo', model: null, effort: 'High', text: '' } });
        expect(press(renderer, 'Model')).toBeUndefined();
        // Two segments and the one hairline between them, never a divider
        // floating at the end where a third used to be.
        expect(renderer.root.findAllByType('View' as any)
            .filter((node: any) => node.props.style?.width === 1)).toHaveLength(1);
    });
});

/** The model's name is styled with an array now (DROVE-217), so flatten before reading it. */
function modelColour(renderer: any): string | undefined {
    const text = renderer.root.findAllByType('Text' as any)
        .find((node: any) => node.props.children === 'Opus 5 1M');
    const style = [text.props.style].flat(Infinity).filter(Boolean);
    return style.reduce((colour: string | undefined, entry: any) => entry?.color ?? colour, undefined);
}

describe('the colour each glyph is drawn in (DROVE-176)', () => {
    it('gives the open padlock the warning hue and the shut one the neutral', () => {
        const open = mount({ modeKind: 'yolo' }).root.findByType('Ionicons' as any);
        expect(open.props.name).toBe('lock-open-outline');
        expect(open.props.color).toBe(palette.warning);
        const shut = mount({ modeKind: 'default' }).root.findByType('Ionicons' as any);
        expect(shut.props.name).toBe('lock-closed-outline');
        expect(shut.props.color).toBe(palette.neutral);
    });

    it('gives safe-yolo and read-only their own, neither of them the warning', () => {
        const shield = mount({ modeKind: 'safe-yolo' }).root.findByType('Ionicons' as any);
        expect(shield.props.color).toBe(palette.shield);
        const eye = mount({ modeKind: 'read-only' }).root.findByType('Ionicons' as any);
        expect(eye.props.color).toBe(palette.eye);
    });

    it('warms the needle up the scale, cool at the floor and the warning at the ceiling', () => {
        const needle = (index: number) => mount({ effortIndex: index }).root
            .findByType('Line' as any).props.stroke;
        expect(needle(0)).toBe(palette.effort[0]);
        expect(needle(5)).toBe(palette.warning);
        expect(needle(2)).not.toBe(needle(4));
    });

    it('leaves the model neutral, because a name is not a state', () => {
        expect(modelColour(mount())).toBe('text');
    });
});

/**
 * A pick the terminal has not confirmed yet (DROVE-217).
 *
 * The rule for WHEN is pinned in sync/agentModeRequests.spec.ts and the colour
 * in composerControlColour.spec.ts. These are the three the render has to show:
 * that all three segments take it, that it OVERRIDES the settled colour rather
 * than sitting beside it, and that a finger on the slider outranks it.
 */
describe('a pick still on its way to the terminal (DROVE-217)', () => {
    it('draws the padlock, the needle and the name in the pending colour, one rule for three controls', () => {
        const renderer = mount({
            modeKind: 'yolo',
            effortIndex: 5,
            pending: { permission: true, effort: true, model: true },
        });
        expect(renderer.root.findByType('Ionicons' as any).props.color).toBe(palette.pending);
        expect(renderer.root.findByType('Line' as any).props.stroke).toBe(palette.pending);
        expect(modelColour(renderer)).toBe(palette.pending);
    });

    it('overrides the settled colour rather than sitting beside it: the open padlock is not the amber while it waits', () => {
        const waiting = mount({ modeKind: 'yolo', pending: { permission: true } });
        expect(waiting.root.findByType('Ionicons' as any).props.color).not.toBe(palette.warning);
        const landed = mount({ modeKind: 'yolo', pending: { permission: false } });
        expect(landed.root.findByType('Ionicons' as any).props.color).toBe(palette.warning);
    });

    it('leaves the other two alone: one control waiting is not the whole row waiting', () => {
        const renderer = mount({ modeKind: 'yolo', effortIndex: 5, pending: { effort: true } });
        expect(renderer.root.findByType('Ionicons' as any).props.color).toBe(palette.warning);
        expect(renderer.root.findByType('Line' as any).props.stroke).toBe(palette.pending);
        expect(modelColour(renderer)).toBe('text');
    });

    it('says so to VoiceOver, which colour never reaches', () => {
        const renderer = mount({ nativeMenus: true, pending: { permission: true } });
        const menus = renderer.root.findAllByType('NativeSettingsMenu' as any);
        expect(menus[0].props.accessibilityLabel).toBe('Permission mode, Yolo, not confirmed by the terminal yet');
        expect(menus[1].props.accessibilityLabel).toBe('Reasoning effort, High, 4 of 6');
    });
});

/**
 * The effort segment as a SLIDER (DROVE-200). The rules live in
 * effortSlider.spec.ts; these are the ones only a render can show.
 */
describe('the effort segment when it is a slider', () => {
    const scale = { keys: ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'], names: ['Low', 'Medium', 'High', 'xHigh', 'Max', 'Ultracode'] };
    function slider(overrides: Record<string, unknown> = {}) {
        return {
            active: false,
            index: 3,
            onPressIn: () => {},
            onMove: () => {},
            onRelease: () => {},
            tapStop: () => {},
            tapAuto: () => {},
            step: () => {},
            dismiss: () => {},
            state: { phase: 'closed', anchorX: 0, anchorIndex: 3, index: 3, grabbed: false },
            placement: null,
            ...overrides,
        } as any;
    }

    it('takes the touch for the whole gesture rather than letting the scroll view have it back', () => {
        const renderer = mount({ effortSlider: slider(), effortScale: scale });
        const segment = press(renderer, 'Reasoning effort');
        expect(segment.props.onResponderGrant).toBeTypeOf('function');
        expect(segment.props.onResponderMove).toBeTypeOf('function');
        expect(segment.props.onResponderRelease).toBeTypeOf('function');
        expect(segment.props.onResponderTerminationRequest()).toBe(false);
    });

    it('is adjustable, and moves a notch per VoiceOver action', () => {
        const moves: number[] = [];
        const renderer = mount({
            effortSlider: slider({ step: (delta: number) => moves.push(delta) }),
            effortScale: scale,
        });
        const segment = press(renderer, 'Reasoning effort');
        expect(segment.props.accessibilityRole).toBe('adjustable');
        segment.props.onAccessibilityAction({ nativeEvent: { actionName: 'increment' } });
        segment.props.onAccessibilityAction({ nativeEvent: { actionName: 'decrement' } });
        expect(moves).toEqual([1, -1]);
    });

    it('points the needle at the thumb while a drag runs, so the two cannot disagree', () => {
        const needle = (renderer: any) => renderer.root.findByType('Line' as any).props;
        // At rest the needle reads the session's own level, the fourth of six.
        const resting = needle(mount({ effortSlider: slider(), effortScale: scale }));
        // Mid-drag it reads the THUMB, which is at the ceiling: hard right,
        // and the warning amber the DROVE-176 ramp ends on.
        const dragging = needle(mount({
            effortSlider: slider({ active: true, index: 5 }),
            effortScale: scale,
        }));
        expect(dragging.stroke).toBe(palette.effort[2]);
        expect(dragging.x2).toBeGreaterThan(resting.x2);
        expect(dragging.stroke).not.toBe(resting.stroke);
    });

    it('lets a finger on the slider outrank a wait (DROVE-217): the thumb is not a request yet', () => {
        const needle = (renderer: any) => renderer.root.findByType('Line' as any).props.stroke;
        // Dragging over the top of a pick that is still in flight: the needle
        // follows the thumb in the ramp's colour, because the drag is where
        // Clay's finger is and the wait is about a value he has left behind.
        expect(needle(mount({
            effortSlider: slider({ active: true, index: 5 }),
            effortScale: scale,
            pending: { effort: true },
        }))).toBe(palette.effort[2]);
        // Let go, and the wait is what is left to draw.
        expect(needle(mount({
            effortSlider: slider({ active: false, index: 5 }),
            effortScale: scale,
            pending: { effort: true },
        }))).toBe(palette.pending);
    });

    it('hangs the popover off a wrapper that clips nothing, outside the glass', () => {
        const renderer = mount({ effortSlider: slider({ active: true }), effortScale: scale });
        const popover = renderer.root.findByType('EffortSliderPopover' as any);
        expect(popover).toBeTruthy();
        // The glass surface is a sibling of the popover, not its parent: the
        // fallback material clips to its own bounds (DROVE-153).
        const surface = renderer.root.findByType('GlassChromeSurface' as any);
        expect(surface.findAllByType('EffortSliderPopover' as any)).toEqual([]);
    });

    it('keeps the picker when no slider is handed in, so a desktop still lists it', () => {
        const renderer = mount();
        const segment = press(renderer, 'Reasoning effort');
        expect(segment.props.onResponderGrant).toBeUndefined();
        expect(renderer.root.findAllByType('EffortSliderPopover' as any)).toEqual([]);
    });
});
