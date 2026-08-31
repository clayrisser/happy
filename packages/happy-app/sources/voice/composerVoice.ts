/**
 * What the composer does to the voice (DROVE-162).
 *
 * Clay: "And don't stop talking when I'm typing." He is usually typing the
 * next thing WHILE listening to the current reply, which is the entire point
 * of read-aloud on a phone, and every keystroke used to call
 * `readAloud.interrupt('typed')` — which cut the sentence in flight, moved the
 * position to the end of the timeline and released the audio session. One
 * character was enough to end the reading for good.
 *
 * The rule is one line long and the reason it lives in its own file is that
 * "nothing happens" is not testable inside a React callback: a spec can prove
 * that `keystroke` reaches the reader and that `focus` and the keyboard do
 * not, only if there is somewhere for all four to arrive.
 *
 * What is deliberately NOT here: the microphone. Holding the mic still stops
 * reading and hands the audio session back (DROVE-143), because a recogniser
 * genuinely cannot share the route with a synthesiser. A keyboard can.
 */
export interface ComposerVoiceTarget {
    /** Stop every capture, keep reading (DROVE-162). */
    userTyped(): void;
}

export type ComposerVoiceEvent =
    /** The composer took focus. The keyboard is on its way up. */
    | 'focus'
    /** A character was typed, deleted or pasted by the user. */
    | 'keystroke'
    /**
     * Dictation wrote the composer (DROVE-74). It arrives through the same
     * onChangeText as a keystroke and must not read as one, or the mic would
     * be told to stop by its own transcript.
     */
    | 'dictation-write'
    /** The software keyboard appeared or was resized. */
    | 'keyboard-shown'
    /** The keyboard went away, by the Done key or a tap outside. */
    | 'keyboard-hidden'
    /** The composer lost focus. */
    | 'blur';

/**
 * Apply a composer event to the voice. Exactly one of them touches it.
 *
 * Focus, blur and the keyboard moving are layout, not intent: none of them
 * says the answer being read is no longer wanted, so none of them reaches the
 * reader at all.
 */
export function composerVoiceEvent(target: ComposerVoiceTarget, event: ComposerVoiceEvent): void {
    if (event !== 'keystroke') return;
    target.userTyped();
}
