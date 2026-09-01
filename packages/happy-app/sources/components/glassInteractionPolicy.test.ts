import { describe, expect, it } from 'vitest';
import * as glassPolicy from './glassInteractionPolicy';
import { resolveBubblePressableFeedback } from './bubblePressableFeedback';

describe('native GlassView interaction policy (DROVE-169)', () => {
    it('asks UIGlassEffect for its own press response on an interactive surface', () => {
        expect(glassPolicy.getNativeGlassInteractivity(true, true)).toBe(true);
    });

    it('leaves a surface nothing lands on alone', () => {
        expect(glassPolicy.getNativeGlassInteractivity(false, true)).toBe(false);
    });

    it('asks for nothing where the effect does not exist, so the fallback keeps its own pressed state', () => {
        expect(glassPolicy.getNativeGlassInteractivity(true, false)).toBe(false);
        expect(glassPolicy.getNativeGlassInteractivity(false, false)).toBe(false);
    });

    it('has no menu-versus-sheet gate left to ask (DROVE-242)', () => {
        // The composer's mode and model were SwiftUI menus on iOS and sheets
        // everywhere else, and this module held the split. They are sheets on
        // every platform now, so the question is not asked here or anywhere.
        expect('shouldUseExpoNativeSettingsMenu' in glassPolicy).toBe(false);
    });
});

describe('hand-written press feedback stands down for the platform (DROVE-169)', () => {
    it('drops the spring inside a surface drawing the real press', () => {
        expect(resolveBubblePressableFeedback({
            platform: 'native',
            nativeGlassPress: true,
        })).toEqual({ animateScale: false });
    });

    it('keeps it everywhere else, so a control off the material still answers a touch', () => {
        expect(resolveBubblePressableFeedback({
            platform: 'native',
            nativeGlassPress: false,
        })).toEqual({ animateScale: true });
        expect(resolveBubblePressableFeedback({ platform: 'native' })).toEqual({ animateScale: true });
    });

    it('never animates on web, whatever the surface says', () => {
        expect(resolveBubblePressableFeedback({
            platform: 'web',
            nativeGlassPress: false,
        })).toEqual({ animateScale: false });
    });

    it('honours an explicit opt-out', () => {
        expect(resolveBubblePressableFeedback({
            platform: 'native',
            scaleFeedback: false,
        })).toEqual({ animateScale: false });
    });
});

describe('a glass control has room to swell on press (DROVE-202)', () => {
    // Clay: "it's not that it's scaling up inside, it's that the size doesn't
    // grow". The effect was already interactive; the frame around it was not
    // letting the swell out.
    it('never clips the material, so the press swell can leave the resting frame', () => {
        expect(glassPolicy.getGlassSurfaceOverflow(true)).toBe('visible');
    });

    it('keeps the flat fallback clipped, because there it is what rounds the content', () => {
        expect(glassPolicy.getGlassSurfaceOverflow(false)).toBe('hidden');
    });
});

describe('pressed state stands down for the material (DROVE-202)', () => {
    it('draws nothing where UIGlassEffect is drawing the press', () => {
        expect(glassPolicy.shouldDrawPressedFallback(true, true)).toBe(false);
    });

    it('draws the fade off the material, so a phone without it still answers', () => {
        expect(glassPolicy.shouldDrawPressedFallback(false, true)).toBe(true);
    });

    it('draws nothing when the control is not pressed or is disabled', () => {
        expect(glassPolicy.shouldDrawPressedFallback(false, false)).toBe(false);
        expect(glassPolicy.shouldDrawPressedFallback(false, true, true)).toBe(false);
    });
});

/**
 * LIQUID GLASS BEHAVIOUR ON THE COMPOSER'S ROW (DROVE-266).
 *
 * Clay, with the row photographed: "shouldn't all these buttons have the Liquid
 * Glass behavior". The answer is in two halves and this suite pins both.
 *
 * The FILL cannot be glass, and that is DROVE-254's finding rather than a
 * shortfall in the wiring: a `UIGlassEffect` nested inside the bubble's own has
 * nothing left to refract, and Apple's `UIGlassContainerEffect` MERGES sibling
 * shapes, which is the "this blends in" complaint DROVE-254 was filed about. So
 * the opaque fills stay and `colorAlpha === 1` is untouched — asserted in
 * composerControlColour.spec.ts, where it always was.
 *
 * The BEHAVIOUR was genuinely missing, and reaches exactly the controls whose
 * glass is exposed.
 */
describe('which composer controls the platform can answer for (DROVE-266)', () => {
    const response = (surfaceDrawsNativeGlass: boolean, control: 'bare' | 'filled', disabled = false) =>
        glassPolicy.resolveComposerPressResponse({ surfaceDrawsNativeGlass, control, disabled });

    it('hands the press to the platform for a bare glyph on live material', () => {
        // Send, and the mic at rest (DROVE-254, DROVE-264). The glass is
        // exposed under the finger, so it lenses and the imitation stands down.
        expect(response(true, 'bare')).toEqual({ nativeGlass: true, fade: false });
    });

    it('keeps the fade on an opaque fill, because there is nothing under it to lens', () => {
        // The `+`, the session capsule, the audio disc and the mic once open.
        // This is the assertion that stops "turn interactive on" quietly
        // leaving four controls with no press response at all.
        expect(response(true, 'filled')).toEqual({ nativeGlass: false, fade: true });
    });

    it('keeps the fade everywhere when there is no material at all', () => {
        // A phone with no Liquid Glass, Reduce Transparency, the desktop
        // composer. Nothing is being covered and nothing is reacting.
        expect(response(false, 'bare')).toEqual({ nativeGlass: false, fade: true });
        expect(response(false, 'filled')).toEqual({ nativeGlass: false, fade: true });
    });

    it('draws exactly one response per press, and never zero', () => {
        // The property worth having, rather than four cases that happen to be
        // right: an enabled control always answers a touch, and never twice.
        for (const surface of [true, false]) {
            for (const control of ['bare', 'filled'] as const) {
                const r = response(surface, control);
                expect(r.nativeGlass !== r.fade, `${surface}/${control}`).toBe(true);
            }
        }
    });

    it('draws nothing at all for a disabled control', () => {
        expect(response(true, 'bare', true)).toEqual({ nativeGlass: false, fade: false });
        expect(response(false, 'filled', true)).toEqual({ nativeGlass: false, fade: false });
    });

    it('agrees with BubblePressable, so the spring and the fade cannot both run', () => {
        // The two imitations DROVE-169 named are the spring and the fade, and
        // they belong together: where the platform draws the press, neither
        // does. `BubblePressable` reads the same boolean this hands out.
        for (const control of ['bare', 'filled'] as const) {
            const r = response(true, control);
            const { animateScale } = resolveBubblePressableFeedback({
                platform: 'native',
                nativeGlassPress: r.nativeGlass,
            });
            expect(animateScale, control).toBe(r.fade);
        }
    });
});

describe('a glass surface that hosts a press without being one (DROVE-266)', () => {
    it('keeps its clip, so the composer card still rounds what it holds', () => {
        // DROVE-202 is about a surface that SWELLS under a finger, and the
        // composer card is not one: nobody presses the card. Conflating the two
        // would have made asking for the platform's press response cost the
        // card its shape.
        expect(glassPolicy.getGlassSurfaceOverflow(true, false)).toBe('hidden');
    });

    it('leaves every earlier caller exactly as it was', () => {
        // The default is the pre-DROVE-266 behaviour, so the eight chrome
        // surfaces DROVE-202 unclipped are untouched by this.
        expect(glassPolicy.getGlassSurfaceOverflow(true)).toBe('visible');
        expect(glassPolicy.getGlassSurfaceOverflow(true, true)).toBe('visible');
        expect(glassPolicy.getGlassSurfaceOverflow(false, false)).toBe('hidden');
        expect(glassPolicy.getGlassSurfaceOverflow(false, true)).toBe('hidden');
    });
});
