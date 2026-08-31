/**
 * The composer's colour vocabulary, measured (DROVE-176).
 *
 * Two things a spec can hold about colour: that every glyph clears the floor
 * on the glass, on both themes, over both extremes of chat; and that no entry
 * has drifted into a meaning the app already spends a colour on. Whether the
 * result LOOKS right is Clay's call from the screenshots on the ticket.
 */
import { describe, expect, it } from 'vitest';
import {
    COMPOSER_CONTROL_PALETTE,
    COMPOSER_FALLBACK_SURFACE,
    COMPOSER_PRIMARY_SURFACE,
    composerControlPalette,
    composerGlyphLayers,
    effortColour,
    effortPosition,
    micColour,
    permissionModeColour,
    primaryActionColour,
} from './composerControlColour';
import {
    CHROME_BACKDROP_EXTREMES,
    CHROME_CONTRAST_FLOOR,
    glyphContrast,
} from './glassChrome';
import { colorDistance } from '../utils/subagentTint';
import { effortGaugeAngle, permissionModeGlyph } from './sessionControlGlyphs';

/**
 * What each theme already means by a colour, from where it is decided:
 * the working blue (AgentInputStatusRow, radio.active), the reading mark
 * (theme.spokenSentence, DROVE-125), success (theme.success), the recording
 * and destructive red (DROVE-142's banner red, theme.textDestructive) and the
 * link (theme.textLink).
 */
const reserved = {
    dark: { working: '#0A84FF', reading: '#FFD54F', success: '#32D74B', red: '#FF453A', recording: '#FF3B30', link: '#2BACCC' },
    light: { working: '#007AFF', reading: '#946200', success: '#34C759', red: '#FF3B30', recording: '#FF3B30', link: '#2BACCC' },
} as const;

/**
 * "Distinct" in the RMS sRGB distance subagentTint measures with. 0.12 here
 * is about 0.21 in plain Euclidean terms, which is over the 0.20 the syntax
 * palette holds its colours off the reading mark by.
 */
const DISTINCT = 0.12;

const themes = [
    { name: 'dark', dark: true },
    { name: 'light', dark: false },
] as const;

/** Every colour a glyph can be drawn in, per theme, including the ramp's steps on the longest scale. */
function everyGlyphColour(dark: boolean): Array<[string, string]> {
    const palette = composerControlPalette(dark);
    const entries: Array<[string, string]> = [
        ['neutral', palette.neutral],
        ['accent', palette.accent],
        ['warning', palette.warning],
        ['shield', palette.shield],
        ['eye', palette.eye],
        ['recording', palette.recording],
    ];
    for (let level = 0; level < 6; level += 1) {
        entries.push([`effort ${level + 1} of 6`, effortColour(palette, level, 6)]);
    }
    for (let level = 0; level < 4; level += 1) {
        entries.push([`effort ${level + 1} of 4`, effortColour(palette, level, 4)]);
    }
    return entries;
}

function worstContrast(glyph: string, layers: readonly string[]): number {
    return Math.min(...CHROME_BACKDROP_EXTREMES.map((backdrop) => glyphContrast(glyph, backdrop, layers)));
}

describe.each(themes)('legibility on the $name theme, measured', ({ dark }) => {
    it.each(everyGlyphColour(dark))('%s clears 3:1 on the glass over a white chat and a black one', (_name, colour) => {
        expect(worstContrast(colour, composerGlyphLayers(dark))).toBeGreaterThanOrEqual(CHROME_CONTRAST_FLOOR);
    });

    it.each(everyGlyphColour(dark))('%s clears 3:1 on the opaque fallback material too', (_name, colour) => {
        expect(worstContrast(colour, [dark ? COMPOSER_FALLBACK_SURFACE.dark : COMPOSER_FALLBACK_SURFACE.light]))
            .toBeGreaterThanOrEqual(CHROME_CONTRAST_FLOOR);
    });

    it('carries the send arrow on the primary disc, which is a fill rather than glass', () => {
        const palette = composerControlPalette(dark);
        const disc = dark ? COMPOSER_PRIMARY_SURFACE.dark : COMPOSER_PRIMARY_SURFACE.light;
        expect(worstContrast(palette.accent, [disc])).toBeGreaterThanOrEqual(CHROME_CONTRAST_FLOOR);
        expect(worstContrast(palette.neutral, [disc])).toBeGreaterThanOrEqual(CHROME_CONTRAST_FLOOR);
        expect(worstContrast(palette.recording, [disc])).toBeGreaterThanOrEqual(CHROME_CONTRAST_FLOOR);
    });
});

describe('the numbers the light theme was chosen against', () => {
    // These are why light does not simply reuse the system colours. Stated so
    // nobody puts them back on the theory that the dark theme's values are
    // "the" values.
    it('shows iOS blue and the banner red failing on the light glass', () => {
        expect(worstContrast('#007AFF', composerGlyphLayers(false))).toBeLessThan(CHROME_CONTRAST_FLOOR);
        expect(worstContrast('#FF3B30', composerGlyphLayers(false))).toBeLessThan(CHROME_CONTRAST_FLOOR);
        expect(worstContrast('#FF9F0A', composerGlyphLayers(false))).toBeLessThan(CHROME_CONTRAST_FLOOR);
    });

    it('shows the same colours clearing the dark glass, which is why dark keeps them', () => {
        expect(worstContrast('#0A84FF', composerGlyphLayers(true))).toBeGreaterThanOrEqual(CHROME_CONTRAST_FLOOR);
        expect(worstContrast('#FF3B30', composerGlyphLayers(true))).toBeGreaterThanOrEqual(CHROME_CONTRAST_FLOOR);
    });
});

describe.each(themes)('the vocabulary on the $name theme does not collide', ({ name, dark }) => {
    const palette = composerControlPalette(dark);
    const taken = reserved[name];

    it('uses the theme’s own blue as the accent rather than a second blue beside it', () => {
        // The accent IS the working blue (darkened for the light glass), so
        // the row has one blue with one meaning: the app doing something.
        expect(colorDistance(palette.accent, taken.working)).toBeLessThan(DISTINCT);
    });

    it('keeps the recording colour in the banner’s red family', () => {
        expect(colorDistance(palette.recording, taken.recording)).toBeLessThan(0.15);
    });

    it.each([
        ['warning', 'reading'], ['warning', 'success'], ['warning', 'working'], ['warning', 'link'],
        ['warning', 'red'], ['warning', 'recording'],
        ['shield', 'reading'], ['shield', 'success'], ['shield', 'working'], ['shield', 'link'], ['shield', 'red'],
        ['eye', 'reading'], ['eye', 'success'], ['eye', 'working'], ['eye', 'link'], ['eye', 'red'],
        ['accent', 'reading'], ['accent', 'success'], ['accent', 'link'], ['accent', 'red'],
        ['recording', 'reading'], ['recording', 'success'], ['recording', 'working'], ['recording', 'link'],
    ] as const)('holds %s off the reserved %s', (entry, meaning) => {
        expect(colorDistance(palette[entry], taken[meaning])).toBeGreaterThanOrEqual(DISTINCT);
    });

    it('keeps the four mode colours apart from each other, and each off neutral', () => {
        const modes = [palette.warning, palette.shield, palette.eye];
        for (let i = 0; i < modes.length; i += 1) {
            expect(colorDistance(modes[i], palette.neutral)).toBeGreaterThanOrEqual(DISTINCT);
            for (let j = i + 1; j < modes.length; j += 1) {
                expect(colorDistance(modes[i], modes[j])).toBeGreaterThanOrEqual(DISTINCT);
            }
        }
    });

    it('keeps every step of the effort ramp off the reading mark, success, the working blue, the link and the reds', () => {
        for (let level = 0; level < 6; level += 1) {
            const step = effortColour(palette, level, 6);
            for (const meaning of ['reading', 'success', 'working', 'link', 'red', 'recording'] as const) {
                expect(colorDistance(step, taken[meaning]), `${level + 1} of 6 vs ${meaning}`).toBeGreaterThanOrEqual(DISTINCT);
            }
        }
    });

    it('keeps the ramp’s cool half off the shield and the eye, the two cool mode colours', () => {
        for (let level = 0; level < 3; level += 1) {
            const step = effortColour(palette, level, 6);
            expect(colorDistance(step, palette.shield), `${level + 1} of 6 vs shield`).toBeGreaterThanOrEqual(DISTINCT);
            expect(colorDistance(step, palette.eye), `${level + 1} of 6 vs eye`).toBeGreaterThanOrEqual(DISTINCT);
        }
    });
});

describe('the padlock', () => {
    const palette = COMPOSER_CONTROL_PALETTE.dark;

    it('is the warning colour open and neutral shut, which is the pair Clay switches between', () => {
        expect(permissionModeColour(palette, 'yolo')).toBe(palette.warning);
        expect(permissionModeColour(palette, 'bypassPermissions')).toBe(palette.warning);
        expect(permissionModeColour(palette, null, 'default')).toBe(palette.neutral);
        expect(permissionModeColour(palette, null, null)).toBe(palette.neutral);
    });

    it('gives the shield and the eye their own colours, neither of them the warning', () => {
        expect(permissionModeColour(palette, 'safe-yolo')).toBe(palette.shield);
        expect(permissionModeColour(palette, 'read-only')).toBe(palette.eye);
        expect(permissionModeColour(palette, 'safe-yolo')).not.toBe(palette.warning);
        expect(permissionModeColour(palette, 'read-only')).not.toBe(palette.warning);
    });

    it('leaves plan and edits neutral: a route drawn first is nothing to flag', () => {
        expect(permissionModeColour(palette, null, 'plan')).toBe(palette.neutral);
        expect(permissionModeColour(palette, null, 'acceptEdits')).toBe(palette.neutral);
    });

    it('reads the mode the same way the glyph does, so colour and shape cannot disagree', () => {
        for (const [kind, key] of [['yolo', 'plan'], [null, 'PLAN'], ['safe-yolo', null], [null, 'read-only']] as const) {
            const glyph = permissionModeGlyph(kind, key);
            const colour = permissionModeColour(palette, kind, key);
            if (glyph === 'lock-open-outline') expect(colour).toBe(palette.warning);
            if (glyph === 'shield-checkmark-outline') expect(colour).toBe(palette.shield);
            if (glyph === 'eye-outline') expect(colour).toBe(palette.eye);
            if (glyph === 'lock-closed-outline' || glyph === 'map-outline') expect(colour).toBe(palette.neutral);
        }
    });

    it('never makes colour the only carrier: every coloured mode still has its own silhouette', () => {
        const coloured = ['yolo', 'safe-yolo', 'read-only', 'default'].map((mode) => permissionModeGlyph(null, mode));
        expect(new Set(coloured).size).toBe(coloured.length);
    });
});

describe('the effort ramp', () => {
    const palette = COMPOSER_CONTROL_PALETTE.dark;

    it('is the cool stop at the floor and the warning amber at the ceiling, whatever the scale’s length', () => {
        for (const count of [4, 5, 6]) {
            expect(effortColour(palette, 0, count)).toBe(palette.effort[0]);
            expect(effortColour(palette, count - 1, count)).toBe(palette.effort[2]);
            expect(effortColour(palette, count - 1, count)).toBe(palette.warning);
        }
    });

    it('agrees with the needle about where a level is', () => {
        // Same clamp, same interpolation: the colour and the angle are two
        // readings of one position.
        for (const count of [4, 6]) {
            for (let level = -1; level <= count; level += 1) {
                const angle = effortGaugeAngle(level, count);
                const position = effortPosition(level, count);
                expect(position).toBeCloseTo((angle + 130) / 260, 5);
            }
        }
    });

    it('warms monotonically: red rises and blue falls from the floor to the ceiling', () => {
        let previousRed = -1;
        let previousBlue = 256;
        for (let level = 0; level < 6; level += 1) {
            const colour = effortColour(palette, level, 6);
            const red = parseInt(colour.slice(1, 3), 16);
            const blue = parseInt(colour.slice(5, 7), 16);
            expect(red).toBeGreaterThanOrEqual(previousRed);
            expect(blue).toBeLessThanOrEqual(previousBlue);
            previousRed = red;
            previousBlue = blue;
        }
    });

    it('is the mauve stop exactly at the midpoint, not the mean of the ends', () => {
        expect(effortColour(palette, 2, 5)).toBe(palette.effort[1]);
    });

    it('points a one-level scale at the floor, which is also where the needle points', () => {
        expect(effortPosition(0, 1)).toBe(0);
        expect(effortColour(palette, 0, 1)).toBe(palette.effort[0]);
    });
});

describe('the mic and the in-field primary', () => {
    const palette = COMPOSER_CONTROL_PALETTE.light;

    it('turns the mic the recording red once it is latched or held, and leaves it neutral at rest', () => {
        expect(micColour(palette, 'idle')).toBe(palette.neutral);
        expect(micColour(palette, 'latched')).toBe(palette.recording);
        expect(micColour(palette, 'held')).toBe(palette.recording);
    });

    it('turns the primary the accent only once there is something to send', () => {
        expect(primaryActionColour(palette, true)).toBe(palette.accent);
        expect(primaryActionColour(palette, false)).toBe(palette.neutral);
    });
});
