import type { SpeakOptions, SpeechEngine } from './readAloud';
import type { Speaker } from './speaker';

/**
 * One engine that speaks each sentence on exactly one device (DROVE-92).
 *
 * The read-aloud queue does not know there are two speakers; it hands over
 * sentences and stops. This picks a device per sentence, and when the pick
 * moves mid-reply (AirPods paired to the phone come off, the watch app
 * comes to the front) the device that was speaking is stopped before the
 * other starts, so a reply is never narrated twice at once.
 *
 * It is also where a reply is seen to BEGIN: the first sentence after an
 * idle stop. That is when the wrist gets its reply-start cue, whichever
 * device is about to speak.
 */
export interface RoutedSpeechDeps {
    phone: SpeechEngine;
    watch: SpeechEngine;
    /** Called per sentence; the choice may change between two of them. */
    pick: () => Speaker;
    /** Called once per reply, before its first sentence is spoken. */
    onReplyStart?: (speaker: Speaker) => void;
}

export function createRoutedSpeechEngine(deps: RoutedSpeechDeps): SpeechEngine {
    let current: Speaker | null = null;
    const engineFor = (speaker: Speaker) => (speaker === 'watch' ? deps.watch : deps.phone);

    return {
        async speak(text: string, options?: SpeakOptions) {
            const speaker = deps.pick();
            if (current === null) {
                deps.onReplyStart?.(speaker);
            } else if (current !== speaker) {
                await engineFor(current).stop();
            }
            current = speaker;
            // The wrist has no rate knob of its own, so it ignores the
            // catch-up scale and reads at its own speed (DROVE-108).
            return engineFor(speaker).speak(text, options);
        },
        async stop() {
            const was = current;
            current = null;
            if (was !== null) await engineFor(was).stop();
        },
    };
}
