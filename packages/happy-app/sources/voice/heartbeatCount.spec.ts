import { beforeEach, describe, expect, it } from 'vitest';
import { AudioCueMixer } from './audioCueMixer';
import { cueDurationMs, cueSpec, workingCueFor } from './audioCues';
import { ambientCue } from './audioCueState';
import { audioCuesDefaults, type AudioCues } from '@/sync/settings';

/**
 * The heartbeat says how many SUBAGENTS are running, in Morse (DROVE-182,
 * DROVE-209).
 *
 * Clay: "Counting for the Morse code, don't include the main thread."
 *
 * So the number in the ear is the number on the status row, passed through
 * with no arithmetic on it, and zero is the bare thump rather than five dahs.
 * 0, 1, 4, 10 and a count change mid-cadence, which are the cases the ticket
 * asks for, plus 15 because that is a fan-out he actually runs and it is the
 * one a count-the-ticks scheme could never have said.
 */

describe('the counting heartbeat', () => {
    let now = 0;
    let played: string[] = [];
    let config: Required<AudioCues>;
    let mixer: AudioCueMixer;

    beforeEach(() => {
        now = 1_000_000;
        played = [];
        config = { ...audioCuesDefaults };
        mixer = new AudioCueMixer({
            now: () => now,
            play: (id) => { played.push(id); },
            settings: () => config,
        });
    });

    function working(agents: number): void {
        mixer.setState({ reading: true, working: true, pendingKinds: [], agents });
    }

    function run(ms: number): void {
        for (let elapsed = 0; elapsed < ms; elapsed += 250) {
            now += 250;
            mixer.tick();
        }
    }

    it('sounds a lone session as the bare thump, no digits', () => {
        // Zero is the commonest state and `-----` is the longest figure on the
        // scale, so zero gets the marker alone and the silence carries "none".
        working(0);
        run(250);
        expect(played).toEqual(['working:0']);
        expect(cueSpec(workingCueFor(0)).beats).toEqual([{ hz: 196, ms: 190 }]);
    });

    it('says exactly the agent count the status row shows, with no offset', () => {
        // `agents` here is summarizeLiveStatus's agent-row count, which is
        // exactly what the row draws (DROVE-155), and nothing is added to it.
        expect(workingCueFor(0)).toBe('working:0');
        expect(workingCueFor(4)).toBe('working:4');
        expect(workingCueFor(14)).toBe('working:14');
        expect(ambientCue({ reading: true, working: true, pendingKinds: [], agents: 4, speaking: false }))
            .toBe('working:4');
    });

    it('carries the count as Morse digits, one to fifteen', () => {
        for (const agents of [1, 3, 4, 10, 14] as const) {
            played = [];
            working(agents);
            mixer.reset();
            run(250);
            expect(played).toEqual([workingCueFor(agents)]);
        }
    });

    it('keeps the figure well inside the six-second cadence, with silence after', () => {
        // The durations, stated as the ticket asks. None is 190ms, one
        // subagent 1240ms and ten 2340ms, against a 6s default cadence.
        expect(cueDurationMs(cueSpec(workingCueFor(0)))).toBe(190);
        expect(cueDurationMs(cueSpec(workingCueFor(1)))).toBe(1240);
        expect(cueDurationMs(cueSpec(workingCueFor(5)))).toBe(840);
        expect(cueDurationMs(cueSpec(workingCueFor(10)))).toBe(2340);
        const cadence = audioCuesDefaults.workingIntervalSeconds * 1000;
        for (const count of [0, 1, 5, 10, 15, 99]) {
            expect(cadence - cueDurationMs(cueSpec(workingCueFor(count)))).toBeGreaterThan(2_500);
        }
        // The quietest state is the shortest sound, which is the point of
        // not spending `-----` on it.
        expect(cueDurationMs(cueSpec(workingCueFor(0))))
            .toBeLessThan(cueDurationMs(cueSpec(workingCueFor(1))));
    });

    it('reflects a count change on the NEXT beat, not the next cadence', () => {
        working(0);
        run(250);
        expect(played).toEqual(['working:0']);
        // An agent starts. Its own earcon fires elsewhere; what this pins is
        // that the heartbeat does not wait out six seconds to agree with it.
        working(3);
        run(1_500);
        expect(played).toEqual(['working:0', 'working:3']);
    });

    it('is overridden entirely by waiting on him', () => {
        // If he is blocked, the count is not what matters.
        mixer.setState({ reading: true, working: true, pendingKinds: ['question'], agents: 8 });
        run(2_000);
        expect(played).toEqual(['waitingQuestion']);
    });

    it('goes quiet the moment speech starts', () => {
        working(8);
        mixer.setSpeaking(true);
        run(30_000);
        expect(played).toEqual([]);
    });

    it('mutes the whole family from the one settings row', () => {
        config = { ...config, muted: ['working'] };
        working(8);
        run(30_000);
        expect(played).toEqual([]);
    });

    it('is silent with read-aloud off', () => {
        mixer.setState({ reading: false, working: true, pendingKinds: [], agents: 8 });
        run(30_000);
        expect(played).toEqual([]);
    });
});
