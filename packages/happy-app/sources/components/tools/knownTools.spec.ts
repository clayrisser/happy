import { describe, expect, it, vi } from 'vitest';

vi.mock('@expo/vector-icons', () => ({
    Ionicons: () => null,
    Octicons: () => null,
}));

vi.mock('@/text', () => ({
    t: (key: string, params?: Record<string, unknown>) => (
        key === 'tools.sendMessage.to' ? `Message to ${params?.to}` : key
    ),
}));

import { knownTools } from './knownTools';

describe('knownTools', () => {
    it('hides Claude Skill tool calls from chat rendering', () => {
        expect((knownTools as Record<string, { hidden?: boolean }>).Skill?.hidden).toBe(true);
    });
});

type Entry = {
    title?: string | ((opts: { metadata: null, tool: any }) => string);
    minimal?: boolean | ((opts: any) => boolean);
    extractSubtitle?: (opts: { metadata: null, tool: any }) => string | null;
};

function entry(name: string): Entry {
    return (knownTools as Record<string, Entry>)[name];
}

function call(input: unknown, state: 'running' | 'completed' = 'completed') {
    return { name: 'x', state, input, createdAt: 0, startedAt: null, completedAt: null, description: null };
}

describe('SendMessage card row (DROVE-51)', () => {
    const input = {
        to: 'a76c6ae37c5a5970a',
        summary: 'Follow-up',
        message: 'Read the newest comment on DROVE-81 and fix that case too.\n\nThen push.',
    };

    it('reads "Message to <to>" with the first line of the message underneath', () => {
        const tool = entry('SendMessage');
        expect(typeof tool.title).toBe('function');
        expect((tool.title as Function)({ tool: call(input), metadata: null })).toBe('Message to a76c6ae37c5a5970a');
        expect(tool.extractSubtitle!({ tool: call(input), metadata: null }))
            .toBe('Read the newest comment on DROVE-81 and fix that case too.');
    });

    it('is always a card, never a one-line activity row', () => {
        expect(entry('SendMessage').minimal).toBe(false);
    });
});

describe('Agent card row (DROVE-51)', () => {
    const input = { description: 'Extract raft-triangle mechanics', subagent_type: 'Explore', prompt: 'Read the notes.' };

    it('reads the description as the title, under both the Agent and the Task name', () => {
        for (const name of ['Agent', 'Task']) {
            expect((entry(name).title as Function)({ tool: call(input), metadata: null })).toBe('Extract raft-triangle mechanics');
        }
    });

    it('falls back to the plain task name without a description', () => {
        expect((entry('Agent').title as Function)({ tool: call({ prompt: 'x' }), metadata: null })).toBe('tools.names.task');
    });

    it('is always a card, even before the agent has forwarded a single step', () => {
        expect(entry('Agent').minimal).toBe(false);
        expect(entry('Task').minimal).toBe(false);
    });
});
