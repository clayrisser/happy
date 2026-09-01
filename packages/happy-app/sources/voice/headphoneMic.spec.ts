import { describe, expect, it } from 'vitest';
import { HeadphoneMic, MIC_ACK_LEAD_MS, type HeadphoneMicDeps } from './headphoneMic';
import { cueDurationMs, cueSpec, type AudioCueId } from './audioCues';

interface Harness {
    mic: HeadphoneMic;
    /** Every cue played, in order. */
    cues: AudioCueId[];
    /** How many times the ONE capture was tapped. */
    taps: number;
    /** Run the pending open, as its timer would. */
    fire: () => void;
    /** How long the pending open was scheduled for. */
    scheduledFor: number | null;
    capturing: boolean;
    blocked: boolean;
}

function harness(patch: Partial<Pick<Harness, 'capturing' | 'blocked'>> = {}): Harness {
    const state: Harness = {
        mic: null as unknown as HeadphoneMic,
        cues: [],
        taps: 0,
        fire: () => { },
        scheduledFor: null,
        capturing: patch.capturing ?? false,
        blocked: patch.blocked ?? false,
    };
    const deps: HeadphoneMicDeps = {
        capturing: () => state.capturing,
        blocked: () => state.blocked,
        ack: (id) => { state.cues.push(id); },
        duration: (id) => cueDurationMs(cueSpec(id)),
        tap: () => { state.taps += 1; },
        delay: (run, ms) => {
            state.scheduledFor = ms;
            state.fire = () => {
                state.scheduledFor = null;
                state.fire = () => { };
                run();
            };
            return () => {
                state.scheduledFor = null;
                state.fire = () => { };
            };
        },
    };
    state.mic = new HeadphoneMic(deps);
    return state;
}

describe('the mic press opens the mic', () => {
    it('sounds the open cue BEFORE the microphone opens', () => {
        // A tone played into a live recogniser is a tone in the recording:
        // dictation runs the session in .playAndRecord with .defaultToSpeaker,
        // so the cue comes out of the route the mic is listening to.
        const h = harness();
        h.mic.press();
        expect(h.cues).toEqual(['micOpen']);
        expect(h.taps).toBe(0);
        h.fire();
        expect(h.taps).toBe(1);
    });

    it('waits for the whole cue and a little more', () => {
        const h = harness();
        h.mic.press();
        expect(h.scheduledFor).toBe(cueDurationMs(cueSpec('micOpen')) + MIC_ACK_LEAD_MS);
    });

    it('opens the mic through one call, not a capture of its own', () => {
        // `tap` is useVoiceComposer.onTalkTap, the same call DROVE-210 gave
        // the composer's primary button. One capture, three doors.
        const h = harness();
        h.mic.press();
        h.fire();
        expect(h.taps).toBe(1);
    });
});

describe('the mic press closes what it opened', () => {
    it('stops a running capture and says so at once', () => {
        // The stop is the slow half; the recogniser takes its time settling.
        // An acknowledgement that waits for it arrives seconds after the
        // press, which is not an acknowledgement.
        const h = harness({ capturing: true });
        h.mic.press();
        expect(h.cues).toEqual(['micClosed']);
        expect(h.taps).toBe(1);
    });

    it('stops one opened by the on-screen mic', () => {
        // Either control stops what either started (DROVE-210). Nothing here
        // knows which one opened it, which is the point.
        const h = harness({ capturing: true });
        h.mic.press();
        expect(h.taps).toBe(1);
    });

    it('cancels an open that is still waiting on its cue', () => {
        // The quarter-second between the cue and the mic is the one window
        // where `capturing()` is false but a press is already in flight. A
        // second press there must stop it, not queue a second open.
        const h = harness();
        h.mic.press();
        expect(h.mic.isOpening).toBe(true);
        h.mic.press();
        expect(h.mic.isOpening).toBe(false);
        expect(h.cues).toEqual(['micOpen', 'micClosed']);
        h.fire();
        expect(h.taps).toBe(0);
    });
});

describe('a press that could not open the mic', () => {
    it('says so out loud instead of doing nothing quietly', () => {
        // The failure the ticket exists to prevent: eyes-free, a press with no
        // sound is indistinguishable from a press that did nothing.
        const h = harness({ blocked: true });
        h.mic.press();
        expect(h.cues).toEqual(['micRefused']);
        expect(h.taps).toBe(0);
    });

    it('sounds different from an open and from a close', () => {
        const refused = cueSpec('micRefused');
        const open = cueSpec('micOpen');
        const closed = cueSpec('micClosed');
        // Rhythm carries it with the pitch thrown away: up, down, or the same
        // note twice going nowhere. A pocket flattens pitch, not shape.
        expect(open.beats[1].hz).toBeGreaterThan(open.beats[0].hz);
        expect(closed.beats[1].hz).toBeLessThan(closed.beats[0].hz);
        expect(refused.beats[1].hz).toBe(refused.beats[0].hz);
    });

    it('refuses rather than opening when the recogniser is still settling', () => {
        // Same question the on-screen button asks, answered with a sound
        // instead of an alert he cannot read from a pocket.
        const h = harness({ blocked: true });
        h.mic.press();
        h.mic.press();
        expect(h.cues).toEqual(['micRefused', 'micRefused']);
        expect(h.taps).toBe(0);
    });
});

describe('teardown', () => {
    it('never opens the mic into a screen that has gone', () => {
        const h = harness();
        h.mic.press();
        h.mic.dispose();
        h.fire();
        expect(h.taps).toBe(0);
    });
});
