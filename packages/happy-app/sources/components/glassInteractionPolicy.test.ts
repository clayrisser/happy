import { describe, expect, it } from 'vitest';
import * as glassPolicy from './glassInteractionPolicy';
import { resolveBubblePressableFeedback } from './bubblePressableFeedback';
import {
    COMPOSER_IN_FIELD_DISC,
    COMPOSER_IN_FIELD_DISC_OPEN,
    composerControlPalette,
    composerGlassTint,
    composerPausedFill,
} from './composerControlColour';

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

/**
 * THE COMPOSER'S DISCS ARE THE PLATFORM'S BUTTON NOW, AND THE FILL IS ITS TINT
 * (DROVE-266).
 *
 * Clay, correcting the first answer: "stop doing your custom buttons shouldn't
 * they just be smaller liquid glass buttons". They should, so
 * `resolveComposerPressResponse` is gone along with the split it encoded, and
 * what is left to hold is the one thing that split was protecting: that no
 * translucent value can reach `UIGlassEffect.tintColor`, which is exactly how
 * DROVE-254's bug got in.
 */
describe('a composer fill spent as glass tint stays measurable (DROVE-254, DROVE-266)', () => {
    const fills = (dark: boolean) => [
        dark ? COMPOSER_IN_FIELD_DISC.dark : COMPOSER_IN_FIELD_DISC.light,
        dark ? COMPOSER_IN_FIELD_DISC_OPEN.dark : COMPOSER_IN_FIELD_DISC_OPEN.light,
        composerControlPalette(dark).recording,
        composerPausedFill(dark),
    ];

    it('passes every fill the row can wear, on both themes', () => {
        // The guard throws, so this is also the test that stops it ever firing
        // on a phone: every value the composer can hand it is a module constant
        // and every one of them is walked here.
        for (const dark of [true, false]) {
            for (const fill of fills(dark)) {
                expect(composerGlassTint(fill)).toBe(fill);
            }
        }
    });

    it('refuses the translucent tint the capsule used to be drawn in', () => {
        // `CHROME_GLASS_TINT` is the value that shipped and failed (DROVE-254).
        // It reached `tintColor` because nothing was in the way; something is
        // now.
        expect(() => composerGlassTint('rgba(255, 255, 255, 0.08)')).toThrow(/opaque/);
        expect(() => composerGlassTint('rgba(0, 0, 0, 0.5)')).toThrow(/DROVE-254/);
    });

    it('is the only way to the prop, so a fill cannot bypass the check', () => {
        // A plain hex passes through unchanged, which is what makes routing
        // every call site through it free rather than a tax somebody removes.
        expect(composerGlassTint('#282828')).toBe('#282828');
    });
});
