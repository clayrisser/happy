/**
 * A subagent's transcript rows, folded into the same Message objects a
 * session renders, and the cursor the poll hands back (DROVE-93).
 */
import { describe, expect, it } from 'vitest';

import {
    applySubagentTranscriptRows,
    createSubagentTranscriptState,
    describeSubagent,
    findSubagentRun,
    SUBAGENT_QUIET_MS,
} from './subagentTranscript';
import type { Message, ToolCall } from './typesMessage';

const iso = (ms: number) => new Date(ms).toISOString();
const usage = { input_tokens: 2, output_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 9000 };

/** The rows as the CLI puts them on the wire: `isSidechain` already false, no thinking signature. */
const rows = [
    { type: 'user', uuid: 'u1', parentUuid: null, isSidechain: false, agentId: 'a1', timestamp: iso(1000), message: { role: 'user', content: 'Implement DROVE-91 in the happy fork' } },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u1', isSidechain: false, agentId: 'a1', timestamp: iso(2000), message: { role: 'assistant', model: 'claude-fable-5', content: [{ type: 'thinking', thinking: 'plan it' }], usage } },
    { type: 'assistant', uuid: 'a2', parentUuid: 'a1', isSidechain: false, agentId: 'a1', timestamp: iso(2100), message: { role: 'assistant', model: 'claude-fable-5', content: [{ type: 'text', text: 'Reading the ticket first.' }], usage } },
    { type: 'assistant', uuid: 'a3', parentUuid: 'a2', isSidechain: false, agentId: 'a1', timestamp: iso(2200), message: { role: 'assistant', model: 'claude-fable-5', content: [{ type: 'tool_use', id: 'toolu_bash1', name: 'Bash', input: { command: 'ls', description: 'List files' } }], usage } },
    { type: 'user', uuid: 'u2', parentUuid: 'a3', isSidechain: false, agentId: 'a1', timestamp: iso(3000), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_bash1', content: 'a.ts\nb.ts' }] }, toolUseResult: { stdout: 'a.ts\nb.ts' } },
    { type: 'assistant', uuid: 'a4', parentUuid: 'u2', isSidechain: false, agentId: 'a1', timestamp: iso(4000), message: { role: 'assistant', model: 'claude-fable-5', content: [{ type: 'text', text: 'Pushed as 55c43f95. Done.' }], usage } },
];

describe('applySubagentTranscriptRows', () => {
    it('turns the fixture into the messages a session would draw, oldest at the bottom', () => {
        const state = applySubagentTranscriptRows(createSubagentTranscriptState(), rows, 4096);
        // Newest first, the inverted list's order.
        const kinds = state.messages.map((m) => (m.kind === 'agent-text' && m.isThinking ? 'thinking' : m.kind));
        expect(kinds).toEqual(['agent-text', 'tool-call', 'agent-text', 'thinking', 'user-text']);

        const prompt = state.messages[4];
        expect(prompt.kind === 'user-text' && prompt.text).toBe('Implement DROVE-91 in the happy fork');

        const tool = state.messages[1];
        expect(tool.kind).toBe('tool-call');
        if (tool.kind !== 'tool-call') return;
        expect(tool.tool.name).toBe('Bash');
        expect(tool.tool.state).toBe('completed');
        // toolUseResult wins over the block content, the same as in a session.
        expect(tool.tool.result).toEqual({ stdout: 'a.ts\nb.ts' });
        expect(tool.tool.input).toEqual({ command: 'ls', description: 'List files' });

        const final = state.messages[0];
        expect(final.kind === 'agent-text' && final.text).toBe('Pushed as 55c43f95. Done.');

        expect(state.cursor).toBe(4096);
        expect(state.startedAt).toBe(1000);
        expect(state.lastAt).toBe(4000);
        // input + output + cache creation, four assistant records.
        expect(state.tokens).toBe(4 * 107);
    });

    it('a later poll adds only its rows and moves the cursor, without duplicating what is there', () => {
        const first = applySubagentTranscriptRows(createSubagentTranscriptState(), rows.slice(0, 4), 1000);
        expect(first.messages).toHaveLength(4);
        // The tool call is still open.
        const open = first.messages[0];
        expect(open.kind === 'tool-call' && open.tool.state).toBe('running');

        const second = applySubagentTranscriptRows(first, rows.slice(4), 2000);
        expect(second.cursor).toBe(2000);
        expect(second.messages).toHaveLength(5);
        // The result closed the SAME card rather than adding a second one.
        const closed = second.messages.find((m) => m.kind === 'tool-call');
        expect(closed && closed.kind === 'tool-call' && closed.tool.state).toBe('completed');
        expect(closed?.id).toBe(open.id);
        expect(second.tokens).toBe(4 * 107);

        // The first state was not mutated: a React setter sees a new object.
        expect(first.messages).toHaveLength(4);
        expect(first.cursor).toBe(1000);

        // An empty poll changes nothing but the cursor.
        const third = applySubagentTranscriptRows(second, [], 2000);
        expect(third.messages.map((m) => m.id)).toEqual(second.messages.map((m) => m.id));
    });

    it('a sidechain flag left on a row is cleared rather than filed under a Task card', () => {
        const flagged = rows.map((row) => ({ ...row, isSidechain: true }));
        const state = applySubagentTranscriptRows(createSubagentTranscriptState(), flagged, 10);
        expect(state.messages).toHaveLength(5);
    });

    it('rows without a uuid or a timestamp still land, in order', () => {
        const bare = [
            { type: 'user', message: { role: 'user', content: 'hi' } },
            { type: 'assistant', message: { role: 'assistant', model: 'm', content: [{ type: 'text', text: 'hello' }] } },
        ];
        const state = applySubagentTranscriptRows(createSubagentTranscriptState(), bare, 1);
        expect(state.messages.map((m) => m.kind)).toEqual(['agent-text', 'user-text']);
        expect(state.messages[0].createdAt).toBeGreaterThan(state.messages[1].createdAt);
    });

    it('skips a row the normalizer has no shape for', () => {
        const state = applySubagentTranscriptRows(createSubagentTranscriptState(), [{ type: 'attachment', attachment: {} }], 1);
        expect(state.messages).toEqual([]);
    });
});

describe('describeSubagent', () => {
    const transcript = { startedAt: 1000, lastAt: 61_000, tokens: 310_800 };

    it('ticks off the phone clock while running', () => {
        const h = describeSubagent({ state: 'running', updatedAt: 61_000 }, transcript, 91_000);
        expect(h).toEqual({ state: 'running', runState: 'running', elapsedMs: 90_000, tokens: 310_800 });
    });

    it('says so when a running agent has gone quiet', () => {
        const now = 61_000 + SUBAGENT_QUIET_MS + 5_000;
        const h = describeSubagent({ state: 'running', updatedAt: 61_000 }, transcript, now);
        expect(h.quietMs).toBe(SUBAGENT_QUIET_MS + 5_000);
    });

    it('freezes the clock at the parent notification once done', () => {
        const h = describeSubagent({ state: 'done', updatedAt: 61_000, endedAt: 70_000 }, transcript, 999_000);
        expect(h).toEqual({ state: 'done', runState: 'finished', elapsedMs: 69_000, tokens: 310_800 });
    });

    it('falls back to the newest row when the parent never said', () => {
        const h = describeSubagent({ state: 'failed', updatedAt: 61_000 }, transcript, 999_000);
        expect(h.state).toBe('failed');
        expect(h.elapsedMs).toBe(60_000);
    });

    // DROVE-132. The screenshot on the ticket read `Running · 0s` for an
    // agent that had finished minutes earlier: the CLI could not be reached,
    // so the header had nothing, and nothing defaulted to running with a
    // clock that started when the screen opened.
    it('says it does not know rather than Running when nothing is readable', () => {
        expect(describeSubagent(null, { tokens: 0 }, 5)).toEqual({ state: 'unknown', runState: 'unknown', tokens: 0 });
    });

    it('prints no clock at all when it cannot read one', () => {
        expect(describeSubagent(null, { tokens: 0 }, 5).elapsedMs).toBeUndefined();
    });

    it('uses the run the session already recorded when the CLI is unreachable', () => {
        const h = describeSubagent(null, { tokens: 0 }, 999_000, { runState: 'finished', startedAt: 1000, durationMs: 69_000 });
        expect(h).toEqual({ state: 'unknown', runState: 'finished', elapsedMs: 69_000, tokens: 0 });
    });

    it('keeps ticking off a recorded start while the CLI is away', () => {
        const h = describeSubagent(null, { tokens: 0 }, 91_000, { runState: 'running', startedAt: 1_000 });
        expect(h.runState).toBe('running');
        expect(h.elapsedMs).toBe(90_000);
    });

    it('measures a finished run off its rows when the session recorded no duration', () => {
        const h = describeSubagent(null, transcript, 999_000, { runState: 'failed' });
        expect(h.runState).toBe('failed');
        expect(h.elapsedMs).toBe(60_000);
    });
});

const agentTool = (tool: Partial<ToolCall>): Message => ({
    kind: 'tool-call',
    id: 'm1',
    localId: null,
    createdAt: 1_000,
    children: [],
    tool: {
        name: 'Agent',
        state: 'completed',
        input: { description: 'Implement DROVE-132', subagent_type: 'general-purpose' },
        createdAt: 1_000,
        startedAt: 1_000,
        completedAt: 2_000,
        description: null,
        ...tool,
    } as ToolCall,
});

describe('findSubagentRun', () => {
    it('reads the terminal result DROVE-115 put on the launching call', () => {
        const messages = [agentTool({
            result: { isAsync: true, status: 'completed', agentId: 'a1', content: [{ type: 'text', text: 'done' }], totalDurationMs: 245_000 },
        })];
        expect(findSubagentRun(messages, 'a1')).toEqual({ runState: 'finished', startedAt: 1_000, durationMs: 245_000 });
    });

    it('reads a failure the same way', () => {
        const messages = [agentTool({ result: { status: 'killed', agentId: 'a1' } })];
        expect(findSubagentRun(messages, 'a1')?.runState).toBe('failed');
    });

    // The bug in the ticket's header. `agentRunState` answers `running` for
    // anything it cannot read, which is right for a card that must never draw
    // a working agent as dead and wrong for a header that would then assert a
    // state it does not have.
    it('reports nothing for a call still holding only the launch receipt', () => {
        const messages = [agentTool({ result: { isAsync: true, status: 'async_launched', agentId: 'a1' } })];
        expect(findSubagentRun(messages, 'a1')).toBeNull();
    });

    it('does report running while a synchronous Task call is still open', () => {
        const messages = [agentTool({ state: 'running', input: { description: 'x', agentId: 'a1' }, result: undefined })];
        expect(findSubagentRun(messages, 'a1')?.runState).toBe('running');
    });

    it('finds a call folded under another card', () => {
        const parent = agentTool({ result: { status: 'completed', agentId: 'other' } }) as Extract<Message, { kind: 'tool-call' }>;
        parent.children = [agentTool({ result: { status: 'completed', agentId: 'a1', totalDurationMs: 5_000 } })];
        expect(findSubagentRun([parent], 'a1')?.durationMs).toBe(5_000);
    });

    it('is null for an agent the session never launched', () => {
        expect(findSubagentRun([agentTool({ result: { status: 'completed', agentId: 'a1' } })], 'a2')).toBeNull();
    });
});
