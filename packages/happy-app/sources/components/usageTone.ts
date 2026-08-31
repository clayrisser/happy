/**
 * ONE colour ramp for quota, on every surface that draws one (DROVE-231).
 *
 * Clay, on the strip: "Account is right aligned with the percentage and
 * changes color as it fills up." That is the same sentence he gave DROVE-230
 * about the quota sheet's bars, and the two must not answer it separately:
 * a strip that reads amber beside a sheet that reads green is the surface
 * telling Clay two things about one account.
 *
 * So the ramp lives here and both read it. It is not a new ramp. The
 * thresholds are `usageBarTone`'s, unchanged, and the hues are the ones
 * UsageAccountBars has drawn since DROVE-107. This only moves the mapping out
 * of that component so the strip can call the same function rather than
 * copying the switch. `usageBarTone` still owns where the bands sit; this owns
 * what a band looks like.
 *
 * DIRECTION. DROVE-230 has the ramp FILLING as usage is consumed and warming
 * toward the limit, which reverses the old show-what-is-left reading. Nothing
 * here has a direction: it takes headroom LEFT, which is the direction the
 * underlying windows report in, and the fill direction is `usageBarFraction`'s
 * business. That is deliberate. A colour that depended on a display setting
 * would mean the same account looked healthy or burnt depending on a toggle.
 *
 * DROVE-230 owns the thresholds. If that lane moves a band, it moves
 * `usageBarTone` and both surfaces follow; there is nothing to update here.
 */
import type { UsageBarTone } from './agentInputUsage';

/** The one theme shape this needs, so a spec can call it without unistyles. */
export interface UsageToneTheme {
    dark: boolean;
    colors: { warningCritical: string; success: string; textSecondary: string };
}

/**
 * The fill and text colour for a tone.
 *
 * `low` is a literal rather than `theme.colors.warning`, which is the note
 * UsageAccountBars carried and it is still true: the theme's own `warning` is
 * grey, and grey is what "never measured" looks like on these surfaces.
 */
export function usageToneColor(tone: UsageBarTone, theme: UsageToneTheme): string {
    switch (tone) {
        case 'critical':
            return theme.colors.warningCritical;
        case 'low':
            return theme.dark ? '#FF9F0A' : '#FF9500';
        case 'ample':
            return theme.colors.success;
        default:
            return theme.colors.textSecondary;
    }
}
