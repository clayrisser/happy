import { beforeEach, describe, expect, it } from 'vitest';
import { AudioCueMixer, cueStaleMs } from './audioCueMixer';
import { cueDurationMs, cueSpec } from './audioCues';
import { audioCuesDefaults, type AudioCues } from '@/sync/settings';

/**
 * The mixer is driven by ticks and a clock, both injected, so the whole state
 * machine is exercised here without waiting for anything: working, a gate
 * arriving, the gate being answered, speech starting and ending, and idle,
 * which is the walk DROVE-112 asked a test to make.
 */

describe('AudioCueMixer', () => {
    let now = 0;
    let played: string[] = [];
    let volumes: number[] = [];
    let config: Required<AudioCues>;
    let mixer: AudioCueMixer;

    beforeEach(() => {
        now = 1_000_000;
        played = [];
        volumes = [];
        config = { ...audioCuesDefaults };
        mixer = new AudioCueMixer({
            now: () => now,
            play: (id, volume) => { played.push(id); volumes.push(volume); },
            settings: () => config,
        });
    });

    /** Advance the clock and tick as the owner would, every 250ms. */
    function run(ms: number): void {
        for (let elapsed = 0; elapsed < ms; elapsed += 250) {
            now += 250;
            mixer.tick();
        }
    }

    function working(agents = 0): void {
        mixer.setState({ reading: true, working: true, pendingKinds: [], agents });
    }

    /**
     * The working pulse for a subagent count. `working:0` is a lone session,
     * which is the bare thump (DROVE-209).
     */
    function pulse(count = 0): string {
        return `working:${count}`;
    }

    it('pulses while working and silent, on the working interval', () => {
        working();
        run(250);
        expect(played).toEqual([pulse()]);
        // The next one is a whole interval away, not the next tick.
        run(config.workingIntervalSeconds * 1000 - 500);
        expect(played).toEqual([pulse()]);
        run(500);
        expect(played).toEqual([pulse(), pulse()]);
    });

    it('says nothing at all when the session is idle', () => {
        mixer.setState({ reading: true, working: false, pendingKinds: [], agents: 0 });
        run(30_000);
        expect(played).toEqual([]);
    });

    it('says nothing when read-aloud is off', () => {
        mixer.setState({ reading: false, working: true, pendingKinds: [], agents: 0 });
        run(30_000);
        expect(played).toEqual([]);
    });

    it('stops the instant speech starts and resumes when it ends', () => {
        working();
        run(250);
        expect(played).toEqual([pulse()]);
        mixer.setSpeaking(true);
        run(60_000);
        expect(played).toEqual([pulse()]);
        mixer.setSpeaking(false);
        run(config.workingIntervalSeconds * 1000);
        expect(played.length).toBeGreaterThan(1);
    });

    it('changes character the moment a gate arrives, without waiting out the clock', () => {
        working();
        run(250);
        expect(played).toEqual([pulse()]);
        mixer.setState({ reading: true, working: true, pendingKinds: ['question'], agents: 0 });
        // The counting figure has to finish first (DROVE-182), though for a
        // lone session that is only the 190ms thump. What it does NOT do is
        // wait out the six-second cadence, which is the point of the test.
        run(1_500);
        expect(played).toEqual([pulse(), 'waitingQuestion']);
    });

    it('goes back to the working pulse once the gate is answered', () => {
        mixer.setState({ reading: true, working: true, pendingKinds: ['permission'], agents: 0 });
        run(250);
        expect(played).toEqual(['waitingPermission']);
        mixer.setState({ reading: true, working: true, pendingKinds: [], agents: 0 });
        run(250);
        expect(played).toEqual(['waitingPermission', pulse()]);
    });

    it('runs the waiting pulse on the faster clock', () => {
        mixer.setState({ reading: true, working: false, pendingKinds: ['question'], agents: 0 });
        run(config.waitingIntervalSeconds * 1000 * 3);
        const waits = played.filter((id) => id === 'waitingQuestion').length;
        expect(waits).toBeGreaterThanOrEqual(3);
    });

    it('never plays a cue over speech: it waits its turn', () => {
        working();
        mixer.setSpeaking(true);
        mixer.event('agentStart');
        run(1_000);
        expect(played).toEqual([]);
        mixer.setSpeaking(false);
        run(250);
        expect(played).toEqual(['agentStart']);
    });

    it('drops a cue too stale to still be true rather than playing it late', () => {
        mixer.setSpeaking(true);
        mixer.event('toolCall');
        run(cueStaleMs + 1_000);
        mixer.setSpeaking(false);
        run(250);
        expect(played).toEqual([]);
        expect(mixer.dropped).toBe(1);
    });

    it('lets one cue finish before the next starts', () => {
        mixer.event('agentStart');
        mixer.event('agentDone');
        now += 250;
        mixer.tick();
        expect(played).toEqual(['agentStart']);
        // Still inside the first cue's own length.
        now += 10;
        mixer.tick();
        expect(played).toEqual(['agentStart']);
        now += cueDurationMs(cueSpec('agentStart'));
        mixer.tick();
        expect(played).toEqual(['agentStart', 'agentDone']);
    });

    it('keeps the heartbeat out from UNDER an earcon, and no longer than that', () => {
        // AMBIENT YIELDS TO EVENTS, in the form that survived DROVE-197: the
        // beat never starts while an earcon is still sounding, and it starts
        // as soon as one is over. It used to stay clear for a further 700ms
        // as a courtesy, which was affordable when a tool cue was one per RUN
        // and six a minute; per-call earcons turned that courtesy into a
        // permanent gag, and the beat had nowhere left to land.
        working();
        mixer.event('toolCall');
        run(250);
        expect(played).toEqual(['toolCall']);
        // Still inside the earcon's own length: nothing over the top of it.
        now += cueDurationMs(cueSpec('toolCall')) - 1;
        mixer.tick();
        expect(played).toEqual(['toolCall']);
        now += 2;
        mixer.tick();
        expect(played).toEqual(['toolCall', pulse()]);
    });

    it('caps tool cues per minute and drops the excess in silence', () => {
        config = { ...config, toolCuesPerMinute: 3 };
        for (let i = 0; i < 10; i++) mixer.event('toolCall');
        expect(mixer.pending).toBe(3);
        expect(mixer.dropped).toBe(7);
    });

    it('counts the caps per lane, so a flood of tools cannot silence an agent', () => {
        config = { ...config, toolCuesPerMinute: 1, agentCuesPerMinute: 4 };
        for (let i = 0; i < 5; i++) mixer.event('toolCall');
        mixer.event('agentStart');
        run(5_000);
        expect(played).toEqual(['toolCall', 'agentStart']);
    });

    it('lets the cap refill once the window has passed', () => {
        config = { ...config, toolCuesPerMinute: 1 };
        mixer.event('toolCall');
        run(1_000);
        expect(played).toEqual(['toolCall']);
        mixer.event('toolCall');
        expect(mixer.dropped).toBe(1);
        now += 61_000;
        mixer.event('toolCall');
        mixer.tick();
        expect(played).toEqual(['toolCall', 'toolCall']);
    });

    it('says nothing with the master switch off, and forgets what was queued', () => {
        config = { ...config, on: false };
        working();
        mixer.event('agentStart');
        run(30_000);
        expect(played).toEqual([]);
        expect(mixer.pending).toBe(0);
    });

    it('silences one cue without silencing the rest', () => {
        config = { ...config, muted: ['working'] };
        working();
        mixer.event('agentStart');
        run(30_000);
        expect(played).toEqual(['agentStart']);
    });

    it('drops the heartbeat alone when the heartbeat switch is off', () => {
        config = { ...config, heartbeat: false };
        working();
        mixer.event('skipAhead');
        run(30_000);
        expect(played).toEqual(['skipAhead']);
    });

    it('hands the player the volume setting and nothing else (DROVE-341)', () => {
        // The cue's own level is baked into the rendered file, so the number
        // that reaches the player is the SETTING, undecorated. Multiplying the
        // cue's level in here as well is what squared it: at the old default
        // of 0.35 the tool tick came out at 0.0105 rather than 0.105, which is
        // twenty dB under where the table put it.
        config = { ...config, volume: 0.5 };
        mixer.event('toolCall');
        run(250);
        expect(volumes[0]).toBe(0.5);
    });

    it('does not let the cue table leak into the player volume', () => {
        // Two cues at very different levels still hand the player the same
        // number, because the difference between them is in the file.
        expect(cueSpec('agentStart').amplitude).toBeGreaterThan(cueSpec('toolCall').amplitude);
        config = { ...config, volume: 0.4 };
        mixer.event('toolCall');
        mixer.event('agentStart');
        run(30_000);
        expect(volumes.length).toBeGreaterThanOrEqual(2);
        for (const volume of volumes) expect(volume).toBe(0.4);
    });
});
