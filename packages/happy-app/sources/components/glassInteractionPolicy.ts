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

/** Expo owns menu presentation on native iOS; Mac, web, and Android keep their platform routes. */
export function shouldUseExpoNativeSettingsMenu(platform: string, runningOnMac: boolean): boolean {
    return platform === 'ios' && !runningOnMac;
}
