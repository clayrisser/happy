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

/**
 * THE COMPOSER CARD IS A PRESS TARGET THE MOMENT IT IS INTERACTIVE
 * (DROVE-328, reversing the split DROVE-266 drew here).
 *
 * Clay, from his phone with the bubble mid-press: "This behaves like Liquid
 * Glass but when it zooms its borders are clipped." DROVE-266 turned
 * `isInteractive` on for the card and, in the same commit, gave this function
 * a second argument so the card could keep `overflow: 'hidden'`, on the theory
 * that nobody presses the card and the lensing it wanted "happens inside its
 * own bounds". That is not how the effect works. `UIGlassEffect.isInteractive`
 * is a property of the effect VIEW, and the view answers a touch on anything
 * mounted in its `contentView` (the field, the capsule, a disc) by deforming
 * the whole material, which is the swell DROVE-202 diagnosed. So the card
 * swells, `clipsToBounds` pins it at the resting frame, and Clay photographed
 * the hard edge. 266 said "NOT VERIFIED ON A DEVICE"; this is the device.
 *
 * The argument is gone rather than defaulted, because a switch that puts the
 * clip back on the material is the exact escape hatch DROVE-202 moved the
 * decision in here to close. The call below still passes it, through a widened
 * type, to hold that a caller reaching for it gets nothing.
 */
describe('an interactive glass surface swells whatever it holds (DROVE-328)', () => {
    const overflowOf = glassPolicy.getGlassSurfaceOverflow as (
        drawsNativeGlass: boolean,
        ...legacy: unknown[]
    ) => 'visible' | 'hidden';

    it('never clips the composer card: the material answers a touch on anything inside it', () => {
        // This is the assertion DROVE-266 wrote the other way round, and the
        // one Clay's screenshot falsified.
        expect(overflowOf(true, false)).toBe('visible');
    });

    it('offers a caller no argument that puts the clip back', () => {
        // A second argument, in either polarity, changes nothing on the
        // material and nothing off it. The eight surfaces DROVE-202 unclipped
        // and the flat fallback it left clipped are all exactly as they were.
        expect(overflowOf(true)).toBe('visible');
        expect(overflowOf(true, true)).toBe('visible');
        expect(overflowOf(true, false)).toBe('visible');
        expect(overflowOf(false)).toBe('hidden');
        expect(overflowOf(false, false)).toBe('hidden');
        expect(overflowOf(false, true)).toBe('hidden');
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
