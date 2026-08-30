import { describe, expect, it } from 'vitest';
import { Message, ToolCallMessage } from '@/sync/typesMessage';
import { collectSubagentTaskMessageIds } from './subagentTaskLinks';
import { extractThinkingText } from './thinkingText';

function taskMessage(id: string, input: Record<string, unknown>): ToolCallMessage {
    return {
        kind: 'tool-call',
        id,
        localId: null,
        createdAt: 1,
        tool: {
            name: 'Agent',
            state: 'running',
            input,
            createdAt: 1,
            startedAt: 1,
            completedAt: null,
            description: null,
        },
        children: [],
    };
}

describe('collectSubagentTaskMessageIds', () => {
    it('links a subagent id to the tool call that carries it', () => {
        const messages: Message[] = [
            taskMessage('task-msg', { prompt: 'go', sessionSubagent: 'subagent-1' }),
            taskMessage('other-msg', { prompt: 'no link' }),
        ];

        const links = collectSubagentTaskMessageIds(messages);

        expect(links.get('subagent-1')).toBe('task-msg');
        expect(links.size).toBe(1);
    });

    it('has nothing to link when the Task call never reaches the app', () => {
        expect(collectSubagentTaskMessageIds([]).size).toBe(0);
    });
});

describe('extractThinkingText', () => {
    it('strips the stored italics wrapper', () => {
        expect(extractThinkingText('*Weighing the options*')).toBe('Weighing the options');
    });

    it('keeps asterisks the model actually wrote', () => {
        expect(extractThinkingText('*use **bold** here*')).toBe('use **bold** here');
    });

    it('reports an empty thinking block as empty', () => {
        expect(extractThinkingText('**')).toBe('');
    });
});
