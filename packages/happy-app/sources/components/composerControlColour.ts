/**
 * What colour a composer control's glyph is, and why (DROVE-176, DROVE-215).
 *
 * THE RULE, and it is the whole file: a glyph on the composer's control row is
 * the row's FOREGROUND colour unless it is ACTIVE, where active means something
 * is happening right now. A control that merely HOLDS a value is not active,
 * however much the value matters, because it is true of every session all of
 * the time, and a colour that is always on carries nothing.
 *
 * THE FOREGROUND IS THE THEME'S TEXT COLOUR: #FFFFFF on the dark theme,
 * #000000 on the light one. Clay asked for white, and on the theme he runs
 * that is literally white, the same white as the waveform, the speaker and the
 * mic in the capsule beside it. Light cannot take him literally, so the token
 * is named for the row's foreground rather than for the word, and it resolves
 * to `theme.colors.text` so a glyph and the model's name next to it are the
 * same value rather than two greys that nearly agree.
 *
 * WHY DROVE-176's ROW LOOKED BORROWED FROM ANOTHER APP. It coloured the state
 * a control was IN rather than the state it was DOING: a purple shield for the
 * permission mode, a pink needle on the effort dial, both permanent, on two
 * controls that are always drawn. Clay, with the row cropped: "And please no
 * colored icons", then, sharpening it, "I told you to do white for the color
 * of all the icons." The capsule a few points to the right was already three
 * plain white glyphs, so the row disagreed with itself, and the right-hand
 * vocabulary is the one that won.
 *
 * HOW IT ENFORCES ITSELF, so the next glyph added to the row inherits the rule
 * without anyone remembering this ticket:
 *
 *  1. `composerGlyphColour` is the only way to a colour, and its default is the
 *     foreground. A glyph written `composerGlyphColour(palette)` is white
 *     without its author having to know why.
 *  2. Its second argument is a `ComposerActiveSignal`, and the palette is TYPED
 *     as the foreground plus exactly one entry per signal. A new hue cannot go
 *     into the palette without first widening that union, which is a claim, in
 *     the type, that the hue names something happening now. tsc refuses the
 *     shortcut, and the diff puts the claim in front of a reviewer.
 *  3. There is no per-control colour function for a control that only holds a
 *     value. `permissionModeColour` and `effortColour` are GONE rather than
 *     rewritten to return the foreground: a helper lives here only where there
 *     is a live state to compute from, so reaching for one is already the
 *     question "what is this control doing?".
 *  4. composerControlColour.spec.ts pins the palette's key set and the default;
 *     ComposerSessionControls.test.ts asserts the RENDERED colour of the shield
 *     in every mode and of the needle at every level, which is the assertion
 *     that survives someone reintroducing a tint at the call site.
 *
 * THE SIGNALS. Three names, and adding a fourth is the decision, not a
 * formality: a member here claims the control is doing something at the moment
 * it is drawn. "The mode is yolo" and "the effort is high" are values and do
 * not qualify, which is the whole of DROVE-215.
 *
 *   recording  a mic is OPEN: the talk button held or latched, and a live voice
 *              turn on the waveform beside it (DROVE-206). DROVE-142's banner
 *              red, so the glyph and the bar under it are one signal. It stays
 *              because an open mic is the one thing on this row you have to
 *              notice without going looking for it.
 *   accent     one press from the app doing something: the send button once
 *              there is something to send. The theme's working blue, which
 *              means the same on a control as it does on the thread.
 *   pending    RESERVED FOR DROVE-217, AND UNWIRED HERE. A control whose
 *              requested value has not been confirmed by the pane yet: asked
 *              for, not landed, and back to the foreground once it lands. That
 *              is happening now, so it belongs in the vocabulary as a named
 *              state rather than arriving later as a one-off tint, and it gets
 *              a measured colour so that lane wires a state instead of
 *              inventing a hue. That lane owns the wiring; this one only holds
 *              the seat. The amber is what DROVE-176 spent on "look twice",
 *              already measured on both themes and already held off every
 *              reserved colour. Yellow proper is taken: the dark theme's
 *              reading mark is #FFD54F (DROVE-125).
 *
 * WHAT WENT WHITE. The permission glyph in every mode, the effort needle at
 * every level and the slider thumb that follows it, the mic and the waveform at
 * rest, the speaker off, the model's name. Nothing that was readable stopped
 * being readable, because the SHAPES carry all of it and were chosen for
 * exactly that (DROVE-141): a mode is read off its padlock, shield, eye or map,
 * and a level off the needle's angle, which was always the primary reading
 * (DROVE-101). DROVE-176 promised colour was never the only carrier. Removing
 * it is what that promise was for.
 *
 * WHAT KEPT COLOUR, and none of it is a mode value:
 *   - the mic and the waveform while a mic is open (recording).
 *   - the send button while there is something to send (accent). Empty, it is
 *     the foreground like everything else.
 *   - the speaker while read-aloud is on, where the FILL carries it
 *     (DROVE-118): a solid accent disc with the tint that reads against it,
 *     never a glyph colour of its own. Off, its glyph is the foreground.
 *
 * WHAT IS NOT ON THE ROW. The two controls inside the input capsule, and
 * DROVE-214 settled them the same way this file settles the row. The `+` at
 * the leading rim was the one accent this file left standing, on the grounds
 * that the pair was that lane's to rule on; it is the FOREGROUND now. Under
 * the rule above it never qualified: it holds no value and is never one press
 * from the app doing something, it is simply always available, and a colour
 * that is always on carries nothing. The send button at the other rim keeps
 * the accent, because "there is something to send" is a live state, and that
 * contrast is what the accent buys. An empty composer is two foreground
 * glyphs on two identical discs.
 *
 * An open picker still marks its current choice the way a picker does, the
 * effort popover's `Auto` or a checkmark in a native menu, because that is
 * selection chrome on a surface that only exists while a finger is down, not a
 * glyph sitting on the row at rest.
 *
 * MEASURED, NOT EYEBALLED, ON BOTH THEMES. The colour is the glyph, not the
 * fill (the material stays glass, DROVE-153), so every entry is checked as a
 * glyph over the control's stack: the chat at either extreme, the opaque dock
 * scrim, the chrome tint, using DROVE-153's method and DROVE-171's numbers.
 * The light theme is where the system colours fail: iOS blue is 2.88:1 on the
 * light glass and the banner red 2.54:1, so light gets darker siblings of the
 * same hue, exactly as the reading mark did in DROVE-125. A coloured glyph
 * that fails on the glass is worse than a white one, so a value that cannot
 * clear 3:1 does not get in.
 *
 * Pure, so the numbers can be pinned without a renderer.
 * ComposerSessionControls.tsx and AgentInput.tsx
 * read it.
 */

import {
    CHROME_CONTRAST_FLOOR,
    CHROME_GLASS_TINT,
    CHROME_GROUND,
    compositeOver,
    compositeSurface,
    contrastRatio,
    parseColor,
} from './glassChrome';

/**
 * The states that earn a colour. Everything else on the row is the foreground.
 * Read THE SIGNALS above before adding one: the bar is that a session left
 * alone would go on doing the thing.
 */
export type ComposerActiveSignal =
    /** A mic is open: held, latched, or a live voice turn. */
    | 'recording'
    /** One press from the app doing something: a send with something to send. */
    | 'accent'
    /** Requested, not yet confirmed by the pane. DROVE-217 wires this. */
    | 'pending';

/**
 * The foreground, and one entry per active signal. Nothing else, on purpose:
 * the type is what stops a decorative hue being added without an argument for
 * why it names something happening now.
 */
export type ComposerControlPalette =
    & { readonly foreground: string }
    & { readonly [signal in ComposerActiveSignal]: string };

/**
 * Both themes, side by side, so a change to one is made with the other in
 * view. Every value below is asserted at 3:1 or better over the glass in
 * composerControlColour.spec.ts.
 */
export const COMPOSER_CONTROL_PALETTE: { dark: ComposerControlPalette; light: ComposerControlPalette } = {
    dark: {
        // theme.colors.text on the dark theme. Literal white, which is what
        // Clay asked for and what the mic and speaker were already drawn in.
        foreground: '#FFFFFF',
        // iOS system blue, dark variant: the theme's radio.active.
        accent: '#0A84FF',
        // DROVE-142's banner red, unchanged: on the dark glass it clears 4:1.
        recording: '#FF3B30',
        // iOS system orange, dark variant. Drawn by nothing until DROVE-217.
        pending: '#FF9F0A',
    },
    light: {
        // theme.colors.text on the light theme. "White" cannot be literal
        // here; the token is the row's foreground, and this is what it is.
        foreground: '#000000',
        // System blue is 2.88:1 on the light glass; this is the same hue at
        // the darkness the glass demands.
        accent: '#0A5FD6',
        // The banner's #FF3B30 is 2.54:1 on the light glass. A crimson rather
        // than a plain darker red, because at glass darkness a red darkens
        // toward orange, and the blue in a crimson is what keeps it a red. It
        // measures 4.04:1 on the light glass and stays inside the banner's
        // family (0.14 away), so the glyph and the bar read as one signal.
        recording: '#C8203A',
        // System orange is under 2:1 on the light glass; darkened, and held
        // off the light theme's brown reading mark. Nothing until DROVE-217.
        pending: '#CC4A0A',
    },
};

export function composerControlPalette(dark: boolean): ComposerControlPalette {
    return dark ? COMPOSER_CONTROL_PALETTE.dark : COMPOSER_CONTROL_PALETTE.light;
}

/**
 * THE RULE, as the one function that hands out a colour.
 *
 * No signal means the foreground, which is why the argument is optional: a
 * glyph added to the row with nothing to say comes out white by writing less,
 * not by remembering more. Pass a signal only for a state that is happening at
 * the moment the glyph is drawn.
 */
export function composerGlyphColour(
    palette: ComposerControlPalette,
    active?: ComposerActiveSignal | null,
): string {
    return active ? palette[active] : palette.foreground;
}

/**
 * The colour a composer control is drawn in, given what it is SET to and
 * whether that setting has landed (DROVE-217).
 *
 * One rule, three controls: the padlock, the effort needle and the model's
 * name all go through here, so a pick that has not reached the terminal reads
 * the same whichever of them it was.
 */
export function pendingOrSettled(
    palette: ComposerControlPalette,
    pending: boolean,
    settled: string,
): string {
    return pending ? palette.pending : settled;
}

export type MicColourState = 'idle' | 'held' | 'latched';

/** The mic's glyph: the foreground at rest, the recording red once it is open. */
export function micColour(palette: ComposerControlPalette, state: MicColourState): string {
    return composerGlyphColour(palette, state === 'idle' ? null : 'recording');
}

/**
 * The in-field send button's glyph: the accent when there is something to
 * send, the foreground when there is not.
 *
 * Kept coloured under the rule, and it is the one control the rule argues for
 * rather than against. An empty composer offers nothing, so the button has
 * nothing to say; a full one is one press from a message going out, which is a
 * thing about to happen rather than a setting that has a value.
 */
export function primaryActionColour(palette: ComposerControlPalette, hasSomethingToSend: boolean): string {
    return composerGlyphColour(palette, hasSomethingToSend ? 'accent' : null);
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
 * (resolveGlassChromeMaterial -> 'fallback'): the theme's surfaceHigh.
 */
export const COMPOSER_FALLBACK_SURFACE = { dark: '#1E1E1E', light: '#F8F8F8' } as const;

/**
 * THE IN-FIELD DISC: the one circle both ends of the input capsule wear
 * (AgentInput's `mobileInFieldDisc`), and the only surface either of them has
 * apart from Stop and the gate's lock (DROVE-214).
 *
 * Clay: "the plus to add images and stuff should be a circle just like on the
 * right hand side send button." One circle, so one value.
 *
 * IT IS THE DARKER OF THE TWO VALUES EACH THEME ALREADY HAD, and that is a
 * measurement rather than a preference. The send button used to change fill
 * with state: dark #282828 live and #3A3A3C at rest, light #f0f0f0 live and
 * #D1D1D6 at rest. Read off the glass in Clay's screenshot, where the
 * composer's material sits at 61/255, the resting dark value came out at
 * 1.05:1. That is not a faint circle, it is no circle, and copying it to the
 * leading rim would have answered him with nothing to see. Light was worse:
 * #f0f0f0 measures 1.018:1 on the light glass.
 *
 * Both themes land on the same 1.36:1 with the darker value, so the disc is a
 * step DOWN from the glass on each and neither theme is the exception.
 *
 * The fill no longer carries send's state; the GLYPH does, which is the rule
 * this file already runs on. An empty composer is two identical circles, and
 * the accent appears at one rim when there is something to send.
 */
export const COMPOSER_IN_FIELD_DISC = { dark: '#282828', light: '#D1D1D6' } as const;

/**
 * And the held-down step off it, for the `+` while its sheet is open: the
 * value the other state just vacated on each theme, so the pair of surfaces is
 * the pair that was already there, swapped (DROVE-214).
 *
 * The row's controls keep `mobileIconButtonOpen` and are not touched by this.
 */
export const COMPOSER_IN_FIELD_DISC_OPEN = { dark: '#3A3A3C', light: '#f0f0f0' } as const;

/**
 * WHAT THE IN-FIELD DISC IS SEEN AGAINST: the BUBBLE's material, which is not
 * the same backdrop as `composerGlyphLayers` (DROVE-214).
 *
 * That stack models the control ROW's glass, ground plus tint. These two discs
 * are inside the input capsule, whose material is a native UIGlassEffect over
 * the chat, and it does not composite to the same value. Dark is read off
 * Clay's own screenshot, where the capsule's interior sits at 61/255; light is
 * the ground the glass sits on, since a light glass over a light ground barely
 * moves.
 *
 * It exists so the disc's separation can be a test. A circle Clay cannot see
 * is what sent this ticket round a third time, and a value that goes back to
 * blending into the capsule should fail rather than ship.
 */
export const COMPOSER_BUBBLE_MATERIAL = { dark: '#3D3D3D', light: '#F2F2F7' } as const;

/**
 * How far the disc has to sit off that material to read as a circle at all.
 *
 * Not a legibility floor: a disc is a shape, not text, and the glyph on it is
 * held to the real 3:1 elsewhere. This is the separation both themes achieve
 * at 1.36:1 with the values chosen, against the 1.05 and 1.02 of the values
 * that were there before.
 */
export const COMPOSER_DISC_SEPARATION_FLOOR = 1.3;

/**
 * And the weaker bar the OPEN step is held to, because it is a different job.
 *
 * The disc has to read as a shape against a material you are not touching. The
 * open step has to read as a change on a shape your thumb is on, while the
 * press also drops the control to 0.7 opacity and a sheet slides up. It
 * measures 1.30:1 on dark and more on light, so the margin is thin and stated
 * rather than hidden inside a shared number.
 */
export const COMPOSER_DISC_STEP_FLOOR = 1.25;

/**
 * THE EFFORT GAUGE IS TWO MARKS, NOT ONE (DROVE-227).
 *
 * Clay, with the effort control cropped: "This icon isn't contrasting." The
 * NEEDLE was already right. DROVE-215 made it the foreground at every level
 * and the angle carries the value (DROVE-141). What it missed is that the dial
 * is a mark PLUS a track, and only the mark got the foreground. The track kept
 * `theme.colors.divider`, a hairline chosen to separate two list rows, which
 * measures 1.05:1 against the control row's glass on dark and 1.13:1 on light.
 * That is not a dim arc, it is no arc, so the control read as a lone diagonal
 * with no instrument around it.
 *
 * THE CONSTRAINT IS TWO-SIDED, which is what makes this more than "lighten
 * it". The arc has to separate from the CAPSULE, and the needle has to
 * separate from the ARC it points across. A track at the needle's own colour
 * clears the first and fails the second: the instrument goes blank in the
 * other direction. The two floors below are both, and the needle's is the
 * larger of the two on purpose, because the needle is the reading and the arc
 * is only the thing it is read against.
 *
 * The arc's whole luminance range is bounded by those two: on the dark glass
 * the needle is 15.09:1 off the capsule and on the light glass 15.40:1, and
 * the arc splits that room. 2.5:1 and 6:1 is where it is split.
 *
 * IT IS THE FOREGROUND AT A REDUCED OPACITY, NOT A GREY OF ITS OWN, and the
 * reason is the surface rather than the tidiness. The in-field disc could be
 * an opaque hex (DROVE-214) because it is a solid fill that REPLACES the
 * material under it, so one measured value is the whole truth. The arc is a
 * 2pt hairline drawn ON a live UIGlassEffect that refracts whatever the chat
 * is showing; `composerGlyphLayers` models that as a ground plus a tint, which
 * is close but not the surface. A translucent stroke moves WITH the material
 * and holds its ratio when the model and the real thing disagree; an opaque
 * hex is pinned to the model and drifts. The gauge's own open state is the
 * proof: pressing it washes the capsule with `glass.backgroundSubtle`, which
 * on light lifts it by 42%, and the translucent track follows it to 2.54:1
 * where a hex tuned for the resting glass would have collapsed.
 *
 * Saying it as the FOREGROUND, rather than as white and black, also settles
 * DROVE-215's rule for the track by construction: there is no hue to reach
 * for. The arc is the same colour as the needle with less of it, which is the
 * thing the eye is being asked to read.
 *
 * The alphas differ by theme because the two glasses are not mirror images:
 * 0.28 over a near-black capsule and 0.37 over a near-white one both land on
 * the same 2.5:1. One shared alpha would have given light 1.95:1.
 */
export const COMPOSER_GAUGE_TRACK_ALPHA = { dark: 0.28, light: 0.37 } as const;

/**
 * The dial's arc: the row's foreground, at the alpha above.
 *
 * Derived from the palette rather than written out, so the track cannot become
 * a colour without the foreground becoming one first.
 */
export function composerGaugeTrack(dark: boolean): string {
    const { r, g, b } = parseColor(composerControlPalette(dark).foreground);
    const channels = [r, g, b].map((value) => Math.round(value * 255)).join(', ');
    return `rgba(${channels}, ${dark ? COMPOSER_GAUGE_TRACK_ALPHA.dark : COMPOSER_GAUGE_TRACK_ALPHA.light})`;
}

/**
 * How far the arc has to sit off the capsule to read as an instrument.
 *
 * Above DROVE-214's 1.3 disc floor, and that is deliberate rather than
 * inherited: a 44pt circle can be found at 1.36:1 because it is a large area,
 * and a 2pt hairline at the same separation is a smudge. The shipped values
 * measure 2.51:1 on dark and 2.50:1 on light, and 2.39:1 at the worst of the
 * three materials the gauge is drawn on.
 */
export const COMPOSER_GAUGE_TRACK_FLOOR = 2.3;

/**
 * And the other side of it: how far the needle has to sit off the arc.
 *
 * WCAG's 3:1 would be enough to SEE the needle. This is higher because seeing
 * it is not the job: the needle is the value (DROVE-141) and the arc is the
 * scale behind it, so the two marks have to rank, not merely differ. Asserted
 * to be greater than the track's floor, which is the ranking written down.
 * The shipped values measure 6.01:1 on dark and 6.16:1 on light, 5.11:1 at the
 * worst material.
 */
export const COMPOSER_GAUGE_NEEDLE_FLOOR = 4.5;

/**
 * `theme.colors.glass.backgroundSubtle`, the wash a control takes while its
 * picker is open or a drag is running (`controlOpen`).
 *
 * Here because it is a material the gauge is really drawn on, not decoration:
 * on light it is a 42% white lift, easily enough to strand a track tuned only
 * against the resting glass.
 */
export const COMPOSER_CONTROL_OPEN_WASH = {
    dark: 'rgba(255, 255, 255, 0.07)',
    light: 'rgba(255, 255, 255, 0.42)',
} as const;

/**
 * Every material the effort gauge is drawn on, as layer stacks over the chat.
 *
 * Three, and all three are ordinary: the control row's glass, the opaque
 * fallback a device with no Liquid Glass gets, and the glass under the open
 * wash. The floors hold on all of them.
 */
export function composerGaugeMaterials(dark: boolean): Readonly<Record<string, readonly string[]>> {
    const glass = composerGlyphLayers(dark);
    return {
        glass,
        fallback: [dark ? COMPOSER_FALLBACK_SURFACE.dark : COMPOSER_FALLBACK_SURFACE.light],
        open: [...glass, dark ? COMPOSER_CONTROL_OPEN_WASH.dark : COMPOSER_CONTROL_OPEN_WASH.light],
    };
}

/**
 * Both sides of the gauge's contrast at once, over one material.
 *
 * The arithmetic lives here rather than in the spec so the two numbers are
 * computed the same way everywhere they are quoted, and so a reader can ask
 * the module what the gauge measures without running a test.
 */
export function composerGaugeContrast(
    dark: boolean,
    layers: readonly string[],
    backdrop: string,
): { track: number; needle: number } {
    const bed = compositeSurface(backdrop, layers);
    const arc = compositeOver(composerGaugeTrack(dark), bed);
    const needle = parseColor(composerControlPalette(dark).foreground);
    return { track: contrastRatio(arc, bed), needle: contrastRatio(needle, arc) };
}


/**
 * THE PAUSED READER'S DISC, AND THE TINT THAT READS ON IT (DROVE-258).
 *
 * Clay: "When I long press read and it pauses color it I dunno pause colour
 * maybe yellow or orange and show pause icon."
 *
 * WHAT WAS WRONG. DROVE-233 gave read-aloud a pause and DROVE-236 drew it, on
 * the two carriers the audio-out button already had: the glyph said whether
 * read-aloud was ON and the fill said whether it was reading RIGHT NOW. Paused
 * therefore wore the reading glyph on no disc, which is a state you can only
 * identify by remembering what you last did. Read-aloud is the eyes-free
 * feature. Remembering is the thing it exists to save.
 *
 * NO NEW HUE, AND THAT IS NOT A TECHNICALITY. It is the palette's own amber,
 * the entry DROVE-217 measured on both themes and held off every reserved
 * colour, reached through `composerGlyphColour` so it cannot be edited here
 * without the palette moving. What DROVE-258 adds is a STATE that wears an
 * existing colour, which is the only kind of addition this file has ever let
 * through cheaply.
 *
 * AND THE AMBER IS THE RIGHT ONE RATHER THAN THE AVAILABLE ONE. It already
 * means HELD on this row: a pick the pane has not confirmed is asked-for and
 * not landed, and a paused reader is reading and not running. Both are one
 * event away from being over, neither is going anywhere on its own, and the
 * wrist spends orange on the same idea ("look twice", WristPalette.swift). One
 * amber, one meaning, on two controls that are never confused for each other
 * because one is a glyph and this one is a disc.
 *
 * WHY A DISC AND NOT A COLOURED GLYPH. The fill is the carrier this button
 * already uses for its live states, so paused reads in the same vocabulary as
 * reading and a call rather than in a second one. It is also the measurement:
 * the amber on the RESTING disc clears the floor by 0.03 on the light theme,
 * which is a pass that would not survive anyone touching either value, and the
 * amber AS the disc clears it by a margin instead.
 *
 * WHAT THIS DOES NOT DO. It does not colour anything else. The `+`, send at
 * rest, the padlock, the needle, the model's name and the mic are the
 * foreground exactly as DROVE-215 left them, and the mic still takes no circle
 * until it is open. This is one hue on one state.
 */
export function composerPausedFill(dark: boolean): string {
    return composerGlyphColour(composerControlPalette(dark), 'pending');
}

/**
 * The glyph colour for a control whose disc is a FILL rather than the glass.
 *
 * WHITE UNLESS WHITE CANNOT BE READ. A filled disc is its own backdrop, so the
 * glyph on it belongs to the FILL and not to the theme, and both filled discs
 * on this row are already drawn with `theme.colors.button.primary.tint`, which
 * is #FFFFFF on both themes. This keeps that and adds one condition.
 *
 * IT IS DELIBERATELY NOT "WHICHEVER READS BETTER", which was the first shape
 * of this function and was wrong. Black measures 5.76:1 on the dark theme's
 * blue against white's 3.65:1, so picking the maximum would have flipped the
 * send disc and the reading disc to black glyphs on a ticket about pause. The
 * row has ONE tint and this hands back exactly it until the floor says it
 * cannot, which is a rule about legibility rather than a second opinion about
 * taste.
 *
 * AND THE AMBER IS WHERE THE FLOOR ACTUALLY SAYS SO. White on the dark theme's
 * amber measures about 2:1. Copying the ternary that was already at the call
 * site would have shipped a pause icon you cannot read on the disc whose whole
 * job is to make pause readable.
 */
export function composerFillTint(fill: string): string {
    const bed = parseColor(fill);
    const tint = COMPOSER_CONTROL_PALETTE.dark.foreground;
    return contrastRatio(parseColor(tint), bed) >= CHROME_CONTRAST_FLOOR
        ? tint
        : COMPOSER_CONTROL_PALETTE.light.foreground;
}

/** The pause glyph's colour: whichever foreground reads on the amber. */
export function composerPausedTint(dark: boolean): string {
    return composerFillTint(composerPausedFill(dark));
}
