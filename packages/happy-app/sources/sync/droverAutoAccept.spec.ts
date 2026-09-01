/**
 * Which gates one pass picks up, over a real store shape (DROVE-277).
 *
 * The classifier's spec proves the SHAPE rule on a synthetic entry. This one
 * proves the SCOPE rule on the same session records the app actually holds:
 * a mirrored card belongs to the lane whose Claude uuid raised it, so
 * switching auto-accept on for one lane must not answer the lane next to it.
 * Five lanes share one checkout on this machine and every one of their gates
 * lands in the SAME bridge session, so getting this wrong would not be a near
 * miss — it would answer everything.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('./storage', () => ({
    storage: { getState: () => ({ sessions: {} }), subscribe: () => () => {} },
}));
vi.mock('./ops', () => ({
    sessionAllow: vi.fn(async () => {}),
}));

import { autoAcceptPass } from './droverAutoAccept';
import type { GateSession } from './droverGates';

/** A gate as the bridge mirrors it: held by `bridge`, raised by a lane. */
function permission(claudeSessionId: string, id: string, over: Record<string, unknown> = {}) {
    return {
        [id]: {
            tool: 'Bash',
            arguments: { command: `echo ${id}` },
            createdAt: 1_000,
            droverOrigin: { sessionId: claudeSessionId },
            droverEvent: { kind: 'permission', title: 'Run Bash', reason: 'why', createdAt: 1_000 },
            ...over,
        },
    };
}

function store(requests: Record<string, unknown>, lanes: string[]): Record<string, GateSession> {
    const sessions: Record<string, GateSession> = {
        bridge: { agentState: { requests }, metadata: { path: '/repo' } },
    };
    for (const lane of lanes) {
        sessions[`happy-${lane}`] = { agentState: { requests: {} }, metadata: { claudeSessionId: lane } };
    }
    return sessions;
}

describe('scope: only the sessions that are switched on', () => {
    it('answers nothing at all when no session is on', () => {
        const sessions = store(permission('lane-a', 'g1'), ['lane-a']);
        expect(autoAcceptPass(sessions, new Set(), new Set())).toEqual({ answered: [], presented: [] });
    });

    it('answers the switched-on lane and leaves the neighbouring lane pending', () => {
        const sessions = store(
            { ...permission('lane-a', 'g1'), ...permission('lane-b', 'g2') },
            ['lane-a', 'lane-b'],
        );
        const pass = autoAcceptPass(sessions, new Set(['happy-lane-a']), new Set());
        expect(pass.answered).toEqual(['bridge:g1']);
        expect(pass.presented).toEqual([]);
    });

    it('leaves a gate the bridge could not attribute alone, rather than guessing it onto a lane', () => {
        // No `droverOrigin`. An older bridge sends none, and matching such a
        // card by cwd would put one lane's prompt on another lane's screen —
        // which for auto-accept means answering it.
        const sessions = store(permission('lane-a', 'g1', { droverOrigin: null }), ['lane-a']);
        expect(autoAcceptPass(sessions, new Set(['happy-lane-a']), new Set()).answered).toEqual([]);
    });

    it('answers a gate the switched-on session holds itself, when it came off the bus', () => {
        const sessions: Record<string, GateSession> = {
            'happy-solo': {
                agentState: { requests: permission('anything', 'g9') },
                metadata: { claudeSessionId: 'anything' },
            },
        };
        expect(autoAcceptPass(sessions, new Set(['happy-solo']), new Set()).answered).toEqual(['happy-solo:g9']);
    });
});

describe('shape: the non-boolean ones present, and say why', () => {
    it('presents a question and answers the permission beside it, in one pass', () => {
        const sessions = store({
            ...permission('lane-a', 'g1'),
            ...permission('lane-a', 'g2', {
                tool: 'AskUserQuestion',
                arguments: { questions: [{ header: 'Which?', question: 'Pick', options: [{ label: 'A' }] }] },
                droverEvent: { kind: 'question', title: 'Which?', createdAt: 1_000 },
            }),
        }, ['lane-a']);
        const pass = autoAcceptPass(sessions, new Set(['happy-lane-a']), new Set());
        expect(pass.answered).toEqual(['bridge:g1']);
        expect(pass.presented.map((p) => p.id)).toEqual(['bridge:g2']);
        expect(pass.presented[0].reason).toContain('not a boolean');
    });

    it('presents a to-do, which never expires and is nobody’s decision', () => {
        const sessions = store(permission('lane-a', 'g3', {
            tool: 'DroverTodo',
            arguments: { title: 'log in to the box', options: [{ id: 'done', label: 'Done' }] },
            droverEvent: { kind: 'todo', title: 'log in to the box', createdAt: 1_000 },
        }), ['lane-a']);
        const pass = autoAcceptPass(sessions, new Set(['happy-lane-a']), new Set());
        expect(pass.answered).toEqual([]);
        expect(pass.presented).toHaveLength(1);
    });
});

describe('one answer per gate', () => {
    it('skips a gate this process has already answered', () => {
        const sessions = store(permission('lane-a', 'g1'), ['lane-a']);
        const on = new Set(['happy-lane-a']);
        const first = autoAcceptPass(sessions, on, new Set());
        expect(first.answered).toEqual(['bridge:g1']);
        // The store does not update the instant the RPC leaves, so the very
        // next store change reads the same gate still pending. Without this
        // guard that is a second allow on the ledger for one decision.
        const second = autoAcceptPass(sessions, on, new Set(first.answered));
        expect(second.answered).toEqual([]);
        // And it is not reported as "presented" either: it is neither.
        expect(second.presented).toEqual([]);
    });

    it('counts a gate once even when two switched-on sessions can both see it', () => {
        const sessions = store(permission('lane-a', 'g1'), ['lane-a']);
        sessions['happy-dup'] = { agentState: { requests: {} }, metadata: { claudeSessionId: 'lane-a' } };
        const pass = autoAcceptPass(sessions, new Set(['happy-lane-a', 'happy-dup']), new Set());
        expect(pass.answered).toEqual(['bridge:g1']);
    });
});
