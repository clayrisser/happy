/**
 * How a mic is being held open (DROVE-30, DROVE-74).
 *
 * `hold` is push-to-talk: the finger is on the button and lifting it is the
 * signal that the sentence is over, so the mic cannot be left on by mistake.
 * `latch` is tap on, tap off: it suits long dictation and a phone in a
 * pocket, which is exactly when a finger cannot stay on a button, and it is
 * the one that can be left hot, which is why a latch has an idle auto-stop
 * and an unmissable indicator.
 *
 * Both live on ONE button: a press opens the mic as `hold`, and a lift inside
 * the tap window turns it into `latch` (see micButton.ts).
 */
export type MicMode = 'hold' | 'latch';

/**
 * A latched dictation mic stops itself after this long with no change to the
 * live transcript. Fifteen seconds is longer than a pause to think and
 * shorter than a phone forgotten on a desk. Stated on DROVE-30. Hold has no
 * timeout: a finger is on the button.
 */
export const DICTATION_LATCH_IDLE_MS = 15_000;
