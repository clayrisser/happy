import { describe, expect, it } from 'vitest';
import {
    headphoneAction,
    isTransportCommand,
    type HeadphoneOwner,
    type RemoteCommand,
} from './headphonePress';

const commands: RemoteCommand[] = ['play', 'pause', 'toggle', 'next', 'previous'];
const owners: HeadphoneOwner[] = ['transport', 'menu'];

describe('what a headphone press means', () => {
    it('skips to the next session on a double press and nothing else does', () => {
        // DROVE-300 in one assertion. Clay: "double press would be just like
        // playing YouTube, it skips to the next track — in this case the next
        // session." Double press arrives as nextTrack, and it is the ONLY
        // press that moves the voice.
        expect(headphoneAction('next', 'transport')).toBe('next-session');
        for (const command of commands.filter((entry) => entry !== 'next')) {
            expect(headphoneAction(command, 'transport'), command).not.toBe('next-session');
        }
    });

    it('opens the microphone on a TRIPLE press and nothing else does', () => {
        // Moved from the double (DROVE-225 had it there). The media metaphor
        // owns the double now, and triple was reserved rather than spent, so
        // it was the one gesture there was room in.
        expect(headphoneAction('previous', 'transport')).toBe('mic');
        for (const command of commands.filter((entry) => entry !== 'previous')) {
            expect(headphoneAction(command, 'transport'), command).not.toBe('mic');
        }
    });

    it('leaves the single press on play/pause', () => {
        // Build 13's transport, unchanged through two remappings. Taking this
        // for anything would cost him the control he uses most, and it is the
        // one the hardware is labelled with.
        expect(headphoneAction('toggle', 'transport')).toBe('transport');
        expect(headphoneAction('play', 'transport')).toBe('transport');
        expect(headphoneAction('pause', 'transport')).toBe('transport');
    });

    it('never leaves a transport press with no meaning at all', () => {
        // Every one of the three presses is spent now. A press that reached
        // `ignore` on the ordinary state would be a command taken away from
        // whatever else is playing and then dropped, which is the exact thing
        // DROVE-225 refused to do with the triple.
        for (const command of commands) {
            expect(headphoneAction(command, 'transport'), command).not.toBe('ignore');
        }
    });
});

describe('the two features that want the same three presses', () => {
    it('gives every press to the menu while a menu is being read', () => {
        // DROVE-73's cycle-and-select, on the same three presses. The owner is
        // what keeps the two apart, so neither has to know about the other.
        expect(headphoneAction('toggle', 'menu')).toBe('menu-select');
        expect(headphoneAction('next', 'menu')).toBe('menu-next');
        expect(headphoneAction('previous', 'menu')).toBe('menu-previous');
    });

    it('does not open the microphone while a menu is waiting', () => {
        // A question is on the table. Answering it is the thing to do, and a
        // triple press that opened the mic instead would leave the menu still
        // reading into an open recogniser.
        for (const command of commands) {
            expect(headphoneAction(command, 'menu'), command).not.toBe('mic');
        }
    });

    it('does not move the voice off the session that is asking him something', () => {
        // The menu belongs to a session, and skipping to the next one while it
        // waits for an answer would abandon the question mid-sentence.
        for (const command of commands) {
            expect(headphoneAction(command, 'menu'), command).not.toBe('next-session');
        }
    });

    it('never gives one press two meanings', () => {
        // The arbitration is by OWNER, so within one owner each command maps
        // to exactly one action and the table is total.
        for (const owner of owners) {
            for (const command of commands) {
                expect(typeof headphoneAction(command, owner)).toBe('string');
            }
        }
    });

    it('resolves the owner with nothing but the two arguments', () => {
        // Foreground/background parity starts here (DROVE-300): the table is a
        // pure function of the command and the owner, so it cannot come to a
        // different answer with the app in a pocket. Called twice, once with
        // every global this file could have reached for left untouched.
        for (const owner of owners) {
            for (const command of commands) {
                expect(headphoneAction(command, owner)).toBe(headphoneAction(command, owner));
            }
        }
    });
});

describe('the guard that keeps read-aloud out of the other two presses', () => {
    it('calls only the transport presses transport', () => {
        // backgroundAudio.ts stops the reader on any command that is not
        // `play`. Without this guard the double press would turn read-aloud
        // off on its way to the next session, and the triple on its way to
        // the mic.
        expect(isTransportCommand('toggle')).toBe(true);
        expect(isTransportCommand('play')).toBe(true);
        expect(isTransportCommand('pause')).toBe(true);
        expect(isTransportCommand('next')).toBe(false);
        expect(isTransportCommand('previous')).toBe(false);
    });

    it('agrees with the table it guards', () => {
        for (const command of commands) {
            expect(isTransportCommand(command), command)
                .toBe(headphoneAction(command, 'transport') === 'transport');
        }
    });
});
