import { describe, expect, it } from 'vitest';
import {
    readAloudTransport,
    remoteTransportGesture,
    transportEffect,
    type ReadAloudTransport,
    type TransportGesture,
} from './readAloudTransport';
import { headphoneAction } from './headphonePress';

/**
 * The transport table (DROVE-233).
 *
 * Three surfaces and three states, so the interesting assertion is not any one
 * cell but that a walk of every cell holds: whatever he presses, wherever the
 * reader is, one of five things happens and none of them is a surprise.
 */

const states: ReadAloudTransport[] = ['off', 'paused', 'reading'];
const gestures: TransportGesture[] = ['tap', 'long-press', 'remote-play', 'remote-pause', 'remote-toggle'];

describe('readAloudTransport', () => {
    it('is off whenever read-aloud is off, paused flag or not', () => {
        expect(readAloudTransport(false, false)).toBe('off');
        // A stale paused flag beside a disabled reader is not a fourth state.
        expect(readAloudTransport(false, true)).toBe('off');
    });

    it('tells paused apart from reading', () => {
        expect(readAloudTransport(true, true)).toBe('paused');
        expect(readAloudTransport(true, false)).toBe('reading');
    });
});

describe('the tap keeps its on/off meaning (DROVE-98)', () => {
    it('turns reading on from off', () => {
        expect(transportEffect('tap', 'off')).toBe('turn-on');
    });

    it('turns reading off while it is reading', () => {
        expect(transportEffect('tap', 'reading')).toBe('turn-off');
    });

    it('turns reading OFF from paused rather than resuming', () => {
        // One gesture, one axis. A tap that resumed would give the control two
        // meanings on the same press and leave paused with no way out except
        // the gesture that made it.
        expect(transportEffect('tap', 'paused')).toBe('turn-off');
    });
});

describe('the long press is pause and resume (DROVE-233)', () => {
    it('pauses while it is reading', () => {
        expect(transportEffect('long-press', 'reading')).toBe('pause');
    });

    it('resumes from paused', () => {
        expect(transportEffect('long-press', 'paused')).toBe('resume');
    });

    it('does nothing at all while read-aloud is off', () => {
        // Starting is the tap's job. A long press that started reading would
        // be a second way to start, with no position to hold.
        expect(transportEffect('long-press', 'off')).toBe('nothing');
    });

    it('is a round trip: pause then resume and the state is back', () => {
        const paused = transportEffect('long-press', 'reading');
        expect(paused).toBe('pause');
        expect(transportEffect('long-press', 'paused')).toBe('resume');
    });
});

describe('the headphones and the lock screen drive the same state', () => {
    it('maps a single headphone press to the same pause the long press makes', () => {
        // iOS reports a single press as togglePlayPauseCommand (DROVE-225).
        expect(transportEffect('remote-toggle', 'reading'))
            .toBe(transportEffect('long-press', 'reading'));
        expect(transportEffect('remote-toggle', 'paused'))
            .toBe(transportEffect('long-press', 'paused'));
    });

    it('pauses on the lock screen pause button and resumes on its play button', () => {
        expect(transportEffect('remote-pause', 'reading')).toBe('pause');
        expect(transportEffect('remote-play', 'paused')).toBe('resume');
    });

    it('NEVER turns read-aloud on from a pocket (DROVE-189)', () => {
        // "a squeeze that turned the voice back on for a session he had walked
        // away from would be a surprise, and the button is one tap away".
        expect(transportEffect('remote-play', 'off')).toBe('nothing');
        expect(transportEffect('remote-pause', 'off')).toBe('nothing');
        expect(transportEffect('remote-toggle', 'off')).toBe('nothing');
    });

    it('never turns read-aloud OFF from a pocket either, which is what changed', () => {
        // Before this ticket every non-play command called
        // interrupt('toggled-off'), so a squeeze ended the reading and threw
        // the position away. No remote press reaches 'turn-off' now.
        for (const gesture of ['remote-play', 'remote-pause', 'remote-toggle'] as const) {
            for (const state of states) {
                expect(transportEffect(gesture, state)).not.toBe('turn-off');
                expect(transportEffect(gesture, state)).not.toBe('turn-on');
            }
        }
    });

    it('idempotent presses do nothing rather than flipping', () => {
        expect(transportEffect('remote-play', 'reading')).toBe('nothing');
        expect(transportEffect('remote-pause', 'paused')).toBe('nothing');
    });
});

describe('the table as a whole', () => {
    it('answers every gesture in every state', () => {
        for (const gesture of gestures) {
            for (const state of states) {
                expect(['turn-on', 'turn-off', 'pause', 'resume', 'nothing'])
                    .toContain(transportEffect(gesture, state));
            }
        }
    });

    it('never pauses something that is not reading, or resumes something that is', () => {
        for (const gesture of gestures) {
            for (const state of states) {
                const effect = transportEffect(gesture, state);
                if (effect === 'pause') expect(state).toBe('reading');
                if (effect === 'resume') expect(state).toBe('paused');
            }
        }
    });
});

describe('remoteTransportGesture', () => {
    it('takes the three transport commands', () => {
        expect(remoteTransportGesture('play')).toBe('remote-play');
        expect(remoteTransportGesture('pause')).toBe('remote-pause');
        expect(remoteTransportGesture('toggle')).toBe('remote-toggle');
    });

    it('leaves the double press to the microphone (DROVE-225)', () => {
        expect(remoteTransportGesture('next')).toBeNull();
        expect(headphoneAction('next', 'transport')).toBe('mic');
    });

    it('leaves the triple press reserved (DROVE-73)', () => {
        expect(remoteTransportGesture('previous')).toBeNull();
    });

    it('agrees with the press table about which commands are the transport', () => {
        // Two files, one answer. A command that headphonePress calls transport
        // is exactly a command this turns into a gesture.
        for (const command of ['play', 'pause', 'toggle', 'next', 'previous'] as const) {
            const isTransport = headphoneAction(command, 'transport') === 'transport';
            expect(remoteTransportGesture(command) !== null).toBe(isTransport);
        }
    });
});
