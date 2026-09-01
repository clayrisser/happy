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
} from './readingControl';

interface FakeState {
    global: boolean;
    focused: string | null;
    paused: boolean;
    known: string[];
    held: string[];
    took: string[];
    disabled: string[];
    pauses: boolean[];
}

function fake(over: Partial<FakeState> = {}): { state: FakeState; policy: ReadingPolicy } {
    const state: FakeState = {
        global: true,
        focused: 'A',
        paused: false,
        known: ['A', 'B', 'C'],
        held: ['B'],
        took: [],
        disabled: [],
        pauses: [],
        ...over,
    };
    const policy: ReadingPolicy = {
        globalEnabled: () => state.global,
        speaking: () => ({
            sessionId: state.focused,
            playing: state.focused !== null && !state.paused,
            sentence: state.focused ? 'The lane is green.' : null,
        }),
        knows: (id) => state.known.includes(id),
        take: (id) => {
            state.took.push(id);
            if (state.focused && state.focused !== id) state.held.push(state.focused);
            state.focused = id;
            state.paused = false;
        },
        disable: (id) => {
            state.disabled.push(id);
            if (state.focused === id) state.focused = null;
        },
        setPaused: (p) => {
            state.pauses.push(p);
            state.paused = p;
        },
        rows: (): ReadingSessionRow[] => [
            ...(state.focused
                ? [{ sessionId: state.focused, enabled: true, state: state.paused ? ('paused' as const) : ('speaking' as const), title: state.focused }]
                : []),
            ...state.held
                .filter((id) => id !== state.focused)
                .map((id) => ({ sessionId: id, enabled: true, state: 'yielded' as const, title: id })),
        ],
        titleOf: (id) => id,
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
        const { policy } = fake({ global: false, focused: null });
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
        expect(rows.find((r) => r.sessionId === 'A')?.state).toBe('speaking');
        expect(rows.find((r) => r.sessionId === 'B')?.state).toBe('yielded');
    });

    it('gives a named session the voice through the ONE policy, not a second copy', () => {
        const { state, policy } = fake();
        const v = applyReadingCommand(cmd({ verb: 'on', sessionId: 'C' }), policy, 2_000);
        expect(v.applied).toBe(true);
        // It called take(), which is DROVE-297's rule. Nothing here decides
        // what taking the voice means; a thumb reaches the same function.
        expect(state.took).toEqual(['C']);
        expect(state.focused).toBe('C');
        // and whoever had it is still on the list, holding its place
        expect(v.state.sessions.find((r) => r.sessionId === 'A')?.state).toBe('yielded');
    });

    it('pause and resume are the phone holding position, not a stop', () => {
        const { state, policy } = fake();
        expect(applyReadingCommand(cmd({ verb: 'pause' }), policy, 2_000).applied).toBe(true);
        expect(state.pauses).toEqual([true]);
        expect(state.focused).toBe('A');
        const v = applyReadingCommand(cmd({ id: 'rd-2', verb: 'resume' }), policy, 2_000);
        expect(v.applied).toBe(true);
        expect(state.pauses).toEqual([true, false]);
        expect(state.focused).toBe('A');
    });

    it('off gives up the voice and is NOT a pause', () => {
        const { state, policy } = fake();
        const v = applyReadingCommand(cmd({ verb: 'off', sessionId: 'A' }), policy, 2_000);
        expect(v.applied).toBe(true);
        expect(state.disabled).toEqual(['A']);
        expect(state.pauses).toEqual([]);
        expect(v.state.sessionId).toBeNull();
    });
});

describe('the three things a terminal must never cause', () => {
    it('reading off on the phone is REPORTED, never quietly switched on', () => {
        // Clay's own words on the ticket: starting audio on a device in his
        // pocket from a terminal is a surprise. So every mutating verb refuses
        // and says why, and nothing on the reader is touched.
        const { state, policy } = fake({ global: false });
        for (const verb of ['on', 'off', 'pause', 'resume'] as const) {
            const v = applyReadingCommand(
                cmd({ verb, sessionId: verb === 'on' || verb === 'off' ? 'A' : undefined }),
                policy,
                2_000,
            );
            expect(v.applied).toBe(false);
            expect(v.reason).toContain('read aloud is off on the phone');
        }
        expect(state.took).toEqual([]);
        expect(state.disabled).toEqual([]);
        expect(state.pauses).toEqual([]);
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
        const { policy } = fake({ focused: null });
        const v = applyReadingCommand(cmd({ verb: 'pause' }), policy, 2_000);
        expect(v.applied).toBe(false);
        expect(v.reason).toContain('nothing is reading');
    });

    it('resuming nothing says so instead of picking a session for him', () => {
        const { state, policy } = fake({ focused: null });
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
        const { policy } = fake({ global: false });
        const v = applyReadingCommand(cmd({ verb: 'pause' }), policy, 2_000);
        expect(v.state.global).toBe('off');
        expect(v.state.sessions.length).toBeGreaterThan(0);
    });
});
