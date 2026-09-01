import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message, ToolCallMessage } from './typesMessage';

vi.mock('@/components/tools/knownTools', () => ({
    knownTools: {
        Skill: { hidden: true },
    },
}));

vi.mock('@/text', () => ({
    t: (key: string, params?: { count?: number }) => {
        if (key === 'toolGroup.ranShellCommands') return `Ran ${params?.count} shell commands`;
        if (key === 'toolGroup.readFiles') return `Read ${params?.count} files`;
        return `${key}:${params?.count ?? ''}`;
    },
}));

// droverGates reads storage for the first-seen map; the row builder only
// takes its title and preview helpers, which never touch it.
vi.mock('./storage', () => ({ storage: { getState: () => ({ sessions: {} }) } }));

import {
    buildWristRows,
    createWristCoalescer,
    droverWristMoreTail,
    droverWristRowLimit,
    droverWristTextLimit,
    transcriptDelta,
    trimForWrist,
    rowKey,
} from './droverWatchTranscript';

function user(id: string, text: string, createdAt: number): Message {
    return { kind: 'user-text', id, localId: null, createdAt, text };
}

function agent(id: string, text: string, createdAt: number, isThinking = false): Message {
    return { kind: 'agent-text', id, localId: null, createdAt, text, isThinking };
}

function tool(
    id: string,
    name: string,
    createdAt: number,
    options: { state?: 'running' | 'completed' | 'error'; input?: unknown; permission?: ToolCallMessage['tool']['permission'] } = {},
): ToolCallMessage {
    const state = options.state ?? 'completed';
    return {
        kind: 'tool-call',
        id,
        localId: null,
        createdAt,
        tool: {
            name,
            state,
            input: options.input ?? { command: `echo ${id}` },
            createdAt,
            startedAt: createdAt,
            completedAt: state === 'running' ? null : createdAt + 1,
            description: null,
            ...(options.permission ? { permission: options.permission } : {}),
        },
        children: [],
    };
}

/** Newest first, as the store holds them. */
function newestFirst(...chronological: Message[]): Message[] {
    return [...chronological].reverse();
}

describe('trimForWrist', () => {
    it('leaves a short row alone', () => {
        expect(trimForWrist('hello there')).toBe('hello there');
    });

    it('cuts a long row to the limit and says the phone has the rest', () => {
        const text = 'word '.repeat(200).trim();
        const out = trimForWrist(text);
        expect(out.endsWith(droverWristMoreTail)).toBe(true);
        const head = out.slice(0, -droverWristMoreTail.length - 1);
        expect(head.length).toBeLessThanOrEqual(500);
        expect(head.length).toBeGreaterThan(400);
        // On a word boundary, not mid-word.
        expect(head.endsWith('word')).toBe(true);
    });

    it('cuts a wall with no spaces at the limit', () => {
        const out = trimForWrist('x'.repeat(600));
        expect(out).toBe(`${'x'.repeat(500)}\n${droverWristMoreTail}`);
    });

    it('a row exactly at the limit carries no tail', () => {
        expect(trimForWrist('y'.repeat(500))).toBe('y'.repeat(500));
    });
});

describe('buildWristRows', () => {
    it('orders oldest first with user, assistant, tools and gate rows told apart', () => {
        const messages = newestFirst(
            user('u1', 'fix the build', 1),
            tool('t1', 'Bash', 2),
            tool('t2', 'Bash', 3),
            tool('t3', 'Bash', 4),
            tool('t4', 'Bash', 5),
            tool('q1', 'AskUserQuestion', 6, {
                input: { questions: [{ header: 'Which', question: 'Which branch?' }] },
                permission: { id: 'req-1', status: 'pending' },
            }),
            agent('a1', 'Done.', 7),
        );
        const rows = buildWristRows(messages, { sessionId: 's1', thinking: false });
        expect(rows.map((r) => r.kind)).toEqual(['user', 'tools', 'gate', 'assistant']);
        expect(rows[0]).toMatchObject({ id: 'u1', text: 'fix the build', at: new Date(1).toISOString() });
        expect(rows[1].text).toBe('Ran 4 shell commands');
        expect(rows[1].streaming).toBeUndefined();
        expect(rows[2]).toMatchObject({ id: 'q1', gateId: 's1:req-1' });
        expect(rows[2].text).toBe('Which\nWhich branch?');
        expect(rows[3]).toMatchObject({ id: 'a1', text: 'Done.' });
        expect(rows[3].streaming).toBeUndefined();
    });

    it('a settled gate stays in the transcript with no gate id', () => {
        const messages = newestFirst(
            tool('q1', 'AskUserQuestion', 1, {
                input: { questions: [{ question: 'Proceed?' }] },
                permission: { id: 'req-1', status: 'approved' },
            }),
        );
        const [row] = buildWristRows(messages, { sessionId: 's1', thinking: false });
        expect(row.kind).toBe('gate');
        expect(row.gateId).toBeUndefined();
    });

    it('marks the newest assistant row streaming while the turn runs', () => {
        const rows = buildWristRows(newestFirst(user('u1', 'go', 1), agent('a1', 'On it', 2)), {
            sessionId: 's1',
            thinking: true,
        });
        expect(rows[1].streaming).toBe(true);
        expect(rows[0].streaming).toBeUndefined();
    });

    it('never marks a user row streaming, even when the turn runs', () => {
        const rows = buildWristRows(newestFirst(agent('a0', 'before', 1), user('u1', 'go', 2)), {
            sessionId: 's1',
            thinking: true,
        });
        expect(rows[1].streaming).toBeUndefined();
        expect(rows[0].streaming).toBeUndefined();
    });

    it('a run with a running member is streaming', () => {
        const rows = buildWristRows(
            newestFirst(tool('t1', 'Read', 1, { input: { file_path: '/a' } }), tool('t2', 'Read', 2, { state: 'running', input: { file_path: '/b' } })),
            { sessionId: 's1', thinking: false },
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ kind: 'tools', text: 'Read 2 files', streaming: true });
    });

    it('a lone tool call is one tools row with the phone activity label', () => {
        const rows = buildWristRows(newestFirst(tool('t1', 'Bash', 1, { input: { command: 'make test' } })), {
            sessionId: 's1',
            thinking: false,
        });
        expect(rows).toHaveLength(1);
        expect(rows[0].kind).toBe('tools');
        expect(rows[0].text).toContain('make test');
    });

    it('keeps the newest 30 rows and drops the rest', () => {
        const chronological: Message[] = [];
        for (let i = 0; i < 45; i++) chronological.push(user(`u${i}`, `m${i}`, i + 1));
        const rows = buildWristRows(newestFirst(...chronological), { sessionId: 's1', thinking: false });
        expect(rows).toHaveLength(30);
        expect(rows[0].id).toBe('u15');
        expect(rows[29].id).toBe('u44');
    });

    it('drops thinking, empty text and hidden tools', () => {
        const rows = buildWristRows(
            newestFirst(agent('th', 'pondering', 1, true), agent('e', '   ', 2), tool('sk', 'Skill', 3), user('u', 'hi', 4)),
            { sessionId: 's1', thinking: false },
        );
        expect(rows.map((r) => r.id)).toEqual(['u']);
    });

    it('trims a long reply to 500 characters with the tail', () => {
        const rows = buildWristRows(newestFirst(agent('a1', 'z'.repeat(2000), 1)), { sessionId: 's1', thinking: false });
        expect(rows[0].text).toBe(`${'z'.repeat(500)}\n${droverWristMoreTail}`);
    });
});

describe('transcriptDelta', () => {
    const rows = buildWristRows(newestFirst(user('u1', 'a', 1), agent('a1', 'b', 2)), { sessionId: 's1', thinking: false });

    it('carries every row the watch has not been sent', () => {
        const delta = transcriptDelta('s1', rows, false, new Map(), null, new Date(0));
        expect(delta).toMatchObject({ kind: 'transcript', sessionId: 's1', ids: ['u1', 'a1'], streaming: false });
        expect(delta?.rows.map((r) => r.id)).toEqual(['u1', 'a1']);
        expect(delta?.updatedAt).toBe(new Date(0).toISOString());
    });

    it('is null when nothing moved', () => {
        const sent = new Map(rows.map((r) => [r.id, rowKey(r)]));
        expect(transcriptDelta('s1', rows, false, sent, false)).toBeNull();
    });

    it('carries only the changed row, and the whole id list', () => {
        const sent = new Map(rows.map((r) => [r.id, rowKey(r)]));
        const grown = buildWristRows(newestFirst(user('u1', 'a', 1), agent('a1', 'b and more', 2)), {
            sessionId: 's1',
            thinking: false,
        });
        const delta = transcriptDelta('s1', grown, false, sent, false);
        expect(delta?.rows.map((r) => r.id)).toEqual(['a1']);
        expect(delta?.ids).toEqual(['u1', 'a1']);
    });

    it('a streaming flag flip alone is a delta', () => {
        const sent = new Map(rows.map((r) => [r.id, rowKey(r)]));
        const delta = transcriptDelta('s1', rows, true, sent, false);
        expect(delta?.rows).toEqual([]);
        expect(delta?.streaming).toBe(true);
    });

    it('a row falling off the window is a delta with no rows', () => {
        const sent = new Map(rows.map((r) => [r.id, rowKey(r)]));
        const delta = transcriptDelta('s1', rows.slice(1), false, sent, false);
        expect(delta?.ids).toEqual(['a1']);
        expect(delta?.rows).toEqual([]);
    });
});

describe('createWristCoalescer', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('folds a burst into one send at the end of the window', () => {
        const send = vi.fn();
        const coalescer = createWristCoalescer(send, 250);
        for (let i = 0; i < 10; i++) {
            coalescer.schedule('s1');
            vi.advanceTimersByTime(10);
        }
        expect(send).not.toHaveBeenCalled();
        vi.advanceTimersByTime(250);
        expect(send).toHaveBeenCalledTimes(1);
        expect(send).toHaveBeenCalledWith('s1');
    });

    it('sends at most four times a second under a steady stream', () => {
        const send = vi.fn();
        const coalescer = createWristCoalescer(send, 250);
        for (let ms = 0; ms < 1000; ms += 5) {
            coalescer.schedule('s1');
            vi.advanceTimersByTime(5);
        }
        expect(send).toHaveBeenCalledTimes(4);
    });

    it('a lone change goes out after one interval', () => {
        const send = vi.fn();
        const coalescer = createWristCoalescer(send, 250);
        coalescer.schedule('s1');
        vi.advanceTimersByTime(249);
        expect(send).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(send).toHaveBeenCalledTimes(1);
    });

    it('rations per session, not across them', () => {
        const send = vi.fn();
        const coalescer = createWristCoalescer(send, 250);
        coalescer.schedule('s1');
        coalescer.schedule('s2');
        vi.advanceTimersByTime(250);
        expect(send).toHaveBeenCalledTimes(2);
    });

    it('stop drops what was pending', () => {
        const send = vi.fn();
        const coalescer = createWristCoalescer(send, 250);
        coalescer.schedule('s1');
        coalescer.stop();
        vi.advanceTimersByTime(1000);
        expect(send).not.toHaveBeenCalled();
    });
});

/**
 * What the biggest possible delta weighs on the wire.
 *
 * The row cap and the text cap are the only things standing between a long
 * conversation and an oversized frame, and an oversized frame does not error
 * on the way out — Socket.IO CLOSES the socket (DROVE-211), and
 * WatchConnectivity's `sendMessage` is tighter still at roughly 64KB. Neither
 * failure names the transcript when it happens, so the ceiling is asserted
 * here rather than left to whoever next reaches for a bigger window.
 *
 * Raising either cap is allowed. Raising one past this line without moving
 * this line is what the test is for.
 */
describe('what a delta weighs', () => {
    /** WatchConnectivity's sendMessage limit, the tighter of the two wires. */
    const watchFrameLimit = 64 * 1024;

    /** Every row at its longest, every id long, the whole window changed. */
    function worstCaseDelta() {
        const sessionId = `sess-${'y'.repeat(36)}`;
        const messages: Message[] = [];
        for (let i = 0; i < droverWristRowLimit * 2; i++) {
            messages.push(agent(`msg-${'x'.repeat(30)}-${i}`, 'w'.repeat(droverWristTextLimit * 4), 1000 + i));
        }
        const rows = buildWristRows(newestFirst(...messages), { sessionId, thinking: true });
        return { sessionId, rows, delta: transcriptDelta(sessionId, rows, true, new Map(), null) };
    }

    it('caps the window at the row limit however long the conversation is', () => {
        const { rows } = worstCaseDelta();
        expect(rows).toHaveLength(droverWristRowLimit);
    });

    it('stays well inside the watch frame limit at its very worst', () => {
        const { delta } = worstCaseDelta();
        const bytes = Buffer.byteLength(JSON.stringify(delta), 'utf8');
        expect(bytes).toBeLessThan(watchFrameLimit);
        // Roughly 20KB today. The margin is the point: a frame that only just
        // fits is one product decision away from not fitting.
        expect(bytes).toBeLessThan(watchFrameLimit / 2);
    });

    it('never carries a row longer than the text limit plus its tail', () => {
        const { rows } = worstCaseDelta();
        const longest = Math.max(...rows.map((row) => row.text.length));
        expect(longest).toBeLessThanOrEqual(droverWristTextLimit + droverWristMoreTail.length + 1);
    });
});
