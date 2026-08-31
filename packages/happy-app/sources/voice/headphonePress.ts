/**
 * What a headphone press MEANS (DROVE-225).
 *
 * Clay, with the phone in his pocket: "on my headphones, how to trigger that
 * from my headphones, push to talk". Read-aloud already speaks into his ears;
 * this is the other half, talking back without taking the phone out.
 *
 * One button, and read-aloud already owns it. Build 13 shipped play/pause on
 * the lock screen and on an AirPod squeeze (DROVE-189), so a press already
 * means something. It cannot also mean push-to-talk without a rule, and this
 * file is the rule.
 *
 * ## What the hardware actually reports
 *
 * PRESS-AND-HOLD IS NOT AVAILABLE, so "push to talk" cannot be built as a
 * hold however much the name asks for one. Two independent checks say so:
 *
 *  1. The API has no such event. `MPRemoteCommandCenter` in the iOS 26.2 SDK
 *     on this machine declares eighteen commands and not one of them is a
 *     button being held: pause, play, stop, togglePlayPause, changePlaybackRate,
 *     changeRepeatMode, changeShuffleMode, nextTrack, previousTrack,
 *     skipForward, skipBackward, seekForward, seekBackward,
 *     changePlaybackPosition, rating, like, dislike, bookmark. The only
 *     begin/end pair in the whole framework is `MPSeekCommandEvent`, whose
 *     `type` is `BeginSeeking` or `EndSeeking`: that is hold-to-scrub on a
 *     transport, not a general press-and-hold, and nothing else carries a
 *     duration at all.
 *  2. The hardware never sends it anyway. Apple's own AirPods control table
 *     gives press-and-hold to Siri or to the listening-mode switch on every
 *     model that has a stem, and the wired EarPods centre button holds for
 *     Siri too. That is a system-level claim made before any app is consulted,
 *     so it never reaches a command centre. Measured with sources on DROVE-73,
 *     against this same tree.
 *
 * WHAT DOES ARRIVE is three discrete presses, and iOS counts them for us:
 * single press -> `togglePlayPauseCommand`, double -> `nextTrackCommand`,
 * triple -> `previousTrackCommand`. There is no timing to do in JS. AirPods 1
 * and 2 are the exception with one assignable double-tap per ear, so they get
 * whatever the user pointed that tap at and nothing more.
 *
 * AND ONLY WHILE THIS APP OWNS NOW PLAYING. `wireRemoteCommands` in
 * DroverSpeechModule.swift runs only while the session is HELD, which JS sets
 * while read-aloud is on and the app is backgrounded. That is not a
 * limitation to work around, it is exactly the case Clay described: phone in
 * the pocket, headphones in, the reader talking. In the foreground the button
 * belongs to Music, and an app in the foreground does not need it.
 *
 * ## The rule
 *
 * Three presses, and two features want them. So the command stream has ONE
 * OWNER at a time, named by `HeadphoneOwner`, and the owner decides:
 *
 *   - `transport`, the ordinary state. Single press is play/pause, exactly
 *     what build 13 already does and what AirPods teach every user. DOUBLE
 *     PRESS IS THE MICROPHONE. Triple is left alone.
 *   - `menu`, while an audio menu is being read out (DROVE-73). Single press
 *     selects the option being read, double moves to the next option, triple
 *     to the previous. The microphone is NOT reachable then, on purpose: a
 *     question is on the table and answering it is the thing to do. He
 *     answers, the menu closes, and the next double press is the mic again.
 *
 * Written down here rather than in either feature so the two cannot both
 * think they have the double press. DROVE-73 has not shipped a gesture yet;
 * when it does, it sets the owner and reads this table.
 *
 * ## Why double press and not something cleverer
 *
 * Because single press has to stay play/pause. It is the gesture the hardware
 * is labelled with, it is what he already has on build 13, and taking it for
 * the mic would mean he can no longer pause the reader from his ears, which
 * is the control he uses most. Double press is the next one along, it is what
 * AirPods already teach as "the other thing", and it is a deliberate gesture
 * that a jacket pocket does not produce by accident. Triple press is reserved
 * rather than spent, because DROVE-73 needs a third.
 *
 * Pure. No device, no timers, no state.
 */

/**
 * A command as the native module reports it, which is one press class each.
 *
 * `play` and `pause` are the lock screen's two separate buttons; `toggle` is
 * the single press from a headphone, which is why all three mean the same
 * thing here.
 */
export type RemoteCommand = 'play' | 'pause' | 'toggle' | 'next' | 'previous';

/** Who the press belongs to right now. See the rule above. */
export type HeadphoneOwner =
    /** Nothing is asking him anything. Play/pause and the mic. */
    | 'transport'
    /** An audio menu is being read and wants an answer (DROVE-73). */
    | 'menu';

export type HeadphoneAction =
    /** Play/pause the reader, as build 13 already does. */
    | 'transport'
    /** Open the microphone, or close the one this opened (DROVE-225). */
    | 'mic'
    /** Take the option being read (DROVE-73). */
    | 'menu-select'
    /** Move to the next option (DROVE-73). */
    | 'menu-next'
    /** Move back an option (DROVE-73). */
    | 'menu-previous'
    /**
     * Nothing. A press this build has no meaning for, which must be silent
     * rather than guessed at: a gesture that does a surprising thing in a
     * pocket is worse than one that does nothing.
     */
    | 'ignore';

/**
 * The whole table, in one function.
 *
 * Exhaustive on purpose: a new command or a new owner cannot be added without
 * landing a line here, which is what stops a third feature quietly claiming a
 * press that already means something.
 */
export function headphoneAction(command: RemoteCommand, owner: HeadphoneOwner): HeadphoneAction {
    switch (owner) {
        case 'transport':
            switch (command) {
                case 'play':
                case 'pause':
                case 'toggle':
                    return 'transport';
                case 'next':
                    return 'mic';
                case 'previous':
                    // Reserved for DROVE-73 and unspent until then.
                    return 'ignore';
            }
            break;
        case 'menu':
            switch (command) {
                case 'play':
                case 'pause':
                case 'toggle':
                    return 'menu-select';
                case 'next':
                    return 'menu-next';
                case 'previous':
                    return 'menu-previous';
            }
            break;
    }
    return 'ignore';
}

/**
 * Does this command drive the transport, on the ordinary state?
 *
 * `backgroundAudio.ts` is the one place a remote command reaches the READER,
 * and before this ticket it treated every command that was not `play` as a
 * reason to stop reading. A double press would then have turned read-aloud
 * off on its way to opening the mic. This is the guard that keeps that file
 * about the transport and nothing else.
 */
export function isTransportCommand(command: RemoteCommand): boolean {
    return headphoneAction(command, 'transport') === 'transport';
}
