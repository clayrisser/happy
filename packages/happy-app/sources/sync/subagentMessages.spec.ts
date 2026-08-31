/**
 * A row inside a consolidated card on an AGENT screen (DROVE-166).
 *
 * The main-transcript case has passed since DROVE-152 and did not catch this,
 * because the two differ in the only thing that matters: the ids on an agent
 * screen belong to the agent's transcript, which the session's message map
 * has never held. So the whole trip is asserted here, not just the string:
 * fold real transcript rows, consolidate them the way the screen does, route
 * each row, then open the route the way the detail screen opens it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    clearSubagentMessages,
    getSubagentMessage,
    getSubagentMessages,
    hasSubagentScope,
    publishSubagentMessages,
    resetSubagentMessages,
} from './subagentMessages';
import { applySubagentTranscriptRows, createSubagentTranscriptState } from './subagentTranscript';
import type { Message, ToolCallMessage } from './typesMessage';
import { groupToolCallsForDisplay } from '@/hooks/useGroupedMessages';
import { getToolRowRoute } from '@/utils/toolRowRoute';
import { groupSameToolRuns } from '@/utils/toolRunGroups';

vi.mock('@/components/tools/knownTools', () => ({ knownTools: {} }));
vi.mock('@/text', () => ({
    t: (key: string, params?: { count?: number }) => `${key}:${params?.count ?? ''}`,
}));

const sessionId = 'sess-1';
const agentId = 'agent-7';

const iso = (ms: number) => new Date(ms).toISOString();

function use(uuid: string, at: number, callId: string, name: string, input: unknown) {
    return {
        type: 'assistant',
        uuid,
        isSidechain: false,
        agentId,
        timestamp: iso(at),
        message: { role: 'assistant', model: 'claude-fable-5', content: [{ type: 'tool_use', id: callId, name, input }] },
    };
}

function result(uuid: string, at: number, callId: string, stdout: string) {
    return {
        type: 'user',
        uuid,
        isSidechain: false,
        agentId,
        timestamp: iso(at),
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: callId, content: stdout }] },
        toolUseResult: { stdout },
    };
}

/** What the CLI serves for an agent that ran six commands and edited a file. */
const rows = [
    { type: 'user', uuid: 'u1', isSidechain: false, agentId, timestamp: iso(1000), message: { role: 'user', content: 'Fix DROVE-166' } },
    use('a1', 1100, 'call-b1', 'Bash', { command: 'ls' }),
    result('r1', 1200, 'call-b1', 'a.ts'),
    use('a2', 1300, 'call-b2', 'Bash', { command: 'git status' }),
    result('r2', 1400, 'call-b2', 'clean'),
    use('a3', 1500, 'call-b3', 'Bash', { command: 'pnpm tsc' }),
    result('r3', 1600, 'call-b3', 'ok'),
    use('a4', 1700, 'call-r1', 'Read', { file_path: '/tmp/a.ts' }),
    result('rr1', 1800, 'call-r1', 'source'),
    use('a5', 1900, 'call-r2', 'Read', { file_path: '/tmp/b.ts' }),
    result('rr2', 2000, 'call-r2', 'source'),
    use('a6', 2100, 'call-e1', 'Edit', { file_path: '/tmp/a.ts' }),
    result('re1', 2200, 'call-e1', 'edited'),
    { type: 'assistant', uuid: 'a7', isSidechain: false, agentId, timestamp: iso(2300), message: { role: 'assistant', model: 'claude-fable-5', content: [{ type: 'text', text: 'Done.' }] } },
];

function transcript(only = rows) {
    return applySubagentTranscriptRows(createSubagentTranscriptState(), only, 4096);
}

/**
 * What `session/[id]/message/[messageId].tsx` does with a route: read the
 * agent off the query, and read the message out of that agent's published
 * scope when there is one, out of the session's own map when there is not.
 */
function openRow(route: string, sessionMessages: Record<string, Message> = {}): Message | null {
    const [path, query] = route.split('?');
    const [, , routeSessionId, kind, messageId] = path.split('/');
    if (kind !== 'message') return null;
    const scope = new URLSearchParams(query ?? '').get('agentId');
    if (hasSubagentScope(routeSessionId, scope)) {
        return getSubagentMessage(routeSessionId, scope, messageId);
    }
    return sessionMessages[messageId] ?? null;
}

function toolRows(items: ReturnType<typeof groupSameToolRuns>): ToolCallMessage[] {
    const out: ToolCallMessage[] = [];
    for (const item of items) {
        if (item.type !== 'tool-group') continue;
        for (const message of item.messages) {
            if (message.kind === 'tool-call') out.push(message);
        }
    }
    return out;
}

afterEach(() => {
    resetSubagentMessages();
});

describe('a row inside a consolidated card on an agent screen', () => {
    it('opens the command it stands for', () => {
        const state = transcript();
        publishSubagentMessages(sessionId, agentId, state.messagesMap);

        const shell = groupSameToolRuns(state.messages)
            .find((item) => item.type === 'tool-group' && item.runCategory === 'terminal');
        expect(shell?.type).toBe('tool-group');
        if (shell?.type !== 'tool-group') return;
        expect(shell.messages).toHaveLength(3);

        for (const message of shell.messages) {
            if (message.kind !== 'tool-call') continue;
            const route = getToolRowRoute({ sessionId, agentId, messageId: message.id, tool: message.tool });
            expect(route).toBe(`/session/${sessionId}/message/${message.id}?agentId=${agentId}`);
            // The same object the row was drawn from, not a copy and not null.
            expect(openRow(String(route))).toBe(message);
        }
    });

    it('resolved to nothing while the route named only the session, which is why it looked dead', () => {
        const state = transcript();
        publishSubagentMessages(sessionId, agentId, state.messagesMap);
        const [first] = toolRows(groupSameToolRuns(state.messages));

        const oldRoute = getToolRowRoute({ sessionId, messageId: first.id, tool: first.tool });
        expect(oldRoute).toBe(`/session/${sessionId}/message/${first.id}`);
        // The session's map is what that route asks, and it has never held an
        // agent's rows. The detail screen found nothing and popped back.
        expect(openRow(String(oldRoute))).toBeNull();
    });

    it('covers every foldable family, and sends an edit row to the file the session already reads', () => {
        const state = transcript();
        publishSubagentMessages(sessionId, agentId, state.messagesMap);

        const families = new Set<string>();
        for (const message of toolRows(groupSameToolRuns(state.messages))) {
            families.add(message.tool.name);
            const route = String(getToolRowRoute({ sessionId, agentId, messageId: message.id, tool: message.tool }));
            if (message.tool.name === 'Edit') {
                // A file is read off the machine by path, and the session is
                // the same one either way, so this route carries no agent.
                expect(route).toBe(`/session/${sessionId}/file?path=${btoa('/tmp/a.ts')}`);
                continue;
            }
            expect(openRow(route)).toBe(message);
        }
        expect(families).toEqual(new Set(['Bash', 'Read']));
    });

    it('opens a group nested inside an agent work card the same way', () => {
        const state = transcript();
        publishSubagentMessages(sessionId, agentId, state.messagesMap);

        // How AgentWorkGroupView folds its children: single calls grouped too,
        // so every tool row on the screen sits inside a group.
        const nested = groupToolCallsForDisplay(state.messages, true, { groupSingleToolCalls: true });
        const rowsInGroups = toolRows(nested);
        expect(rowsInGroups.length).toBe(6);

        for (const message of rowsInGroups) {
            if (message.tool.name === 'Edit') continue;
            const route = String(getToolRowRoute({ sessionId, agentId, messageId: message.id, tool: message.tool }));
            expect(openRow(route)).toBe(message);
        }
    });

    it('follows a command that was still running when the row was tapped', () => {
        const open = transcript(rows.slice(0, 2));
        publishSubagentMessages(sessionId, agentId, open.messagesMap);
        const [running] = toolRows(groupToolCallsForDisplay(open.messages, true, { groupSingleToolCalls: true }));
        expect(running.tool.state).toBe('running');

        const route = String(getToolRowRoute({ sessionId, agentId, messageId: running.id, tool: running.tool }));
        expect(openRow(route)).toBe(running);

        // The next poll closes the call. The route did not change, and it now
        // reads the finished one.
        const closed = applySubagentTranscriptRows(open, rows.slice(2, 3), 200);
        publishSubagentMessages(sessionId, agentId, closed.messagesMap);
        const after = openRow(route);
        expect(after?.kind === 'tool-call' && after.tool.state).toBe('completed');
        expect(after?.kind === 'tool-call' && after.tool.result).toEqual({ stdout: 'a.ts' });
    });

    it('keeps two agents in one session apart', () => {
        const mine = transcript();
        publishSubagentMessages(sessionId, agentId, mine.messagesMap);
        publishSubagentMessages(sessionId, 'agent-other', {});
        const [first] = toolRows(groupSameToolRuns(mine.messages));

        expect(openRow(`/session/${sessionId}/message/${first.id}?agentId=agent-other`)).toBeNull();
        expect(openRow(`/session/${sessionId}/message/${first.id}?agentId=${agentId}`)).toBe(first);
    });

    /**
     * The reader needs the WHOLE transcript, not one row (DROVE-195): a tap on
     * a sentence means "read from here on", and "on" is the rest of the
     * agent's work.
     */
    it('hands the whole published transcript over for reading', () => {
        const state = transcript();
        publishSubagentMessages(sessionId, agentId, state.messagesMap);
        const all = getSubagentMessages(sessionId, agentId);
        expect(all.length).toBe(Object.keys(state.messagesMap).length);
        expect(all.length).toBeGreaterThan(0);

        // A scope nobody published is empty rather than throwing, so a tap
        // arriving a frame before the first poll lands does nothing.
        expect(getSubagentMessages(sessionId, 'agent-nobody')).toEqual([]);
        expect(getSubagentMessages(null, agentId)).toEqual([]);

        clearSubagentMessages(sessionId, agentId);
        expect(getSubagentMessages(sessionId, agentId)).toEqual([]);
    });

    it('lets the scope go when the agent screen does', () => {
        const state = transcript();
        publishSubagentMessages(sessionId, agentId, state.messagesMap);
        expect(hasSubagentScope(sessionId, agentId)).toBe(true);
        clearSubagentMessages(sessionId, agentId);
        expect(hasSubagentScope(sessionId, agentId)).toBe(false);
        expect(getSubagentMessage(sessionId, agentId, 'anything')).toBeNull();
    });
});
