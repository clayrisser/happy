export type BubblePressablePlatform = 'native' | 'web';

/**
 * Whether `BubblePressable` draws its own scale.
 *
 * `nativeGlassPress` is the DROVE-169 clause: inside a surface that has asked
 * `UIGlassEffect` for its own press response, the platform brightens and
 * deforms the material under the finger and lets the rest of the capsule
 * answer with it. A `withSpring` scale on top of that is a second, worse
 * animation of the same press, and on the material it scales the effect view
 * itself, which renders as a refractive blob rather than a control reacting.
 * So the platform wins and the spring stands down.
 */
export function resolveBubblePressableFeedback({
    platform,
    scaleFeedback = true,
    nativeGlassPress = false,
}: {
    platform: BubblePressablePlatform;
    scaleFeedback?: boolean;
    nativeGlassPress?: boolean;
}): { animateScale: boolean } {
    return { animateScale: platform !== 'web' && scaleFeedback && !nativeGlassPress };
}
