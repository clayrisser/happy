/**
 * THE COMPOSER'S GLASS HOSTS, MOUNTED, AND NONE OF THEM CLIPPED (DROVE-328).
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
 * The composer has two glass hosts on the material:
 *
 *   the bubble     `MobileGlassSurface` with `COMPOSER_BUBBLE_SURFACE`, over a
 *                  caller style that still carries `overflow: 'hidden'` for
 *                  the flat desktop card underneath it.
 *   a filled disc  `ComposerControlButton` with a fill, which is
 *                  `GlassChromeButton` at 39 (DROVE-266) and therefore
 *                  `GlassChromeSurface`.
 *
 * Send and the mic at rest are bare glyphs on the bubble with no glass of
 * their own (DROVE-254, DROVE-264), and the session capsule is an opaque
 * `View` by DROVE-254's ruling, so neither is a host and neither swells; the
 * bubble under them does. The capsule's own clip is asserted in
 * `glassInteractionPolicy.test.ts` as the flat case.
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
// Reanimated, which vitest cannot transform. A bare glyph owes this file only
// the fact that it mounts no glass of its own.
vi.mock('./BubblePressable', () => ({ BubblePressable: host('BubblePressable') }));

import { MobileGlassSurface } from './MobileGlass';
import { ComposerControlButton } from './ComposerControlButton';
import { COMPOSER_BUBBLE_SURFACE } from './composerBubbleLayout';
import { MOBILE_COMPOSER_METRICS } from './agentInputLayout';
import { COMPOSER_IN_FIELD_DISC } from './composerControlColour';

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

const bubble = () => mount(React.createElement(
    MobileGlassSurface,
    { ...COMPOSER_BUBBLE_SURFACE, enabled: true, style: cardStyle },
    React.createElement('Field'),
));

const glassViews = (renderer: ReturnType<typeof create>) => renderer.root.findAllByType('GlassView' as any);

describe('the composer bubble is interactive glass and is not clipped (DROVE-328)', () => {
    it('asks UIGlassEffect for the press, so it swells', () => {
        // DROVE-266's half that was right, and stays: without this the bubble
        // is a static surface and every control inside it fakes its press.
        expect(COMPOSER_BUBBLE_SURFACE.interactive).toBe(true);
        const [glass] = glassViews(bubble());
        expect(glass.props.isInteractive).toBe(true);
    });

    it('reaches the native view with overflow visible, whatever the caller\'s style said', () => {
        // The caller's `overflow: 'hidden'` is still in the array; the
        // primitive's answer comes after it and wins. This is the line that
        // was `hidden` on Clay's phone.
        const [glass] = glassViews(bubble());
        expect(flatten(glass.props.style).overflow).toBe('visible');
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
