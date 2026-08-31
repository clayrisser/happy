/**
 * THE SAME DOT IN THE LIST AS IN THE SESSION (DROVE-243).
 *
 * Clay, circling the dot on a session row: "Shouldn't this dot match the dot in
 * the session." These pin the two halves of the answer. First that a session's
 * facts land on DROVE-231's states at all, so the list speaks the vocabulary he
 * wrote. Second that a row and the session's own surfaces read the SAME state
 * off the SAME session, and differ in exactly one respect, which is the blink.
 */
import { describe, expect, it } from 'vitest';
import type { Session } from '@/sync/storageTypes';
import { CONTEXT_COMPACTION_PERCENT } from './contextCompaction';
import {
    SESSION_ROW_DOT_BLINKS,
    sessionDotFacts,
    sessionDotPresentation,
    sessionDotState,
    sessionRowDot,
    idleSessionDotFacts,
} from './sessionDot';
import {
    DISCONNECT_RECENT_MS,
    statusDotBlinks,
    statusDotColors,
    statusDotLabels,
    type StatusDotState,
} from './statusDotState';

const now = 1_700_000_000_000;
const window = 200_000;
const compactionAt = Math.round(window * (CONTEXT_COMPACTION_PERCENT / 100));

function session(overrides: Partial<Session> = {}): Session {
    return {
        id: 'session',
        seq: 1,
        createdAt: now - 60_000,
        updatedAt: now,
        active: true,
        activeAt: now,
        metadata: null,
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        ...overrides,
    } as Session;
}

/** A session whose CLI is publishing, with the main thread working. */
function working(extra: Record<string, unknown> = {}, session_: Partial<Session> = {}): Session {
    return session({
        metadata: {
            liveStatus: { at: now, main: { startedAt: now - 5_000 }, ...extra },
        } as never,
        ...session_,
    });
}

function usage(contextSize: number) {
    return {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreation: 0,
        cacheRead: 0,
        contextSize,
        contextWindow: window,
        timestamp: now,
    };
}

const stateOf = (s: Session, at = now) => sessionDotState(sessionDotFacts(s, at), at);

describe('a session lands on Clay\'s table', () => {
    it('is green while it is up and idle, and never grey', () => {
        const state = stateOf(session());
        expect(state).toBe('connected');
        // The bug this ticket is named for: `ActiveSessionsGroupCompact` drew
        // `textSecondary` here, so a live session wore grey in the list while
        // its own strip drew green.
        expect(sessionRowDot(sessionDotFacts(session(), now), now).color).toBe('#34C759');
    });

    it('is blue while the main thread works', () => {
        expect(stateOf(working())).toBe('working');
    });

    it('is blue on a session that only reports `thinking`', () => {
        // No live snapshot at all: an older CLI, a Rig session, or the seconds
        // before the first publish. A list row cannot go green through a turn.
        expect(stateOf(session({ thinking: true }))).toBe('working');
    });

    it('is amber while a permission is waiting', () => {
        const held = session({ agentState: { requests: { one: {} } } as never });
        expect(stateOf(held)).toBe('waiting');
        expect(statusDotColors[stateOf(held)]).toBe('#FF9500');
    });

    it('is purple while compacting: working, no tool, at the compaction point', () => {
        const compacting = working({}, { latestUsage: usage(compactionAt) });
        expect(stateOf(compacting)).toBe('compacting');
    });

    it('stays blue at the compaction point while a TOOL is running', () => {
        const tool = working(
            { tool: { id: 't', name: 'Bash', startedAt: now - 1_000 } },
            { latestUsage: usage(compactionAt) },
        );
        expect(stateOf(tool)).toBe('working');
    });

    it('is yellow just after it drops and red once it has been gone a while', () => {
        const dropped = session({ presence: now, active: false, activeAt: now });
        expect(stateOf(dropped, now + DISCONNECT_RECENT_MS - 1)).toBe('recentlyDisconnected');
        expect(stateOf(dropped, now + DISCONNECT_RECENT_MS)).toBe('disconnected');
    });

    it('reads when it dropped off `presence`, and forgets it while up', () => {
        expect(sessionDotFacts(session({ presence: now - 1_000 }), now).lastSeenAt).toBe(now - 1_000);
        // Null on a live session, so a heartbeat cannot churn every row.
        expect(sessionDotFacts(session(), now).lastSeenAt).toBeNull();
    });

    it('ignores a live snapshot that has gone stale', () => {
        const stale = working({ at: now - 10 * 60_000 });
        expect(stateOf(stale)).toBe('connected');
    });
});

describe('the row and the session draw the same dot', () => {
    const cases: { name: string; session: Session; at?: number }[] = [
        { name: 'idle', session: session() },
        { name: 'working', session: working() },
        { name: 'thinking with no snapshot', session: session({ thinking: true }) },
        { name: 'compacting', session: working({}, { latestUsage: usage(compactionAt) }) },
        {
            name: 'waiting on a permission',
            session: session({ agentState: { requests: { one: {} } } as never }),
        },
        {
            name: 'just dropped',
            session: session({ presence: now - 1_000, active: false }),
        },
        {
            name: 'gone a while',
            session: session({ presence: now - 10 * 60_000, active: false }),
            at: now,
        },
    ];

    for (const entry of cases) {
        const at = entry.at ?? now;
        const facts = sessionDotFacts(entry.session, at);

        it(`agrees on the state and the hue: ${entry.name}`, () => {
            const row = sessionRowDot(facts, at);
            const inside = sessionDotPresentation(facts, at);
            expect(row.state).toBe(inside.state);
            expect(row.color).toBe(inside.color);
            // One palette, not a copy of it.
            expect(row.color).toBe(statusDotColors[row.state]);
            expect(row.label).toBe(statusDotLabels[row.state]);
        });

        it(`blinks exactly as the strip does: ${entry.name}`, () => {
            // Clay overruled the row-takes-the-hue-only rule: he asked twice
            // for this dot to match the one in the session, so the motion
            // matches too. Same state, same colour, same blink.
            const row = sessionRowDot(facts, at);
            const inside = sessionDotPresentation(facts, at);
            expect(row.isPulsing).toBe(inside.isPulsing);
            expect(inside.isPulsing).toBe(statusDotBlinks(inside.state));
        });
    }
});

describe('the row takes the strip\'s motion too, by Clay\'s call', () => {
    it('pulses for exactly the two states that pulse inside the session', () => {
        expect(SESSION_ROW_DOT_BLINKS).toBe(true);
        const blinking: StatusDotState[] = ['working', 'compacting'];
        for (const state of blinking) expect(statusDotBlinks(state)).toBe(true);
        for (const entry of [working(), working({}, { latestUsage: usage(compactionAt) })]) {
            const facts = sessionDotFacts(entry, now);
            expect(blinking).toContain(sessionDotState(facts, now));
            expect(sessionRowDot(facts, now).isPulsing).toBe(statusDotBlinks(sessionDotState(facts, now)));
        }
    });

    it('still says the state in words, since the dot stopped moving', () => {
        const facts = sessionDotFacts(working(), now);
        expect(sessionRowDot(facts, now).label).toBe('Working');
    });
});

describe('the fallback facts', () => {
    it('draw a live idle session, so a row with nothing published is green', () => {
        expect(sessionRowDot(idleSessionDotFacts, now).color).toBe(statusDotColors.connected);
    });
});
