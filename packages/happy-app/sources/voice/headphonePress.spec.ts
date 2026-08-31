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
    it('opens the microphone on a double press and nothing else does', () => {
        // The whole ticket in one assertion. Double press arrives as
        // nextTrack, and it is the ONLY press that reaches the mic.
        expect(headphoneAction('next', 'transport')).toBe('mic');
        for (const command of commands.filter((entry) => entry !== 'next')) {
            expect(headphoneAction(command, 'transport'), command).not.toBe('mic');
        }
    });

    it('leaves the single press on play/pause', () => {
        // Build 13's transport, unchanged. Taking this for the mic would cost
        // him the control he uses most, and it is the one the hardware is
        // labelled with.
        expect(headphoneAction('toggle', 'transport')).toBe('transport');
        expect(headphoneAction('play', 'transport')).toBe('transport');
        expect(headphoneAction('pause', 'transport')).toBe('transport');
    });

    it('does not claim the triple press before DROVE-73 needs it', () => {
        // Enabled-and-ignored is worse than left alone: it would take the
        // press away from whatever else is playing and do nothing with it.
        expect(headphoneAction('previous', 'transport')).toBe('ignore');
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
        // double press that opened the mic instead would leave the menu still
        // reading into an open recogniser.
        for (const command of commands) {
            expect(headphoneAction(command, 'menu'), command).not.toBe('mic');
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
});

describe('the guard that keeps read-aloud out of the mic press', () => {
    it('calls only the transport presses transport', () => {
        // backgroundAudio.ts stops the reader on any command that is not
        // `play`. Without this guard the double press would turn read-aloud
        // off on its way to opening the mic.
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
