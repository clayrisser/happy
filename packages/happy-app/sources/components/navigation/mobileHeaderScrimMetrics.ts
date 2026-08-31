/**
 * The header backdrop's numbers, pulled out of the component so a test can
 * read them (DROVE-180).
 *
 * DROVE-180 asks the header for the same treatment as the composer "wherever
 * it masks content today". Measured, it does not mask: `MobileHeaderScrim` is
 * a dim gradient over a live `BlurView`, so content behind it is blurred and
 * dimmed and never erased, which is already what the ticket asks the composer
 * to become. Nothing was inverted here. These constants moved out so that the
 * claim is asserted rather than asserted-about, and so the next person to
 * reach for the scrim's strength finds the reason it cannot go down: on the
 * header there is no card under the pill or the chevron, so the scrim IS the
 * layer carrying those glyphs, and it sits exactly on DROVE-153's fill floor.
 */

/** Multiplier on the gradient's own peak while nothing underlaps the header. */
export const MOBILE_STRONG_HEADER_SCRIM_RESTING_OPACITY = 0.80;
/** And once a message is actually sliding beneath it. */
export const MOBILE_STRONG_HEADER_SCRIM_UNDERLAP_OPACITY = 0.96;
export const MOBILE_HOME_SCRIM_OVERLAY_OPACITY = 1;

/** Alpha at the outer edge, before the ramp begins, per variant and theme. */
export const STRONG_TINT_PEAK_LIGHT = 0.76;
export const STRONG_TINT_PEAK_DARK = 0.55;
export const SUBTLE_TINT_PEAK_LIGHT = 0.55;
export const SUBTLE_TINT_PEAK_DARK = 0.40;

/**
 * How tall the ramp is, in points. Expressed as a length rather than a
 * fraction because the three scrims differ in height, and a fraction would
 * give each of them a different-looking edge. Longer than the composer's 12pt
 * rim ramp because the header has no capsule for a ramp to land on: here the
 * gradient IS the material's edge.
 */
export const MOBILE_HEADER_EDGE_RAMP_POINTS = 36;
