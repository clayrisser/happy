/**
 * Counting two taps by hand (DROVE-235).
 *
 * `Gesture.Tap().numberOfTaps(2)` is the right tool wherever a View can be
 * wrapped, and CodeWrapToggle uses it. Two places cannot take a View:
 *
 *   - the web, where react-native-web drops onDoubleClick and MarkdownView
 *     keeps gesture-handler off that path so text stays selectable;
 *   - a sentence run, which is a `Text` inline inside another `Text`. A
 *     GestureDetector renders a View, and a View in the middle of a paragraph
 *     breaks the line the sentence sits on. `Text.onPress` is the only press
 *     that survives there, and it has no tap count.
 *
 * So both count presses against a window instead. The decision is here, with
 * no React and no clock of its own, so it can be tested rather than mounted.
 */

/** How long a first tap stays pending. Matches the native recogniser's delay. */
export const doubleTapWindowMs = 350;

/** When the first tap of a possible pair happened, or null for none pending. */
export type DoubleTapState = number | null;

/**
 * One press. `fired` is true when it completed a pair.
 *
 * A press outside the window is not a failure, it is the first tap of the
 * next pair, so a slow double tap becomes a fresh start rather than nothing.
 * Firing clears the pending tap, so three presses fire once and four fire
 * twice.
 */
export function pressDoubleTap(
    pendingSince: DoubleTapState,
    now: number,
    windowMs: number = doubleTapWindowMs,
): { fired: boolean; pendingSince: DoubleTapState } {
    if (pendingSince !== null && now - pendingSince < windowMs) {
        return { fired: true, pendingSince: null };
    }
    return { fired: false, pendingSince: now };
}
