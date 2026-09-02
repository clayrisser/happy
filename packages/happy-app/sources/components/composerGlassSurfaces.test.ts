/**
 * THE COMPOSER'S GLASS HOSTS, MOUNTED, NONE OF THEM CLIPPED, AND ONE OF THEM
 * INTERACTIVE (DROVE-328, DROVE-343).
 *
 * Clay, from his phone with the bubble mid-press: "This behaves like Liquid
 * Glass but when it zooms its borders are clipped." The zoom is the platform's
 * press response, which DROVE-266 asked for by turning `isInteractive` on for
 * the card; the clipping is `overflow: 'hidden'` on the same host, which the
 * same commit kept through a `pressTarget={false}` escape hatch. DROVE-202 had
 * already found that an ExpoView's `overflow` becomes `clipsToBounds` on the
 * view the `UIVisualEffectView` is pinned to, so the swell is cut at the
 * resting frame. 266 re-created that on the one surface it also made swell.
 *
 * `glassInteractionPolicy.test.ts` holds the rule. This file holds the HOSTS:
 * it mounts the composer's material the way `AgentInput` and
 * `ComposerControlButton` draw it and reads the style that reaches the native
 * view, because the rule was right in DROVE-202 and the composer still shipped
 * clipped. What a caller's style says, and what the primitive does with it
 * last, is what this can see and a pure function cannot.
 *
 * The composer has THREE glass hosts on the material, and all three answer a
 * finger:
 *
 *   the shell      `MobileGlassSurface` with `COMPOSER_BUBBLE_SURFACE`, over a
 *                  caller style that still carries `overflow: 'hidden'` for
 *                  the flat desktop card underneath it. NOT interactive since
 *                  DROVE-343, and still never clipped.
 *   the text row   NOT a host. It is a plain view, and the bubble's press
 *                  target: it reports its touches and the shell answers them
 *                  for the length of the press. It carried a surface of its own
 *                  for one OTA and Clay photographed it as a lighter panel.
 *   a filled disc  `ComposerControlButton` with a fill, which is
 *                  `GlassChromeButton` at 39 (DROVE-266) and therefore
 *                  `GlassChromeSurface`.
 *   the capsule    `ComposerSessionControls`, one `GlassChromeSurface` for its
 *                  four segments (DROVE-343, DROVE-169).
 *
 * WHY THE PRESS MOVED. `UIGlassEffect.isInteractive` is a property of the
 * effect VIEW and its interaction sees every touch delivered inside it, so
 * while the shell carried it a press on the `+` or on a segment of the capsule
 * swelled the whole bubble. Clay: "whenever I push a button from that group,
 * the input box should not also have that touch effect. The input box should
 * only get the touch effect when I'm touching where the text is." There is no
 * per-region switch. It is a plain boolean prop though, so the shell asks for
 * the press only while the text row reports a touch: scoped in time where it
 * cannot be scoped in space.
 *
 * Send and the mic at rest are bare glyphs with no glass of their own
 * (DROVE-254, DROVE-264). They drew the shell's swell and now draw
 * `BubblePressable`'s own pressed state, which is what they have on any phone
 * without the material — the cost of the ruling, and the right side of it,
 * because a press on send is a press on a control.
 *
 * WHY THE BUBBLE NEEDS NO CLIP OF ITS OWN. The only thing an unclipped card
 * could show past its corner is a child reaching the drawn arc, and
 * `composerBubbleLayout.spec.ts` measures every disc's clearance from that arc
 * at every text height (3.829pt, never under 2). The field is transparent on
 * iOS, the attachment strip is a ScrollView that clips its own thumbnails
 * inside the 9pt inset, and the bubble's gradient rounds itself off the
 * caller's radius (DROVE-202). So the clip was never rounding anything on the
 * material; it was only cutting the swell.
 */
import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { host, theme, flatten, glassApi } = vi.hoisted(() => {
    const flatten = (style: unknown): Record<string, unknown> => {
        if (!style) {
            return {};
        }
        if (Array.isArray(style)) {
            return style.reduce<Record<string, unknown>>(
                (merged, entry) => Object.assign(merged, flatten(entry)),
                {},
            );
        }
        return { ...(style as Record<string, unknown>) };
    };
    return {
        host: (name: string) => (props: any) => React.createElement(name, props, props.children),
        theme: {
            dark: true,
            colors: {
                surface: '#111111',
                surfaceHigh: '#222222',
                text: '#ffffff',
                glass: {
                    border: 'rgba(255,255,255,0.12)',
                    background: '#000000',
                    backgroundStrong: '#000000',
                    tint: 'rgba(16, 16, 16, 0.08)',
                },
            },
        },
        flatten,
        /** Flipped per test: the material is there, or the phone is older. */
        glassApi: { available: true },
    };
});

vi.mock('react-native', () => ({
    Platform: {
        OS: 'ios',
        select: (options: Record<string, unknown>) => ('ios' in options ? options.ios : options.default),
    },
    StyleSheet: {
        create: (input: any) => input,
        flatten,
        hairlineWidth: 0.5,
        absoluteFill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
        absoluteFillObject: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
    },
    View: host('View'),
    Text: host('Text'),
    Pressable: host('Pressable'),
    AccessibilityInfo: {
        isReduceTransparencyEnabled: () => Promise.resolve(false),
        addEventListener: () => ({ remove: () => {} }),
    },
}));

vi.mock('expo-glass-effect', () => ({
    GlassView: host('GlassView'),
    isGlassEffectAPIAvailable: () => glassApi.available,
}));
vi.mock('expo-blur', () => ({ BlurView: host('BlurView') }));
vi.mock('expo-linear-gradient', () => ({ LinearGradient: host('LinearGradient') }));
vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({ theme }),
    StyleSheet: { create: (input: any) => (typeof input === 'function' ? input(theme) : input) },
}));
vi.mock('@/utils/platform', () => ({ isRunningOnMac: () => false }));
// The capsule's own dependencies. `GlassChromeSurface` is deliberately NOT
// mocked here — it is the host under test.
vi.mock('@expo/vector-icons', () => ({ Ionicons: host('Ionicons') }));
vi.mock('react-native-svg', () => ({
    default: host('Svg'), Circle: host('Circle'), Line: host('Line'), Path: host('Path'),
}));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
// Reanimated, which vitest cannot transform. `ComposerBubble`'s rows are
// `Animated.View`s so Home can hand them its reveal timings; what this file
// needs from them is only that they are views with a style.
vi.mock('react-native-reanimated', () => ({ default: { View: host('AnimatedView') } }));
// Reanimated, which vitest cannot transform. A bare glyph owes this file only
// the fact that it mounts no glass of its own.
vi.mock('./BubblePressable', () => ({ BubblePressable: host('BubblePressable') }));

import { MobileGlassSurface } from './MobileGlass';
import { ComposerControlButton } from './ComposerControlButton';
import { ComposerSessionControls } from './ComposerSessionControls';
import { ComposerBubble } from './ComposerBubble';
import * as layoutModule from './composerBubbleLayout';
import {
    COMPOSER_BUBBLE_SURFACE,
    resolveComposerBubbleSurfaceStyle,
    resolveComposerShellInteractive,
} from './composerBubbleLayout';
import { MOBILE_COMPOSER_BUBBLE_CONTROL_SIZE, MOBILE_COMPOSER_METRICS } from './agentInputLayout';
import {
    COMPOSER_IN_FIELD_DISC,
    composerGlassTint,
    composerSessionCapsuleFill,
} from './composerControlColour';

beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
    glassApi.available = true;
});

function mount(element: React.ReactElement) {
    let renderer: ReturnType<typeof create>;
    act(() => {
        renderer = create(element);
    });
    return renderer!;
}

/**
 * The card's style as `AgentInput` hands it over: the desktop `unifiedPanel`
 * underneath, which clips because off the material it is the only thing
 * rounding the field's background, and the mobile panel over it with the
 * bubble's radius. The primitive decides `overflow` LAST (DROVE-202); this is
 * the caller trying to have a say.
 */
const cardStyle = [
    { borderRadius: 16, overflow: 'hidden' as const, paddingHorizontal: 8 },
    { borderRadius: MOBILE_COMPOSER_METRICS.shellRadius, backgroundColor: 'transparent' },
];

/**
 * The card as `AgentInput` hands it over on a given material (DROVE-343).
 *
 * The composer's own overflow answer goes on LAST, exactly where the renderer
 * puts it, and takes the material as its argument: unclipped on Liquid Glass
 * because three surfaces inside the shell swell, clipped off it because the
 * flat card is then the only thing rounding what it holds.
 */
const cardStyleOn = (drawsNativeGlass: boolean) => [
    ...cardStyle,
    resolveComposerBubbleSurfaceStyle(drawsNativeGlass),
];

const bubble = () => mount(React.createElement(
    MobileGlassSurface,
    { ...COMPOSER_BUBBLE_SURFACE, enabled: true, style: cardStyleOn(glassApi.available) },
    React.createElement('Field'),
));

const glassViews = (renderer: ReturnType<typeof create>) => renderer.root.findAllByType('GlassView' as any);

describe('the composer shell is calm glass and is not clipped (DROVE-328, DROVE-343)', () => {
    it('does NOT ask UIGlassEffect for the press, so a control press leaves it still', () => {
        // DROVE-266 put `interactive` here and it did what it says: the effect
        // view answers every touch delivered inside it by swelling. That is
        // why the bubble swelled under the `+`, which is the ticket. There is
        // no per-region switch on the effect, so the press moved to the text
        // row rather than being filtered here.
        expect(COMPOSER_BUBBLE_SURFACE.interactive).toBe(false);
        const [glass] = glassViews(bubble());
        expect(glass.props.isInteractive).toBe(false);
    });

    it('reaches the native view with overflow visible, whatever the desktop card\'s style said', () => {
        // The caller's `overflow: 'hidden'` is still in the array; the
        // composer's own answer comes after it and wins. This is the line that
        // was `hidden` on Clay's phone, and it matters MORE now than it did:
        // the shell holds three surfaces that swell past their resting frames,
        // so a clipped shell would cut all three at the bubble's edge.
        const [glass] = glassViews(bubble());
        expect(flatten(glass.props.style).overflow).toBe('visible');
        expect(resolveComposerBubbleSurfaceStyle(true).overflow).toBe('visible');
    });

    it('keeps the bubble\'s radius on the effect view, so the glass itself is still rounded', () => {
        const [glass] = glassViews(bubble());
        expect(flatten(glass.props.style).borderRadius).toBe(MOBILE_COMPOSER_METRICS.shellRadius);
    });

    it('rounds its own gradient off that radius, because nothing clips it any more', () => {
        // DROVE-202's companion rule for an unclipped surface: the full-bleed
        // overlay has to round its own corners rather than borrow a clip.
        const renderer = bubble();
        const [gradient] = renderer.root.findAllByType('LinearGradient' as any);
        expect(flatten(gradient.props.style).borderRadius).toBe(MOBILE_COMPOSER_METRICS.shellRadius);
    });

    it('still mounts the field inside the material', () => {
        expect(bubble().root.findAllByType('Field' as any)).toHaveLength(1);
    });

    it('keeps the flat card clipped on a phone without the material', () => {
        // Off the material the caller's clip is the only thing rounding what
        // the card holds, and DROVE-202 left that alone on purpose.
        glassApi.available = false;
        const renderer = bubble();
        expect(glassViews(renderer)).toHaveLength(0);
        const [blur] = renderer.root.findAllByType('BlurView' as any);
        expect(flatten(blur.props.style).overflow).toBe('hidden');
    });
});

/**
 * THE TEXT ROW DRAWS NOTHING AT REST, AND THE SHELL DRAWS THE PRESS
 * (DROVE-343, second pass).
 *
 * The first pass asserted the opposite of this block: that the text row mounts
 * an interactive `MobileGlassSurface` of the shell's own material, on the
 * reasoning that glass nested in glass has nothing left to refract
 * (DROVE-254). The EFFECT does not, and that was never the whole surface:
 * `MobileGlassSurface` also paints `chromeGlassTint` — DROVE-171's tint,
 * chosen so the composer SEPARATES from the chat behind it — and a full-bleed
 * white `LinearGradient` over it. On OTA 01a05f69, iOS 26 build 18, Clay:
 * "What the hell happened here?" over a screenshot of a distinctly lighter
 * rounded panel filling the field.
 *
 * So the assertions are retargeted to the thing the screenshot falsified: a
 * view mounted at rest draws at rest, so nothing is mounted. What is left is a
 * plain view reporting its touches, and the shell's `isInteractive` following
 * them for the length of the press.
 */
describe('the text row draws nothing at rest (DROVE-343)', () => {
    const bubbleWith = (props: Record<string, unknown> = {}) => mount(React.createElement(
        ComposerBubble,
        { style: cardStyle, ...props } as never,
        React.createElement('Field'),
    ));

    it('mounts exactly one glass host, and it is the shell', () => {
        // TWO was the bug. The second was the field's own, and it is the panel
        // in the photograph.
        const views = glassViews(bubbleWith());
        expect(views).toHaveLength(1);
        expect(flatten(views[0].props.style).borderRadius)
            .toBe(MOBILE_COMPOSER_METRICS.shellRadius);
    });

    it('gives the field\u2019s row no material, no tint and no radius of its own', () => {
        const renderer = bubbleWith();
        const field = renderer.root.findAllByType('Field' as any)[0];
        expect(field).toBeTruthy();
        // Every ancestor style between the field and the shell: nothing in it
        // may paint. A `backgroundColor`, a `tintColor` or a `borderRadius`
        // here is the lighter panel coming back.
        const row = renderer.root.findAllByType('View' as any)
            .filter((node: any) => node.findAllByType('Field' as any).length > 0);
        for (const node of row) {
            const style = flatten(node.props.style);
            expect(style.backgroundColor).toBeUndefined();
            expect(style.borderRadius).toBeUndefined();
            expect(style.borderWidth).toBeUndefined();
            expect(node.props.tintColor).toBeUndefined();
        }
        // And the resolver no longer publishes a surface for it to wear.
        expect('COMPOSER_BUBBLE_TEXT_ROW_SURFACE' in layoutModule).toBe(false);
    });

    it('leaves the shell calm until the field is actually held', () => {
        // At rest the bubble is exactly what it was before this ticket: one
        // calm glass shell, no press anywhere.
        const [glass] = glassViews(bubbleWith());
        expect(glass.props.isInteractive).toBe(false);
        expect(resolveComposerShellInteractive(null)).toBe(false);
    });

    it('spends the field\u2019s press on the shell, and nothing else does', () => {
        // The press case Clay kept: "The input box should only get the touch
        // effect when I'm touching where the text is." The row reports the
        // touch, the shell answers it, and a touch that starts on the `+` or
        // the capsule never reaches this handler at all.
        expect(resolveComposerShellInteractive('textRow')).toBe(true);
        expect(resolveComposerShellInteractive('sessionCapsule')).toBe(false);
        expect(resolveComposerShellInteractive('add')).toBe(false);

        const renderer = bubbleWith();
        const row = renderer.root.findAllByType('View' as any)
            .find((node: any) => typeof node.props.onTouchStart === 'function');
        expect(row, 'the field\u2019s row reports its own touches').toBeTruthy();
        act(() => { row!.props.onTouchStart(); });
        expect(glassViews(renderer)[0].props.isInteractive).toBe(true);
        act(() => { row!.props.onTouchEnd(); });
        expect(glassViews(renderer)[0].props.isInteractive).toBe(false);
        // A drag off the field ends it too, or the bubble would stay swollen.
        act(() => { row!.props.onTouchStart(); });
        act(() => { row!.props.onTouchCancel(); });
        expect(glassViews(renderer)[0].props.isInteractive).toBe(false);
    });

    it('never mounts or unmounts a host to draw that press', () => {
        // DROVE-286: the press stream must not ride a view the state can
        // unmount. Swapping a glass host in on touch-down would do exactly
        // that, under the finger, and take the keyboard with it.
        const renderer = bubbleWith();
        const before = glassViews(renderer).length;
        const row = renderer.root.findAllByType('View' as any)
            .find((node: any) => typeof node.props.onTouchStart === 'function');
        act(() => { row!.props.onTouchStart(); });
        expect(glassViews(renderer)).toHaveLength(before);
        expect(renderer.root.findAllByType('Field' as any)).toHaveLength(1);
    });
});

describe('the shared composer keeps its own padding under a hostile card style (DROVE-345)', () => {
    /**
     * Both screens hand `ComposerBubble` a card style, and a card style setting
     * `paddingHorizontal` or `paddingVertical` beats a shorthand inside the
     * component however it is ordered. That leak shipped for two tickets as a
     * comment claiming zero padding over a style that never wrote one, and a
     * spec that resolves the GEOMETRY cannot see it, because it lives in the
     * stylesheet.
     */
    const hostile = { paddingHorizontal: 8, paddingVertical: 2, paddingBottom: 8 };

    it('applies the bubble\u2019s four sides after whatever the caller said', () => {
        const renderer = mount(React.createElement(
            ComposerBubble,
            { style: hostile } as never,
            React.createElement('Field'),
        ));
        const [shell] = glassViews(renderer);
        const resolved = flatten(shell.props.style);
        expect(resolved.paddingTop).toBe(MOBILE_COMPOSER_METRICS.bubbleInset);
        expect(resolved.paddingLeft).toBe(MOBILE_COMPOSER_METRICS.bubbleInset);
        expect(resolved.paddingRight).toBe(MOBILE_COMPOSER_METRICS.bubbleInset);
        // The floor is the only side with no text against it (DROVE-236).
        expect(resolved.paddingBottom).toBe(MOBILE_COMPOSER_METRICS.bubbleInsetBottom);
    });

    it('mounts ONE calm host with the field inside it', () => {
        const views = glassViews(mount(React.createElement(
            ComposerBubble,
            {} as never,
            React.createElement('Field'),
        )));
        // TWO here for one OTA — the shell, and a surface of the field's own
        // inside it — and the second is the lighter panel Clay photographed.
        // One host, calm at rest, is the whole shape of the fix.
        expect(views).toHaveLength(1);
        expect(views[0].props.isInteractive).toBe(false);
        expect(views[0].findAllByType('Field' as any).length).toBeGreaterThan(0);
    });

    it('puts one gap between trailing controls and none before the first', () => {
        // The row wants a fixed 6 in three places and slack in exactly one, and
        // a row-level `gap` cannot say that: it would gap both sides of the
        // spacer too (`resolveComposerBubbleGapGeometry`).
        const renderer = mount(React.createElement(
            ComposerBubble,
            {
                leading: React.createElement('Add'),
                controls: React.createElement('Capsule'),
                trailing: [React.createElement('Mic'), React.createElement('Send')],
            } as never,
            React.createElement('Field'),
        ));
        const gaps = renderer.root.findAllByType('View' as any)
            .filter((node: any) => flatten(node.props.style).width === MOBILE_COMPOSER_METRICS.controlGap);
        // `+` | capsule, capsule | spacer, mic | send. Three, never four.
        expect(gaps).toHaveLength(3);
    });
});

describe('a filled composer disc is interactive glass and is not clipped (DROVE-328)', () => {
    const disc = () => mount(React.createElement(
        ComposerControlButton,
        { fill: COMPOSER_IN_FIELD_DISC.dark, accessibilityLabel: 'Add' },
        React.createElement('Glyph'),
    ));

    it('is one GlassView, asking for the press', () => {
        const views = glassViews(disc());
        expect(views).toHaveLength(1);
        expect(views[0].props.isInteractive).toBe(true);
    });

    it('reaches the native view with overflow visible', () => {
        const [glass] = glassViews(disc());
        expect(flatten(glass.props.style).overflow).toBe('visible');
    });

    it('spends the fill as the effect\'s tint rather than a view over it', () => {
        // DROVE-254's guarantee survives the disc being real glass: the fill
        // is opaque and it is the material's own colour, not a lid on it.
        const [glass] = glassViews(disc());
        expect(glass.props.tintColor).toBe(COMPOSER_IN_FIELD_DISC.dark);
    });
});

describe('a bare glyph on the bubble mounts no glass of its own (DROVE-254, DROVE-264)', () => {
    it('is the bubble\'s press, not a second surface', () => {
        const renderer = mount(React.createElement(
            ComposerControlButton,
            { accessibilityLabel: 'Send' },
            React.createElement('Glyph'),
        ));
        expect(glassViews(renderer)).toHaveLength(0);
        expect(renderer.root.findAllByType('BubblePressable' as any)).toHaveLength(1);
    });
});
