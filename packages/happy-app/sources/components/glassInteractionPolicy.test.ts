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

    it('uses Expo-native settings menus across iPhone and iPad but not Mac, web, or Android', () => {
        expect(glassPolicy.shouldUseExpoNativeSettingsMenu('ios', false)).toBe(true);
        expect(glassPolicy.shouldUseExpoNativeSettingsMenu('ios', true)).toBe(false);
        expect(glassPolicy.shouldUseExpoNativeSettingsMenu('web', false)).toBe(false);
        expect(glassPolicy.shouldUseExpoNativeSettingsMenu('android', false)).toBe(false);
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
