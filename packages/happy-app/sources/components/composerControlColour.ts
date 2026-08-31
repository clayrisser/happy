/**
 * What colour each composer control is, and why (DROVE-176).
 *
 * Clay, on the DROVE-153 composer: "Color all the buttons here". Every glyph
 * on the row was white on the glass except the speaker, which is blue because
 * read-aloud is on. DROVE-141 made the SHAPES carry the state, and they still
 * do; this file adds colour as a second carrier, never the only one. A
 * colour-blind reading of the row is the DROVE-141 reading and it is
 * unchanged.
 *
 * THE VOCABULARY IS SMALL AND EACH ENTRY MEANS ONE THING. The app already
 * spends most of the wheel: the working blue is the main thread (DROVE-155),
 * yellow is the reading mark (DROVE-125), green is success, red is destructive
 * and recording (DROVE-142), and the subagent tint is a neutral grey ON
 * PURPOSE (DROVE-145). Every entry here is either one of those, used for the
 * thing it already means, or a hue none of them use. The spec measures the
 * distance from every reserved colour so a later edit cannot drift into one.
 *
 *   accent     the app doing or offering something: the `+` that adds, the
 *              send arrow once there is something to send, the speaker that
 *              is speaking. It is the theme's own blue, which is the working
 *              blue: the main thread working is the app doing something, so
 *              this is the same meaning on a control rather than a second
 *              blue beside it.
 *   warning    a setting that costs if glanced past. The OPEN padlock (yolo,
 *              no gate) and the TOP of the effort dial share it on purpose:
 *              both are "this session is running hot". Amber, which is the
 *              warning family everywhere on iOS, and the one hue on the row
 *              that says "look twice" without saying "wrong".
 *   shield     safe-yolo: no gate, but fenced to the workspace. Indigo, a
 *              cool colour with no other meaning in the app, chosen to sit
 *              as far from the amber as the wheel allows so an open door and
 *              a fenced one never read alike.
 *   eye        read-only: it can look. Teal, cool and calm, and measured
 *              apart from the link colour it is nearest to.
 *   effort     a RAMP, not a colour: cool at the floor warming toward the
 *              ceiling, so ultracode is unmistakable without reading the
 *              needle. Cool slate through mauve to the warning amber. The
 *              intermediate stops are positions, not vocabulary, and the spec
 *              holds every one of them off the reserved colours.
 *   recording  the mic latched or held. DROVE-142's banner red, so the glyph
 *              and the bar under it are one signal. Also a live voice turn on
 *              the waveform beside it (DROVE-206), because a live mic is a
 *              live mic wherever it is drawn.
 *   neutral    the theme's text colour: the shut padlock (asks first, nothing
 *              to flag), the mic at rest, the waveform at rest, the speaker
 *              off, the in-field send button with nothing to send, and the
 *              model's name. The name is deliberately neutral: it is read,
 *              not glanced, it has no state axis to map to, and a coloured
 *              word beside coloured glyphs would compete with the state they
 *              carry.
 *
 * DROVE-206 REARRANGED THE COMPOSER AND SPENT NO NEW COLOUR ON IT, which is
 * the test of a vocabulary this small. The `+` moved inside the field and is
 * still the accent, on the same measured glass stack rather than on a fill
 * nothing has measured. The waveform came out of the field onto the row and
 * took `recording` and `neutral`, the entries the mic beside it already uses,
 * through the same `micColour` helper. The send button stopped changing
 * identity, which RETIRED a case rather than adding one.
 *
 * MEASURED, NOT EYEBALLED, ON BOTH THEMES. The colour is the glyph, not the
 * fill (the material stays glass, DROVE-153), so every entry is checked as a
 * glyph over the control's stack: the chat at either extreme, the opaque
 * dock scrim, the chrome tint, using DROVE-153's method and DROVE-171's
 * numbers. The light theme is where the system colours fail: iOS blue is
 * 2.88:1 on the light glass and the banner red 2.54:1, so light gets darker
 * siblings of the same hue, exactly as the reading mark did in DROVE-125.
 * A coloured glyph that fails on the glass is worse than a white one, so a
 * value that cannot clear 3:1 does not get in.
 *
 * Pure, so the numbers can be pinned without a renderer.
 * ComposerSessionControls.tsx and AgentInput.tsx read it.
 */

import { CHROME_GLASS_TINT, CHROME_GROUND } from './glassChrome';

export interface ComposerControlPalette {
    neutral: string;
    accent: string;
    warning: string;
    shield: string;
    eye: string;
    recording: string;
    /** The effort ramp's stops, floor to ceiling. */
    effort: readonly [cool: string, mid: string, hot: string];
}

/**
 * Both themes, side by side, so a change to one is made with the other in
 * view. Every value below is asserted at 3:1 or better over the glass in
 * composerControlColour.spec.ts.
 */
export const COMPOSER_CONTROL_PALETTE: { dark: ComposerControlPalette; light: ComposerControlPalette } = {
    dark: {
        neutral: '#FFFFFF',
        // iOS system blue, dark variant: the theme's radio.active.
        accent: '#0A84FF',
        // iOS system orange, dark variant.
        warning: '#FF9F0A',
        shield: '#8A88FF',
        eye: '#5AC8FA',
        // DROVE-142's banner red, unchanged: on the dark glass it clears 4:1.
        recording: '#FF3B30',
        effort: ['#8FB8C8', '#C990C8', '#FF9F0A'],
    },
    light: {
        neutral: '#000000',
        // System blue is 2.88:1 on the light glass; this is the same hue at
        // the darkness the glass demands.
        accent: '#0A5FD6',
        // System orange is under 2:1 on the light glass; darkened, and held
        // off the light theme's brown reading mark.
        warning: '#CC4A0A',
        shield: '#4F46E5',
        eye: '#0E7490',
        // The banner's #FF3B30 is 2.54:1 on the light glass. A crimson rather than a
        // plain darker red, because at glass darkness red and the warning
        // orange converge, and the blue in a crimson is what keeps them
        // apart. The exact stop is where two bounds meet: near enough
        // that red to read as the same signal as DROVE-142's banner (0.14),
        // far enough from the warning orange not to be mistaken for it
        // (0.15). It measures 4.04:1 on the light glass.
        recording: '#C8203A',
        effort: ['#5B6B8C', '#9A4FA0', '#CC4A0A'],
    },
};

export function composerControlPalette(dark: boolean): ComposerControlPalette {
    return dark ? COMPOSER_CONTROL_PALETTE.dark : COMPOSER_CONTROL_PALETTE.light;
}

/**
 * The permission mode's colour, by the same kind-then-key reading the glyph
 * uses (sessionControlGlyphs.ts), so colour and shape cannot disagree about
 * which mode this is.
 */
export function permissionModeColour(
    palette: ComposerControlPalette,
    kind: string | null | undefined,
    key?: string | null,
): string {
    const value = (kind ?? key ?? '').toLowerCase();
    if (value === 'yolo' || value === 'bypasspermissions' || value === 'full') return palette.warning;
    if (value === 'safe-yolo' || value === 'workspace' || value === 'auto') return palette.shield;
    if (value === 'read-only' || value === 'read' || value === 'read_only') return palette.eye;
    // Plan, edits and the default that stops and asks: nothing to flag.
    return palette.neutral;
}

/**
 * Where on the ramp level `index` of a `count`-long scale sits, 0 at the
 * floor and 1 at the ceiling. The same interpolation the needle's angle
 * uses, so the colour and the angle agree about the position (DROVE-101).
 */
export function effortPosition(index: number, count: number): number {
    const levels = Math.max(1, Math.round(count));
    if (levels === 1) return 0;
    const level = Math.max(0, Math.min(levels - 1, Math.round(index)));
    return level / (levels - 1);
}

/**
 * The needle's colour at a position on the ramp.
 *
 * Piecewise in sRGB between the three stops, so the middle of the scale is
 * the mauve stop rather than the muddy mean of slate and amber. The ends are
 * the stops exactly: the floor is always the cool stop and the ceiling always
 * the warning amber, whatever the scale's length.
 */
export function effortColour(palette: ComposerControlPalette, index: number, count: number): string {
    const position = effortPosition(index, count);
    const [cool, mid, hot] = palette.effort;
    if (position <= 0.5) return mixHex(cool, mid, position * 2);
    return mixHex(mid, hot, (position - 0.5) * 2);
}

export type MicColourState = 'idle' | 'held' | 'latched';

/** The mic's glyph: neutral at rest, recording once it is live. */
export function micColour(palette: ComposerControlPalette, state: MicColourState): string {
    return state === 'idle' ? palette.neutral : palette.recording;
}

/**
 * The in-field send button's glyph: the accent when there is something to
 * send, neutral when there is not.
 *
 * The rule is unchanged by DROVE-206 and says more than it used to. It was
 * competing with the waveform, which was what the same button became on an
 * empty composer, so the accent had to distinguish two controls as well as
 * two states. Now it distinguishes one control's two states and nothing else.
 */
export function primaryActionColour(palette: ComposerControlPalette, hasSomethingToSend: boolean): string {
    return hasSomethingToSend ? palette.accent : palette.neutral;
}

/**
 * The stack a composer glyph actually sits on, per theme, in the order it is
 * painted: the chat (either extreme), the dock scrim, which is opaque at the
 * composer (AgentContentView), then the control's chrome tint (DROVE-171).
 * The spec paints every entry over this on both backdrops.
 */
export function composerGlyphLayers(dark: boolean): readonly string[] {
    return dark
        ? [CHROME_GROUND.dark, CHROME_GLASS_TINT.dark]
        : [CHROME_GROUND.light, CHROME_GLASS_TINT.light];
}

/**
 * The opaque material a device with no Liquid Glass draws instead
 * (resolveGlassChromeMaterial → 'fallback'): the theme's surfaceHigh.
 */
export const COMPOSER_FALLBACK_SURFACE = { dark: '#1E1E1E', light: '#F8F8F8' } as const;

/**
 * The in-field primary's active disc (AgentInput's mobilePrimaryButtonActive,
 * the theme's surfaceHighest). The send arrow is the one accent glyph that
 * sits on a solid fill rather than on the glass.
 */
export const COMPOSER_PRIMARY_SURFACE = { dark: '#282828', light: '#f0f0f0' } as const;

function mixHex(from: string, to: string, amount: number): string {
    const t = Math.max(0, Math.min(1, amount));
    const a = hexChannels(from);
    const b = hexChannels(to);
    const channel = (i: number) => Math.round(a[i] + (b[i] - a[i]) * t);
    return `#${[0, 1, 2].map((i) => channel(i).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

function hexChannels(hex: string): [number, number, number] {
    const digits = hex.replace('#', '');
    return [
        parseInt(digits.slice(0, 2), 16),
        parseInt(digits.slice(2, 4), 16),
        parseInt(digits.slice(4, 6), 16),
    ];
}
