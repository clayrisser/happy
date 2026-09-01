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

describe('the tap is the play button (DROVE-98, DROVE-327)', () => {
    it('turns reading on from off', () => {
        expect(transportEffect('tap', 'off')).toBe('turn-on');
    });

    it('turns reading off while it is reading', () => {
        expect(transportEffect('tap', 'reading')).toBe('turn-off');
    });

    it('RESUMES from paused, and never turns it off (DROVE-327)', () => {
        // Clay, from his phone: "if it's paused and I single tap it should
        // unpause not end the reading." This cell was 'turn-off' through
        // DROVE-233 and DROVE-236 on the argument that a tap is one axis. A
        // switch has one axis; a player's cheapest gesture is "talk".
        expect(transportEffect('tap', 'paused')).toBe('resume');
        expect(transportEffect('tap', 'paused')).not.toBe('turn-off');
    });

    it('never pauses, in any state: the hold owns that (DROVE-327)', () => {
        // "To go into pause though you hold it in."
        for (const state of states) {
            expect(transportEffect('tap', state)).not.toBe('pause');
        }
    });
});

describe('the long press is pause while reading, off while paused (DROVE-233, DROVE-327)', () => {
    it('pauses while it is reading', () => {
        expect(transportEffect('long-press', 'reading')).toBe('pause');
    });

    it('turns reading OFF from paused, which is the way out (DROVE-327)', () => {
        // The hold used to resume, so the tap could be on/off. With the tap
        // resuming, the hold is what leaves paused for off, and nothing on
        // the button leaves paused by accident.
        expect(transportEffect('long-press', 'paused')).toBe('turn-off');
        expect(transportEffect('long-press', 'paused')).not.toBe('resume');
    });

    it('opens boss mode while read-aloud is off (DROVE-236)', () => {
        // The cell used to be `nothing`. Clay collapsed the waveform and the
        // speaker into one button and gave it this job. It still does not start
        // READING: starting is the tap's job, and a long press that started
        // reading would be a second way to start with no position to hold.
        expect(transportEffect('long-press', 'off')).toBe('boss-mode');
    });

    it("is Clay's table, cell for cell (DROVE-236, DROVE-327)", () => {
        //     state     single press        long press
        //     normal    reading mode on     boss mode
        //     reading   back to normal      pause
        //     paused    resume              back to normal
        expect(transportEffect('tap', 'off')).toBe('turn-on');
        expect(transportEffect('long-press', 'off')).toBe('boss-mode');
        expect(transportEffect('tap', 'reading')).toBe('turn-off');
        expect(transportEffect('long-press', 'reading')).toBe('pause');
        // The row DROVE-236's table did not write out, and the one he wrote
        // from the phone when the button got it wrong (DROVE-327).
        expect(transportEffect('tap', 'paused')).toBe('resume');
        expect(transportEffect('long-press', 'paused')).toBe('turn-off');
    });

    it('is the ONLY gesture that can reach boss mode (DROVE-236)', () => {
        // A squeeze in a pocket must not dial anybody. The remote gestures are
        // untouched by the new cell.
        for (const gesture of gestures) {
            const reachesBoss = states.some((state) => transportEffect(gesture, state) === 'boss-mode');
            expect(reachesBoss).toBe(gesture === 'long-press');
        }
    });

    it('leaves exactly ONE pause gesture in the whole table (DROVE-233, DROVE-236)', () => {
        // The collapse must not invent a second way to pause. Every cell that
        // pauses is a press ON a reading state, and nothing else pauses.
        for (const gesture of gestures) {
            for (const state of states) {
                if (transportEffect(gesture, state) === 'pause') {
                    expect(state).toBe('reading');
                }
            }
        }
        expect(transportEffect('long-press', 'reading')).toBe('pause');
    });

    it('is a round trip: hold pauses, TAP resumes, and the state is back (DROVE-327)', () => {
        const paused = transportEffect('long-press', 'reading');
        expect(paused).toBe('pause');
        expect(transportEffect('tap', 'paused')).toBe('resume');
        // And the hold from there is the exit, not a second resume.
        expect(transportEffect('long-press', 'paused')).toBe('turn-off');
    });
});

describe('the headphones and the lock screen drive the same state', () => {
    it('maps a single headphone press to the pause the hold makes and the resume the tap makes', () => {
        // iOS reports a single press as togglePlayPauseCommand (DROVE-225). It
        // is a play/pause key: pause is the hold's cell, resume is the tap's
        // (DROVE-327). It never follows the hold into turn-off, because a
        // squeeze in a pocket must not end the reading (asserted below).
        expect(transportEffect('remote-toggle', 'reading'))
            .toBe(transportEffect('long-press', 'reading'));
        expect(transportEffect('remote-toggle', 'paused'))
            .toBe(transportEffect('tap', 'paused'));
        expect(transportEffect('remote-toggle', 'paused')).toBe('resume');
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
    /**
     * EVERY CELL, PINNED (DROVE-327). The tests above each argue one cell;
     * this is the whole table as a literal, so a change to any of the fifteen
     * fails here by name whatever the argument for it. Three of these cells
     * have been changed twice already.
     */
    const cells: ReadonlyArray<[TransportGesture, ReadAloudTransport, string]> = [
        ['tap', 'off', 'turn-on'],
        ['tap', 'reading', 'turn-off'],
        ['tap', 'paused', 'resume'],
        ['long-press', 'off', 'boss-mode'],
        ['long-press', 'reading', 'pause'],
        ['long-press', 'paused', 'turn-off'],
        ['remote-play', 'off', 'nothing'],
        ['remote-play', 'reading', 'nothing'],
        ['remote-play', 'paused', 'resume'],
        ['remote-pause', 'off', 'nothing'],
        ['remote-pause', 'reading', 'pause'],
        ['remote-pause', 'paused', 'nothing'],
        ['remote-toggle', 'off', 'nothing'],
        ['remote-toggle', 'reading', 'pause'],
        ['remote-toggle', 'paused', 'resume'],
    ];

    for (const [gesture, state, effect] of cells) {
        it(`${gesture} while ${state} → ${effect}`, () => {
            expect(transportEffect(gesture, state)).toBe(effect);
        });
    }

    it('pins all fifteen cells, none twice', () => {
        expect(new Set(cells.map(([g, s]) => `${g}/${s}`)).size).toBe(gestures.length * states.length);
    });

    it('answers every gesture in every state', () => {
        for (const gesture of gestures) {
            for (const state of states) {
                expect(['turn-on', 'turn-off', 'pause', 'resume', 'boss-mode', 'nothing'])
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

    it('leaves the double press to the next session (DROVE-300)', () => {
        // It reaches the reader, but through nextSession.ts and as a focus
        // move, not as a play/pause. This file must not claim it.
        expect(remoteTransportGesture('next')).toBeNull();
        expect(headphoneAction('next', 'transport')).toBe('next-session');
    });

    it('leaves the triple press to the microphone (DROVE-300)', () => {
        expect(remoteTransportGesture('previous')).toBeNull();
        expect(headphoneAction('previous', 'transport')).toBe('mic');
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
