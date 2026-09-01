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
    COMPOSER_CAPSULE_DIVIDER_FLOOR,
    COMPOSER_DISC_SEPARATION_FLOOR,
    COMPOSER_DISC_STEP_FLOOR,
    COMPOSER_GAUGE_NEEDLE_FLOOR,
    COMPOSER_GAUGE_TRACK_ALPHA,
    COMPOSER_GAUGE_TRACK_FLOOR,
    COMPOSER_IN_FIELD_DISC,
    COMPOSER_IN_FIELD_DISC_OPEN,
    COMPOSER_SESSION_CAPSULE_FILL,
    composerCapsuleDivider,
    composerControlPalette,
    composerGaugeContrast,
    composerGaugeMaterials,
    composerFillTint,
    composerGaugeTrack,
    composerGlyphColour,
    composerPausedFill,
    composerPausedTint,
    composerMicSurface,
    composerSendSurface,
    composerSessionCapsuleFill,
    pendingOrSettled,
    composerGlyphLayers,
    micColour,
    primaryActionColour,
    autoAcceptColour,
    composerAudioOutFill,
    composerAudioOutTint,
} from './composerControlColour';
import {
    CHROME_BACKDROP_EXTREMES,
    CHROME_CONTRAST_FLOOR,
    CHROME_GLASS_TINT,
    colorAlpha,
    compositeOver,
    compositeSurface,
    contrastRatio,
    glyphContrast,
    parseColor,
} from './glassChrome';
import { effortGaugeAngle } from './sessionControlGlyphs';
import { colorDistance } from '../utils/subagentTint';
import { permissionModeGlyph } from './sessionControlGlyphs';
import { permissionAccessibilityValue } from './autoAcceptRow';

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

    /**
     * AUTO-ACCEPT IS THE THIRD ACTIVE STATE (DROVE-277), and it is written
     * here rather than beside the modes because it is not one: a mode is a
     * value the session holds, and auto-accept is the app answering prompts on
     * Clay's behalf while he is not looking. Same class as an open mic.
     *
     * IT IS THE PADLOCK'S COLOUR AGAIN SINCE DROVE-331. DROVE-277 had no
     * control to colour — the switch was inside the padlock's sheet, so the
     * padlock was the only object that could carry the state. DROVE-281 made
     * the bolt a segment of the capsule and moved the state onto it; DROVE-331
     * took the bolt back off on Clay's word, so the padlock is the one object
     * on the row that can carry the state and it does, with the sheet it opens
     * holding the switch.
     */
    it('leaves the padlock on the foreground while auto-accept is off', () => {
        expect(autoAcceptColour(palette, false)).toBe(palette.foreground);
        expect(autoAcceptColour(palette, false)).toBe(composerGlyphColour(palette));
    });

    it('colours the padlock with the accent while auto-accept is on, and spends no new hue on it', () => {
        expect(autoAcceptColour(palette, true)).toBe(palette.accent);
        // The same accent the send button wears when it has something to send:
        // one colour, one meaning, "something is about to happen".
        expect(autoAcceptColour(palette, true)).toBe(primaryActionColour(palette, true));
        // And the palette did not grow to fit it.
        expect(Object.keys(palette).sort()).toEqual(['accent', 'foreground', 'pending', 'recording']);
    });

    it('does it on both themes, so the state is legible wherever Clay is reading', () => {
        // The accent is a different hex per theme and the same ROLE, which is
        // the property that matters: the padlock separates from the capsule's
        // fill on dark and on light, measured below against
        // `COMPOSER_DISC_SEPARATION_FLOOR`, and it is never the foreground
        // while it is on.
        for (const dark of [true, false]) {
            const p = composerControlPalette(dark);
            expect(autoAcceptColour(p, true)).toBe(p.accent);
            expect(autoAcceptColour(p, true)).not.toBe(p.foreground);
            expect(autoAcceptColour(p, false)).toBe(p.foreground);
        }
    });

    it('leaves the SHAPE alone, so the colour adds a state instead of hiding the mode', () => {
        // Six modes, six silhouettes, and auto-accept does not become a
        // seventh: whatever the toggle is set to, the glyph is still the
        // mode's. A reader who cannot tell the accent from the foreground
        // reads the mode correctly and hears auto-accept in words.
        const shapes = ['yolo', 'safe-yolo', 'read-only', 'plan', 'acceptEdits', 'default']
            .map((mode) => permissionModeGlyph(null, mode));
        expect(new Set(shapes).size).toBe(shapes.length);
        expect(permissionAccessibilityValue('Yolo', true)).toBe('Yolo, auto-accept on');
        expect(permissionAccessibilityValue('Yolo', false)).toBe('Yolo');
        expect(permissionAccessibilityValue(undefined, true)).toBe('auto-accept on');
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


/**
 * THE EFFORT GAUGE'S DIAL (DROVE-227).
 *
 * Clay, with the effort control cropped: "This icon isn't contrasting." The
 * needle was fine. The ARC it sweeps was `theme.colors.divider`, which is a
 * list hairline and measures 1.05:1 on the dark glass, so the control was a
 * white diagonal with nothing round it.
 *
 * The test is two-sided on purpose, because either side alone has a wrong
 * answer that passes it. Lighten only against the capsule and the track
 * eventually reaches the needle's own colour, and the needle vanishes into the
 * ring. Hold it only under the needle and `divider` was already fine. Both
 * floors, on both themes, on all three materials the gauge is drawn on.
 */
describe.each(themes)('the effort gauge on the $name theme is two marks, not one', ({ dark }) => {
    const materials = Object.entries(composerGaugeMaterials(dark));

    /** The worst of the two chat extremes, which is the shape the rest of this file measures in. */
    function gauge(layers: readonly string[]): { track: number; needle: number } {
        const readings = CHROME_BACKDROP_EXTREMES.map((backdrop) => composerGaugeContrast(dark, layers, backdrop));
        return {
            track: Math.min(...readings.map((reading) => reading.track)),
            needle: Math.min(...readings.map((reading) => reading.needle)),
        };
    }

    it.each(materials)('separates the arc from the %s the gauge sits on', (_name, layers) => {
        expect(gauge(layers).track).toBeGreaterThanOrEqual(COMPOSER_GAUGE_TRACK_FLOOR);
    });

    it.each(materials)('keeps the needle above the arc on the %s', (_name, layers) => {
        expect(gauge(layers).needle).toBeGreaterThanOrEqual(COMPOSER_GAUGE_NEEDLE_FLOOR);
    });

    /**
     * The ranking, as an assertion rather than a paragraph. The needle is the
     * value and the arc is the scale it is read against, so the gap above the
     * arc has to beat the gap below it. This is what stops the next pass
     * fixing "not contrasting" by walking the track up to white.
     */
    it('ranks the two marks: the needle stands off the arc harder than the arc stands off the capsule', () => {
        expect(COMPOSER_GAUGE_NEEDLE_FLOOR).toBeGreaterThan(COMPOSER_GAUGE_TRACK_FLOOR);
        for (const [name, layers] of materials) {
            const { track, needle } = gauge(layers);
            expect(needle, name).toBeGreaterThan(track);
        }
    });

    /**
     * The value that shipped, failing. `theme.colors.divider` is not a bad
     * colour, it is a colour for a different job: two list rows meeting on an
     * opaque background. On the composer's glass it is the capsule again.
     */
    it('fails the floor for the divider the track used to be drawn in', () => {
        const wasTrack = dark ? '#2A2A2A' : '#eaeaea';
        const bed = compositeSurface('#000000', composerGaugeMaterials(dark).capsule);
        expect(contrastRatio(parseColor(wasTrack), bed)).toBeLessThan(COMPOSER_GAUGE_TRACK_FLOOR);
        // And it passed the OTHER side comfortably, which is why one-sided
        // testing would have called the shipped gauge fine.
        expect(contrastRatio(parseColor(composerControlPalette(dark).foreground), parseColor(wasTrack)))
            .toBeGreaterThan(COMPOSER_GAUGE_NEEDLE_FLOOR);
    });

    /**
     * And the obvious over-correction, failing the other way. A track at the
     * needle's own colour is the brightest arc available and the worst gauge:
     * one solid shape with no mark in it.
     */
    it('fails the floor for a track drawn in the needle’s own colour', () => {
        const palette = composerControlPalette(dark);
        const bed = compositeSurface('#000000', composerGaugeMaterials(dark).capsule);
        const needle = parseColor(palette.foreground);
        expect(contrastRatio(needle, bed)).toBeGreaterThan(COMPOSER_GAUGE_TRACK_FLOOR);
        expect(contrastRatio(needle, needle)).toBeLessThan(COMPOSER_GAUGE_NEEDLE_FLOOR);
    });

    /**
     * The decision, pinned: the foreground at an opacity, not a grey of its
     * own. Written as a test because it is the part a later edit is most
     * likely to undo by "simplifying" the rgba into a hex, and the hex is what
     * drifts when the material under it moves (see the open wash above).
     */
    it('draws the track as the foreground at a reduced opacity, so it can never become a hue', () => {
        const track = composerGaugeTrack(dark);
        const alpha = dark ? COMPOSER_GAUGE_TRACK_ALPHA.dark : COMPOSER_GAUGE_TRACK_ALPHA.light;
        expect(colorAlpha(track)).toBeCloseTo(alpha, 5);
        expect(alpha).toBeGreaterThan(0);
        expect(alpha).toBeLessThan(1);
        // Opaque, it IS the foreground: same channels, all of the way.
        const opaque = compositeOver(track.replace(/[\d.]+\)$/, '1)'), parseColor('#808080'));
        expect(opaque).toEqual(parseColor(composerControlPalette(dark).foreground));
    });

    /**
     * Every LEVEL, because the needle sweeps and the ticket asked. The needle
     * is radial and stops 3pt short of a track 2pt wide, so the gap between
     * the two marks is the same at every angle: there is no level where they
     * overlap and none where the pair is measured differently. Asserting the
     * geometry is what lets the two contrast numbers above stand for all six.
     */
    it('puts the needle the same distance off the arc at every level', () => {
        const size = 20;
        const strokeWidth = 2;
        const trackRadius = (size - strokeWidth) / 2;
        for (const count of [4, 5, 6]) {
            for (let level = 0; level < count; level += 1) {
                const angle = effortGaugeAngle(level, count);
                expect(Math.abs(angle), `level ${level} of ${count}`).toBeLessThanOrEqual(130);
            }
        }
        // The needle's tip, plus its round cap, still clears the arc's inner edge.
        const needleReach = trackRadius - 3 + 2.25 / 2;
        expect(needleReach).toBeLessThan(trackRadius - strokeWidth / 2);
    });
});

/**
 * The numbers this landed on, quoted once so a reader does not have to run the
 * suite to know what "clears the floor" bought (DROVE-227).
 *
 * Both themes split roughly 14:1 of available room the same way, which is the
 * point of the two per-theme alphas: 0.28 over a near-black capsule and 0.37
 * over a near-white one are the same arc. The room shrank a little when
 * DROVE-254 made the capsule an opaque fill instead of glass; the split did
 * not move.
 */
describe('what the gauge measures, written down', () => {
    it.each([
        ['dark', true, 2.50, 5.90],
        ['light', false, 2.46, 5.61],
    ] as const)('%s: the arc is %s:1 off the capsule and the needle %s:1 off the arc', (_n, dark, track, needle) => {
        const capsule = composerGaugeMaterials(dark).capsule;
        const measured = composerGaugeContrast(dark, capsule, '#000000');
        expect(measured.track).toBeCloseTo(track, 2);
        expect(measured.needle).toBeCloseTo(needle, 2);
    });

    it('leaves the needle the whole of the room it had off the capsule', () => {
        // The arc splits this; it does not add to it. Quoted so the two
        // numbers above are visibly a split of one budget rather than free.
        for (const dark of [true, false]) {
            const capsule = composerGaugeMaterials(dark).capsule;
            const bed = compositeSurface('#000000', capsule);
            const needle = parseColor(composerControlPalette(dark).foreground);
            const room = contrastRatio(needle, bed);
            const measured = composerGaugeContrast(dark, capsule, '#000000');
            expect(room).toBeGreaterThan(13);
            expect(measured.track * measured.needle).toBeCloseTo(room, 4);
        }
    });
});


/**
 * THE SESSION CAPSULE ON THE BUBBLE (DROVE-254).
 *
 * Clay, on the row DROVE-236 built: "This blends in which is annoying." The
 * padlock, the gauge and the model's name read as loose glyphs in the field
 * while the `+` and the mic either side of them read as objects.
 *
 * Three things this pins. That the capsule's surface is OPAQUE, which is the
 * actual fix: a translucent tint inside the bubble's own glass has no single
 * value, so no number could be held about it. That the value it does have
 * clears DROVE-214's floor on both themes. And that it is the discs' exact
 * fill rather than a third grey on a row of two.
 */
describe.each(themes)('the session capsule on the $name theme', ({ name, dark }) => {
    const bubble = parseColor(dark ? COMPOSER_BUBBLE_MATERIAL.dark : COMPOSER_BUBBLE_MATERIAL.light);
    const fill = composerSessionCapsuleFill(dark);

    it('is an OPAQUE fill, because a tint inside the bubble\u2019s glass has no value to measure', () => {
        // The whole ticket in one assertion. The bubble is a `UIGlassEffect`
        // and the capsule used to be a second one inside it; a glass effect
        // nested in a glass effect has nothing left to refract, which is why
        // the arithmetic and Clay's eye disagreed. An opaque fill REPLACES the
        // material under it, so one value is the whole truth (DROVE-214).
        expect(colorAlpha(fill)).toBe(1);
        expect(fill.startsWith('#')).toBe(true);
    });

    it('clears the disc\u2019s separation floor off the bubble it now sits inside', () => {
        expect(contrastRatio(parseColor(fill), bubble))
            .toBeGreaterThanOrEqual(COMPOSER_DISC_SEPARATION_FLOOR);
    });

    it('is the in-field disc\u2019s exact fill, so the row is two greys and not three', () => {
        // Clay's read, and the one the measurement backs: they are peers on
        // one row, the band has room for one value, and the area objection is
        // answered by the dividers rather than by a second grey.
        expect(fill).toBe(dark ? COMPOSER_IN_FIELD_DISC.dark : COMPOSER_IN_FIELD_DISC.light);
        expect(COMPOSER_SESSION_CAPSULE_FILL).toBe(COMPOSER_IN_FIELD_DISC);
    });

    /**
     * THE AUTO-ACCEPT PADLOCK AGAINST THE CAPSULE IT SITS IN, ON BOTH THEMES
     * (DROVE-281, and the padlock's since DROVE-331).
     *
     * DROVE-254 and DROVE-264 measured every new object on this row against
     * what is behind it, and a padlock in the accent is one. It is a graphical
     * control rather than text, so the floor that applies is WCAG 1.4.11's
     * 3:1, and both states clear it on both themes with the ON state — the one
     * whose cost of being missed is a command running unasked — clearing it by
     * the smallest margin, which is the number worth writing down.
     *
     * THE THIRD RATIO IS THE ONE THAT MATTERS MOST. On against off is what a
     * glance actually reads, and it is the measurement that would quietly rot
     * if someone ever moved the accent nearer the foreground. It is well over
     * `COMPOSER_DISC_SEPARATION_FLOOR`, which is the bar the row already uses
     * for "these two are different objects".
     */
    it('draws the auto-accept padlock clear of the capsule in both states, measured (DROVE-281, DROVE-331)', () => {
        const p = composerControlPalette(dark);
        const bed = parseColor(fill);
        const on = contrastRatio(parseColor(autoAcceptColour(p, true)), bed);
        const off = contrastRatio(parseColor(autoAcceptColour(p, false)), bed);
        expect(on, `${name} on`).toBeGreaterThanOrEqual(3);
        expect(off, `${name} off`).toBeGreaterThanOrEqual(3);
        expect(on).toBeCloseTo(dark ? 4.483 : 3.812, 3);
        expect(off).toBeCloseTo(dark ? 14.743 : 13.802, 3);
        // And the two states apart from EACH OTHER, which is what a glance reads.
        const separation = contrastRatio(
            parseColor(autoAcceptColour(p, true)),
            parseColor(autoAcceptColour(p, false)),
        );
        expect(separation).toBeCloseTo(dark ? 3.288 : 3.621, 3);
        expect(separation).toBeGreaterThan(COMPOSER_DISC_SEPARATION_FLOOR);
    });

    it('measures the same 1.36:1 the discs do, because it is the same value', () => {
        const capsule = contrastRatio(parseColor(fill), bubble);
        const disc = contrastRatio(parseColor(dark ? COMPOSER_IN_FIELD_DISC.dark : COMPOSER_IN_FIELD_DISC.light), bubble);
        expect(capsule).toBeCloseTo(disc, 6);
        expect(capsule).toBeCloseTo(1.36, 2);
    });

    /**
     * THE VALUE THAT SHIPPED, FAILING, which is what stops this coming back.
     *
     * It was `GlassChromeSurface`'s default tint, `CHROME_GLASS_TINT`. It fails
     * on the axis that matters first: it is translucent, so inside the bubble's
     * own glass there is no separation to assert. And modelled generously, as
     * if the platform simply added it to the bubble's material, light comes out
     * at 1.22:1 and fails the floor outright. Dark models at 1.58:1, passes the
     * arithmetic and still blends on the phone, which is the whole reason the
     * opacity assertion is the one that leads.
     */
    it('fails the spec for the glass tint the capsule used to be drawn in', () => {
        const tint = dark ? CHROME_GLASS_TINT.dark : CHROME_GLASS_TINT.light;
        expect(colorAlpha(tint)).toBeLessThan(1);
        const modelled = contrastRatio(compositeOver(tint, bubble), bubble);
        expect(modelled).toBeCloseTo(name === 'dark' ? 1.577 : 1.222, 3);
        if (name === 'light') {
            expect(modelled).toBeLessThan(COMPOSER_DISC_SEPARATION_FLOOR);
        }
    });

    /**
     * THE TWO HAIRLINES INSIDE IT ARE KEPT, and held to the same bar the
     * gauge's track is.
     *
     * The ticket asks whether a capsule that reads properly still needs them.
     * It does: they are what stops 154pt of one tone reading as a slab, and
     * what says the three segments are three presses. So they get the fill's
     * treatment rather than the fill's exemption.
     */
    it('draws its dividers as the gauge\u2019s track, so the capsule holds two tones and not four', () => {
        expect(composerCapsuleDivider(dark)).toBe(composerGaugeTrack(dark));
        expect(COMPOSER_CAPSULE_DIVIDER_FLOOR).toBe(COMPOSER_GAUGE_TRACK_FLOOR);
    });

    it('separates a divider from the fill, at rest and under an open segment\u2019s wash', () => {
        for (const [material, layers] of Object.entries(composerGaugeMaterials(dark))) {
            const bed = compositeSurface('#000000', layers);
            const hairline = compositeOver(composerCapsuleDivider(dark), bed);
            expect(contrastRatio(hairline, bed), material)
                .toBeGreaterThanOrEqual(COMPOSER_CAPSULE_DIVIDER_FLOOR);
        }
    });

    /**
     * And the token they were drawn in, failing. `theme.colors.glass.divider`
     * is a rule for two list rows meeting on an opaque background; on the
     * capsule's fill it is DROVE-227's gauge track again, a mark that is not
     * dim but absent.
     */
    it('fails the floor for the list hairline the dividers used to be drawn in', () => {
        const wasDivider = dark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(60, 60, 67, 0.12)';
        const bed = parseColor(fill);
        expect(contrastRatio(compositeOver(wasDivider, bed), bed))
            .toBeLessThan(COMPOSER_CAPSULE_DIVIDER_FLOOR);
    });
});

/**
 * WHICH SURFACE THE PRIMARY BUTTON WEARS (DROVE-254).
 *
 * Clay, on the trailing button: "No circle on this icon unless pressed as
 * mic." DROVE-236 collapsed send and the mic into one control, so that is an
 * instruction about two of five faces and the table decides the rest.
 */
describe('send and the mic, two tables since DROVE-264', () => {
    const send = (over: Partial<Parameters<typeof composerSendSurface>[0]> = {}) =>
        composerSendSurface({ stop: false, blocked: false, ...over });
    const mic = (live: boolean) => composerMicSurface({ live });

    it('takes the circle off SEND, which is the instruction', () => {
        // Clay: "the send button shouldn't have a circle around it." At every
        // length of text, because the glyph is what carries "there is something
        // to send" and always has (DROVE-214, DROVE-215).
        expect(send()).toBe('none');
    });

    it('keeps the circle off the mic at rest, which was already the rule', () => {
        expect(mic(false)).toBe('none');
    });

    it('puts the mic’s back the moment it is actually open, held or latched', () => {
        expect(mic(true)).toBe('recording');
    });

    it('makes the trailing pair ONE vocabulary rather than a circle beside a glyph', () => {
        // The row's consistency, stated as an assertion. Before DROVE-264 the
        // mic at rest was bare and send wore a disc, so two neighbouring
        // controls in the same state drew differently for no reason a reader
        // could name.
        expect(send()).toBe(mic(false));
    });

    it('keeps Stop and the gate’s lock on their own surfaces, and ranks them first', () => {
        // Stop outranks the gate: a blank composer on a non-steerable agent is
        // both blocked and abortable and must not look locked.
        expect(send({ stop: true, blocked: true })).toBe('stop');
        expect(send({ blocked: true })).toBe('locked');
    });

    it('leaves the mic’s surface deaf to everything but the capture', () => {
        // The other half of the split. The mic used to share a table with send,
        // so Stop and the gate could take its slot; they cannot reach it now,
        // which is what makes "hit the microphone" work mid-turn and mid-block.
        expect(mic(true)).toBe('recording');
        expect(mic(false)).toBe('none');
    });

    it('spends no new colour: the only fill either gains is the recording red', () => {
        // DROVE-215's rule on the surface axis. A disc that appears only while
        // the mic is open is a state change, which is exactly what earns one,
        // and the fill it takes is DROVE-142's banner red rather than a second
        // red drawn for the surface. The white glyph on it clears the floor on
        // both themes, so the pair is one signal.
        for (const dark of [true, false]) {
            const palette = composerControlPalette(dark);
            expect(contrastRatio(parseColor('#FFFFFF'), parseColor(palette.recording)))
                .toBeGreaterThanOrEqual(CHROME_CONTRAST_FLOOR);
        }
    });
});

/**
 * AND BOTH BARE GLYPHS HAVE TO CARRY THEMSELVES (DROVE-254, DROVE-264).
 *
 * Taking a disc away takes the anchor DROVE-214 measured with it, so the glyph
 * is read straight off the bubble's material. Measured rather than assumed: a
 * glyph that was fine on a #282828 disc is not automatically fine on a #3D3D3D
 * bubble. DROVE-254 took this measurement for the mic; DROVE-264 spends the
 * same number on send, which is why its circle could go without a second look.
 */
describe.each(themes)('the bare glyphs with no disc under them, on the $name theme', ({ dark }) => {
    const bubble = () => parseColor(dark ? COMPOSER_BUBBLE_MATERIAL.dark : COMPOSER_BUBBLE_MATERIAL.light);

    it('clears the 3:1 floor on the bubble they are drawn straight onto', () => {
        for (const glyph of [
            micColour(composerControlPalette(dark), 'idle'),
            // Send with nothing to send is the foreground, same as the mic.
            primaryActionColour(composerControlPalette(dark), false),
        ]) {
            expect(contrastRatio(parseColor(glyph), bubble()))
                .toBeGreaterThanOrEqual(CHROME_CONTRAST_FLOOR);
        }
    });

    it('measures 10.862:1 on dark and 18.819:1 on light, which is the number the circle cost', () => {
        // The figure DROVE-254 took for the mic and DROVE-264 spends again for
        // send. Written down rather than derived at the call site, because it
        // is the whole argument for a bare glyph.
        const glyph = parseColor(micColour(composerControlPalette(dark), 'idle'));
        expect(contrastRatio(glyph, bubble())).toBeCloseTo(dark ? 10.862 : 18.819, 3);
    });

    it('keeps send’s ACCENT legible bare, which the disc used to sit under', () => {
        // The one case where the disc WAS doing work, and the reason this
        // ticket is not a pure subtraction. The accent is not the foreground,
        // so it does not inherit the foreground's headroom, and it has to clear
        // the floor on the bubble by itself.
        const accent = parseColor(primaryActionColour(composerControlPalette(dark), true));
        expect(contrastRatio(accent, bubble())).toBeGreaterThanOrEqual(CHROME_CONTRAST_FLOOR);
    });

    it('fails the spec for the system blue the accent used to be exactly', () => {
        // THE VALUE THAT WOULD HAVE SHIPPED, FAILING, which is what stops this
        // coming back. `#0A84FF` is iOS system blue's dark variant and it was
        // right while send wore a #282828 disc, where it measures 4.042:1.
        // Bare on the bubble it is 2.978:1, under the floor, and it is exactly
        // the sort of miss that survives a screenshot.
        if (!dark) return;
        expect(contrastRatio(parseColor('#0A84FF'), bubble())).toBeCloseTo(2.978, 3);
        expect(contrastRatio(parseColor('#0A84FF'), bubble())).toBeLessThan(CHROME_CONTRAST_FLOOR);
        expect(contrastRatio(parseColor('#0A84FF'), parseColor(COMPOSER_IN_FIELD_DISC.dark)))
            .toBeGreaterThanOrEqual(CHROME_CONTRAST_FLOOR);
    });

    it('holds the accent between its two opposite floors, and says how much room is left', () => {
        // The accent is a glyph on the bubble AND a fill under a white glyph
        // (DROVE-118, DROVE-258). Those pull opposite ways, so the pair is
        // asserted together: a change that helps one and breaks the other fails
        // here rather than on a phone.
        const accent = composerControlPalette(dark).accent;
        const onBubble = contrastRatio(parseColor(accent), bubble());
        const whiteOnIt = contrastRatio(parseColor('#FFFFFF'), parseColor(accent));
        expect(onBubble).toBeGreaterThanOrEqual(CHROME_CONTRAST_FLOOR);
        expect(whiteOnIt).toBeGreaterThanOrEqual(CHROME_CONTRAST_FLOOR);
        expect(composerFillTint(accent)).toBe('#FFFFFF');
        if (dark) {
            expect(onBubble).toBeCloseTo(3.303, 3);
            expect(whiteOnIt).toBeCloseTo(3.288, 3);
        }
    });

    it('loses contrast against the disc it used to sit on, and still has room to spare', () => {
        // The honest half: 14.74 -> 10.86 on dark. The disc was a step DOWN
        // from the bubble, so a white glyph on it was further off than a white
        // glyph on the bubble. Both are miles over the floor, which is why the
        // circle was spendable at all.
        const disc = parseColor(dark ? COMPOSER_IN_FIELD_DISC.dark : COMPOSER_IN_FIELD_DISC.light);
        const glyph = parseColor(micColour(composerControlPalette(dark), 'idle'));
        expect(contrastRatio(glyph, bubble())).toBeGreaterThan(CHROME_CONTRAST_FLOOR * 3);
        expect(contrastRatio(glyph, disc)).toBeGreaterThan(CHROME_CONTRAST_FLOOR * 3);
    });

    it('still reads the two apart while the mic is OPEN, which is when they sit closest', () => {
        // Two bare glyphs side by side is fine while both are at rest, because
        // they are different shapes. The state to check is the one where they
        // are NOT symmetric: a filled red disc beside a bare arrowhead. They
        // differ in surface, in shape and in the glyph's own colour at once.
        const recordingFill = parseColor(composerControlPalette(dark).recording);
        expect(contrastRatio(recordingFill, bubble()))
            .toBeGreaterThanOrEqual(COMPOSER_DISC_SEPARATION_FLOOR);
        expect(composerFillTint(composerControlPalette(dark).recording)).toBe('#FFFFFF');
    });
});

/**
 * THE PAUSED READER'S DISC (DROVE-258).
 *
 * Clay: "When I long press read and it pauses color it I dunno pause colour
 * maybe yellow or orange and show pause icon."
 *
 * Three things to hold. That the amber is the palette's OWN amber rather than
 * a fourth entry smuggled in beside it. That it clears the bars the composer
 * already measures fills against, on both themes, over both extremes of chat.
 * And that the glyph sitting on it is legible, which the white the other two
 * discs wear is NOT — that is the one number that makes this more than a
 * colour swap.
 */
describe.each(themes)('the pause disc on the $name theme', ({ dark }) => {
    const palette = composerControlPalette(dark);
    const bubble = dark ? COMPOSER_BUBBLE_MATERIAL.dark : COMPOSER_BUBBLE_MATERIAL.light;
    const disc = dark ? COMPOSER_IN_FIELD_DISC.dark : COMPOSER_IN_FIELD_DISC.light;
    const fill = composerPausedFill(dark);

    it('spends no new hue: it IS the palette amber, reached through the one function', () => {
        // The point of routing it through `composerGlyphColour` rather than
        // reading `palette.pending` at the call site is that the amber cannot
        // be edited here without the palette moving, and the palette cannot
        // grow an entry without widening `ComposerActiveSignal` in front of a
        // reviewer. DROVE-258 adds a STATE, not a colour.
        expect(fill).toBe(composerGlyphColour(palette, 'pending'));
        expect(Object.keys(palette).sort()).toEqual(['accent', 'foreground', 'pending', 'recording']);
    });

    /**
     * OPAQUE, WHICH IS DROVE-254's HARD SPEC AND NOT A PREFERENCE. That ticket
     * found the capsule was a `UIGlassEffect` nested inside the bubble's own,
     * so the platform never added the tint the contrast model assumed and a
     * translucent surface in there has no single value to measure. Every fill
     * on this row is an opaque hex for that reason, and the pause disc is a
     * fill on this row.
     */
    it('is opaque, so there is one value to measure rather than a composite', () => {
        expect(colorAlpha(fill)).toBe(1);
    });

    it('reads as a disc against the bubble, past the strictest separation bar on the row', () => {
        // A fill is held to COMPOSER_DISC_SEPARATION_FLOOR (1.3) and a hairline
        // inside the capsule to COMPOSER_CAPSULE_DIVIDER_FLOOR (2.3, DROVE-254,
        // which is the gauge track's floor by construction). Asserted against
        // the HARDER of the two, because a state indicator that only just
        // clears the bar a decoration clears is the invisibility this ticket is
        // about.
        expect(COMPOSER_CAPSULE_DIVIDER_FLOOR).toBeGreaterThan(COMPOSER_DISC_SEPARATION_FLOOR);
        expect(worstContrast(fill, [bubble])).toBeGreaterThanOrEqual(COMPOSER_CAPSULE_DIVIDER_FLOOR);
    });

    it('reads apart from the resting disc it replaces, which is what OFF wears', () => {
        // Paused vs off is a LUMINANCE question: one is amber, the other is the
        // row's neutral grey, so a ratio is the right measure and the disc
        // floor is the right bar.
        expect(worstContrast(fill, [disc])).toBeGreaterThanOrEqual(COMPOSER_DISC_SEPARATION_FLOOR);
    });

    it('reads apart from the two discs it sits beside, by HUE rather than by ratio', () => {
        // Paused vs reading and paused vs a call are pairs of saturated fills,
        // and a contrast ratio is luminance only: the light amber and the light
        // crimson land within 1.23:1 of each other while being obviously
        // different colours. `colorDistance` is what the rest of this file
        // already measures a vocabulary collision with, and it is what the
        // `pending` rows of the collision table above use.
        expect(colorDistance(fill, palette.accent)).toBeGreaterThanOrEqual(DISTINCT);
        expect(colorDistance(fill, palette.recording)).toBeGreaterThanOrEqual(DISTINCT);
        expect(colorDistance(fill, palette.foreground)).toBeGreaterThanOrEqual(DISTINCT);
    });

    it('carries a glyph that clears 3:1 on it', () => {
        expect(worstContrast(composerPausedTint(dark), [fill])).toBeGreaterThanOrEqual(CHROME_CONTRAST_FLOOR);
    });
});

/**
 * AND WHY THE TINT IS DERIVED RATHER THAN COPIED, which is the trap this
 * ticket walked into first, stated per theme because the two themes are where
 * the whole point of it shows.
 */
describe('the pause glyph is not white just because its neighbours are', () => {
    it('refuses white on the dark theme’s amber, which cannot carry it', () => {
        const fill = composerPausedFill(true);
        expect(worstContrast('#FFFFFF', [fill])).toBeLessThan(CHROME_CONTRAST_FLOOR);
        expect(composerPausedTint(true)).not.toBe('#FFFFFF');
        expect(worstContrast(composerPausedTint(true), [fill])).toBeGreaterThanOrEqual(CHROME_CONTRAST_FLOOR);
    });

    it('keeps white on the light theme’s amber, which can', () => {
        const fill = composerPausedFill(false);
        expect(worstContrast('#FFFFFF', [fill])).toBeGreaterThanOrEqual(CHROME_CONTRAST_FLOOR);
        expect(composerPausedTint(false)).toBe('#FFFFFF');
    });
});

/**
 * The tint helper on its own, because its value is that it is not a table.
 */
describe('the tint a filled disc gets', () => {
    it('is one of the two foregrounds the app already has, never a third value', () => {
        const both = [COMPOSER_CONTROL_PALETTE.dark.foreground, COMPOSER_CONTROL_PALETTE.light.foreground];
        for (const dark of [true, false]) {
            const palette = composerControlPalette(dark);
            for (const fill of [palette.accent, palette.recording, palette.pending, palette.foreground]) {
                expect(both).toContain(composerFillTint(fill));
            }
        }
    });

    it('reproduces the white the accent and recording discs already ship', () => {
        // The helper is not a change to those two. If it disagreed with what is
        // on the phone today it would be a redesign wearing a refactor's
        // clothes, so the agreement is the assertion.
        for (const dark of [true, false]) {
            const palette = composerControlPalette(dark);
            expect(composerFillTint(palette.accent)).toBe('#FFFFFF');
            expect(composerFillTint(palette.recording)).toBe('#FFFFFF');
        }
    });

    /**
     * The version of this helper that "picks whichever reads better" is the one
     * that has to stay out, and it is an easy edit to make by accident. Black
     * beats white on the dark theme's blue, so a maximiser would have turned
     * the send disc and the reading disc black on a ticket about pause.
     */
    it('is not a maximiser: it keeps the row’s white where black would score higher', () => {
        const blue = COMPOSER_CONTROL_PALETTE.dark.accent;
        expect(worstContrast('#000000', [blue])).toBeGreaterThan(worstContrast('#FFFFFF', [blue]));
        expect(worstContrast('#FFFFFF', [blue])).toBeGreaterThanOrEqual(CHROME_CONTRAST_FLOOR);
        expect(composerFillTint(blue)).toBe('#FFFFFF');
    });

    it('picks the one that actually reads, on every fill the row can draw', () => {
        for (const dark of [true, false]) {
            const palette = composerControlPalette(dark);
            for (const fill of [palette.accent, palette.recording, palette.pending]) {
                expect(worstContrast(composerFillTint(fill), [fill]))
                    .toBeGreaterThanOrEqual(CHROME_CONTRAST_FLOOR);
            }
        }
    });
});

/**
 * What the pause disc measures, written down, so a reader does not have to run
 * the suite to know what "clears the floor" bought (DROVE-258).
 */
describe('what the pause disc measures', () => {
    it.each([
        ['dark', true, 5.28, 7.17, 10.22],
        ['light', false, 4.13, 3.03, 4.61],
    ] as const)('%s: %s:1 off the bubble, %s:1 off the resting disc, %s:1 under its glyph', (
        _name, dark, bubble, resting, glyph,
    ) => {
        const fill = composerPausedFill(dark);
        expect(worstContrast(fill, [dark ? COMPOSER_BUBBLE_MATERIAL.dark : COMPOSER_BUBBLE_MATERIAL.light]))
            .toBeCloseTo(bubble, 2);
        expect(worstContrast(fill, [dark ? COMPOSER_IN_FIELD_DISC.dark : COMPOSER_IN_FIELD_DISC.light]))
            .toBeCloseTo(resting, 2);
        expect(worstContrast(composerPausedTint(dark), [fill])).toBeCloseTo(glyph, 2);
    });

    it('leaves white on the dark amber at the 2.06:1 that made the tint a function', () => {
        expect(worstContrast('#FFFFFF', [composerPausedFill(true)])).toBeCloseTo(2.06, 2);
    });
});

/**
 * READ-ALOUD'S FOUR FACES, MEASURED ON THE CAPSULE IT MOVED ONTO (DROVE-284).
 *
 * Clay: "Add the reading mode whatever thing to the group and keep it all on
 * the same row as send and +." The control left the row's in-field disc for a
 * segment of the session capsule, which is a DIFFERENT surface, so every number
 * DROVE-236 and DROVE-258 took against the disc has to be taken again here
 * rather than inherited.
 *
 * TWO BARS, AS EVERYWHERE ELSE ON THIS ROW. A fill is a shape and is held to
 * `COMPOSER_DISC_SEPARATION_FLOOR`; the glyph on it is text and is held to the
 * real 3:1. The amber is where the second one bites, which is the whole of
 * DROVE-258's tint function.
 */
describe('read-aloud as a capsule segment', () => {
    it.each([
        ['dark', true, 7.17, 4.48, 4.16],
        ['light', false, 3.03, 3.81, 3.71],
    ] as const)('%s: the three live fills read off the capsule at %s, %s and %s:1', (
        _name, dark, paused, accent, recording,
    ) => {
        const capsule = composerSessionCapsuleFill(dark);
        expect(worstContrast(composerAudioOutFill(dark, 'paused')!, [capsule])).toBeCloseTo(paused, 2);
        expect(worstContrast(composerAudioOutFill(dark, 'accent')!, [capsule])).toBeCloseTo(accent, 2);
        expect(worstContrast(composerAudioOutFill(dark, 'recording')!, [capsule])).toBeCloseTo(recording, 2);
        for (const face of ['paused', 'accent', 'recording'] as const) {
            expect(worstContrast(composerAudioOutFill(dark, face)!, [capsule]), face)
                .toBeGreaterThanOrEqual(COMPOSER_DISC_SEPARATION_FLOOR);
        }
    });

    it.each([
        ['dark', true, 10.22, 3.29, 3.55, 14.74],
        ['light', false, 4.61, 5.80, 5.64, 13.80],
    ] as const)('%s: the glyph reads on each of them at %s, %s, %s and %s:1 off', (
        _name, dark, paused, accent, recording, off,
    ) => {
        const glyphOn = (face: 'paused' | 'accent' | 'recording') => worstContrast(
            composerAudioOutTint(dark, face), [composerAudioOutFill(dark, face)!],
        );
        expect(glyphOn('paused')).toBeCloseTo(paused, 2);
        expect(glyphOn('accent')).toBeCloseTo(accent, 2);
        expect(glyphOn('recording')).toBeCloseTo(recording, 2);
        // Off there is no fill at all, so the glyph is read off the capsule
        // like the padlock and the needle beside it.
        expect(composerAudioOutFill(dark, 'none')).toBeNull();
        expect(worstContrast(composerAudioOutTint(dark, 'none'), [composerSessionCapsuleFill(dark)]))
            .toBeCloseTo(off, 2);
        for (const face of ['paused', 'accent', 'recording'] as const) {
            expect(glyphOn(face), face).toBeGreaterThanOrEqual(CHROME_CONTRAST_FLOOR);
        }
    });

    it('flips the tint on the amber rather than copying the row\u2019s white', () => {
        // DROVE-258's finding, re-checked on this surface: white on the dark
        // theme's amber measures about 2:1, so a segment that copied "always
        // the primary tint" would draw a pause glyph you cannot read on the
        // face whose whole job is to make pause readable.
        expect(composerAudioOutTint(true, 'paused')).toBe(COMPOSER_CONTROL_PALETTE.light.foreground);
        expect(composerAudioOutTint(true, 'accent')).toBe(COMPOSER_CONTROL_PALETTE.dark.foreground);
        expect(composerAudioOutTint(true, 'recording')).toBe(COMPOSER_CONTROL_PALETTE.dark.foreground);
        // And off it is the ROW's foreground, which is theme-dependent.
        expect(composerAudioOutTint(true, 'none')).toBe(COMPOSER_CONTROL_PALETTE.dark.foreground);
        expect(composerAudioOutTint(false, 'none')).toBe(COMPOSER_CONTROL_PALETTE.light.foreground);
    });

    it('keeps every fill OPAQUE, which is the guarantee DROVE-254 bought', () => {
        // `colorAlpha === 1` is load-bearing and is not weakened to make a
        // layout fit: a translucent fill inside the bubble's own glass has no
        // single value to measure, which is the fault that refusal exists to
        // stop coming back. A segment's fill is painted by a View rather than
        // handed to a UIGlassEffect, and the rule is the same either way.
        for (const dark of [true, false]) {
            for (const face of ['paused', 'accent', 'recording'] as const) {
                expect(colorAlpha(composerAudioOutFill(dark, face)!), `${dark}/${face}`).toBe(1);
            }
        }
    });

    it('spends no new hue: the three faces are three entries the palette already had', () => {
        // The bar this file sets for a state that earns colour. Read-aloud adds
        // none: reading is the accent, a call is the recording red, paused is
        // DROVE-258's amber, which is `pending` under another name.
        for (const dark of [true, false]) {
            const p = composerControlPalette(dark);
            expect(composerAudioOutFill(dark, 'accent')).toBe(p.accent);
            expect(composerAudioOutFill(dark, 'recording')).toBe(p.recording);
            expect(composerAudioOutFill(dark, 'paused')).toBe(composerPausedFill(dark));
            expect(composerAudioOutFill(dark, 'paused')).toBe(p.pending);
        }
    });

    it('takes the palette\u2019s accent, not the theme\u2019s raw blue', () => {
        // The disc used `theme.colors.radio.active` directly, which quietly
        // sidestepped DROVE-264's finding: that value is #0A84FF and the
        // palette's accent is #0A8FFF, eleven points of green lifted precisely
        // so one hue can be a glyph on the bubble AND a fill under a white
        // glyph. Read-aloud's reading face is the second job by name.
        expect(composerAudioOutFill(true, 'accent')).toBe('#0A8FFF');
        expect(composerAudioOutFill(true, 'accent')).not.toBe('#0A84FF');
    });
});
