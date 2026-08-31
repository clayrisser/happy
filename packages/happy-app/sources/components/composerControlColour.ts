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
 * WHAT IS NOT ON THE ROW, so this file does not rule on it. The `+` at the
 * field's leading edge keeps its accent: it sits inside the input capsule,
 * paired with the send button at the other rim (DROVE-206), and DROVE-214 owns
 * that pair. An open picker still marks its current choice the way a picker
 * does, the effort popover's `Auto` or a checkmark in a native menu, because
 * that is selection chrome on a surface that only exists while a finger is
 * down, not a glyph sitting on the row at rest.
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
 * ComposerSessionControls.tsx, EffortSliderPopover.tsx and AgentInput.tsx
 * read it.
 */

import { CHROME_GLASS_TINT, CHROME_GROUND } from './glassChrome';

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
 * The in-field primary's active disc (AgentInput's mobilePrimaryButtonActive,
 * the theme's surfaceHighest). The send arrow is the one accent glyph that
 * sits on a solid fill rather than on the glass.
 */
export const COMPOSER_PRIMARY_SURFACE = { dark: '#282828', light: '#f0f0f0' } as const;
