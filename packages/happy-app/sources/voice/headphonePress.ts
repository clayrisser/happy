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
 * DroverSpeechModule.swift used to run only while the session was HELD, which
 * JS sets while read-aloud is on and the app is backgrounded. DROVE-233 widened
 * that to "while read-aloud is ON", because the narrower rule left a locked
 * phone with an idle session showing no card and therefore no buttons — Clay
 * photographed exactly that on build 14. The cost is that the press now
 * reaches Drover in the FOREGROUND too, where it used to belong to Music. That
 * is the right way round for an app that is reading to him, and it is the same
 * trade any audio player makes by holding the card.
 *
 * The single press means pause and resume rather than off (DROVE-233); what it
 * does is `transportEffect`'s to say, in readAloudTransport.ts. Which PRESS is
 * whose is still this file's, and that has not moved.
 *
 * ## The rule
 *
 * Three presses, and two features want them. So the command stream has ONE
 * OWNER at a time, named by `HeadphoneOwner`, and the owner decides:
 *
 *   - `transport`, the ordinary state. Single press is play/pause, exactly
 *     what build 13 already does and what AirPods teach every user. DOUBLE
 *     PRESS IS THE NEXT SESSION. TRIPLE PRESS IS THE MICROPHONE.
 *   - `menu`, while an audio menu is being read out (DROVE-73). Single press
 *     selects the option being read, double moves to the next option, triple
 *     to the previous. The microphone is NOT reachable then, on purpose: a
 *     question is on the table and answering it is the thing to do. He
 *     answers, the menu closes, and the next triple press is the mic again.
 *
 * Written down here rather than in either feature so the two cannot both
 * think they have the double press. DROVE-73 has not shipped a gesture yet;
 * when it does, it sets the owner and reads this table.
 *
 * ## Why double press is the NEXT SESSION (DROVE-300)
 *
 * Clay, choosing it himself: "double press would be just like playing YouTube,
 * it skips to the next track — in this case the next session."
 *
 * That is the argument, and it is a better one than the one it replaces. The
 * three presses are not three free slots: they are a TRANSPORT, and every
 * pair of headphones ever made has taught the same three meanings —
 * play/pause, next, previous. A double press that opened a microphone was
 * borrowing the next-track gesture for something that is not a track, and it
 * had to be learnt because nothing else in the world does it. A double press
 * that moves the voice to the next session is the gesture doing its own job:
 * the sessions ARE the tracks, and the reader is the player.
 *
 * It also settles the lock screen and the car, which the old mapping could
 * not. Enabling `nextTrackCommand` puts a ⏭ on the now-playing card and in
 * every CarPlay head unit, and there is no way to have the press without the
 * button (MPRemoteCommandCenter has one switch for both and
 * MPNowPlayingInfoCenter cannot relabel a glyph). DROVE-225 had to write that
 * off as "a lock-screen button that opens the mic ... simply wearing the wrong
 * icon". Now the icon is right: ⏭ on the dashboard skips to the next session,
 * which is what a ⏭ means.
 *
 * ## Why the microphone MOVED to the triple press rather than being lost
 *
 * Single press cannot be taken. It is the gesture the hardware is labelled
 * with, it is what build 13 already does, and taking it for the mic would
 * cost him the control he uses most. Double press now has a job the media
 * metaphor gives it. That leaves triple, which DROVE-225 deliberately did not
 * spend: "reserved rather than spent, because DROVE-73 needs a third". It is
 * spent now, and DROVE-73 is not harmed, because the menu is a different
 * OWNER and keeps all three presses to itself while it is up. That is exactly
 * the arbitration this file was written for, and it is the reason the mic had
 * somewhere to go.
 *
 * THE COST, named rather than discovered: the triple press only arrives on a
 * binary that ENABLES `previousTrackCommand`, and enabling it puts a ⏮ on the
 * card that opens the microphone. That is DROVE-225's wrong-icon trade paid a
 * second time, and this time it is on the ⏮ rather than the ⏭. It is the
 * price of having the mic on the headphones at all; there is no third button.
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
    /**
     * Pause the session being read at its held position and give the voice to
     * the next session that has reading enabled (DROVE-300). Never a stop and
     * never a jump-ahead: the outgoing session keeps its place and the
     * incoming one resumes at ITS place, which is DROVE-289's held reading.
     */
    | 'next-session'
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
                    return 'next-session';
                case 'previous':
                    return 'mic';
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
 * `backgroundAudio.ts` is the one place a remote command reaches the READER's
 * play/pause, and before DROVE-225 it treated every command that was not
 * `play` as a reason to stop reading. A double press would then have turned
 * read-aloud off on its way to doing its own job. This is the guard that
 * keeps that file about the transport and nothing else.
 *
 * `next-session` reaches the reader too (DROVE-300), through its own
 * subscription in nextSession.ts, and it is NOT the transport: it moves the
 * focus rather than the play/pause state, so it must stay false here.
 */
export function isTransportCommand(command: RemoteCommand): boolean {
    return headphoneAction(command, 'transport') === 'transport';
}
