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
        const text = mount().root.findAllByType('Text' as any)
            .find((node: any) => node.props.children === 'Opus 5 1M');
        expect(text.props.style.color).toBe('text');
    });
});
