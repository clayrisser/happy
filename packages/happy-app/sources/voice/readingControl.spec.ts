/**
 * A terminal steering this phone's voice (DROVE-298).
 *
 * The rule under test is narrow on purpose: the phone DECIDES, and every
 * refusal is an answer rather than a workaround. The take-the-voice semantics
 * themselves are DROVE-297's and are pinned by its own specs; what is pinned
 * here is that a command from a terminal reaches exactly the same policy a
 * thumb does, and that the three things a terminal must never cause — audio it
 * did not ask for, a change nobody sees, a command that arrives late and acts
 * anyway — cannot happen.
 */

import { describe, expect, it } from 'vitest';

import {
    applyReadingCommand,
    readingCommandExpired,
    readingSnapshotOf,
    type ReadingCommand,
    type ReadingPolicy,
    type ReadingSessionRow,
    type ReadingSessionState,
} from './readingControl';

interface FakeState {
    /** The phone's default read-aloud switch: localSettings.readAloudEnabled. */
    defaultEnabled: boolean;
    /** Who has the voice. */
    holder: string | null;
    paused: boolean;
    known: string[];
    /** Armed sessions, which under DROVE-297 is per session and not one flag. */
    armed: string[];
    took: string[];
    disabled: string[];
    pauses: boolean[];
}

function fake(over: Partial<FakeState> = {}): { state: FakeState; policy: ReadingPolicy } {
    const state: FakeState = {
        defaultEnabled: true,
        holder: 'A',
        paused: false,
        known: ['A', 'B', 'C'],
        armed: ['A', 'B'],
        took: [],
        disabled: [],
        pauses: [],
        ...over,
    };
    const stateOf = (id: string): ReadingSessionState => {
        if (!state.armed.includes(id)) return 'off';
        if (state.holder !== id) return 'yielded';
        return state.paused ? 'paused' : 'reading';
    };
    const policy: ReadingPolicy = {
        report: () => ({
            session: state.holder,
            state: state.holder === null ? 'off' : stateOf(state.holder),
            sentence: state.holder ? 'The lane is green.' : null,
            defaultEnabled: state.defaultEnabled,
        }),
        knows: (id: string) => state.known.includes(id),
        isEnabled: (id: string) => state.armed.includes(id),
        setEnabled: (id: string, on: boolean) => {
            if (on) {
                // DROVE-297's rule, in the fake: enabling TAKES the voice.
                state.took.push(id);
                if (!state.armed.includes(id)) state.armed.push(id);
                state.holder = id;
                state.paused = false;
                return;
            }
            state.disabled.push(id);
            state.armed = state.armed.filter((s) => s !== id);
            if (state.holder === id) state.holder = null;
        },
        setPaused: (p: boolean) => {
            state.pauses.push(p);
            state.paused = p;
        },
        rows: (): ReadingSessionRow[] =>
            state.known
                .map((id) => ({ sessionId: id, enabled: true, state: stateOf(id), title: id }))
                .filter((row) => row.state !== 'off'),
        titleOf: (id: string) => id,
    };
    return { state, policy };
}

const cmd = (over: Partial<ReadingCommand> = {}): ReadingCommand => ({
    id: 'rd-1',
    verb: 'status',
    at: 1_000,
    ttlMs: 8_000,
    by: 'cli',
    ...over,
});

describe('the phone answers a terminal (DROVE-298)', () => {
    it('reports the truth for status, whatever the phone is set to', () => {
        const { policy } = fake({ defaultEnabled: false, holder: null, armed: [] });
        const v = applyReadingCommand(cmd({ verb: 'status' }), policy, 2_000);
        expect(v.applied).toBe(true);
        expect(v.state.global).toBe('off');
        expect(v.state.sessionId).toBeNull();
    });

    it('names the sentence and the session it is reading', () => {
        const { policy } = fake();
        const v = applyReadingCommand(cmd({ verb: 'status' }), policy, 2_000);
        expect(v.state.playing).toBe(true);
        expect(v.state.sessionId).toBe('A');
        expect(v.state.sentence).toBe('The lane is green.');
    });

    it('distinguishes yielded from off, which is what makes the rule legible', () => {
        // DROVE-297's visible half. A session that is ON and silent because
        // another took the voice is not the same thing as one that is OFF, and
        // a table that cannot tell them apart makes the behaviour mysterious.
        const { policy } = fake();
        const rows = readingSnapshotOf(policy).sessions;
        expect(rows.find((r) => r.sessionId === 'A')?.state).toBe('reading');
        expect(rows.find((r) => r.sessionId === 'B')?.state).toBe('yielded');
        // and C, which nobody armed, is not on the table at all
        expect(rows.find((r) => r.sessionId === 'C')).toBeUndefined();
    });

    it('gives a named session the voice through the ONE rule, not a second copy', () => {
        const { state, policy } = fake();
        const v = applyReadingCommand(cmd({ verb: 'on', sessionId: 'C' }), policy, 2_000);
        expect(v.applied).toBe(true);
        // It called setEnabled(), which is readAloud.setSessionEnabled, which
        // is DROVE-297's voiceMove. Nothing here decides what taking the voice
        // means; the composer's control reaches the same function.
        expect(state.took).toEqual(['C']);
        expect(state.holder).toBe('C');
        // and whoever had it is still on the list, holding its place
        expect(v.state.sessions.find((r) => r.sessionId === 'A')?.state).toBe('yielded');
    });

    it('pause and resume are the phone holding position, not a stop', () => {
        const { state, policy } = fake();
        expect(applyReadingCommand(cmd({ verb: 'pause' }), policy, 2_000).applied).toBe(true);
        expect(state.pauses).toEqual([true]);
        expect(state.holder).toBe('A');
        const v = applyReadingCommand(cmd({ id: 'rd-2', verb: 'resume' }), policy, 2_000);
        expect(v.applied).toBe(true);
        expect(state.pauses).toEqual([true, false]);
        expect(state.holder).toBe('A');
    });

    it('off releases the voice and is NOT a pause', () => {
        // DROVE-297's release: the voice goes quiet and nothing else claims it.
        // A terminal turning one session off must not start another talking.
        const { state, policy } = fake();
        const v = applyReadingCommand(cmd({ verb: 'off', sessionId: 'A' }), policy, 2_000);
        expect(v.applied).toBe(true);
        expect(state.disabled).toEqual(['A']);
        expect(state.pauses).toEqual([]);
        expect(v.state.sessionId).toBeNull();
        // B was armed and stays armed, and stays quiet
        expect(v.state.sessions.find((r) => r.sessionId === 'B')?.state).toBe('yielded');
    });
});

describe('the three things a terminal must never cause', () => {
    it('arming a session on a phone whose read-aloud is OFF is reported, never done', () => {
        // Clay's own words on the ticket: starting audio on a device in his
        // pocket from a terminal is a surprise. `on` is the only verb that can
        // make sound out of nothing, so it is the one that is gated — and
        // DROVE-297 put `defaultEnabled` on its report for exactly this check.
        const { state, policy } = fake({ defaultEnabled: false, armed: [], holder: null });
        const v = applyReadingCommand(cmd({ verb: 'on', sessionId: 'A' }), policy, 2_000);
        expect(v.applied).toBe(false);
        expect(v.reason).toContain('read aloud is off on the phone');
        expect(state.took).toEqual([]);
        expect(v.state.global).toBe('off');
    });

    it('but a session HE armed by hand is still steerable, default off or not', () => {
        // The default being off does not mean nothing is speaking: under
        // DROVE-297 arming is per session. Refusing to move the voice of a
        // session he switched on himself would refuse the remote control
        // exactly where it is most useful.
        const { state, policy } = fake({ defaultEnabled: false, armed: ['A'], holder: 'A' });
        expect(applyReadingCommand(cmd({ verb: 'pause' }), policy, 2_000).applied).toBe(true);
        expect(state.pauses).toEqual([true]);
        expect(applyReadingCommand(cmd({ id: 'rd-2', verb: 'off', sessionId: 'A' }), policy, 2_000).applied).toBe(true);
        expect(state.disabled).toEqual(['A']);
    });

    it('and nothing quieter than it was is ever refused for being off', () => {
        // `off` and `pause` only ever REMOVE audio. Gating them on the default
        // would be refusing the one direction that can never surprise him.
        const { policy } = fake({ defaultEnabled: false, armed: ['A'], holder: 'A' });
        expect(applyReadingCommand(cmd({ verb: 'off', sessionId: 'A' }), policy, 2_000).reason).toBeUndefined();
    });

    it('a session the phone does not know is refused BY NAME', () => {
        const { state, policy } = fake();
        const v = applyReadingCommand(cmd({ verb: 'on', sessionId: 'ZZ' }), policy, 2_000);
        expect(v.applied).toBe(false);
        expect(v.reason).toContain('does not know that session');
        expect(state.took).toEqual([]);
    });

    it('a command that arrives after its life is over does NOTHING', () => {
        // The surprise this whole ticket refuses: an app that was closed when
        // the ask went out, opening twenty minutes later and starting to talk.
        // The command carries its terminal's own patience, so a late one is a
        // dead letter rather than an instruction.
        const late = cmd({ verb: 'pause', at: 1_000, ttlMs: 8_000 });
        expect(readingCommandExpired(late, 9_001)).toBe(true);
        const { state, policy } = fake();
        const v = applyReadingCommand(late, policy, 9_001);
        expect(v.applied).toBe(false);
        expect(v.reason).toContain('expired');
        expect(state.pauses).toEqual([]);
    });

    it('a command with no life at all is treated as already dead', () => {
        expect(readingCommandExpired(cmd({ ttlMs: 0 }), 1_000)).toBe(true);
        expect(readingCommandExpired(cmd({ at: Number.NaN }), 1_000)).toBe(true);
    });
});

describe('refusals that are answers, not errors', () => {
    it('pausing silence says so instead of pretending', () => {
        const { policy } = fake({ holder: null });
        const v = applyReadingCommand(cmd({ verb: 'pause' }), policy, 2_000);
        expect(v.applied).toBe(false);
        expect(v.reason).toContain('nothing is reading');
    });

    it('resuming nothing says so instead of picking a session for him', () => {
        const { state, policy } = fake({ holder: null });
        const v = applyReadingCommand(cmd({ verb: 'resume' }), policy, 2_000);
        expect(v.applied).toBe(false);
        expect(state.took).toEqual([]);
    });

    it('on with no session named is refused rather than aimed at the focused one', () => {
        const { state, policy } = fake();
        const v = applyReadingCommand(cmd({ verb: 'on' }), policy, 2_000);
        expect(v.applied).toBe(false);
        expect(state.took).toEqual([]);
    });

    it('every refusal still carries the state, so one round trip is enough', () => {
        const { policy } = fake({ defaultEnabled: false, armed: [], holder: null });
        const v = applyReadingCommand(cmd({ verb: 'pause' }), policy, 2_000);
        expect(v.applied).toBe(false);
        expect(v.state.global).toBe('off');
    });
});
