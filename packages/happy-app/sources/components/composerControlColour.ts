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
 * AND SINCE DROVE-254 THERE IS A SECOND AXIS: the SURFACE behind the glyph.
 * It says the same thing colour does and it says it for the same reason. A
 * control wears a fill when it is an object you press, and the MIC gains a
 * fill when it is actually open and has none when it is not. No hue is spent
 * on that; the fill it gains is the recording red the glyph already wore. The
 * rule below is about glyphs, the rules on `composerSendSurface` and
 * `composerMicSurface` are about fills, and they agree.
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
 * contrast is what the accent buys. Since DROVE-264 send has no disc under it
 * either, so an empty composer is a white `+` on a disc at one rim and two
 * bare white glyphs at the other.
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

import type { AudioOutFill } from './composerAudioOut';
import {
    CHROME_CONTRAST_FLOOR,
    CHROME_GLASS_TINT,
    CHROME_GROUND,
    colorAlpha,
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
        // THE SYSTEM BLUE, LIFTED 11 POINTS OF GREEN (DROVE-264).
        //
        // It was `#0A84FF` exactly, iOS system blue's dark variant and the
        // theme's `radio.active`, and it was measured against the DISC send
        // used to wear: 4.042:1 on `COMPOSER_IN_FIELD_DISC`. DROVE-264 takes
        // that disc away on Clay's "the send button shouldn't have a circle
        // around it", so the accent is now read straight off the bubble, and on
        // the bubble the system blue measures 2.978:1. That is under the floor
        // this file refuses to let a colour in below, by 0.022, which nothing
        // would have noticed on a phone and a spec does.
        //
        // THE VALUE IS PINNED BETWEEN TWO OPPOSITE REQUIREMENTS, which is why
        // it is this precise and why it is worth a paragraph. The accent has
        // two jobs: it is a GLYPH on the bubble (send with something to send)
        // and it is a FILL under a white glyph (read-aloud reading, DROVE-118).
        // Lighter clears the bubble and strands the white; darker carries the
        // white and vanishes into the bubble. `#0A8FFF` is the point that
        // maximises the smaller of the two: 3.303:1 on the bubble and 3.288:1
        // for white on it. Anything much either side fails one of them.
        //
        // 0.3 OF MARGIN IS THIN AND IS SAID SO RATHER THAN HIDDEN. If either
        // number ever has to move again, the fix is not a third nudge: it is to
        // stop making one value do both jobs, the way this palette already
        // splits the accent by THEME, and split it by ROLE as well. That is a
        // decision with an argument to write, not a hex to retune.
        //
        // It is still the theme's blue: 0.025 away by `colorDistance`, against
        // the 0.12 the spec allows before the row would have two blues.
        accent: '#0A8FFF',
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
 * The auto-accept BOLT's glyph colour: the foreground while it is off, the
 * accent while it is on (DROVE-277, moved off the padlock by DROVE-281).
 *
 * THIS IS THE RULE APPLIED, NOT AN EXCEPTION TO IT, and the distinction is the
 * whole reason it is written here rather than tinted at the call site. The rule
 * is that a control holding a VALUE gets no colour and a control that is DOING
 * something does. A permission mode is a value: yolo, plan and default are true
 * of the session all of the time, which is why DROVE-215 took their colours
 * away and why `permissionModeColour` is deleted rather than rewritten.
 *
 * Auto-accept is not a value the session holds. It is a thing the app is doing
 * on Clay's behalf, continuously, to prompts he never sees — the same class as
 * an open mic and a send with something in it, which are the other two the
 * accent is spent on. It is also the only state on this row whose cost of being
 * missed is a command running unasked, so if any state on the composer earns a
 * colour it is this one.
 *
 * IT WAS THE PADLOCK'S COLOUR UNTIL DROVE-281 AND IT IS THE BOLT'S NOW, which
 * is a move rather than an addition. DROVE-277 had no control to colour: the
 * switch was a row inside the padlock's sheet, so the padlock was the only
 * object on the row that could wear the state at all, and tinting it was the
 * only way the session could visibly wear it. DROVE-281 puts the bolt on the
 * row as its own segment, so the state now has the control that owns it to sit
 * on, and the padlock goes back to the foreground in every mode.
 *
 * TINTING BOTH WAS THE OTHER OPTION AND IS REFUSED. Two accent glyphs touching
 * inside one capsule say the same thing twice on the row with the least width
 * on the phone, and the second one says it about a control that is not the one
 * you press to change it. One state, one coloured glyph, and it is the glyph
 * that toggles it.
 *
 * It reuses `accent`. No new palette entry, no new hue, and
 * `ComposerActiveSignal` does not widen — the three signals are still recording,
 * accent and pending, which is what the spec pins. The bolt also FILLS when it
 * is on (`autoAcceptGlyph`), so the state is carried by the silhouette as well
 * as by the hue and a reader who cannot see the difference still reads it; the
 * accessibility value carries it in words on top of that.
 */
export function autoAcceptColour(palette: ComposerControlPalette, autoAccept: boolean): string {
    return composerGlyphColour(palette, autoAccept ? 'accent' : null);
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
 * this file already runs on, and DROVE-264 has since taken send's circle away
 * altogether. So this value has two members rather than three: the `+` and the
 * audio button. The rule it was written for is untouched — one circle, one
 * value — and the accent still appears at the trailing rim when there is
 * something to send, now on a bare glyph.
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
 *
 * SINCE DROVE-236 IT IS THE BACKDROP FOR THE WHOLE BUTTON ROW, not just the
 * two discs: the session capsule and the audio button moved inside the bubble
 * too. So it is also what the capsule's fill is measured against, and what the
 * mic's bare glyph is measured against once DROVE-254 takes its disc away.
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
 * THE SESSION CAPSULE'S SURFACE, and why it stopped being glass (DROVE-254).
 *
 * Clay, on the row after DROVE-236 moved it inside the bubble: "This blends in
 * which is annoying." The padlock, the gauge and the model's name read as
 * loose glyphs in the field rather than as one control, while the `+` and the
 * mic either side of them are plainly objects.
 *
 * THE CAUSE IS GLASS ON GLASS, not a tint that is one step too weak. The
 * bubble is a `GlassView` carrying a `UIGlassEffect` (AgentInput's
 * `MobileGlassSurface material="liquid"`), and until this ticket the capsule
 * was a SECOND `GlassView` inside it. A glass effect draws by sampling what is
 * behind its own view; when that is already a glass effect over the same chat,
 * the inner one has nothing left to refract that its host has not refracted
 * already. Apple groups glass with `UIGlassContainerEffect` for exactly this
 * reason and does not nest it. DROVE-153 gave the capsule glass when it lived
 * OUTSIDE the bubble on the dock scrim, where glass over the chat was the
 * right material; DROVE-236 moved it inside and the material stopped being
 * true without anything being changed.
 *
 * WHICH IS ALSO WHY THE OLD VALUE COULD NOT BE MEASURED. Modelled as a tint
 * over the bubble, `CHROME_GLASS_TINT` composites to rgb(90,90,90) on dark and
 * rgb(220,220,225) on light: 1.58:1 and 1.22:1 off the bubble. Light fails
 * `COMPOSER_DISC_SEPARATION_FLOOR` outright. Dark passes the arithmetic and
 * still blends on the phone, because the arithmetic assumes the tint is added
 * to the bubble's material and the platform does not add it. A translucent
 * surface inside another glass surface has no single value, so there is
 * nothing a spec can hold. That is the whole argument for the fix.
 *
 * SO IT IS AN OPAQUE FILL, the same move DROVE-214 made one element over: a
 * fill REPLACES the material under it, so one measured value is the whole
 * truth. It is also what the other three controls on that row already are.
 * Plain views with opaque fills; the capsule was the only glass object among
 * them, which is the inconsistency Clay was looking at.
 *
 * AND IT IS THE DISCS' EXACT FILL, not a value of its own.
 *
 *   1. They are peers on one row. Three greys on one line is worse than two,
 *      and there is no third thing for a third grey to mean.
 *   2. The band has room for one value. The discs are a step DOWN from the
 *      bubble on both themes, so a lighter capsule is the failure this ticket
 *      is about and a darker one would make the capsule the darkest surface
 *      on the row, ranking a control that HOLDS values above the two that DO
 *      something. That is DROVE-215's rule wearing a grey instead of a hue.
 *   3. The area objection is real and it is answered by the dividers rather
 *      than by the fill. At 320 the capsule is about 154 x 36, five times a
 *      36pt disc, and one tone over five times the area does read heavier.
 *      What stops it presenting as a slab is that it is cut into three by two
 *      hairlines, which is the same reason Apple's grouped capsules and its
 *      single circles share one material. It measures 1.36:1 on both themes,
 *      the same number the discs land on, because it is the same value.
 */
export const COMPOSER_SESSION_CAPSULE_FILL = COMPOSER_IN_FIELD_DISC;

export function composerSessionCapsuleFill(dark: boolean): string {
    return dark ? COMPOSER_SESSION_CAPSULE_FILL.dark : COMPOSER_SESSION_CAPSULE_FILL.light;
}

/**
 * The two hairlines inside it are KEPT, and re-measured. They are what stops
 * 154pt of one tone reading as a slab, which is the other half of the argument
 * for the fill above. `composerCapsuleDivider` is below, with the gauge's
 * floors, because it is derived from the gauge's track.
 */

/**
 * SEND AND THE MIC ARE TWO CONTROLS AGAIN, AND NEITHER WEARS A CIRCLE AT REST
 * (DROVE-264, reversing half of DROVE-254 and half of DROVE-236).
 *
 * Clay, two messages: "I don't think we should combine the send and the
 * microphone button because I might wanna type some stuff and then hit the
 * microphone and then say some stuff", and "the send button shouldn't have a
 * circle around it".
 *
 * WHY THE COLLAPSE WAS WRONG, in his words rather than in a principle. DROVE-236
 * folded send and the mic into one slot on the argument that they are one job:
 * put words in, send them out. That is true of the JOB and false of the
 * SEQUENCE. A single morphing button assumes typing and dictating are
 * ALTERNATIVES, so reaching the mic requires the send affordance to disappear
 * and the other way round. Clay's composition is type a bit, dictate the rest,
 * then send, which needs both controls on the screen at the same moment. One
 * slot cannot hold that however cleverly its faces are ordered.
 *
 * WHAT THE SPLIT GIVES BACK FOR FREE, and it is the trap DROVE-236 wrote the
 * longest comment about. That ticket had to check `captureOpen` FIRST and let it
 * outrank the composer's contents, because dictation partials land in the field
 * within a word and the button would otherwise flip to Send under his thumb
 * mid-sentence. Two controls cannot flip into each other, so the rule has no
 * subject any more: the mic is always the mic and send is always send, at every
 * length of text and at every moment of a capture. The guarantee DROVE-206
 * bought — "a paper plane means a press sends" — is now structural rather than
 * defended by an ordering.
 *
 * ## The two tables
 *
 * SEND. `stop` and `locked` are send unable to proceed and keep their own
 * surfaces, exactly as DROVE-254 left them: Stop is another ACTION, and a lock
 * with no surface reads as decoration rather than as a button refusing.
 * Everything else is NOTHING — a bare glyph on the bubble, at every length of
 * text, which is the second message.
 *
 * That is the row becoming consistent rather than gaining an exception. The
 * mic at rest was already bare (DROVE-254), so a bare send makes the trailing
 * pair one vocabulary instead of a circle beside a glyph. The measurement was
 * already taken when the mic lost its own disc: a foreground glyph on the
 * bubble is 10.862:1 on dark and 18.819:1 on light, both miles over the 3:1
 * floor, which is why the circle was spendable at all.
 *
 * DROVE-254's argument for KEEPING send's disc was that "send has no ON state
 * to spend one on". That is still true and it is no longer the question. The
 * disc was never bought by send's states; it was inherited from the `+` at the
 * other rim (DROVE-214, "one circle, so one value"). Clay has now looked at the
 * pair and asked for the glyph. What survives of DROVE-214 is the RULE — one
 * circle, one value — and it survives with two members instead of three: the
 * `+` and the audio button are discs, the two voice-and-send glyphs are not.
 *
 * THE MIC. Unchanged from DROVE-254 and re-argued now that it sits beside a
 * PERMANENT send rather than replacing it. Nothing at rest, the recording disc
 * the moment it is open, held or latched (DROVE-210).
 *
 * It reads BETTER next to a permanent send, not worse, and the reason is what
 * the disc was doing in the first place. DROVE-254 spent the mic's circle to
 * give one slot "a visible off and on", because that slot changed what it WAS.
 * The slot does not change any more, so the disc has stopped paying for
 * identity and pays only for state: the one control on the row that can be
 * OPEN is the one control that grows a surface when it is. That is DROVE-215's
 * rule on the fill axis, and it is now the only thing the fill says.
 *
 * The pair also cannot be confused while the mic is live, which is the thing to
 * check when two glyphs sit together with no circles: an open mic is a filled
 * red disc beside a bare white arrowhead, which differ in surface, in colour
 * and in shape at once.
 *
 * NO NEW HUE AND NO NEW GREY. Every surface below is one the row already had.
 *
 * WHAT THIS COSTS THE ROW, because a second permanent control is not free and
 * the ticket asks for it in writing. One 36pt object and one 6pt gap, which is
 * 42pt off the model name's budget at every width. The table, the widths that
 * still hold and the width that does not are in `sessionPillLabel.ts`.
 */
export type ComposerSendSurface = 'stop' | 'locked' | 'none';

/**
 * Send's surface. Stop first, for DROVE-254's reason: a blank composer on a
 * non-steerable agent is both blocked and abortable, and it must not look
 * locked.
 */
export function composerSendSurface(state: {
    /** The agent is working on an empty composer, so the button is Stop. */
    stop: boolean;
    /** The gate refuses this send. */
    blocked: boolean;
}): ComposerSendSurface {
    if (state.stop) return 'stop';
    if (state.blocked) return 'locked';
    return 'none';
}

export type ComposerMicSurface = 'recording' | 'none';

/** The mic's surface: nothing, until the mic is actually open (DROVE-210). */
export function composerMicSurface(state: {
    /** Held or latched right now. */
    live: boolean;
}): ComposerMicSurface {
    return state.live ? 'recording' : 'none';
}

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
 * The arc's whole luminance range is bounded by those two: the needle is
 * 14.74:1 off the capsule on dark and 13.80:1 on light, and the arc splits
 * that room. 2.5:1 and 5.6:1 is where it is split. Those numbers moved when
 * DROVE-254 made the capsule an opaque fill instead of glass. The alphas did
 * not, because they were chosen against a near-black and a near-white surface
 * and that is still what they sit on.
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
 * on light lifts it by 42%, and the translucent track follows it to 2.52:1
 * where a hex tuned for the resting fill would have collapsed.
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
 * measure 2.50:1 on dark and 2.46:1 on light, and 2.37:1 at the worse of the
 * two materials the gauge is drawn on.
 */
export const COMPOSER_GAUGE_TRACK_FLOOR = 2.3;

/**
 * And the other side of it: how far the needle has to sit off the arc.
 *
 * WCAG's 3:1 would be enough to SEE the needle. This is higher because seeing
 * it is not the job: the needle is the value (DROVE-141) and the arc is the
 * scale behind it, so the two marks have to rank, not merely differ. Asserted
 * to be greater than the track's floor, which is the ranking written down.
 * The shipped values measure 5.90:1 on dark and 5.61:1 on light, 5.02:1 at the
 * worse material.
 */
export const COMPOSER_GAUGE_NEEDLE_FLOOR = 4.5;

/**
 * THE TWO HAIRLINES INSIDE IT ARE KEPT, and re-measured against the new fill
 * (DROVE-254).
 *
 * The question the ticket asks is whether a capsule that reads properly still
 * needs them. It does, and the reason is the one that settled the fill: the
 * dividers are what keep 154pt of one tone from reading as a slab, and they
 * are what say the three segments are three separate presses rather than one
 * long button. Removing them would also hand the model's name 2pt it has not
 * asked for and move a budget `sessionPillLabel.ts` measured (`dividers: 2`).
 *
 * They needed the same treatment as the fill. `theme.colors.glass.divider` is
 * a hairline chosen to separate two list rows: over the new fill it measures
 * 1.28:1 on dark and 1.20:1 on light, which is DROVE-227's gauge track all
 * over again, a mark that is not dim but absent.
 *
 * SO A DIVIDER IS THE GAUGE'S TRACK, at the same strength, derived from it
 * rather than restated. Both are structure drawn at reduced weight on the same
 * surface, so the capsule holds exactly two tones: the foreground for the
 * glyphs, the foreground at the hairline alpha for everything that is only
 * scaffolding. A third value would be a third thing to read and there is no
 * third thing being said. Shape keeps them apart: a straight 20pt rule against
 * a curved arc, and the ranking DROVE-227 pinned (needle over track) is
 * untouched, because a divider is never read against the needle.
 */
export function composerCapsuleDivider(dark: boolean): string {
    return composerGaugeTrack(dark);
}

/**
 * How far a hairline inside the capsule has to sit off the fill.
 *
 * The gauge track's floor, by construction and not by coincidence: it is the
 * same kind of mark on the same surface, and DROVE-227 already argued why a
 * hairline needs more separation than a 36pt disc does. It measures 2.50:1 on
 * dark and 2.46:1 on light, and 2.37:1 under the wash a pressed segment takes.
 */
export const COMPOSER_CAPSULE_DIVIDER_FLOOR = COMPOSER_GAUGE_TRACK_FLOOR;

/**
 * `theme.colors.glass.backgroundSubtle`, the wash a control takes while its
 * picker is open or a drag is running (`controlOpen`).
 *
 * Here because it is a material the gauge is really drawn on, not decoration:
 * on light it is a 42% white lift, easily enough to strand a track tuned only
 * against the resting fill.
 */
export const COMPOSER_CONTROL_OPEN_WASH = {
    dark: 'rgba(255, 255, 255, 0.07)',
    light: 'rgba(255, 255, 255, 0.42)',
} as const;

/**
 * Every material the effort gauge is drawn on, as layer stacks over the chat.
 *
 * TWO SINCE DROVE-254, WHERE THERE WERE THREE. The capsule is an opaque fill
 * rather than glass, so the gauge sits on the same surface at rest whatever
 * the device can draw: there is no separate fallback material for a phone with
 * no Liquid Glass, and no chat backdrop showing through. The wash a pressed
 * segment takes is the only thing that still moves it.
 *
 * The stacks are still expressed over a backdrop, because that is what
 * `composerGaugeContrast` takes and because the arithmetic then says the thing
 * out loud: an opaque first layer makes the backdrop irrelevant, which is the
 * whole reason a fill was chosen over a tint.
 */
export function composerGaugeMaterials(dark: boolean): Readonly<Record<string, readonly string[]>> {
    const fill = composerSessionCapsuleFill(dark);
    return {
        capsule: [fill],
        open: [fill, dark ? COMPOSER_CONTROL_OPEN_WASH.dark : COMPOSER_CONTROL_OPEN_WASH.light],
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
 * OPAQUE, WHICH IS DROVE-254's RULE AND NOT A STYLE CHOICE. That ticket found
 * the session capsule was a `UIGlassEffect` nested inside the bubble's own, so
 * the platform never added the tint the contrast model assumed: a translucent
 * surface inside another glass surface has no single value, and there is
 * nothing a spec can hold. Every fill on this row is an opaque hex for that
 * reason, this one included, and `colorAlpha` is asserted rather than assumed.
 *
 * IT IS NOT A FACE ON SEND'S OR THE MIC'S TABLE. Those are
 * `composerSendSurface` and `composerMicSurface`, and read-aloud is neither;
 * the three controls sit side by side and are different buttons. The audio-out button has its own table and has since
 * DROVE-236: `audioOutButton`'s `fill` in composerAudioOut.ts, which is where
 * this face is added rather than at a call site.
 *
 * WHAT THIS DOES NOT DO. It does not colour anything else. The `+`, send at
 * rest, the padlock, the needle, the model's name and the mic are the
 * foreground exactly as DROVE-215 left them, and the mic still takes no circle
 * until it is open, which is DROVE-254's and is untouched here. This is one
 * hue on one state.
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

/**
 * READ-ALOUD'S FOUR FACES, AS A CAPSULE SEGMENT RATHER THAN A DISC
 * (DROVE-284).
 *
 * Clay: "Add the reading mode whatever thing to the group and keep it all on
 * the same row as send and +." The control moved into the session capsule and
 * its state table did not move with it — `audioOutButton` in
 * composerAudioOut.ts still decides which of the four faces is drawn, and this
 * only says what colour that face is.
 *
 * WHAT CHANGED IS THE OFF FACE AND NOTHING ELSE. On the row it wore the
 * in-field disc at rest, because DROVE-266 ruled that a bare glyph between two
 * discs reads as decoration rather than as a button. Inside the capsule the
 * question does not arise: the padlock, the bolt and the gauge all sit on the
 * capsule's own fill with nothing of their own, and a fifth surface among them
 * would be the odd object rather than the button. So off is `null` — no fill —
 * and the three live faces keep the colours DROVE-258 and DROVE-236 measured.
 *
 * THE ACCENT IS THE PALETTE'S, NOT `theme.colors.radio.active`. The disc took
 * the theme's blue directly, which quietly sidestepped DROVE-264's finding:
 * that value is `#0A84FF` and the palette's accent is `#0A8FFF`, eleven points
 * of green lifted precisely so the same hue can be a glyph on the bubble AND a
 * fill under a white glyph. Read-aloud's reading face is the second of those
 * two jobs by name, so it belongs to the measured value.
 */
export function composerAudioOutFill(dark: boolean, fill: AudioOutFill): string | null {
    if (fill === 'none') return null;
    const palette = composerControlPalette(dark);
    if (fill === 'paused') return composerPausedFill(dark);
    if (fill === 'recording') return palette.recording;
    return palette.accent;
}

/**
 * And the glyph on it: `composerFillTint`'s answer over whichever fill is
 * there, the row's foreground when there is none.
 *
 * One rule rather than a ternary at the call site, which is what shipped the
 * bug DROVE-258 wrote about: white on the dark theme's amber measures about
 * 2:1, so a copied "always the primary tint" would draw a pause glyph you
 * cannot read on the disc whose whole job is to make pause readable.
 */
export function composerAudioOutTint(dark: boolean, fill: AudioOutFill): string {
    const bed = composerAudioOutFill(dark, fill);
    return bed ? composerFillTint(bed) : composerGlyphColour(composerControlPalette(dark));
}

/**
 * THE FILL, HANDED TO A REAL GLASS BUTTON AS ITS TINT (DROVE-266).
 *
 * Clay, for the second time: "stop doing your custom buttons shouldn't they
 * just be smaller liquid glass buttons". They should, and they are now
 * `GlassChromeButton` at the composer's size, which is the same control the
 * header draws rather than a View coloured to look like one. What that changes
 * for THIS file is where the fill is spent: it used to be a `backgroundColor`
 * on a plain view, and it is now `UIGlassEffect.tintColor` on the button's own
 * effect.
 *
 * WHY THAT DOES NOT REOPEN DROVE-254, which is the one question this function
 * exists to answer. That ticket's finding is precise and it is about a
 * TRANSLUCENT tint: `CHROME_GLASS_TINT` inside the bubble's own glass had
 * nothing left to refract, so what landed on screen depended on a backdrop the
 * model could not see, and light modelled at 1.222:1, under the floor. An
 * OPAQUE tint is not that case. Opacity is exactly the property that makes the
 * backdrop irrelevant, which is why DROVE-254 reached for an opaque fill in the
 * first place, and whether that one value is painted by a View or handed to the
 * effect it is the same value and the same measurement.
 *
 * SO THE GUARANTEE IS NOT REPLACED, IT IS ENFORCED ONE STEP EARLIER.
 * `colorAlpha === 1` on the fills is untouched and everything that depends on it
 * still holds. This adds the step that was missing when DROVE-254's bug got in:
 * the capsule failed because a translucent tint reached `tintColor` and nothing
 * refused it. Now nothing can, because this is the only way to that prop and it
 * throws.
 *
 * WHAT STILL NEEDS A DEVICE, said here rather than left to be found. That UIKit
 * renders a fully opaque `tintColor` at full weight. If it renders it at a
 * partial weight w, the drawn fill is `w * tint + (1 - w) * bubble` and the
 * separation falls with it: from 1.36:1 at w = 1, anything under about w = 0.96
 * drops the capsule and the discs below `COMPOSER_DISC_SEPARATION_FLOOR`. That
 * is a build to run, not a number to assume.
 */
export function composerGlassTint(fill: string): string {
    if (colorAlpha(fill) !== 1) {
        throw new Error(
            `composer glass tint must be opaque (DROVE-254): ${fill} is not. `
            + 'A translucent tint inside the bubble’s own glass has no single '
            + 'value to measure, which is the fault this refusal exists to stop '
            + 'coming back.',
        );
    }
    return fill;
}
