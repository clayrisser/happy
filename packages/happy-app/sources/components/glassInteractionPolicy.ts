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
