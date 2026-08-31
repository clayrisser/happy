import { describe, expect, it, vi } from 'vitest';
import { generateGroupSummary, groupMessagesForDisplay, groupToolCallsForDisplay } from './useGroupedMessages';
import { Message, ToolCallMessage } from '@/sync/typesMessage';
import { extractThinkingText } from '@/utils/thinkingText';

vi.mock('@/components/tools/knownTools', () => ({
    knownTools: {
        Skill: { hidden: true },
    },
}));

vi.mock('@/text', () => ({
    t: (key: string, params?: { count?: number }) => `${key}:${params?.count ?? ''}`,
}));

function toolMessage(id: string, createdAt: number, options: { pendingPermission?: boolean; state?: ToolCallMessage['tool']['state'] } = {}): ToolCallMessage {
    const state = options.state ?? 'completed';
    return {
        kind: 'tool-call',
        id,
        localId: null,
        createdAt,
        tool: {
            name: 'CodexBash',
            state,
            input: { command: id },
            createdAt,
            startedAt: createdAt,
            completedAt: state === 'running' ? null : createdAt + 1,
            description: id,
            ...(options.pendingPermission
                ? {
                    permission: {
                        id: `permission-${id}`,
                        status: 'pending' as const,
                    },
                }
                : {}),
        },
        children: [],
    };
}

function namedToolMessage(id: string, name: string, createdAt: number): ToolCallMessage {
    const message = toolMessage(id, createdAt);
    return {
        ...message,
        tool: {
            ...message.tool,
            name,
        },
    };
}

describe('useGroupedMessages', () => {
    it('classifies Rig tool families in group summaries', () => {
        const messages = [
            namedToolMessage('terminal', 'exec_command', 1),
            namedToolMessage('edit', 'apply_patch', 2),
            namedToolMessage('read', 'read_agent_history', 3),
            namedToolMessage('search', 'list_workspaces', 4),
            namedToolMessage('task', 'spawn_agent', 5),
        ];

        expect(generateGroupSummary(messages)).toBe([
            'toolGroup.editedFiles:1',
            'toolGroup.readFiles:1',
            'toolGroup.ranCommands:1',
            'toolGroup.searched:1',
            'toolGroup.ranTasks:1',
        ].join(', '));
    });

    it('stores grouped tools in chronological render order', () => {
        const messages: Message[] = [
            {
                kind: 'agent-text',
                id: 'agent-after-tools',
                localId: null,
                createdAt: 5,
                text: 'done',
            },
            toolMessage('tool-latest', 4),
            toolMessage('tool-middle', 3),
            toolMessage('tool-earliest', 2),
            {
                kind: 'user-text',
                id: 'user',
                localId: null,
                createdAt: 1,
                text: 'run tools',
            },
        ];

        const group = groupToolCallsForDisplay(messages, true).find((item) => item.type === 'tool-group');

        expect(group?.messages.map((message) => message.id)).toEqual([
            'tool-earliest',
            'tool-middle',
            'tool-latest',
        ]);
    });

    it('groups only adjacent tool calls between text messages', () => {
        const messages: Message[] = [
            {
                kind: 'agent-text',
                id: 'agent-final',
                localId: null,
                createdAt: 7,
                text: 'done',
            },
            toolMessage('tool-4', 6),
            toolMessage('tool-3', 5),
            {
                kind: 'agent-text',
                id: 'agent-middle',
                localId: null,
                createdAt: 4,
                text: 'next step',
            },
            toolMessage('tool-2', 3),
            toolMessage('tool-1', 2),
            {
                kind: 'user-text',
                id: 'user',
                localId: null,
                createdAt: 1,
                text: 'run tools',
            },
        ];

        const groups = groupToolCallsForDisplay(messages, true).filter((item) => item.type === 'tool-group');

        expect(groups).toHaveLength(2);
        expect(groups[0]?.messages.map((message) => message.id)).toEqual(['tool-3', 'tool-4']);
        expect(groups[1]?.messages.map((message) => message.id)).toEqual(['tool-1', 'tool-2']);
    });

    it('keeps the final agent message visible and collapses earlier agent work', () => {
        const messages: Message[] = [
            {
                kind: 'agent-text',
                id: 'agent-final',
                localId: null,
                createdAt: 5,
                text: 'done',
            },
            toolMessage('tool-latest', 4),
            {
                kind: 'agent-text',
                id: 'agent-progress',
                localId: null,
                createdAt: 3,
                text: 'checking',
            },
            toolMessage('tool-earliest', 2),
            {
                kind: 'user-text',
                id: 'user',
                localId: null,
                createdAt: 1,
                text: 'run tools',
            },
        ];

        const items = groupMessagesForDisplay(messages, true);

        expect(items.map((item) => item.type)).toEqual(['message', 'agent-work-group', 'message']);
        expect(items[0]).toMatchObject({ type: 'message', id: 'agent-final' });
        expect(items[1]).toMatchObject({ type: 'agent-work-group', id: 'work-tool-earliest' });
        if (items[1].type !== 'agent-work-group') {
            throw new Error('Expected an agent work group');
        }
        expect(items[1].messages.map((message) => message.id)).toEqual([
            'tool-latest',
            'agent-progress',
            'tool-earliest',
        ]);
    });

    it('does not mark completed agent work as running when a hidden tool is stale', () => {
        const messages: Message[] = [
            {
                kind: 'agent-text',
                id: 'agent-final',
                localId: null,
                createdAt: 5,
                text: 'done',
            },
            toolMessage('tool-stale-running', 4, { state: 'running' }),
            {
                kind: 'user-text',
                id: 'user',
                localId: null,
                createdAt: 1,
                text: 'run tools',
            },
        ];

        const items = groupMessagesForDisplay(messages, true);
        const group = items.find((item) => item.type === 'agent-work-group');

        expect(group).toMatchObject({
            type: 'agent-work-group',
            hasRunning: false,
            completedAt: 5,
        });
    });

    it('does not collapse the current turn while the agent is still working', () => {
        const messages: Message[] = [
            {
                kind: 'agent-text',
                id: 'agent-streaming',
                localId: null,
                createdAt: 5,
                text: 'still working',
            },
            toolMessage('tool-latest', 4),
            {
                kind: 'agent-text',
                id: 'agent-progress',
                localId: null,
                createdAt: 3,
                text: 'checking',
            },
            toolMessage('tool-earliest', 2),
            {
                kind: 'user-text',
                id: 'user',
                localId: null,
                createdAt: 1,
                text: 'run tools',
            },
        ];

        const items = groupMessagesForDisplay(messages, true, { collapseCurrentTurn: false });

        expect(items.map((item) => item.type)).toEqual([
            'message',
            'message',
            'message',
            'message',
            'message',
        ]);
        expect(items.map((item) => item.id)).toEqual([
            'agent-streaming',
            'tool-latest',
            'agent-progress',
            'tool-earliest',
            'user',
        ]);
    });

    it('folds the finished current-turn tools and leaves the running one on screen', () => {
        const messages: Message[] = [
            toolMessage('tool-running', 5, { state: 'running' }),
            toolMessage('tool-third', 4),
            toolMessage('tool-second', 3),
            toolMessage('tool-first', 2),
            {
                kind: 'user-text',
                id: 'user',
                localId: null,
                createdAt: 1,
                text: 'run tools',
            },
        ];

        const items = groupMessagesForDisplay(messages, true, { collapseCurrentTurn: false });

        expect(items.map((item) => item.type)).toEqual(['message', 'tool-group', 'message']);
        expect(items[0].id).toBe('tool-running');
        const group = items[1];
        if (group.type !== 'tool-group') throw new Error('expected a tool group');
        expect(group.messages.map((msg) => msg.id)).toEqual(['tool-first', 'tool-second', 'tool-third']);
        expect(group.hasRunning).toBe(false);
        expect(generateGroupSummary(group.messages)).toBe('toolGroup.ranCommands:3');
        expect(items[2].id).toBe('user');
    });

    it('keeps a pending-permission tool out of the live turn group', () => {
        const messages: Message[] = [
            toolMessage('tool-asking', 4, { state: 'running', pendingPermission: true }),
            toolMessage('tool-second', 3),
            toolMessage('tool-first', 2),
            {
                kind: 'user-text',
                id: 'user',
                localId: null,
                createdAt: 1,
                text: 'run tools',
            },
        ];

        const items = groupMessagesForDisplay(messages, true, { collapseCurrentTurn: false });

        expect(items.map((item) => item.type)).toEqual(['message', 'tool-group', 'message']);
        expect(items[0].id).toBe('tool-asking');
    });

    it('marks a tool group when it contains a pending permission', () => {
        const messages: Message[] = [
            toolMessage('tool-latest', 3, { pendingPermission: true }),
            toolMessage('tool-earliest', 2),
            {
                kind: 'user-text',
                id: 'user',
                localId: null,
                createdAt: 1,
                text: 'run tools',
            },
        ];

        const group = groupMessagesForDisplay(messages, true).find((item) => item.type === 'tool-group');

        expect(group).toMatchObject({
            type: 'tool-group',
            id: 'group-tool-earliest',
            hasPendingPermission: true,
        });
    });

    it('does not collapse a single standalone tool call into a tool group', () => {
        const messages: Message[] = [
            toolMessage('tool-only', 2),
            {
                kind: 'user-text',
                id: 'user',
                localId: null,
                createdAt: 1,
                text: 'run one tool',
            },
        ];

        const items = groupMessagesForDisplay(messages, true);

        expect(items.map((item) => item.type)).toEqual(['message', 'message']);
        expect(items[0]).toMatchObject({ type: 'message', id: 'tool-only' });
    });

    it('keeps interactive questions expanded and out of tool groups', () => {
        const messages: Message[] = [
            toolMessage('tool-latest', 4),
            namedToolMessage('question', 'request_user_input', 3),
            toolMessage('tool-earliest', 2),
            {
                kind: 'user-text',
                id: 'user',
                localId: null,
                createdAt: 1,
                text: 'run tools',
            },
        ];

        const items = groupToolCallsForDisplay(messages, true, { groupSingleToolCalls: true });

        expect(items.map(item => item.id)).toEqual([
            'group-tool-latest',
            'question',
            'group-tool-earliest',
            'user',
        ]);
        expect(items[1]).toMatchObject({ type: 'message', id: 'question' });
    });

    it('keeps an answered interactive question out of collapsed agent work', () => {
        const messages: Message[] = [
            {
                kind: 'agent-text',
                id: 'agent-final',
                localId: null,
                createdAt: 5,
                text: 'done',
            },
            toolMessage('tool-latest', 4),
            namedToolMessage('question', 'request_user_input', 3),
            toolMessage('tool-earliest', 2),
            {
                kind: 'user-text',
                id: 'user',
                localId: null,
                createdAt: 1,
                text: 'run tools',
            },
        ];

        const items = groupMessagesForDisplay(messages, true);

        expect(items.some(item => item.id === 'question' && item.type === 'message')).toBe(true);
        const workGroup = items.find(item => item.type === 'agent-work-group');
        expect(workGroup?.messages.some(message => message.id === 'question')).toBe(false);
    });

    it('hides Claude Skill tool calls from the display list', () => {
        const messages: Message[] = [
            {
                kind: 'agent-text',
                id: 'agent-final',
                localId: null,
                createdAt: 3,
                text: 'done',
            },
            namedToolMessage('skill-tool', 'Skill', 2),
            {
                kind: 'user-text',
                id: 'user',
                localId: null,
                createdAt: 1,
                text: 'run skill',
            },
        ];

        const items = groupMessagesForDisplay(messages, true);

        expect(items.map((item) => item.id)).toEqual(['agent-final', 'user']);
    });

    it('keeps a thinking block in the stream as its own row', () => {
        const messages: Message[] = [
            {
                kind: 'agent-text',
                id: 'agent-final',
                localId: null,
                createdAt: 4,
                text: 'Here is the answer',
            },
            {
                kind: 'agent-text',
                id: 'agent-thinking',
                localId: null,
                createdAt: 3,
                text: '*Let me weigh the two options carefully.*',
                isThinking: true,
            },
            {
                kind: 'user-text',
                id: 'user',
                localId: null,
                createdAt: 1,
                text: 'which one?',
            },
        ];

        const items = groupMessagesForDisplay(messages, true, { collapseCurrentTurn: false });

        expect(items.map((item) => item.id)).toEqual(['agent-final', 'agent-thinking', 'user']);
        const thinkingItem = items[1];
        if (thinkingItem.type !== 'message') throw new Error('expected a message item');
        expect(thinkingItem.message.kind === 'agent-text' && thinkingItem.message.isThinking).toBe(true);
        expect(
            extractThinkingText(thinkingItem.message.kind === 'agent-text' ? thinkingItem.message.text : ''),
        ).toBe('Let me weigh the two options carefully.');
    });

    it('drops an empty thinking block but never a thinking block with text', () => {
        const messages: Message[] = [
            {
                kind: 'agent-text',
                id: 'agent-empty-thinking',
                localId: null,
                createdAt: 3,
                text: '**',
                isThinking: true,
            },
            {
                kind: 'user-text',
                id: 'user',
                localId: null,
                createdAt: 1,
                text: 'go',
            },
        ];

        const items = groupMessagesForDisplay(messages, true, { collapseCurrentTurn: false });

        expect(items.map((item) => item.id)).toEqual(['user']);
    });

    // DROVE-46: grouping is off by default (settings `groupToolCalls: false`),
    // and that path used to hand every message straight to the list — so the
    // empty blocks Claude Code writes drew a row each.
    it('drops empty thinking blocks with grouping off and keeps the one with text', () => {
        const messages: Message[] = [
            {
                kind: 'agent-text',
                id: 'agent-final',
                localId: null,
                createdAt: 6,
                text: 'Here is the answer',
            },
            {
                kind: 'agent-text',
                id: 'agent-empty-two',
                localId: null,
                createdAt: 5,
                text: '**',
                isThinking: true,
            },
            {
                kind: 'agent-text',
                id: 'agent-empty-one',
                localId: null,
                createdAt: 4,
                text: '**',
                isThinking: true,
            },
            {
                kind: 'agent-text',
                id: 'agent-thinking',
                localId: null,
                createdAt: 3,
                text: '*Weighing the two options.*',
                isThinking: true,
            },
            {
                kind: 'user-text',
                id: 'user',
                localId: null,
                createdAt: 1,
                text: 'which one?',
            },
        ];

        const items = groupMessagesForDisplay(messages, false);

        expect(items.map((item) => item.id)).toEqual(['agent-final', 'agent-thinking', 'user']);
    });

    // DROVE-46: two blocks in a row must not leave two rows behind, grouped or not.
    it('leaves no row for consecutive empty thinking blocks when grouping is on', () => {
        const messages: Message[] = [
            {
                kind: 'agent-text',
                id: 'agent-empty-two',
                localId: null,
                createdAt: 4,
                text: '**',
                isThinking: true,
            },
            {
                kind: 'agent-text',
                id: 'agent-empty-one',
                localId: null,
                createdAt: 3,
                text: '*   *',
                isThinking: true,
            },
            {
                kind: 'user-text',
                id: 'user',
                localId: null,
                createdAt: 1,
                text: 'go',
            },
        ];

        const items = groupMessagesForDisplay(messages, true, { collapseCurrentTurn: false });

        expect(items.map((item) => item.id)).toEqual(['user']);
    });

    it('folds a completed turn around its answer, not around its thinking', () => {
        const messages: Message[] = [
            {
                kind: 'agent-text',
                id: 'agent-final',
                localId: null,
                createdAt: 5,
                text: 'Done',
            },
            toolMessage('tool-two', 4),
            toolMessage('tool-one', 3),
            {
                kind: 'agent-text',
                id: 'agent-thinking',
                localId: null,
                createdAt: 2,
                text: '*planning*',
                isThinking: true,
            },
            {
                kind: 'user-text',
                id: 'user',
                localId: null,
                createdAt: 1,
                text: 'go',
            },
        ];

        const items = groupMessagesForDisplay(messages, true, { collapseCurrentTurn: true });

        expect(items.map((item) => item.type)).toEqual(['message', 'agent-work-group', 'message']);
        expect(items[0].id).toBe('agent-final');
        const work = items[1];
        if (work.type !== 'agent-work-group') throw new Error('expected an agent work group');
        expect(work.messages.map((msg) => msg.id)).toEqual(['tool-two', 'tool-one', 'agent-thinking']);
    });

    it('can collapse single standalone tool calls for nested work details', () => {
        const messages: Message[] = [
            toolMessage('tool-only', 2),
            {
                kind: 'user-text',
                id: 'user',
                localId: null,
                createdAt: 1,
                text: 'run one tool',
            },
        ];

        const items = groupToolCallsForDisplay(messages, true, { groupSingleToolCalls: true });

        expect(items.map((item) => item.type)).toEqual(['tool-group', 'message']);
        expect(items[0]).toMatchObject({
            type: 'tool-group',
            id: 'group-tool-only',
            hasPendingPermission: false,
        });
        if (items[0].type !== 'tool-group') {
            throw new Error('Expected a tool group');
        }
        expect(items[0].messages.map((message) => message.id)).toEqual(['tool-only']);
    });
});

describe('groupMessagesForDisplay: phone attachments (DROVE-234)', () => {
    const uploadRow = (ref: string, name: string, createdAt: number): ToolCallMessage => ({
        kind: 'tool-call',
        id: `file-${ref}`,
        localId: null,
        createdAt,
        children: [],
        tool: {
            name: 'file',
            state: 'completed',
            input: { ref, name, size: 10 },
            createdAt,
            startedAt: createdAt,
            completedAt: createdAt,
            description: `Attached image: ${name}`,
        },
    });

    const envelope = (id: string, createdAt: number, path: string): Message => ({
        kind: 'user-text',
        id,
        localId: null,
        createdAt,
        text: '<cross-session-message from-name="phone" from-mode="bypass">\n'
            + 'look\n'
            + '\n'
            + 'An image was attached from the phone. Read it with the Read tool before answering:\n'
            + `[Image 1: ${path}]\n`
            + '</cross-session-message>',
    });

    // Storage keeps the transcript newest-first.
    it('drops the upload row whose picture the message now draws itself', () => {
        const messages: Message[] = [
            envelope('m1', 2, '/u/d82a4d2f1e1c-IMG_0483.jpg'),
            uploadRow('ref-483', 'IMG_0483.jpg', 1),
        ];
        const ids = groupMessagesForDisplay(messages, false).map((item) => item.id);
        expect(ids).toEqual(['m1']);
    });

    it('keeps the upload row when no marker resolved to it', () => {
        const messages: Message[] = [
            {
                kind: 'user-text',
                id: 'm1',
                localId: null,
                createdAt: 2,
                text: 'here is a screenshot',
            },
            uploadRow('ref-483', 'IMG_0483.jpg', 1),
        ];
        const ids = groupMessagesForDisplay(messages, false).map((item) => item.id);
        expect(ids).toEqual(['m1', 'file-ref-483']);
    });
});
