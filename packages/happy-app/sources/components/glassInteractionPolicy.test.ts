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
