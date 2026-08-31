/**
 * Is the app in front of the user? (DROVE-189.)
 *
 * One line, in its own file, because backgroundAudio.ts imports react-native
 * and drover-speech and neither of those can be loaded under vitest — and this
 * is the one decision in that file worth pinning, since getting it wrong in
 * either direction is a bug you only find in a pocket.
 *
 * `inactive` is NOT the foreground: it is the shade coming down, a call
 * banner, the app switcher. Treating it as background means the audio session
 * is held through it, which is right, because what follows `inactive` is
 * usually `background`.
 */
export type ForegroundState = 'active' | 'background' | 'inactive' | 'unknown' | 'extension';

export function isForeground(state: ForegroundState | string): boolean {
    return state === 'active';
}
