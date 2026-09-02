/**
 * THE SESSIONS-LIST ENTRY IS THE SESSION COMPOSER, DISABLED (DROVE-394).
 *
 * Clay, on the sessions list: the new-session entry should look the SAME as
 * the input box inside a session, everything greyed out, and a tap anywhere
 * on it should open the new-session options. Same component in a disabled
 * state, not a separate design.
 *
 * So this mounts the REAL bubble with the REAL capsule and the REAL discs,
 * twice from one set of props: once as the sheet draws it, once as the entry
 * draws it (`disabled`, `onPress`). It resolves both trees through the layout
 * engine (DROVE-214's rule) and holds three things: every segment and disc the
 * sheet draws is drawn on the entry at the same frame; a finger at the drawn
 * centre of any of them reaches the entry's one press and never a picker; and
 * nothing on the way to a glass surface is dimmed with `opacity`, because
 * UIKit stops drawing an effect under an ancestor below full alpha, which is
 * what left the sheet with bare glyphs in Clay's photograph.
 */
import * as React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
import { ComposerControlButton } from './ComposerControlButton';
import { ComposerSessionControls } from './ComposerSessionControls';
import {
    MOBILE_COMPOSER_BUBBLE_BASE_HEIGHT,
    MOBILE_COMPOSER_BUBBLE_CONTROL_SIZE,
    MOBILE_COMPOSER_CAPSULE_SEGMENT_WIDTH,
    MOBILE_COMPOSER_METRICS,
} from './agentInputLayout';
import { COMPOSER_IN_FIELD_DISC } from './composerControlColour';
import { getEffortLevelsForModel, getHardcodedPermissionModes } from './modelModeOptions';
import { homeComposerCapsule } from './homeComposer';
import { type FlexNode, type FlexFrame, resolveFlexFrames } from './flexFrames';

beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

const translate = ((key: string) => key) as never;
const BUBBLE_WIDTH = 393 - 2 * MOBILE_COMPOSER_METRICS.shellGutter;
const ENTRY_LABEL = 'New session';
const SEGMENTS = ['Permission mode', 'Read aloud', 'Reasoning effort', 'Model'];
const DISCS = ['Add image', 'Send'];

const LAYOUT_KEYS = new Set([
    'flexDirection', 'alignItems', 'justifyContent', 'flex', 'flexShrink',
    'width', 'height', 'minHeight', 'maxHeight',
    'padding', 'paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight',
    'gap', 'borderRadius',
]);
const REFUSED_KEYS = new Set(['position', 'top', 'left', 'right', 'bottom', 'transform', 'margin']);

function layoutStyle(name: string, style: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(style)) {
        if (value === undefined || value === null) continue;
        if (REFUSED_KEYS.has(key)) {
            throw new Error(`homeEntryComposer: "${name}" places itself with "${key}" (DROVE-214)`);
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
    const children = (node.children ?? []).filter((child: any) => (
        child && typeof child === 'object'
        // The material's highlight, placed absolutely on the phone: not a row.
        && child.type !== 'LinearGradient'
    ));
    return {
        name,
        style: layoutStyle(name, flatten(raw)) as FlexNode['style'],
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
    if (!found) throw new Error(`homeEntryComposer: no frame named "${name}"`);
    return found;
}

function contains(frame: FlexFrame, point: { x: number; y: number }): boolean {
    return point.x >= frame.x && point.x <= frame.x + frame.width
        && point.y >= frame.y && point.y <= frame.y + frame.height;
}

/** The deepest enabled pressable under the point: what the responder system settles on. */
function pressTargetAt(root: FlexFrame, seen: Map<string, Rendered>, point: { x: number; y: number }): Rendered | null {
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

function centreOf(frame: FlexFrame): { x: number; y: number } {
    return { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 };
}

/** Every host element in render order, with its props. */
function eachNode(node: any, visit: (n: any) => void): void {
    if (!node || typeof node !== 'object') return;
    visit(node);
    (node.children ?? []).forEach((child: any) => eachNode(child, visit));
}

/**
 * HOME'S OWN CAPSULE PROPS, from the catalog the sheet reads.
 *
 * `homeComposerCapsule` is the one resolver both of Home's mounts use, so the
 * spec reads the same object the screen does rather than a restatement.
 */
function capsuleProps() {
    const permissionOptions = getHardcodedPermissionModes('claude', translate);
    const model = { key: 'claude-fable-5-1', name: 'Fable 5.1' };
    const effortOptions = getEffortLevelsForModel('claude', model.key);
    return homeComposerCapsule({
        agent: { key: 'claude', name: 'Claude Code' },
        permission: permissionOptions[0] ?? null,
        permissionOptions,
        model,
        modelOptions: [model],
        effort: effortOptions[Math.min(effortOptions.length - 1, 3)] ?? null,
        effortOptions,
        effortPickerOptions: effortOptions,
    });
}

interface Mounted {
    json: any;
    frames: FlexFrame;
    seen: Map<string, Rendered>;
    opened: number;
    picked: string[];
}

/**
 * Home's composer, drawn the way `HomeDock` draws it: the `+`, the capsule
 * with the speaker, and send, inside `ComposerBubble`. `entry` is the
 * sessions-list face; without it this is the sheet's.
 */
function mount(entry: boolean): Mounted {
    const capsule = capsuleProps();
    const picked: string[] = [];
    let opened = 0;
    const glyph = entry ? theme.colors.textSecondary : theme.colors.text;
    let renderer: any;
    act(() => {
        renderer = create(React.createElement(
            ComposerBubble,
            {
                onPress: entry ? () => { opened += 1; } : undefined,
                accessibilityLabel: entry ? ENTRY_LABEL : undefined,
                leading: React.createElement(ComposerControlButton, {
                    fill: COMPOSER_IN_FIELD_DISC.dark,
                    disabled: entry,
                    onPress: entry ? undefined : () => picked.push('add'),
                    accessibilityRole: 'button',
                    accessibilityLabel: 'Add image',
                }, React.createElement('Ionicons', { name: 'add', color: glyph })),
                controls: React.createElement(ComposerSessionControls, {
                    label: capsule.label,
                    size: MOBILE_COMPOSER_BUBBLE_CONTROL_SIZE,
                    segmentWidth: MOBILE_COMPOSER_CAPSULE_SEGMENT_WIDTH,
                    verticalSlop: MOBILE_COMPOSER_METRICS.primaryActionSlop,
                    modeKey: capsule.modeKey,
                    effortIndex: capsule.effortIndex,
                    effortCount: capsule.effortCount,
                    canOpen: capsule.canOpen,
                    readAloud: {
                        glyph: 'volume-mute-outline',
                        fill: 'none',
                        on: false,
                        accessibilityLabel: 'Read aloud',
                        onPress: () => picked.push('readAloud'),
                    },
                    onPress: (picker: string) => picked.push(picker),
                    disabled: entry,
                } as never),
                trailing: [React.createElement(ComposerControlButton, {
                    key: 'primary',
                    disabled: entry,
                    onPress: entry ? undefined : () => picked.push('send'),
                    accessibilityRole: 'button',
                    accessibilityLabel: 'Send',
                }, React.createElement('Ionicons', { name: 'arrow-up', color: glyph }))],
            } as never,
            React.createElement('View', { key: 'field', style: { height: 22 } }),
        ));
    });
    const json = renderer.toJSON();
    const seen = new Map<string, Rendered>();
    const root = toFlexNode(json, 0, seen);
    return {
        json,
        frames: resolveFlexFrames(root, BUBBLE_WIDTH),
        seen,
        get opened() { return opened; },
        picked,
    };
}

describe('the sessions-list entry is the session composer, disabled (DROVE-394)', () => {
    it('draws every segment and disc the sheet draws, at the same frame', () => {
        const sheet = mount(false);
        const entry = mount(true);
        for (const name of [...SEGMENTS, ...DISCS]) {
            const drawn = frameByName(entry.frames, name);
            const reference = frameByName(sheet.frames, name);
            expect(drawn.width, `${name} is drawn on the entry`).toBeGreaterThan(0);
            expect(drawn.height, `${name} is drawn on the entry`).toBeGreaterThan(0);
            expect({ x: drawn.x, width: drawn.width }, `${name} sits where the sheet's does`)
                .toEqual({ x: reference.x, width: reference.width });
        }
    });

    it('is as tall at rest as the bubble the sheet opens into', () => {
        // The list keeps this much clear under the dock, and the sheet's
        // shell animates from it: one number, the bubble's own.
        expect(mount(true).frames.height).toBe(MOBILE_COMPOSER_BUBBLE_BASE_HEIGHT);
    });

    it('answers a finger anywhere on it with the one press, never a picker', () => {
        const entry = mount(true);
        for (const name of [...SEGMENTS, ...DISCS]) {
            const target = pressTargetAt(entry.frames, entry.seen, centreOf(frameByName(entry.frames, name)));
            expect(target?.name, `a finger on ${name}`).toBe(ENTRY_LABEL);
            act(() => { target!.onPress!(); });
        }
        expect(entry.opened).toBe(SEGMENTS.length + DISCS.length);
        expect(entry.picked).toEqual([]);
    });

    it('lets nothing inside the bubble take a touch, and never lenses the shell', () => {
        const entry = mount(true);
        const surface = entry.json.children[0];
        expect(surface.type).toBe('GlassView');
        expect(surface.props.pointerEvents).toBe('none');
        expect(surface.props.isInteractive).toBe(false);
        // The sheet's mount is untouched by the entry's rule.
        const sheet = mount(false).json;
        expect(sheet.type).toBe('GlassView');
        expect(sheet.props.pointerEvents).toBeUndefined();
    });

    it('greys every glyph with the placeholder colour, not an opacity over the glass', () => {
        const entry = mount(true);
        const glyphs: string[] = [];
        eachNode(entry.json, (node) => {
            if (node.type === 'Ionicons') glyphs.push(node.props.color);
            if (node.type === 'Line') glyphs.push(node.props.stroke);
            if (node.type === 'Text' && node.children?.includes('Fable 5.1')) {
                glyphs.push(flatten(node.props.style).color as string);
            }
            const style = flatten(typeof node.props?.style === 'function'
                ? node.props.style({ pressed: false })
                : node.props?.style);
            if (style.opacity !== undefined) {
                expect(style.opacity, `${node.type} fades`).toBe(1);
            }
        });
        // Padlock, speaker, needle, name, `+`, send.
        expect(glyphs.length).toBeGreaterThanOrEqual(6);
        for (const colour of glyphs) expect(colour).toBe(theme.colors.textSecondary);
    });

    it('is disabled in the tree VoiceOver reads', () => {
        const entry = mount(true);
        for (const name of [...SEGMENTS, ...DISCS]) {
            const rendered = entry.seen.get(name);
            expect(rendered, name).toBeTruthy();
            expect(rendered!.disabled || rendered!.node.props.accessibilityState?.disabled, `${name} disabled`).toBe(true);
        }
    });
});

/**
 * HOME'S REVEAL MOVES; IT DOES NOT FADE (DROVE-394).
 *
 * A source scan, because the fault is a style on the screen and no render of
 * the shared components can see it. `focusedComposerAnimationStyle` is the
 * shell's, `focusedActionsRevealStyle` the button row's; both stand above
 * every glass surface in the composer, and either carrying `opacity` is the
 * sheet Clay photographed.
 */
describe('nothing above a glass surface on the new-session sheet animates opacity (DROVE-394)', () => {
    const homeDock = readFileSync(join(__dirname, 'HomeDock.tsx'), 'utf8');

    const bodyOf = (name: string): string => {
        const start = homeDock.indexOf(`const ${name} = useAnimatedStyle(`);
        expect(start, name).toBeGreaterThan(-1);
        let depth = 0;
        for (let index = homeDock.indexOf('(', start); index < homeDock.length; index += 1) {
            if (homeDock[index] === '(') depth += 1;
            if (homeDock[index] === ')') {
                depth -= 1;
                if (depth === 0) return homeDock.slice(start, index);
            }
        }
        throw new Error(`unterminated ${name}`);
    };

    it.each(['focusedComposerAnimationStyle', 'focusedActionsRevealStyle'])('%s carries no opacity', (name) => {
        expect(bodyOf(name)).not.toContain('opacity');
    });

    it('opens from the bubble’s own resting height', () => {
        expect(bodyOf('focusedComposerAnimationStyle')).toContain('MOBILE_COMPOSER_BUBBLE_BASE_HEIGHT');
        expect(homeDock).toContain('export const MOBILE_HOME_DOCK_CONTENT_INSET = MOBILE_HOME_DOCK_TOP_PADDING\n    + MOBILE_COMPOSER_BUBBLE_BASE_HEIGHT');
    });

    it('mounts the entry as the bubble with one press and the sheet’s capsule', () => {
        expect(homeDock).toContain('onPress={openFocusMode}');
        expect(homeDock).not.toContain('activateOnPress');
        expect(homeDock).not.toContain('Plan, ask, build…"\n');
        expect(homeDock.match(/readAloud=\{readAloudSegment\}/g)?.length).toBe(2);
        expect(homeDock.match(/label=\{capsule\.label\}/g)?.length).toBe(2);
    });
});
