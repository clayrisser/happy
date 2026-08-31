import { beforeEach, describe, expect, it } from 'vitest';
import { AudioCueMixer } from './audioCueMixer';
import { cueDurationMs, cueSpec, heartbeatCount, workingCueFor } from './audioCues';
import { ambientCue } from './audioCueState';
import { audioCuesDefaults, type AudioCues } from '@/sync/settings';
import { summarizeLiveStatus, type LiveStatus } from '@/utils/liveStatus';

/**
 * The heartbeat says how many threads are running, in Morse (DROVE-182).
 *
 * Clay: "The heartbeat is supposed to be number of subagents including main in
 * Morse code."
 *
 * 0, 1, 4, 5 and a count change mid-cadence, which are the cases the ticket
 * asks for, plus 10 and 15 because those are the fan-outs he actually runs and
 * they are the ones a count-the-ticks scheme could never have said.
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

    it('counts the main thread, so a lone session says one and never zero', () => {
        working(0);
        run(250);
        expect(played).toEqual(['working:1']);
    });

    it('says one more than the agent count the status row shows', () => {
        // The one place the two numbers differ, and by a written rule rather
        // than an accident. `agents` here is `summarizeLiveStatus`'s
        // `sideCount`, which is the very field the row prints (DROVE-155).
        expect(heartbeatCount(0)).toBe(1);
        expect(heartbeatCount(4)).toBe(5);
        expect(heartbeatCount(14)).toBe(15);
        expect(ambientCue({ reading: true, working: true, pendingKinds: [], agents: 4, speaking: false }))
            .toBe('working:5');
    });

    it('carries the count as Morse digits, one to fifteen', () => {
        for (const [agents, expected] of [[0, 1], [3, 4], [4, 5], [9, 10], [14, 15]] as const) {
            played = [];
            working(agents);
            mixer.reset();
            run(250);
            expect(played).toEqual([workingCueFor(expected)]);
        }
    });

    it('keeps the figure well inside the six-second cadence, with silence after', () => {
        // The durations, stated as the ticket asks. One thread is 1240ms and
        // ten is 2340ms, against a 6s default cadence.
        expect(cueDurationMs(cueSpec(workingCueFor(1)))).toBe(1240);
        expect(cueDurationMs(cueSpec(workingCueFor(5)))).toBe(840);
        expect(cueDurationMs(cueSpec(workingCueFor(10)))).toBe(2340);
        const cadence = audioCuesDefaults.workingIntervalSeconds * 1000;
        for (const count of [1, 5, 10, 15, 99]) {
            expect(cadence - cueDurationMs(cueSpec(workingCueFor(count)))).toBeGreaterThan(2_500);
        }
    });

    it('reflects a count change on the NEXT beat, not the next cadence', () => {
        working(0);
        run(250);
        expect(played).toEqual(['working:1']);
        // An agent starts. Its own earcon fires elsewhere; what this pins is
        // that the heartbeat does not wait out six seconds to agree with it.
        working(3);
        run(1_500);
        expect(played).toEqual(['working:1', 'working:4']);
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

/**
 * The wrist and the screen read ONE number (DROVE-209, DROVE-185).
 *
 * DROVE-209's point was that the heartbeat and the status row must not carry
 * two numbers that differ for no visible reason. The service used to re-count
 * by filtering `summarizeLiveStatus`'s rows to `kind === 'agent'` while the
 * row printed `sideCount`, which also counts workflows — so the wrist beat one
 * short for as long as any workflow ran. Nothing caught it because no fixture
 * here or in `liveStatus.spec.ts` had a workflow and a heartbeat in the same
 * test. This is that fixture.
 *
 * Nesting is in it too (DROVE-185): a subagent's own subagents are ordinary
 * entries in the same array, they count, and folding them away on screen is a
 * drawing decision that must not reach this number.
 */
describe('the number the row prints is the number the wrist beats', () => {
    const at = 1_700_000_000_000;
    const live: LiveStatus = {
        at,
        agents: [
            { id: 'a1', label: 'Top', startedAt: at - 300_000 },
            { id: 'a1b', label: 'Child', startedAt: at - 200_000, parentId: 'a1' },
            { id: 'a1c', label: 'Grandchild', startedAt: at - 100_000, parentId: 'a1b' },
        ],
        workflows: [
            { id: 'wf_1', name: 'drover-relaunch', done: 1, total: 4, startedAt: at - 400_000 },
        ],
    };

    it('is the same value on both surfaces, workflow and nesting included', () => {
        const summary = summarizeLiveStatus(live, at);
        // Three agents across three depths, plus the workflow.
        expect(summary.sideCount).toBe(4);
        // What the service feeds the mixer is this field, not a re-count of
        // the rows, so the two cannot drift apart again.
        expect(ambientCue({ reading: true, working: true, pendingKinds: [], agents: summary.sideCount, speaking: false }))
            .toBe(workingCueFor(heartbeatCount(summary.sideCount)));
    });

    it('does not change when a parent is folded on screen', () => {
        // The rows a collapsed sheet draws are fewer than the rows that exist.
        // The count comes off neither: it comes off `sideCount`.
        const summary = summarizeLiveStatus(live, at);
        const agentRows = summary.rows.filter((row) => row.kind === 'agent');
        expect(agentRows).toHaveLength(3);
        expect(summary.sideCount).toBe(4);
        // The old expression, kept here as the thing that must never come
        // back: it is one short of what the row shows.
        expect(agentRows.length).not.toBe(summary.sideCount);
    });
});
