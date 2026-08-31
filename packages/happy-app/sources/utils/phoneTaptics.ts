/**
 * The phone's OWN taptic vocabulary (DROVE-75): the four one-shot feedbacks
 * components/haptics.ts exports and where each is used, so the demo screen can
 * fire them beside the wrist patterns and Clay can tell a composer tick from a
 * question buzz.
 *
 * Pure data. The player is `playPhoneTaptic` in components/haptics.ts, whose
 * switch is exhaustive over `PhoneTapticId`, so adding a row here without a
 * beat to play it fails to compile rather than silently doing nothing.
 */

export type PhoneTapticId = 'light' | 'selection' | 'confirm' | 'error';

export interface PhoneTapticSpec {
    id: PhoneTapticId;
    title: string;
    /** Where the app fires it, so the feel can be matched to a moment. */
    meaning: string;
}

export const phoneTaptics: readonly PhoneTapticSpec[] = [
    {
        id: 'light',
        title: 'Light tap',
        meaning: 'The composer: send, the mic, a picker opened, a model or suggestion picked.',
    },
    {
        id: 'selection',
        title: 'Selection tick',
        meaning: 'A picker moving one notch; the wrap toggle uses it.',
    },
    {
        id: 'confirm',
        title: 'Confirm',
        meaning: 'The success double-tap after a pick lands. The audio half is a spoken "Got it".',
    },
    {
        id: 'error',
        title: 'Error',
        meaning: 'Abort, or a send the composer refused.',
    },
];
