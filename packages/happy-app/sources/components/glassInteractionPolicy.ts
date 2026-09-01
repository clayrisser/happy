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
 *
 * ONE ARGUMENT, AND THE SECOND ONE IS GONE (DROVE-328). DROVE-266 added a
 * `pressTarget` flag here so the composer card could turn `isInteractive` on
 * and keep `overflow: 'hidden'`, on the theory that nobody presses the card:
 * that a surface which merely HOSTS pressed controls wants the lensing under a
 * finger and no swell, and that its corners were what rounded the field and the
 * attachment strip. Clay, from his phone with the bubble mid-press: "This
 * behaves like Liquid Glass but when it zooms its borders are clipped." The
 * theory was wrong on both counts. `isInteractive` is a property of the effect
 * VIEW, and the view answers a touch on anything mounted in its `contentView`,
 * the field and the capsule included, by deforming the whole material; there
 * is no "host without being a target" for it to be. And on the material the
 * card was rounding nothing: the field is transparent on iOS, the strip clips
 * itself inside the 9pt inset, and `composerBubbleLayout.spec.ts` measures
 * every disc clear of the drawn corner. So the flag's only effect was to put
 * back, on the one surface 266 also made swell, the exact clip this function
 * exists to refuse. 266 said "NOT VERIFIED ON A DEVICE"; the photo is the
 * device, and the flag is deleted rather than defaulted so no caller can reach
 * for it again.
 */
export function getGlassSurfaceOverflow(drawsNativeGlass: boolean): 'visible' | 'hidden' {
    return drawsNativeGlass ? 'visible' : 'hidden';
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
 * WHAT THE COMPOSER'S CONTROLS ARE MADE OF, AND WHY THAT ANSWERS THE TICKET
 * (DROVE-266).
 *
 * Clay, twice, the second time as a correction: "you can make the buttons in
 * the speech bubble a little bigger and also make them behave like liquid glass
 * buttons I already told you that stop doing your custom buttons shouldn't they
 * just be smaller liquid glass buttons".
 *
 * THE FIRST ANSWER WAS THE WRONG SHAPE AND IS GONE. It turned
 * `UIGlassEffect.isInteractive` on for the BUBBLE — which was right, and stays —
 * and then reasoned that only the controls showing bare glass could benefit,
 * because an opaque fill has nothing under it to lens. A function,
 * `resolveComposerPressResponse`, encoded that split and handed the other four
 * controls a hand-rolled `withSpring` scale and an `opacity: 0.7`.
 *
 * The lensing argument is true and it answers a question nobody asked. What
 * those controls lacked was not lensing, it was BEING A BUTTON: they were
 * `View`s with a `backgroundColor` wrapped round a `Pressable`, and a glass
 * button is a `UIVisualEffectView` that UIKit deforms, brightens, shadows and
 * springs on its own schedule. None of that arrives from a flag two levels up,
 * and none of it depends on seeing through the control. So the split was a
 * careful answer to the wrong question, which is what "stop doing your custom
 * buttons" was pointing at.
 *
 * WHAT REPLACES IT is smaller: the composer's discs are `GlassChromeButton` at
 * the composer's size, spending their opaque fill as `UIGlassEffect.tintColor`.
 * `ComposerControlButton.tsx` is the whole of it, and `GlassChromeButtonContent`
 * was already doing the right thing with the fade — down on the material, kept
 * off it — so there is nothing left for a policy function to decide.
 * `resolveComposerPressResponse` and its `ComposerControlSurface` type are
 * deleted rather than kept "just in case", because a rule with no caller is a
 * rule nobody maintains.
 *
 * TWO CONTROLS ARE STILL NOT GLASS BUTTONS, AND BOTH FOR REASONS THAT ARE ABOUT
 * THEM RATHER THAN ABOUT THE MATERIAL.
 *
 *   send at rest,      They have no surface. DROVE-264 took send's circle off
 *   the mic at rest    and DROVE-254 took the mic's, on Clay's standing
 *                      instruction, so giving either a glass button would BE
 *                      the circle he removed. They are bare glyphs on the
 *                      bubble, the bubble is interactive, and the press they
 *                      draw is already the platform's. Their filled faces —
 *                      Stop, the gate's lock, an open capture — are glass
 *                      buttons like everything else.
 *   the session        DROVE-254 was filed about THIS control being a
 *   capsule            `UIGlassEffect` nested inside the bubble's own, and the
 *                      fix was to stop it being one. Re-glassing it is the
 *                      single move that would re-create that ticket. It would
 *                      also cost the open segment's wash its clip, because an
 *                      interactive surface must not clip (`getGlassSurfaceOverflow`)
 *                      and that clip is what rounds the wash to the capsule's
 *                      ends. It keeps the fade, which is the only response an
 *                      opaque capsule can have, and `ComposerSessionControls`
 *                      says so at the point it draws it.
 *
 * AND THE CONTRAST GUARANTEE IS NOT TOUCHED. DROVE-254's finding is about a
 * TRANSLUCENT tint inside the bubble's glass, which has no single value to
 * measure. Every fill on this row is still an opaque hex, `colorAlpha === 1` is
 * still asserted on every one of them, and `composerGlassTint` now REFUSES a
 * translucent value on the way to `tintColor` — which is the step that was
 * missing when DROVE-254's bug got in. The one thing that needs a device is
 * whether UIKit renders an opaque tint at full weight; the arithmetic for what
 * happens if it does not is on `composerGlassTint`.
 */
