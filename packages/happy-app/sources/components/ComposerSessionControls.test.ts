/**
 * The composer's session capsule, mounted (DROVE-153, DROVE-176, DROVE-178,
 * DROVE-215).
 *
 * composerControlColour.spec.ts measures the colours and sessionPillLabel.spec.ts
 * pins the model's width budget. This is the render: that the three segments
 * come out in the order Clay asked for, that each opens its own picker on the
 * first tap and never a menu of the three (DROVE-111), and that the colour
 * each glyph is drawn in is the one the rule says it should be. The colour
 * half is the one that has to be a RENDER: the module can only say what it
 * hands out, and the call site is where a tint gets put back.
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

// The theme is a knob, not a constant: the colour rule has to be shown on the
// light theme too, where "white" is #000000 (DROVE-215).
const { themeState } = vi.hoisted(() => ({ themeState: { dark: true } }));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({ theme: { dark: themeState.dark, colors: { text: 'text', divider: 'divider', glass: {} } } }),
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

/**
 * The RENDERED colour of every glyph in the capsule (DROVE-176, DROVE-215).
 *
 * This is where the rule is actually pinned. composerControlColour.spec.ts can
 * say the module hands out the foreground; only a render can say the row does,
 * because the row is where a tint would be put back.
 */
describe('the colour each glyph is drawn in (DROVE-176, DROVE-215)', () => {
    it('draws the padlock, the shield and the eye in the row’s foreground, whatever the mode', () => {
        // Clay: "I told you to do white for the color of all the icons." The
        // mode is a value the session holds, not a thing it is doing, so it
        // buys no colour. The SHAPE still separates them, which is the trade
        // DROVE-141 made and DROVE-176 promised to keep good for.
        const glyph = (modeKind: string) => mount({ modeKind }).root.findByType('Ionicons' as any).props;
        expect(glyph('yolo').name).toBe('lock-open-outline');
        expect(glyph('default').name).toBe('lock-closed-outline');
        expect(glyph('safe-yolo').name).toBe('shield-checkmark-outline');
        expect(glyph('read-only').name).toBe('eye-outline');
        for (const mode of ['yolo', 'bypassPermissions', 'safe-yolo', 'read-only', 'plan', 'acceptEdits', 'default']) {
            expect(glyph(mode).color, mode).toBe(palette.foreground);
        }
    });

    it('draws the needle in the foreground at every level, so nothing is a ramp any more', () => {
        const needle = (index: number) => mount({ effortIndex: index }).root
            .findByType('Line' as any).props.stroke;
        for (let level = 0; level < 6; level += 1) {
            expect(needle(level), `level ${level}`).toBe(palette.foreground);
        }
    });

    it('leaves the model on the foreground too, because a name is not a state', () => {
        const text = mount().root.findAllByType('Text' as any)
            .find((node: any) => node.props.children === 'Opus 5 1M');
        expect(text.props.style.color).toBe('text');
    });

    it('does the same on the light theme, where the foreground is #000000 rather than white', () => {
        // Same rule, other theme. The token is the row's FOREGROUND, so light
        // gets the theme's own text colour instead of a literal white that
        // would vanish on it.
        themeState.dark = false;
        try {
            const light = COMPOSER_CONTROL_PALETTE.light;
            expect(light.foreground).toBe('#000000');
            for (const mode of ['yolo', 'safe-yolo', 'read-only', 'default']) {
                expect(mount({ modeKind: mode }).root.findByType('Ionicons' as any).props.color, mode)
                    .toBe(light.foreground);
            }
            for (let level = 0; level < 6; level += 1) {
                expect(mount({ effortIndex: level }).root.findByType('Line' as any).props.stroke, `level ${level}`)
                    .toBe(light.foreground);
            }
        } finally {
            themeState.dark = true;
        }
    });

    it('draws the whole capsule in one colour, which is what Clay asked for', () => {
        // The capsule the ticket was filed against had a purple shield and a
        // pink needle a few points from three plain white glyphs. One assertion
        // that the two capsules now speak the same vocabulary.
        const renderer = mount({ modeKind: 'safe-yolo', effortIndex: 5 });
        const shield = renderer.root.findByType('Ionicons' as any).props.color;
        const stroke = renderer.root.findByType('Line' as any).props.stroke;
        expect(new Set([shield, stroke, palette.foreground]).size).toBe(1);
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
        // Mid-drag it reads the THUMB, which is at the ceiling: hard right.
        // The ANGLE is the whole of it now (DROVE-215): the stroke is the
        // foreground at either end, so the drag has to move the line to say
        // anything, which is the reading the dial was chosen for (DROVE-101).
        const dragging = needle(mount({
            effortSlider: slider({ active: true, index: 5 }),
            effortScale: scale,
        }));
        expect(dragging.x2).toBeGreaterThan(resting.x2);
        expect(dragging.stroke).toBe(palette.foreground);
        expect(resting.stroke).toBe(palette.foreground);
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
