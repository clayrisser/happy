import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE PULSE FOLLOWS THE DOT (DROVE-385).
 *
 * Clay: "when it's still doing work but there's no subagents, shouldn't it
 * still pulse? The audio should still pulse so I have an audio cue that it's
 * working."
 *
 * The cue layer had its own notion of busy — `session.thinking === true ||
 * isLiveStatusFresh(liveStatus)` — sitting beside the one the dot on the same
 * screen is drawn from, which is the second notion of busy `audioCueService`'s
 * own header swears does not exist. Two of them means they can disagree, and
 * the case Clay photographed is where they did: DROVE-344 and DROVE-361 taught
 * the dot about a main thread mid-turn, a compaction the CLI names outright,
 * and a background agent that outlives the turn that launched it, and none of
 * that reached the sound.
 *
 * So this file pins the JOIN rather than the predicate. Every case below is
 * asserted twice: what the DOT says, and what the heartbeat does. A future
 * change that moves one without the other fails here, which is the whole point
 * of having one resolver.
 *
 * The real service, the real mixer and the real `ambientCueFor` are all in it.
 * Two seams are cut, the same two `pauseSilencesCues.spec.ts` cuts: the store
 * the ambient state is read from, and `cuePlayer`, the one file that touches
 * the device.
 */

const fake = vi.hoisted(() => ({
    played: [] as { id: string; volume: number; offsetDb: number }[],
    warmed: [] as { ids: readonly string[]; volume: number; offsetDb: number }[],
    state: {
        settings: {} as Record<string, unknown>,
        sessions: {} as Record<string, unknown>,
    },
}));

vi.mock('./cuePlayer', () => ({
    playCue: (id: string, volume: number, offsetDb = 0) => {
        fake.played.push({ id, volume, offsetDb });
    },
    warmCuePlayers: (ids: readonly string[], volume: number, offsetDb = 0) => {
        fake.warmed.push({ ids, volume, offsetDb });
    },
    releaseCuePlayers: () => {},
}));

vi.mock('@/sync/storage', () => ({ storage: { getState: () => fake.state } }));

import { audioCues } from './audioCueService';
import { sessionDotFacts, sessionDotState } from '@/components/sessionDot';
import type { Session } from '@/sync/storageTypes';

/** The reader, reduced to what the cue service actually asks it. */
function reader(overrides: Partial<{ focused: string | null; paused: boolean; speech: boolean }> = {}) {
    return {
        isEnabled: true,
        focusedSessionId: overrides.focused ?? null,
        isMicHeld: false,
        isPaused: overrides.paused ?? false,
        speechPending: overrides.speech ?? false,
        sayUrgent: () => {},
        cancelUrgent: () => {},
    };
}

describe('the working pulse and the dot are one decision', () => {
    /**
     * An hour on per test. The service is a singleton and carries its own
     * last-read stamp between tests, so a clock that ever moved backwards
     * would skip the ambient re-read and beat about the previous test's
     * session. `pauseSilencesCues.spec.ts` has the long version of this.
     */
    let clock = Date.now();
    let seq = 0;
    let session: string;

    /** A live snapshot the CLI would publish, at the current fake time. */
    function live(extra: Record<string, unknown> = {}) {
        return { at: clock, ...extra };
    }

    /** The main thread mid-turn: a `main` block is what says so. */
    function midTurn(extra: Record<string, unknown> = {}) {
        return live({ main: { startedAt: clock - 30_000, tokens: 6_600 }, ...extra });
    }

    function put(state: Record<string, unknown>): void {
        fake.state.sessions = { [session]: { presence: 'online', ...state } };
    }

    /** What the DOT makes of the session under test, through its own resolver. */
    function dot(): string {
        const stored = (fake.state.sessions as Record<string, Session>)[session];
        return sessionDotState(sessionDotFacts(stored, Date.now()), Date.now());
    }

    function run(ms: number): void {
        vi.advanceTimersByTime(ms);
    }

    /** Every ambient pulse heard so far, in order. */
    function pulses(): string[] {
        return fake.played.map((entry) => entry.id).filter((id) => id.startsWith('working') || id.startsWith('waiting'));
    }

    beforeEach(() => {
        clock += 3_600_000;
        vi.useFakeTimers();
        vi.setSystemTime(clock);
        seq += 1;
        session = `s${seq}`;
        fake.played = [];
        fake.warmed = [];
        fake.state.settings = { audioCues: { speakGates: false } };
        fake.state.sessions = {};
    });

    afterEach(() => {
        audioCues.stop();
        vi.useRealTimers();
    });

    it('pulses on a session mid-turn with NO subagents, which is the ask', () => {
        // DROVE-344's picture, in a fixture: the CLI is two minutes into a
        // turn, the fan-out is empty, and the phone used to draw green and say
        // nothing. `working:0` is the thump on its own (DROVE-209).
        put({ metadata: { liveStatus: midTurn() } });
        expect(dot()).toBe('working');
        audioCues.attach(reader({ focused: session }));
        run(3_000);
        expect(pulses()).toContain('working:0');
    });

    it('says nothing at all on a connected idle session', () => {
        // The other half, and the half a broad predicate gets wrong: a session
        // the CLI is publishing nothing about is not working, and silence is
        // already the right signal for idle.
        put({});
        expect(dot()).toBe('connected');
        audioCues.attach(reader({ focused: session }));
        run(10_000);
        expect(pulses()).toEqual([]);
    });

    it('pulses while a compaction runs, which nothing else says is work', () => {
        // DROVE-257's case. The transcript does not move for two minutes and
        // `thinking` went false at the response headers, so the CLI saying so
        // outright is the only fact there is.
        put({ metadata: { liveStatus: live({ compacting: { startedAt: clock - 60_000 } }) } });
        expect(dot()).toBe('compacting');
        audioCues.attach(reader({ focused: session }));
        run(3_000);
        expect(pulses()).toContain('working:0');
    });

    it('pulses for a background agent whose turn has already ended (DROVE-361)', () => {
        // `main` is null — the fan-out outlived the prompt — and the count in
        // the sound is the count on the row.
        put({
            metadata: {
                liveStatus: live({
                    agents: [
                        { id: 'a1', name: 'general-purpose', startedAt: clock - 5_000 },
                        { id: 'a2', name: 'general-purpose', startedAt: clock - 5_000 },
                    ],
                }),
            },
        });
        expect(dot()).toBe('working');
        audioCues.attach(reader({ focused: session }));
        run(3_000);
        expect(pulses()).toContain('working:2');
    });

    it('plays the WAITING pulse on a gate, never the heartbeat', () => {
        // A gate is what "waiting on Clay" means, and it is the state the whole
        // product exists to surface. The dot agrees here: amber, not blue.
        put({ agentState: { requests: { r1: { tool: 'AskUserQuestion', arguments: {} } } } });
        expect(dot()).toBe('waiting');
        audioCues.attach(reader({ focused: session }));
        run(3_000);
        const heard = pulses();
        expect(heard.length).toBeGreaterThan(0);
        expect(heard.every((id) => id.startsWith('waiting'))).toBe(true);
    });

    it('lets the gate win over a turn that is still running, and the dot does not', () => {
        // THE ONE PLACE THE TWO DIVERGE, pinned so it is a decision rather than
        // a drift. `statusDotState` puts working above waiting on purpose
        // (DROVE-231): the dot's blink means BURNING TOKENS RIGHT NOW and a
        // session mid-turn is doing that whatever is queued behind it. The
        // SOUND has the opposite job — it is the thing that has to reach him in
        // a pocket, and a gate nobody answers is the failure the cues exist to
        // prevent — so `ambientCueFor` takes the gate first, exactly as it did
        // before DROVE-385.
        //
        // What DROVE-385 shares is the WORKING term alone. Waiting was never
        // the dot's to decide here and still is not.
        put({
            metadata: { liveStatus: midTurn() },
            agentState: { requests: { r1: { tool: 'AskUserQuestion', arguments: {} } } },
        });
        expect(dot()).toBe('working');
        audioCues.attach(reader({ focused: session }));
        run(3_000);
        const heard = pulses();
        expect(heard.length).toBeGreaterThan(0);
        expect(heard.every((id) => id.startsWith('waiting'))).toBe(true);
    });

    it('says nothing about a session the phone cannot reach', () => {
        // Disconnected beats working in the dot's precedence for a reason, and
        // a heartbeat off a snapshot from a session that has gone is the sound
        // version of the same lie.
        fake.state.sessions = { [session]: { presence: clock - 10_000, metadata: { liveStatus: midTurn() } } };
        expect(dot()).toBe('recentlyDisconnected');
        audioCues.attach(reader({ focused: session }));
        run(10_000);
        expect(pulses()).toEqual([]);
    });

    it('hands the player BOTH numbers: the volume slider and the trim (DROVE-385)', () => {
        // The level is applied exactly once in each place — the slider is the
        // player's volume, the trim is in the rendered samples — so both have
        // to reach `cuePlayer` and neither may be folded into the other on the
        // way. This is what fails if a caller starts multiplying them.
        fake.state.settings = { audioCues: { speakGates: false, volume: 0.6, volumeVsVoiceDb: 5 } };
        put({ metadata: { liveStatus: midTurn() } });
        audioCues.attach(reader({ focused: session }));
        run(3_000);
        const beat = fake.played.find((entry) => entry.id.startsWith('working'));
        expect(beat).toBeDefined();
        expect(beat!.volume).toBe(0.6);
        expect(beat!.offsetDb).toBe(5);
        // The warm-up renders at the same trim, or the first beat of a session
        // plays at the old level and every later one at the new one.
        expect(fake.warmed.at(-1)?.offsetDb).toBe(5);
    });

    it('answers a press at the trim too, past the mixer', () => {
        // `ack` goes straight to the device (DROVE-225) and must not lose the
        // trim on the way; nor must the settings preview.
        fake.state.settings = { audioCues: { volume: 1, volumeVsVoiceDb: -4 } };
        audioCues.ack('micOpen');
        expect(fake.played.at(-1)).toEqual({ id: 'micOpen', volume: 1, offsetDb: -4 });
        audioCues.preview('working:0');
        expect(fake.played.at(-1)?.offsetDb).toBe(-4);
        // The settings row previews at the THUMB's level, not the stored one.
        audioCues.preview('working:0', 9);
        expect(fake.played.at(-1)?.offsetDb).toBe(9);
    });
});
