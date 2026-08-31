import { describe, expect, it, vi } from 'vitest';
import { Message, ToolCallMessage } from '@/sync/typesMessage';
import { getToolRunCategory, groupSameToolRuns, isGateCard, toolRunLabel } from './toolRunGroups';

vi.mock('@/components/tools/knownTools', () => ({
    knownTools: {
        Skill: { hidden: true },
    },
}));

vi.mock('@/text', () => ({
    t: (key: string, params?: { count?: number }) => `${key}:${params?.count ?? ''}`,
}));

type ToolOptions = {
    state?: ToolCallMessage['tool']['state'];
    permission?: ToolCallMessage['tool']['permission'];
};

function tool(id: string, name: string, createdAt: number, options: ToolOptions = {}): ToolCallMessage {
    const state = options.state ?? 'completed';
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
            ...(options.permission ? { permission: options.permission } : {}),
        },
        children: [],
    };
}

function agentText(id: string, createdAt: number, text = 'Looking at the output.'): Message {
    return { kind: 'agent-text', id, localId: null, createdAt, text };
}

function thinking(id: string, createdAt: number, text: string): Message {
    return { kind: 'agent-text', id, localId: null, createdAt, text, isThinking: true };
}

function userText(id: string, createdAt: number): Message {
    return { kind: 'user-text', id, localId: null, createdAt, text: 'do it' };
}

/** Builds the newest-first array the inverted list hands the grouping. */
function newestFirst(chronological: Message[]): Message[] {
    return [...chronological].reverse();
}

function ids(items: ReturnType<typeof groupSameToolRuns>): string[] {
    return items.map((item) => item.id);
}

describe('groupSameToolRuns', () => {
    it('folds a run of four Bash calls into one group reading "Ran 4 shell commands"', () => {
        const items = groupSameToolRuns(newestFirst([
            userText('user', 1),
            tool('b1', 'Bash', 2),
            tool('b2', 'Bash', 3),
            tool('b3', 'Bash', 4),
            tool('b4', 'Bash', 5),
        ]));

        expect(ids(items)).toEqual(['group-b1', 'user']);
        const group = items[0];
        expect(group.type).toBe('tool-group');
        if (group.type !== 'tool-group') return;
        expect(group.messages.map((msg) => msg.id)).toEqual(['b1', 'b2', 'b3', 'b4']);
        expect(group.runCategory).toBe('terminal');
        expect(group.hasRunning).toBe(false);
        expect(group.hasError).toBe(false);
        expect(group.hasPendingPermission).toBe(false);
        expect(toolRunLabel(group.runCategory!, group.messages.length)).toBe('toolGroup.ranShellCommands:4');
    });

    it('leaves a lone call as a plain message', () => {
        const items = groupSameToolRuns(newestFirst([
            userText('user', 1),
            tool('b1', 'Bash', 2),
            agentText('reply', 3),
        ]));

        expect(ids(items)).toEqual(['reply', 'b1', 'user']);
        expect(items.every((item) => item.type === 'message')).toBe(true);
    });

    it('does not group a Bash, Read, Bash sequence', () => {
        const items = groupSameToolRuns(newestFirst([
            tool('b1', 'Bash', 1),
            tool('r1', 'Read', 2),
            tool('b2', 'Bash', 3),
        ]));

        expect(ids(items)).toEqual(['b2', 'r1', 'b1']);
        expect(items.every((item) => item.type === 'message')).toBe(true);
    });

    it('does not group two Bash calls with text between them', () => {
        const items = groupSameToolRuns(newestFirst([
            tool('b1', 'Bash', 1),
            agentText('text', 2),
            tool('b2', 'Bash', 3),
        ]));

        expect(ids(items)).toEqual(['b2', 'text', 'b1']);
        expect(items.every((item) => item.type === 'message')).toBe(true);
    });

    it('marks the group running while its last member runs and keeps the count live', () => {
        const before = groupSameToolRuns(newestFirst([
            tool('b1', 'Bash', 1),
            tool('b2', 'Bash', 2, { state: 'running' }),
        ]));
        expect(ids(before)).toEqual(['group-b1']);
        expect(before[0].type === 'tool-group' && before[0].hasRunning).toBe(true);
        expect(before[0].type === 'tool-group' && before[0].messages.length).toBe(2);

        const after = groupSameToolRuns(newestFirst([
            tool('b1', 'Bash', 1),
            tool('b2', 'Bash', 2),
            tool('b3', 'Bash', 3, { state: 'running' }),
        ]));
        // Same id, so the expanded state the user chose survives the join.
        expect(ids(after)).toEqual(['group-b1']);
        expect(after[0].type === 'tool-group' && after[0].hasRunning).toBe(true);
        expect(after[0].type === 'tool-group' && after[0].messages.length).toBe(3);

        const settled = groupSameToolRuns(newestFirst([
            tool('b1', 'Bash', 1),
            tool('b2', 'Bash', 2),
            tool('b3', 'Bash', 3),
        ]));
        expect(settled[0].type === 'tool-group' && settled[0].hasRunning).toBe(false);
    });

    it('flags an error when a middle member failed', () => {
        const items = groupSameToolRuns(newestFirst([
            tool('b1', 'Bash', 1),
            tool('b2', 'Bash', 2, { state: 'error' }),
            tool('b3', 'Bash', 3),
        ]));

        expect(ids(items)).toEqual(['group-b1']);
        const group = items[0];
        if (group.type !== 'tool-group') throw new Error('expected a group');
        expect(group.hasError).toBe(true);
        expect(group.hasRunning).toBe(false);
        expect(group.messages.map((msg) => msg.id)).toEqual(['b1', 'b2', 'b3']);
    });

    it('does not count a denied permission as a failure', () => {
        const items = groupSameToolRuns(newestFirst([
            tool('b1', 'Bash', 1),
            tool('b2', 'Bash', 2, { state: 'error', permission: { id: 'p', status: 'denied' } }),
        ]));

        expect(items[0].type === 'tool-group' && items[0].hasError).toBe(false);
    });

    it('never absorbs a pending permission card and breaks the run at it', () => {
        const items = groupSameToolRuns(newestFirst([
            tool('b1', 'Bash', 1),
            tool('b2', 'Bash', 2),
            tool('gate', 'Bash', 3, { state: 'running', permission: { id: 'p', status: 'pending' } }),
        ]));

        expect(ids(items)).toEqual(['gate', 'group-b1']);
        expect(items[0].type).toBe('message');
    });

    it('breaks a run at the ask, todo and DroverTodo cards', () => {
        for (const gate of ['AskUserQuestion', 'request_user_input', 'TodoWrite', 'DroverTodo']) {
            const items = groupSameToolRuns(newestFirst([
                tool('b1', 'Bash', 1),
                tool('b2', 'Bash', 2),
                tool('gate', gate, 3),
                tool('b3', 'Bash', 4),
                tool('b4', 'Bash', 5),
            ]));

            expect(ids(items), gate).toEqual(['group-b3', 'gate', 'group-b1']);
            expect(items[1].type, gate).toBe('message');
            expect(isGateCard(tool('gate', gate, 3)), gate).toBe(true);
        }
    });

    it('breaks a run at a user message', () => {
        const items = groupSameToolRuns(newestFirst([
            tool('b1', 'Bash', 1),
            tool('b2', 'Bash', 2),
            userText('user', 3),
            tool('b3', 'Bash', 4),
            tool('b4', 'Bash', 5),
        ]));

        expect(ids(items)).toEqual(['group-b3', 'user', 'group-b1']);
    });

    it('skips over messages that draw nothing without breaking the run', () => {
        const items = groupSameToolRuns(newestFirst([
            tool('b1', 'Bash', 1),
            thinking('empty', 2, '**'),
            tool('skill', 'Skill', 3),
            tool('b2', 'Bash', 4),
        ]));

        expect(ids(items)).toEqual(['group-b1']);
    });

    it('breaks a run at a thinking block with words', () => {
        const items = groupSameToolRuns(newestFirst([
            tool('b1', 'Bash', 1),
            thinking('thought', 2, '*Weighing the two options.*'),
            tool('b2', 'Bash', 3),
        ]));

        expect(ids(items)).toEqual(['b2', 'thought', 'b1']);
    });

    it('folds Read, Grep and Glob, and Edit and Write runs under their own labels', () => {
        const reads = groupSameToolRuns(newestFirst([tool('r1', 'Read', 1), tool('r2', 'Read', 2), tool('r3', 'Read', 3)]));
        expect(reads[0].type === 'tool-group' && reads[0].runCategory).toBe('read');
        expect(toolRunLabel('read', 3)).toBe('toolGroup.readFiles:3');

        const searches = groupSameToolRuns(newestFirst([tool('g1', 'Grep', 1), tool('g2', 'Glob', 2)]));
        expect(ids(searches)).toEqual(['group-g1']);
        expect(searches[0].type === 'tool-group' && searches[0].runCategory).toBe('search');
        expect(toolRunLabel('search', 2)).toBe('toolGroup.searched:2');

        const edits = groupSameToolRuns(newestFirst([tool('e1', 'Edit', 1), tool('e2', 'Write', 2), tool('e3', 'MultiEdit', 3)]));
        expect(ids(edits)).toEqual(['group-e1']);
        expect(edits[0].type === 'tool-group' && edits[0].runCategory).toBe('edit');
        expect(toolRunLabel('edit', 3)).toBe('toolGroup.editedFiles:3');
    });

    it('keeps the user file attachment and unknown tools out of runs', () => {
        expect(getToolRunCategory(tool('f', 'file', 1))).toBeNull();
        expect(getToolRunCategory(tool('m', 'mcp__huly__update', 1))).toBeNull();
        expect(getToolRunCategory(tool('a', 'Agent', 1))).toBeNull();
        expect(getToolRunCategory(tool('b', 'Bash', 1))).toBe('terminal');

        const items = groupSameToolRuns(newestFirst([
            tool('m1', 'mcp__huly__update', 1),
            tool('m2', 'mcp__huly__update', 2),
        ]));
        expect(ids(items)).toEqual(['m2', 'm1']);
    });
});
