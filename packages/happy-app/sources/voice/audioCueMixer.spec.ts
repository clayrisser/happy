import { beforeEach, describe, expect, it } from 'vitest';
import { AudioCueMixer, cueStaleMs, quietAfterEventMs } from './audioCueMixer';
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

    function working(): void {
        mixer.setState({ reading: true, working: true, pendingKinds: [] });
    }

    it('pulses while working and silent, on the working interval', () => {
        working();
        run(250);
        expect(played).toEqual(['working']);
        // The next one is a whole interval away, not the next tick.
        run(config.workingIntervalSeconds * 1000 - 500);
        expect(played).toEqual(['working']);
        run(500);
        expect(played).toEqual(['working', 'working']);
    });

    it('says nothing at all when the session is idle', () => {
        mixer.setState({ reading: true, working: false, pendingKinds: [] });
        run(30_000);
        expect(played).toEqual([]);
    });

    it('says nothing when read-aloud is off', () => {
        mixer.setState({ reading: false, working: true, pendingKinds: [] });
        run(30_000);
        expect(played).toEqual([]);
    });

    it('stops the instant speech starts and resumes when it ends', () => {
        working();
        run(250);
        expect(played).toEqual(['working']);
        mixer.setSpeaking(true);
        run(60_000);
        expect(played).toEqual(['working']);
        mixer.setSpeaking(false);
        run(config.workingIntervalSeconds * 1000);
        expect(played.length).toBeGreaterThan(1);
    });

    it('changes character the moment a gate arrives, without waiting out the clock', () => {
        working();
        run(250);
        expect(played).toEqual(['working']);
        mixer.setState({ reading: true, working: true, pendingKinds: ['question'] });
        run(250);
        expect(played).toEqual(['working', 'waitingQuestion']);
    });

    it('goes back to the working pulse once the gate is answered', () => {
        mixer.setState({ reading: true, working: true, pendingKinds: ['permission'] });
        run(250);
        expect(played).toEqual(['waitingPermission']);
        mixer.setState({ reading: true, working: true, pendingKinds: [] });
        run(250);
        expect(played).toEqual(['waitingPermission', 'working']);
    });

    it('runs the waiting pulse on the faster clock', () => {
        mixer.setState({ reading: true, working: false, pendingKinds: ['question'] });
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
        mixer.event('toolRun');
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

    it('keeps the heartbeat out of the way just after an event', () => {
        working();
        mixer.event('toolRun');
        run(250);
        expect(played).toEqual(['toolRun']);
        now += quietAfterEventMs - 100;
        mixer.tick();
        expect(played).toEqual(['toolRun']);
        now += 200;
        mixer.tick();
        expect(played).toEqual(['toolRun', 'working']);
    });

    it('caps tool cues per minute and drops the excess in silence', () => {
        config = { ...config, toolCuesPerMinute: 3 };
        for (let i = 0; i < 10; i++) mixer.event('toolRun');
        expect(mixer.pending).toBe(3);
        expect(mixer.dropped).toBe(7);
    });

    it('counts the caps per lane, so a flood of tools cannot silence an agent', () => {
        config = { ...config, toolCuesPerMinute: 1, agentCuesPerMinute: 4 };
        for (let i = 0; i < 5; i++) mixer.event('toolRun');
        mixer.event('agentStart');
        run(5_000);
        expect(played).toEqual(['toolRun', 'agentStart']);
    });

    it('lets the cap refill once the window has passed', () => {
        config = { ...config, toolCuesPerMinute: 1 };
        mixer.event('toolRun');
        run(1_000);
        expect(played).toEqual(['toolRun']);
        mixer.event('toolRun');
        expect(mixer.dropped).toBe(1);
        now += 61_000;
        mixer.event('toolRun');
        mixer.tick();
        expect(played).toEqual(['toolRun', 'toolRun']);
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

    it('scales each cue by its own gain and the volume setting', () => {
        config = { ...config, volume: 0.5 };
        mixer.event('toolRun');
        run(250);
        expect(volumes[0]).toBeCloseTo(0.5 * cueSpec('toolRun').gain, 5);
    });
});
