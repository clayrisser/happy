/**
 * A FINGER ON A CAPSULE SEGMENT OPENS THAT SEGMENT'S PICKER (DROVE-371).
 *
 * Clay, on OTA 01a06004: "the effort button is not working." The dial was
 * drawn, the capsule was drawn, and a tap on the dial opened nothing.
 *
 * WHY NO SPEC COULD SEE IT. Every suite that mounts this capsule mocks
 * `BubblePressable` to a host element, so what they assert is that a prop
 * called `onPress` was HANDED to something. Whether a finger at the point the
 * dial is DRAWN reaches that handler is a different question, and it is the
 * one Clay was asking. It has three parts, and the three lived in three files
 * nothing joined up:
 *
 *   the RECT      the segment's hit area, which DROVE-353 recomputed when the
 *                 capsule took the row's width
 *   the HANDLER   `canOpen`, which DROVE-358 gates on the harness's catalog
 *   the SHEET     `composerPickerSheetOpen`, which refuses an effort list with
 *                 nothing in it (DROVE-229)
 *
 * So this file mounts the REAL capsule inside the REAL bubble with the REAL
 * `BubblePressable`, resolves the tree it actually rendered through the layout
 * engine (DROVE-214's rule: read the layout system, never restate it), and
 * dispatches a press at the point each segment is drawn — the deepest enabled
 * pressable under that point answers, which is what the responder system does
 * on the phone. The press then runs the REAL picker state machine, so what is
 * asserted at the end is the thing Clay is looking for: the effort SHEET is up.
 *
 * All three of lock, dial and model are driven, because two of them working is
 * how this shipped: a fix that trades one segment for another is a regression,
 * not a fix.
 */
import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const { host, theme, flatten } = vi.hoisted(() => {
    const flatten = (style: unknown): Record<string, unknown> => {
        if (!style) return {};
        if (Array.isArray(style)) {
            return style.reduce<Record<string, unknown>>(
                (merged, entry) => Object.assign(merged, flatten(entry)),
                {},
            );
        }
        return { ...(style as Record<string, unknown>) };
    };
    return {
        flatten,
        host: (name: string) => (props: any) => React.createElement(name, props, props.children),
        theme: {
            dark: true,
            colors: {
                text: '#ffffff',
                textSecondary: '#aaaaaa',
                surface: '#111111',
                surfaceHigh: '#222222',
                divider: '#333333',
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
    };
});

vi.mock('react-native', () => ({
    Platform: { OS: 'ios', select: (o: any) => ('ios' in o ? o.ios : o.default) },
    StyleSheet: {
        create: (i: any) => i,
        flatten,
        hairlineWidth: 0.5,
        absoluteFill: {},
        absoluteFillObject: {},
    },
    View: host('View'),
    Text: host('Text'),
    Pressable: host('Pressable'),
    AccessibilityInfo: {
        isReduceTransparencyEnabled: () => Promise.resolve(false),
        addEventListener: () => ({ remove: () => {} }),
    },
}));

// Reanimated, which vitest cannot transform. `BubblePressable` is REAL here —
// it is the thing under test — so the shims have to be real enough for it to
// mount: a shared value, an animated style, and `createAnimatedComponent`
// handing back the component it was given.
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
vi.mock('expo-blur', () => ({ BlurView: host('BlurView') }));
vi.mock('expo-linear-gradient', () => ({ LinearGradient: host('LinearGradient') }));
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

import { ComposerBubble } from './ComposerBubble';
import { ComposerSessionControls, type ComposerSessionPicker } from './ComposerSessionControls';
import {
    MOBILE_COMPOSER_BUBBLE_CONTROL_SIZE,
    MOBILE_COMPOSER_CAPSULE_SEGMENT_WIDTH,
    MOBILE_COMPOSER_METRICS,
} from './agentInputLayout';
import { getEffortLevelsForPicker } from './modelModeOptions';
import { effortSliderScaleFromLevels } from './effortSlider';
import {
    composerPickerClosed,
    composerPickerPress,
    composerPickerSheetOpen,
    type ComposerPickerState,
} from './composerPicker';
import { buildSessionPillLabel } from './sessionPillLabel';
import { type FlexNode, type FlexFrame, resolveFlexFrames } from './flexFrames';

beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

/**
 * THE SESSION IN CLAY'S SCREENSHOT: Claude, Fable 5.1, read-aloud on.
 *
 * The effort catalog is the harness's own, read through the same function
 * `SessionView` reads it through, so a spec cannot pass on a list the app
 * would never hand over. Six reachable levels on this model, which is why the
 * dial is drawn at all.
 */
const CLAUDE_METADATA = { flavor: 'claude' } as never;
const MODEL_KEY = 'claude-fable-5-1';
const effortLevels = getEffortLevelsForPicker('claude', MODEL_KEY, CLAUDE_METADATA);
const effortScale = effortSliderScaleFromLevels(effortLevels);

/** The width the composer's bubble is drawn at on a 393pt phone. */
const BUBBLE_WIDTH = 393 - 2 * MOBILE_COMPOSER_METRICS.shellGutter;

const LAYOUT_KEYS = new Set([
    'flexDirection', 'alignItems', 'justifyContent', 'flex', 'flexShrink',
    'width', 'height', 'minHeight', 'maxHeight',
    'padding', 'paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight',
    'gap', 'borderRadius',
]);

/**
 * Styles the layout engine cannot model and MUST NOT be dropped quietly.
 *
 * `flexFrames` refuses these on the way in for DROVE-214's reason — a
 * hand-placed offset is exactly what a spec that restates the geometry cannot
 * see — and this filter would hide them, so it refuses them itself.
 */
const REFUSED_KEYS = new Set(['position', 'top', 'left', 'right', 'bottom', 'transform', 'margin']);

/** What the renderer's own style says about layout, and nothing else. */
function layoutStyle(name: string, style: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(style)) {
        if (value === undefined || value === null) continue;
        if (REFUSED_KEYS.has(key)) {
            throw new Error(`composerCapsuleTap: "${name}" places itself with "${key}" (DROVE-214)`);
        }
        if (key === 'paddingHorizontal') {
            out.paddingLeft = value;
            out.paddingRight = value;
            continue;
        }
        if (key === 'paddingVertical') {
            out.paddingTop = value;
            out.paddingBottom = value;
            continue;
        }
        // `justifyContent: 'center'` centres the CONTENT of a leaf segment and
        // never moves the segment; the resolver models only 'flex-start', so it
        // is dropped rather than refused.
        if (key === 'justifyContent' && value !== 'flex-start') continue;
        if (!LAYOUT_KEYS.has(key)) continue;
        out[key] = value;
    }
    return out;
}

interface Rendered {
    node: any;
    name: string;
    onPress?: () => void;
    disabled: boolean;
}

/** Every host element in render order, named by what a reader would call it. */
function describeNode(node: any, index: number): Rendered {
    const props = node.props ?? {};
    const label = typeof props.accessibilityLabel === 'string' ? props.accessibilityLabel : null;
    return {
        node,
        name: label ?? `${node.type}#${index}`,
        onPress: typeof props.onPress === 'function' ? props.onPress : undefined,
        disabled: props.disabled === true,
    };
}

/** The rendered tree as the layout engine's tree, style for style. */
function toFlexNode(node: any, index: number, seen: Map<string, Rendered>): FlexNode {
    const described = describeNode(node, index);
    let name = described.name;
    let suffix = 1;
    while (seen.has(name)) {
        name = `${described.name}~${suffix += 1}`;
    }
    seen.set(name, described);
    const props = node.props ?? {};
    const raw = typeof props.style === 'function'
        ? props.style({ pressed: false })
        : props.style;
    const children = (node.children ?? []).filter((child: any) => child && typeof child === 'object');
    return {
        name,
        style: layoutStyle(name, flatten(raw)) as FlexNode['style'],
        // A leaf with nothing to measure is the glyph itself: it is centred by
        // its parent and never decides a hit rect.
        intrinsicHeight: children.length === 0 ? 0 : undefined,
        children: children.map((child: any, i: number) => toFlexNode(child, i, seen)),
    };
}

function eachFrame(frame: FlexFrame, visit: (f: FlexFrame) => void): void {
    visit(frame);
    frame.children.forEach((child) => eachFrame(child, visit));
}

function frameByName(root: FlexFrame, name: string): FlexFrame {
    let found: FlexFrame | undefined;
    eachFrame(root, (f) => { if (f.name === name) found = f; });
    if (!found) throw new Error(`composerCapsuleTap: no frame named "${name}"`);
    return found;
}

function contains(frame: FlexFrame, point: { x: number; y: number }): boolean {
    return point.x >= frame.x && point.x <= frame.x + frame.width
        && point.y >= frame.y && point.y <= frame.y + frame.height;
}

/**
 * WHO ANSWERS A FINGER AT THIS POINT.
 *
 * The deepest enabled pressable whose frame contains it, which is what the
 * responder system settles on: a press lands on the innermost view that takes
 * it, and a disabled `Pressable` takes nothing. Reading it off the RESOLVED
 * frames rather than off the render order is the whole point — a segment whose
 * rect moved, collapsed, or was covered by its neighbour answers differently
 * here even though the tree is unchanged.
 */
function pressTargetAt(
    root: FlexFrame,
    seen: Map<string, Rendered>,
    point: { x: number; y: number },
): Rendered | null {
    let best: { depth: number; hit: Rendered } | null = null;
    const walk = (frame: FlexFrame, depth: number) => {
        if (!contains(frame, point)) return;
        const rendered = seen.get(frame.name);
        if (rendered?.onPress && !rendered.disabled && (!best || depth >= best.depth)) {
            best = { depth, hit: rendered };
        }
        frame.children.forEach((child) => walk(child, depth + 1));
    };
    walk(root, 0);
    return best ? (best as { hit: Rendered }).hit : null;
}

interface Composer {
    frames: FlexFrame;
    seen: Map<string, Rendered>;
    /** Which sheet the picker rules put up, after everything pressed so far. */
    sheet: () => ReturnType<typeof composerPickerSheetOpen>;
    picker: () => ComposerPickerState;
}

/**
 * The chat's composer, drawn the way `AgentInput` draws it: the `+`, the
 * capsule, the mic and send, inside `ComposerBubble`.
 *
 * `canOpen` and the sheet's `hasEffortLevels` are computed here from the SAME
 * catalog, because that is how AgentInput computes them — a segment is
 * pressable when the harness can take a pick for it, and the sheet opens when
 * there is a list to draw.
 */
function mountComposer(): Composer {
    let state: ComposerPickerState = composerPickerClosed;
    const hasEffortLevels = effortLevels.length > 0;
    const press = (picker: ComposerSessionPicker) => {
        state = composerPickerPress(state, picker, { keyboardVisible: false }).state;
    };
    const disc = (key: string) => React.createElement('View', {
        key,
        style: {
            width: MOBILE_COMPOSER_BUBBLE_CONTROL_SIZE,
            height: MOBILE_COMPOSER_BUBBLE_CONTROL_SIZE,
        },
    });
    let renderer: any;
    act(() => {
        renderer = create(React.createElement(
            ComposerBubble,
            {
                leading: disc('add'),
                controls: React.createElement(ComposerSessionControls, {
                    label: buildSessionPillLabel({
                        modeLabel: 'Yolo',
                        model: { key: MODEL_KEY, name: 'Fable 5.1' },
                        effortLabel: 'High',
                    }),
                    size: MOBILE_COMPOSER_BUBBLE_CONTROL_SIZE,
                    segmentWidth: MOBILE_COMPOSER_CAPSULE_SEGMENT_WIDTH,
                    verticalSlop: MOBILE_COMPOSER_METRICS.primaryActionSlop,
                    modeKind: 'yolo',
                    effortIndex: effortScale.keys.indexOf('high'),
                    effortCount: effortScale.keys.length,
                    onPress: press,
                    canOpen: {
                        permission: true,
                        effort: hasEffortLevels,
                        model: true,
                    },
                    readAloud: {
                        glyph: 'volume-high',
                        fill: 'reading',
                        on: true,
                        accessibilityLabel: 'Read aloud',
                        onPress: () => {},
                    },
                } as never),
                trailing: [disc('mic'), disc('send')],
            } as never,
            React.createElement('View', { key: 'field', style: { height: 22 } }),
        ));
    });
    const seen = new Map<string, Rendered>();
    const root = toFlexNode(renderer.toJSON(), 0, seen);
    return {
        frames: resolveFlexFrames(root, BUBBLE_WIDTH),
        seen,
        sheet: () => composerPickerSheetOpen({
            open: state.open,
            compact: true,
            hasEffortLevels,
        }),
        picker: () => state,
    };
}

/** The point a finger lands on when it aims at what this segment DRAWS. */
function centreOf(frame: FlexFrame): { x: number; y: number } {
    return { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 };
}

describe('a press on a capsule segment opens that segment’s picker (DROVE-371)', () => {
    it('draws an effort dial only where the session has levels to pick', () => {
        // The premise the bug report rests on: the dial IS on Clay's screen,
        // so the catalog behind it is not empty and the segment is not a
        // decoration.
        expect(effortScale.keys.length).toBeGreaterThan(0);
        const composer = mountComposer();
        expect(() => frameByName(composer.frames, 'Reasoning effort')).not.toThrow();
    });

    it.each([
        ['Reasoning effort', 'effort'],
        ['Permission mode', 'permission'],
        ['Model', 'model'],
    ])('a finger on %s opens the %s sheet', (label, picker) => {
        const composer = mountComposer();
        const segment = frameByName(composer.frames, label);
        expect(segment.width, `${label} hit rect`).toBeGreaterThan(0);
        expect(segment.height, `${label} hit rect`).toBeGreaterThan(0);
        const target = pressTargetAt(composer.frames, composer.seen, centreOf(segment));
        expect(target?.name, `${label} answers its own centre`).toBe(label);
        act(() => { target!.onPress!(); });
        expect(composer.picker().open, `${label} press`).toBe(picker);
        expect(composer.sheet(), `${label} sheet`).toBe('list');
    });

    /**
     * THE CAUSE, HELD WHERE IT CAN FAIL (DROVE-371).
     *
     * A resolved rect and a bound handler are not enough: between them sits
     * whatever the segment MOUNTS, and a child that takes the touch is a
     * segment that never presses. Three of the four glyphs are text and could
     * never do it; the dial is `react-native-svg`, whose view answers its own
     * hit test for every point inside its bounds, and DROVE-343 put the pill
     * between it and the pressable.
     *
     * So the rule is the capsule's, not the dial's: nothing inside a segment
     * is pressable, therefore nothing inside a segment may be reachable by a
     * finger. Asserted on every segment, so the next glyph that is not text
     * cannot reintroduce this.
     */
    it('mounts nothing inside a segment that could take its touch', () => {
        const composer = mountComposer();
        const segments = ['Permission mode', 'Read aloud', 'Reasoning effort', 'Model'];
        for (const label of segments) {
            const rendered = composer.seen.get(label);
            expect(rendered, label).toBeTruthy();
            const children = (rendered!.node.children ?? [])
                .filter((child: any) => child && typeof child === 'object');
            expect(children.length, `${label} draws something`).toBeGreaterThan(0);
            for (const child of children) {
                expect(child.props?.pointerEvents, `${label}'s ${child.type} takes touches`)
                    .toBe('none');
            }
        }
    });

    it('never lets one segment answer for another', () => {
        const composer = mountComposer();
        for (const label of ['Permission mode', 'Read aloud', 'Reasoning effort', 'Model']) {
            const segment = frameByName(composer.frames, label);
            const target = pressTargetAt(composer.frames, composer.seen, centreOf(segment));
            expect(target?.name, label).toBe(label);
        }
    });
});
