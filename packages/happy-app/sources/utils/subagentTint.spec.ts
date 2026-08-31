import { describe, expect, it, vi } from 'vitest';

// theme.ts reaches for Platform.select, and react-native's entry point is Flow
// source that vitest cannot parse. The phone is what this tint is for, so pick
// the ios branch.
vi.mock('react-native', () => ({
    Platform: {
        OS: 'ios',
        select: (options: Record<string, unknown>) => options.ios ?? options.native ?? options.default,
    },
}));

import { darkTheme, lightTheme } from '@/theme';
import {
    colorDistance,
    contrastRatio,
    createSubagentTheme,
    mixHex,
    parseHex,
    relativeLuminance,
    subagentThemeName,
    subagentTintPaletteFor,
    toHex,
    withAlpha,
} from '@/utils/subagentTint';

/**
 * WCAG AA for body text. Every surface the tint touches carries body text on
 * it, so this is the floor, checked against the theme's own text colour rather
 * than eyeballed in one theme.
 */
const bodyTextContrast = 4.5;

/**
 * The tint may not cost more than 15% of the contrast the untinted theme
 * already had. That is the check that actually bites: the app's secondary grey
 * sits near 3:1 on plain white to begin with, so an absolute floor would
 * either fail the shipped theme or pass any tint at all.
 */
const contrastRetention = 0.85;

/** Below this the wash would be invisible and the ticket unfixed. */
const visibleTint = 0.01;

const themes = [
    { name: 'light', theme: lightTheme },
    { name: 'dark', theme: darkTheme },
] as const;

describe('colour maths', () => {
    it('parses three and six digit hex, and refuses anything else', () => {
        expect(parseHex('#fff')).toEqual({ r: 255, g: 255, b: 255 });
        expect(parseHex('#007AFF')).toEqual({ r: 0, g: 122, b: 255 });
        expect(parseHex('rgba(0, 0, 0, 0.5)')).toBeNull();
        expect(parseHex('transparent')).toBeNull();
    });

    it('round-trips through toHex', () => {
        expect(toHex({ r: 0, g: 122, b: 255 })).toBe('#007aff');
    });

    it('mixes towards the overlay and clamps the ratio', () => {
        expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080');
        expect(mixHex('#000000', '#ffffff', 0)).toBe('#000000');
        expect(mixHex('#000000', '#ffffff', 1)).toBe('#ffffff');
        expect(mixHex('#000000', '#ffffff', 5)).toBe('#ffffff');
    });

    it('hands back colours it cannot parse instead of mangling them', () => {
        expect(mixHex('rgba(0, 0, 0, 0.5)', '#007AFF', 0.2)).toBe('rgba(0, 0, 0, 0.5)');
        expect(withAlpha('transparent', 0.5)).toBe('transparent');
    });

    it('turns a hex into rgba', () => {
        expect(withAlpha('#007AFF', 0.9)).toBe('rgba(0, 122, 255, 0.9)');
    });

    it('measures WCAG contrast', () => {
        expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
        expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
        expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 5);
        expect(relativeLuminance('#000000')).toBeCloseTo(0, 5);
        // Order does not matter.
        expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 5);
    });
});

describe('subagentThemeName', () => {
    it('maps the live theme to its tinted counterpart', () => {
        expect(subagentThemeName('dark')).toBe('darkSubagent');
        expect(subagentThemeName('light')).toBe('lightSubagent');
        expect(subagentThemeName(undefined)).toBe('lightSubagent');
    });

    it('is stable when it is handed a tinted name back', () => {
        expect(subagentThemeName('darkSubagent')).toBe('darkSubagent');
        expect(subagentThemeName('lightSubagent')).toBe('lightSubagent');
    });
});

describe.each(themes)('the $name theme, tinted', ({ theme }) => {
    const tinted = createSubagentTheme(theme);
    const palette = subagentTintPaletteFor(theme);

    // Every surface the tint moves, paired with the text that sits on it.
    const surfaces = [
        { role: 'surface', base: theme.colors.surface, tint: tinted.colors.surface, text: theme.colors.text },
        { role: 'surfaceHigh', base: theme.colors.surfaceHigh, tint: tinted.colors.surfaceHigh, text: theme.colors.text },
        { role: 'surfaceHighest', base: theme.colors.surfaceHighest, tint: tinted.colors.surfaceHighest, text: theme.colors.text },
        { role: 'ground', base: theme.colors.groupped.background, tint: tinted.colors.groupped.background, text: theme.colors.text },
        { role: 'header', base: theme.colors.header.background, tint: tinted.colors.header.background, text: theme.colors.header.tint },
        { role: 'input', base: theme.colors.input.background, tint: tinted.colors.input.background, text: theme.colors.input.text },
        { role: 'userMessage', base: theme.colors.userMessageBackground, tint: tinted.colors.userMessageBackground, text: theme.colors.userMessageText },
    ];

    it('takes its accent from the theme, not a hardcoded hex', () => {
        expect(palette.accent).toBe(theme.colors.permission.acceptEdits);
    });

    it('leaves every text colour exactly where it was', () => {
        expect(tinted.colors.text).toBe(theme.colors.text);
        expect(tinted.colors.textSecondary).toBe(theme.colors.textSecondary);
        expect(tinted.colors.header.tint).toBe(theme.colors.header.tint);
        expect(tinted.colors.userMessageText).toBe(theme.colors.userMessageText);
        expect(tinted.colors.agentMessageText).toBe(theme.colors.agentMessageText);
    });

    it('does not mutate the theme it was handed', () => {
        expect(theme.colors.surface).not.toBe(tinted.colors.surface);
        expect(theme.colors.header).not.toBe(tinted.colors.header);
        expect(subagentTintPaletteFor(theme).surface).toBe(tinted.colors.surface);
    });

    it.each(surfaces)('washes $role visibly', ({ base, tint }) => {
        expect(colorDistance(base, tint)).toBeGreaterThan(visibleTint);
    });

    it.each(surfaces)('keeps body text on $role above WCAG AA', ({ tint, text }) => {
        expect(contrastRatio(text, tint)).toBeGreaterThanOrEqual(bodyTextContrast);
    });

    it.each(surfaces)('costs $role less than 15% of the contrast it had', ({ base, tint, text }) => {
        expect(contrastRatio(text, tint)).toBeGreaterThanOrEqual(contrastRatio(text, base) * contrastRetention);
    });

    it.each(surfaces)('keeps secondary text on $role from losing more than 15%', ({ base, tint }) => {
        const secondary = theme.colors.textSecondary;
        expect(contrastRatio(secondary, tint)).toBeGreaterThanOrEqual(contrastRatio(secondary, base) * contrastRetention);
    });

    it('gives the rail and its markers a translucent accent', () => {
        expect(palette.rail.startsWith('rgba(')).toBe(true);
        expect(palette.railMarker.startsWith('rgba(')).toBe(true);
    });

    it('moves the divider further than the surface, so edges stay legible', () => {
        expect(colorDistance(theme.colors.divider, tinted.colors.divider))
            .toBeGreaterThan(colorDistance(theme.colors.surface, tinted.colors.surface));
    });
});
