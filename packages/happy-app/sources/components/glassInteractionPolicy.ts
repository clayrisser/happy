/**
 * Whether a glass surface asks UIKit for its own press behaviour (DROVE-169).
 *
 * Clay: "I'm still waiting for my buttons to have the Liquid Glass animations
 * to them like the DEFAULT behavior". They were not there because this
 * function used to hard-return `false`, so `UIGlassEffect.isInteractive` was
 * never set and the effect was drawn as a static surface. Two hand-written
 * springs stood in for it, a scale on `MobileGlassSurface` and another in
 * `BubblePressable`, plus an `opacity: 0.6` pressed style on
 * `GlassChromeButton`. All three imitated a response the platform draws
 * better: the real one brightens and deforms the material under the finger and
 * lets the rest of the capsule answer with it, which a transform on the whole
 * view cannot do.
 *
 * The old comment justified the suppression as keeping the native view from
 * "competing for responder ownership". That is not what `isInteractive` does.
 * It is a property of the EFFECT (`UIGlassEffect.isInteractive`), applied to
 * the `UIVisualEffectView` that `GlassView` owns; React Native children mount
 * into that view's `contentView` and keep the gesture. The press is still
 * dispatched by the `Pressable`; only the drawing changes hands.
 *
 * Kept pure so the gate is testable. The caller supplies the availability
 * check rather than this module reaching for the native module, which is also
 * what keeps it importable from a test runner with no iOS bridge.
 */
export function getNativeGlassInteractivity(
    interactive: boolean,
    glassApiAvailable: boolean,
): boolean {
    return interactive && glassApiAvailable;
}

/*
 * `shouldUseExpoNativeSettingsMenu` lived here and is gone (DROVE-242).
 *
 * It sent iPhone and iPad to a SwiftUI menu for the composer's mode and model
 * while every other platform used the sheets. Clay, with one of those menus
 * open: "Shouldn't these show in sheets like the effort does". The composer has
 * no native menu left, so there is no platform left to ask. Which sheet a
 * picker opens on is `composerPickerSheetOpen` in composerPicker.ts, decided
 * from the picker and the composer's width and nothing else.
 *
 * This is a NARROWER removal than it looks: `NativeSettingsMenu` itself is
 * untouched and still what the home dock, the view menu and the session row
 * use. What went is the composer's split between a menu and a sheet.
 */

/**
 * Whether a glass surface may draw outside its resting frame (DROVE-202).
 *
 * Clay, on the header: "why does the title in the center not grow when you
 * push on it", then "it's not that it's scaling up inside, it's that the size
 * doesn't grow". DROVE-169 turned `isInteractive` on and the effect did start
 * responding, so what was left was a layout fault rather than an effect one.
 *
 * WHAT WAS CLIPPING IT. `GlassView` is an `ExpoView`, and `ExpoView` is a
 * Fabric `RCTViewComponentView`, which sets `clipsToBounds` straight from the
 * `overflow` style (`RCTViewComponentView.mm`, `getClipsContentToBounds`). The
 * `UIVisualEffectView` carrying the `UIGlassEffect` is a subview pinned to that
 * host view's bounds, so `overflow: 'hidden'` on the glass makes UIKit clip the
 * press swell at the resting frame. The glass still grows; you just cannot see
 * it leave. What is left on screen is the content getting bigger inside a
 * rectangle that does not move, which is exactly what Clay described.
 *
 * Eight chrome styles carried that `overflow: 'hidden'`, so this is decided
 * here and applied LAST in the primitive rather than left to each caller: a
 * consumer style cannot put the clip back. The same flag also cost those
 * controls their drop shadow, because `masksToBounds` clips a layer's own
 * shadow as well as its subviews.
 *
 * Off the material the flat fallback still clips, because there it is the only
 * thing rounding the corners of what it holds.
 */
export function getGlassSurfaceOverflow(
    drawsNativeGlass: boolean,
    /**
     * Whether the surface is the thing being PRESSED, or merely the host of
     * something that is (DROVE-266).
     *
     * DROVE-202's finding is about a surface that SWELLS: a header button, a
     * FAB, a chrome capsule. `clipsToBounds` pins the swell at the resting
     * frame, so what you see is the content growing inside a rectangle that
     * does not move, which is what Clay described. Every caller then was that
     * kind of surface, so the distinction cost nothing and was not drawn.
     *
     * The composer card is the other kind. Nobody presses the card; it holds
     * controls that are pressed, and what interactive glass is wanted for there
     * is the LENSING under a finger on a child, which happens inside the card's
     * own bounds and asks for no swell. That card also has to keep clipping —
     * its rounded corners are what round the text field and the attachment
     * strip inside it — so conflating the two would have made asking for the
     * platform's press response cost the composer its shape.
     *
     * Defaults to true, which is every pre-DROVE-266 caller's behaviour
     * unchanged.
     */
    pressTarget = true,
): 'visible' | 'hidden' {
    return drawsNativeGlass && pressTarget ? 'visible' : 'hidden';
}

/**
 * Whether a control inside a glass surface draws its own pressed state.
 *
 * The companion to `getNativeGlassInteractivity`: where the material is
 * drawing the press, a dimmed glyph on top of it is another imitation of a
 * response the platform already gives, and it is the one that reads as the
 * CONTENT reacting instead of the control. Where there is no material it is
 * the only pressed state there is, so it stays.
 */
export function shouldDrawPressedFallback(
    nativeGlassPress: boolean,
    pressed: boolean,
    disabled?: boolean | null,
): boolean {
    return !nativeGlassPress && pressed && !disabled;
}

/**
 * WHY THE COMPOSER'S CONTROLS ARE NOT MADE OF GLASS, AND WHAT THEY GET INSTEAD
 * (DROVE-266).
 *
 * Clay, with the composer row photographed: "shouldn't all these buttons have
 * the Liquid Glass behavior". The shot is a `+` disc, the session capsule, a
 * filled blue speaker disc and a bare mic glyph. The discs are flat fills. They
 * sit on glass; they are not glass.
 *
 * The request splits into two questions with two different answers, and running
 * them together is what makes the ticket look like a contradiction.
 *
 * ## 1. The FILL cannot be glass, and this is a property of the material
 *
 * DROVE-254 established that the composer bubble is a `UIGlassEffect` and that
 * the session capsule was a SECOND one nested inside it. A glass effect draws
 * by sampling what is behind its own view; when that is already a glass effect
 * over the same chat, the inner one has nothing left to refract that its host
 * has not refracted already. Modelled as a tint it composited to 1.58:1 on dark
 * and 1.22:1 on light off the bubble — light failing outright, dark passing the
 * arithmetic and still blending on the phone, because the arithmetic assumes
 * the platform adds the tint and the platform does not. A translucent surface
 * inside another glass surface has no single value, so there is nothing a spec
 * can hold. That is why every fill on the row is an opaque hex and why
 * `colorAlpha === 1` is asserted rather than assumed.
 *
 * THE OBVIOUS ESCAPE IS `UIGlassContainerEffect` AND IT IS THE WRONG DOOR.
 * `expo-glass-effect` ships it as `GlassContainer`, and Apple's own guidance
 * points at it whenever glass has to sit near glass. But a container does not
 * un-nest anything: it MERGES the shapes inside it, so nearby glass blends into
 * its neighbours as one flowing surface. Merging is the exact effect Clay filed
 * DROVE-254 about — "this blends in which is annoying" — so reaching for it
 * would answer this ticket by re-creating the last one. It is the right tool
 * for a row of glass buttons floating over content, and the composer's controls
 * are not that: they are inside a glass card.
 *
 * SO THE OPAQUE FILL STANDS, and the contrast guarantee needs nothing to
 * replace it, because nothing about the fill changes. This is the branch the
 * ticket names second — "these controls stay opaque and the Liquid Glass answer
 * is in their INTERACTION" — reached by measurement rather than by preference.
 *
 * ## 2. The BEHAVIOUR is genuinely missing, and it is one unset prop
 *
 * "Behavior" is worth taking literally, and taken literally Clay is right.
 * Liquid Glass is not only a material: `UIGlassEffect.isInteractive` is what
 * makes it lens and shift under a finger, and the composer never asks for it.
 * `AgentInput.tsx` renders its `MobileGlassSurface` with no `interactive` prop,
 * so `getNativeGlassInteractivity` returns false, `GlassPressProvider` publishes
 * false, and every control inside falls back to `BubblePressable`'s hand-rolled
 * `withSpring` scale plus an `opacity: 0.7` at each call site.
 *
 * Those are precisely the imitations DROVE-169 removed, still running, on the
 * one surface Clay is looking at. The new-session screen's send button already
 * passes `interactive`; the chat composer was the omission. So the fix is to
 * ask the platform for the response rather than to draw a better fake.
 *
 * ## 3. WHICH controls that can actually reach, which is the honest part
 *
 * An interactive glass effect lenses THE MATERIAL. A control whose own opaque
 * fill covers the material at the point of touch has nothing to lens: the
 * platform response happens underneath a view you cannot see through. So the
 * answer to "all these buttons" is not all of them, and `resolveComposerPressResponse`
 * below is that distinction rather than a comment asking people to remember it.
 *
 *   bare glyph on the bubble   send, and the mic at rest (DROVE-254, DROVE-264).
 *                              The material is exposed under the finger, so the
 *                              platform draws the press and the imitation stands
 *                              down.
 *   opaque fill                the `+`, the session capsule, the audio disc, the
 *                              mic once it is open. The fill covers the glass,
 *                              so there is no lensing to see and the 0.7 fade is
 *                              the only press response available. Keeping it is
 *                              not a consolation prize; dropping it would leave
 *                              those four with no press state at all.
 *
 * That is a real limit rather than a shortfall in the wiring, and it follows
 * from the same fact as part 1: these controls REPLACE the material instead of
 * standing on it. A row where the glass reacts under the two controls that show
 * it and the other four fade is the truthful drawing of what is underneath.
 *
 * ## 4. The blue read-aloud disc, checked against "no coloured icons"
 *
 * The ticket asks whether the active state could be carried by the glass
 * reacting instead. It cannot, twice over. The disc is an opaque fill, so there
 * is no glass under it to react; and a press response lasts as long as a finger
 * while read-aloud lasts as long as it is reading, so a transient cannot carry a
 * state you leave running and walk away from. It also does not breach the rule:
 * DROVE-215 bars colour on a control that HOLDS a value, and reading aloud is
 * something happening right now, which is the one thing that earns a hue. The
 * ICON on it stays white (`composerFillTint`). So the affordance is not dropped
 * and no rule is bent.
 */
export type ComposerControlSurface = 'bare' | 'filled';

export interface ComposerPressResponse {
    /** The platform's own glass response draws this press. */
    nativeGlass: boolean;
    /** This control draws the 0.7 fade, because nothing else will. */
    fade: boolean;
}

/**
 * Which press response a composer control gets, from the two facts that decide
 * it: whether the surface it sits in is drawing interactive glass at all, and
 * whether this control's own fill covers that glass.
 *
 * Exactly one of the two is always true for an enabled control, which is the
 * property worth having: there is no state where a press draws nothing, and
 * none where it draws two responses to one touch.
 */
export function resolveComposerPressResponse({
    surfaceDrawsNativeGlass,
    control,
    disabled = false,
}: {
    /** The bubble asked for `UIGlassEffect.isInteractive` and got it. */
    surfaceDrawsNativeGlass: boolean;
    control: ComposerControlSurface;
    disabled?: boolean | null;
}): ComposerPressResponse {
    if (disabled) return { nativeGlass: false, fade: false };
    const nativeGlass = surfaceDrawsNativeGlass && control === 'bare';
    return { nativeGlass, fade: !nativeGlass };
}
