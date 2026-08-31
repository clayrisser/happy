/**
 * The composer's colour vocabulary, measured, and THE RULE, enforced
 * (DROVE-176, DROVE-215).
 *
 * Three things a spec can hold about colour here. That every colour a glyph can
 * be drawn in clears the floor on the glass, on both themes, over both extremes
 * of chat. That no entry has drifted into a meaning the app already spends a
 * colour on. And, since DROVE-215, that the rule holds: the default is the
 * foreground, the palette has room for nothing but the foreground and the
 * active signals, and there is no longer a function that turns a mode or a
 * level into a hue. Whether the result LOOKS right is Clay's call from the
 * screenshots on the ticket.
 */
import { describe, expect, it } from 'vitest';
import {
    COMPOSER_CONTROL_PALETTE,
    COMPOSER_FALLBACK_SURFACE,
    COMPOSER_BUBBLE_MATERIAL,
    COMPOSER_DISC_SEPARATION_FLOOR,
    COMPOSER_DISC_STEP_FLOOR,
    COMPOSER_IN_FIELD_DISC,
    COMPOSER_IN_FIELD_DISC_OPEN,
    composerControlPalette,
    composerGlyphColour,
    pendingOrSettled,
    composerGlyphLayers,
    micColour,
    primaryActionColour,
} from './composerControlColour';
import {
    CHROME_BACKDROP_EXTREMES,
    CHROME_CONTRAST_FLOOR,
    glyphContrast,
} from './glassChrome';
import { colorDistance } from '../utils/subagentTint';
import { permissionModeGlyph } from './sessionControlGlyphs';

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
 * The theme's own text colour, from theme.ts. The foreground token is not a
 * grey near it, it IS it, which is what makes "white" a true description of
 * the row on the theme Clay runs.
 */
const themeText = { dark: '#ffffff', light: '#000000' } as const;

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

/** Every colour a glyph on the row can be drawn in, per theme. There are four. */
function everyGlyphColour(dark: boolean): Array<[string, string]> {
    const palette = composerControlPalette(dark);
    return [
        ['foreground', palette.foreground],
        ['accent', palette.accent],
        ['recording', palette.recording],
        ['pending', palette.pending],
    ];
}

/** Every permission mode the app can be in, by the kind and by the key. */
const everyMode = [
    'yolo', 'bypassPermissions', 'full',
    'safe-yolo', 'workspace', 'auto',
    'read-only', 'read', 'read_only',
    'plan', 'PLAN', 'acceptEdits', 'edits', 'default',
];

function worstContrast(glyph: string, layers: readonly string[]): number {
    return Math.min(...CHROME_BACKDROP_EXTREMES.map((backdrop) => glyphContrast(glyph, backdrop, layers)));
}

describe.each(themes)('the rule on the $name theme: the foreground unless it is active', ({ name, dark }) => {
    const palette = composerControlPalette(dark);

    it('hands out the foreground when no signal is named, which is what a new glyph gets for free', () => {
        expect(composerGlyphColour(palette)).toBe(palette.foreground);
        expect(composerGlyphColour(palette, null)).toBe(palette.foreground);
        expect(composerGlyphColour(palette, undefined)).toBe(palette.foreground);
    });

    it('makes the foreground the theme’s own text colour, which is literally white on dark', () => {
        expect(palette.foreground.toLowerCase()).toBe(themeText[name]);
    });

    it('has the foreground and one entry per active signal, and nothing else', () => {
        // The type says this too; the assertion is here for the reader who
        // finds a stray purple in the object and wants to know what broke.
        expect(Object.keys(palette).sort()).toEqual(['accent', 'foreground', 'pending', 'recording']);
    });

    it('keeps the colour on the two things that ARE active: an open mic, and a send with something to send', () => {
        expect(micColour(palette, 'held')).toBe(palette.recording);
        expect(micColour(palette, 'latched')).toBe(palette.recording);
        expect(primaryActionColour(palette, true)).toBe(palette.accent);
    });

    /**
     * The `+` inside the field, which DROVE-215 left as this vocabulary's one
     * standing exception and DROVE-214 settled (Clay: "the plus to add images
     * and stuff should be a circle just like on the right hand side send
     * button", and twice before that, no coloured icons).
     *
     * It takes no signal, so it comes out the foreground by writing less. The
     * point of pinning it is the CONTRAST: the two in-field controls are the
     * same glyph colour on the same disc until there is something to send, so
     * the accent at the trailing rim marks a state rather than marking which
     * end of the capsule you are looking at.
     */
    it('draws the in-field `+` in the foreground, so the accent still means something', () => {
        for (const dark of [true, false]) {
            const p = composerControlPalette(dark);
            // The `+` is always available: no signal, so the foreground.
            expect(composerGlyphColour(p)).toBe(p.foreground);
            // Which is what send wears too, until there is something to send.
            expect(primaryActionColour(p, false)).toBe(composerGlyphColour(p));
            expect(primaryActionColour(p, true)).not.toBe(composerGlyphColour(p));
        }
    });

    it('leaves the mic, the waveform and the send button on the foreground at rest', () => {
        expect(micColour(palette, 'idle')).toBe(palette.foreground);
        expect(primaryActionColour(palette, false)).toBe(palette.foreground);
    });

    it('holds a seat for DROVE-217’s pending without wiring it, already measured', () => {
        // A named state the next lane passes to `composerGlyphColour`, rather
        // than a hue it has to invent at a call site.
        expect(composerGlyphColour(palette, 'pending')).toBe(palette.pending);
        expect(palette.pending).not.toBe(palette.foreground);
    });

    it('leaves the shape carrying the mode alone, and it can: six modes, six silhouettes', () => {
        // With the tint gone the glyph is the ONLY carrier, which is the trade
        // DROVE-141 already made and DROVE-176 promised never to lean on.
        const glyphs = ['yolo', 'safe-yolo', 'read-only', 'plan', 'acceptEdits', 'default']
            .map((mode) => permissionModeGlyph(null, mode));
        expect(new Set(glyphs).size).toBe(glyphs.length);
        // And every alias of every mode lands on one of those six.
        for (const mode of everyMode) {
            expect(glyphs, mode).toContain(permissionModeGlyph(null, mode));
        }
    });
});

describe('the rule has no back door left in the module', () => {
    it('exports nothing that turns a mode or a level into a colour', async () => {
        // `permissionModeColour` and `effortColour` were the two functions that
        // coloured a value. They are not rewritten to return the foreground,
        // they are gone: a helper here means there is a live state to compute,
        // so a call site that wants a tint has nothing to reach for.
        const module = await import('./composerControlColour');
        expect(Object.keys(module)).not.toContain('permissionModeColour');
        expect(Object.keys(module)).not.toContain('effortColour');
        expect(Object.keys(module)).not.toContain('effortPosition');
    });
});

describe.each(themes)('legibility on the $name theme, measured', ({ dark }) => {
    it.each(everyGlyphColour(dark))('%s clears 3:1 on the glass over a white chat and a black one', (_name, colour) => {
        expect(worstContrast(colour, composerGlyphLayers(dark))).toBeGreaterThanOrEqual(CHROME_CONTRAST_FLOOR);
    });

    /**
     * THE CIRCLE HAS TO BE VISIBLE, which is the whole of Clay's third pass on
     * this ticket: "the plus to add images and stuff should be a circle just
     * like on the right hand side send button."
     *
     * The send button's resting fill measured 1.05:1 against the capsule's
     * material on the dark theme and #f0f0f0 measured 1.018:1 on the light
     * one. Copying either to the leading rim would have satisfied "the same as
     * send" and drawn nothing. So both themes take the darker of the two
     * values they already had, and the separation is a test.
     */
    it('draws a disc that can actually be seen against the capsule', () => {
        const material = dark ? COMPOSER_BUBBLE_MATERIAL.dark : COMPOSER_BUBBLE_MATERIAL.light;
        const disc = dark ? COMPOSER_IN_FIELD_DISC.dark : COMPOSER_IN_FIELD_DISC.light;
        expect(worstContrast(disc, [material]))
            .toBeGreaterThanOrEqual(COMPOSER_DISC_SEPARATION_FLOOR);

        // And the value it replaced does NOT clear it, on either theme, which
        // is why this test is here rather than a comment.
        const wasResting = dark ? '#3A3A3C' : '#f0f0f0';
        expect(worstContrast(wasResting, [material]))
            .toBeLessThan(COMPOSER_DISC_SEPARATION_FLOOR);
    });

    /**
     * Open is a step off the resting disc, not the same surface. DROVE-206
     * spent the fill itself on the open state, which only worked while the
     * `+` had no resting fill.
     */
    it('keeps the open step distinct from the disc it steps off', () => {
        const disc = dark ? COMPOSER_IN_FIELD_DISC.dark : COMPOSER_IN_FIELD_DISC.light;
        const open = dark ? COMPOSER_IN_FIELD_DISC_OPEN.dark : COMPOSER_IN_FIELD_DISC_OPEN.light;
        expect(open).not.toBe(disc);
        expect(worstContrast(open, [disc]))
            .toBeGreaterThanOrEqual(COMPOSER_DISC_STEP_FLOOR);
        // Held to the weaker bar on purpose, and it is thin: 1.30 on dark.
        // The press opacity and the sheet carry the rest of the feedback.
        expect(COMPOSER_DISC_STEP_FLOOR).toBeLessThan(COMPOSER_DISC_SEPARATION_FLOOR);
    });

    /**
     * Both in-field glyphs sit on a solid disc rather than on the glass since
     * DROVE-214, so the disc is a backdrop the floor has to be met over.
     */
    it('keeps both in-field glyphs legible on the disc they now share', () => {
        const palette = composerControlPalette(dark);
        const disc = dark ? COMPOSER_IN_FIELD_DISC.dark : COMPOSER_IN_FIELD_DISC.light;
        // The `+` at rest, and send with nothing to send: both the foreground.
        expect(worstContrast(palette.foreground, [disc])).toBeGreaterThanOrEqual(CHROME_CONTRAST_FLOOR);
        // And send once there is something to send, which is the one that
        // changes and so the one worth checking on both discs.
        expect(worstContrast(palette.accent, [disc])).toBeGreaterThanOrEqual(CHROME_CONTRAST_FLOOR);
    });

    it.each(everyGlyphColour(dark))('%s clears 3:1 on the opaque fallback material too', (_name, colour) => {
        expect(worstContrast(colour, [dark ? COMPOSER_FALLBACK_SURFACE.dark : COMPOSER_FALLBACK_SURFACE.light]))
            .toBeGreaterThanOrEqual(CHROME_CONTRAST_FLOOR);
    });

    it('carries the send arrow on the primary disc, which is a fill rather than glass', () => {
        const palette = composerControlPalette(dark);
        const disc = dark ? COMPOSER_IN_FIELD_DISC.dark : COMPOSER_IN_FIELD_DISC.light;
        expect(worstContrast(palette.accent, [disc])).toBeGreaterThanOrEqual(CHROME_CONTRAST_FLOOR);
        expect(worstContrast(palette.foreground, [disc])).toBeGreaterThanOrEqual(CHROME_CONTRAST_FLOOR);
        expect(worstContrast(palette.recording, [disc])).toBeGreaterThanOrEqual(CHROME_CONTRAST_FLOOR);
    });
});

describe('the numbers the light theme was chosen against', () => {
    // These are why light does not simply reuse the system colours. Stated so
    // nobody puts them back on the theory that the dark theme's values are
    // "the" values.
    it('shows iOS blue, the banner red and the system orange failing on the light glass', () => {
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
        ['accent', 'reading'], ['accent', 'success'], ['accent', 'link'], ['accent', 'red'],
        ['recording', 'reading'], ['recording', 'success'], ['recording', 'working'], ['recording', 'link'],
        ['pending', 'reading'], ['pending', 'success'], ['pending', 'working'], ['pending', 'link'],
        ['pending', 'red'], ['pending', 'recording'],
    ] as const)('holds %s off the reserved %s', (entry, meaning) => {
        expect(colorDistance(palette[entry], taken[meaning])).toBeGreaterThanOrEqual(DISTINCT);
    });

    it('keeps every active signal off the foreground and off the others', () => {
        const signals = ['accent', 'recording', 'pending'] as const;
        for (let i = 0; i < signals.length; i += 1) {
            expect(colorDistance(palette[signals[i]], palette.foreground), signals[i])
                .toBeGreaterThanOrEqual(DISTINCT);
            for (let j = i + 1; j < signals.length; j += 1) {
                expect(colorDistance(palette[signals[i]], palette[signals[j]]), `${signals[i]} vs ${signals[j]}`)
                    .toBeGreaterThanOrEqual(DISTINCT);
            }
        }
    });
});

describe('the palette is the same object both themes read', () => {
    it('is reachable by theme and by flag, and they agree', () => {
        expect(composerControlPalette(true)).toBe(COMPOSER_CONTROL_PALETTE.dark);
        expect(composerControlPalette(false)).toBe(COMPOSER_CONTROL_PALETTE.light);
    });
});


/**
 * The pending colour (DROVE-217).
 *
 * Clay asked for yellow. The two tests below are why it is not yellow: the
 * amber `warning` is already the open padlock and the top of the effort dial,
 * and the reading mark is a gold on both themes, so on the LIGHT theme there is
 * no gold left that clears the glass without landing on the reading mark. The
 * accent is what the vocabulary already spends on "the app doing something",
 * which is exactly what a request in flight is, so pending costs no new colour
 * at all — the test DROVE-206 set for a change to this file.
 */
describe('a pick the pane has not confirmed yet', () => {
    it('is an amber of its own on both themes, which is the yellow Clay asked for', () => {
        // DROVE-217 first made pending the accent, reasoning that gold was
        // unavailable: the amber was the open padlock and the top of the
        // effort dial. DROVE-215 then deleted both of those hues, so the
        // premise went and the amber is free. Clay asked for yellow twice.
        expect(COMPOSER_CONTROL_PALETTE.dark.pending).not.toBe(COMPOSER_CONTROL_PALETTE.dark.accent);
        expect(COMPOSER_CONTROL_PALETTE.dark.pending).not.toBe(COMPOSER_CONTROL_PALETTE.dark.foreground);
        expect(COMPOSER_CONTROL_PALETTE.light.pending).not.toBe(COMPOSER_CONTROL_PALETTE.light.foreground);
    });

    it('overrides the glyph colour, and hands it straight back when the pick lands', () => {
        // One settled colour now, not five: DROVE-215 made every resting
        // glyph the foreground, so pending is the only thing that can
        // change one, and the glyph's own shape still carries the value.
        for (const dark of [true, false]) {
            const palette = composerControlPalette(dark);
            const settled = composerGlyphColour(palette);
            expect(pendingOrSettled(palette, true, settled)).toBe(palette.pending);
            expect(pendingOrSettled(palette, false, settled)).toBe(settled);
        }
    });

    it('never has to be the only carrier: the glyph under it still has its own shape', () => {
        // DROVE-141's rule. With every resting glyph the same colour this
        // matters more than it did, not less: shape is now the ONLY thing
        // telling the permission modes apart.
        const shapes = ['yolo', 'safe-yolo', 'read-only', 'default'].map((mode) => permissionModeGlyph(null, mode));
        expect(new Set(shapes).size).toBe(shapes.length);
    });
});

