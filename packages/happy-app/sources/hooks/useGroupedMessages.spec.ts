import { describe, expect, it, vi } from 'vitest';
import { Message, ToolCallMessage } from '@/sync/typesMessage';
import { groupMessagesForDisplay } from './useGroupedMessages';

vi.mock('@/components/tools/knownTools', () => ({
    knownTools: {},
}));

vi.mock('@/text', () => ({
    t: (key: string, params?: { count?: number }) => `${key}:${params?.count ?? ''}`,
}));

function tool(id: string, name: string, createdAt: number, state: ToolCallMessage['tool']['state'] = 'completed'): ToolCallMessage {
    return {
        kind: 'tool-call',
        id,
        localId: null,
        createdAt,
        tool: {
            name,
            state,
            input: { command: id },
            createdAt,
            startedAt: createdAt,
            completedAt: state === 'running' ? null : createdAt + 1,
            description: id,
        },
        children: [],
    };
}

function agentText(id: string, createdAt: number): Message {
    return { kind: 'agent-text', id, localId: null, createdAt, text: 'Done.' };
}

function userText(id: string, createdAt: number): Message {
    return { kind: 'user-text', id, localId: null, createdAt, text: 'do it' };
}

function newestFirst(chronological: Message[]): Message[] {
    return [...chronological].reverse();
}

const finishedTurn = newestFirst([
    userText('user', 1),
    tool('b1', 'Bash', 2),
    tool('b2', 'Bash', 3),
    tool('r1', 'Read', 4),
    agentText('answer', 5),
]);

/**
 * What the Fold Finished Turns switch (`groupToolCalls`) actually decides
 * (DROVE-175). Off is not "every call on its own": a run of one tool still
 * folds into one row (DROVE-84). On is what the switch adds: a finished turn
 * collapses into one work row above its answer.
 */
describe('groupMessagesForDisplay', () => {
    it('off: folds a run of one tool into one row and never a work group', () => {
        const items = groupMessagesForDisplay(finishedTurn, false);
        expect(items.map((item) => item.type)).toEqual(['message', 'message', 'tool-group', 'message']);
        expect(items.map((item) => item.id)).toEqual(['answer', 'r1', 'group-b1', 'user']);
        expect(items.some((item) => item.type === 'agent-work-group')).toBe(false);
    });

    it('on: folds the whole finished turn into one work row above the answer', () => {
        const items = groupMessagesForDisplay(finishedTurn, true);
        expect(items.map((item) => item.type)).toEqual(['message', 'agent-work-group', 'message']);
        const work = items[1];
        if (work.type !== 'agent-work-group') throw new Error('expected a work group');
        expect(work.messages.map((msg) => msg.id)).toEqual(['r1', 'b2', 'b1']);
        expect(work.completedAt).toBe(5);
    });

    it('on: leaves the turn still running as rows, with the live call on its own', () => {
        const running = newestFirst([
            userText('user', 1),
            tool('b1', 'Bash', 2),
            tool('b2', 'Bash', 3),
            tool('b3', 'Bash', 4, 'running'),
        ]);
        const items = groupMessagesForDisplay(running, true, { collapseCurrentTurn: false });
        expect(items.map((item) => item.id)).toEqual(['b3', 'group-b1', 'user']);
        expect(items.some((item) => item.type === 'agent-work-group')).toBe(false);
    });
});
