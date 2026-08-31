import { describe, expect, it } from 'vitest';
import { agentLongPressCopyText, buildAgentTurnCopyTextByMessageId, type AgentTurnCopyMessage } from './agentTurnCopy';

describe('buildAgentTurnCopyTextByMessageId', () => {
    it('copies every non-thinking text block without tool calls', () => {
        const messages: AgentTurnCopyMessage[] = [
            { kind: 'agent-text', id: 'final', text: 'Final answer' },
            { kind: 'tool-call', id: 'tool' },
            { kind: 'agent-text', id: 'progress', text: 'Progress update' },
            { kind: 'agent-text', id: 'thinking', text: 'Private thought', isThinking: true },
            { kind: 'user-text', id: 'user', text: 'Do it' },
        ];

        expect(buildAgentTurnCopyTextByMessageId(messages, { currentTurnComplete: true })).toEqual(
            new Map([['final', 'Progress update\n\nFinal answer']]),
        );
    });

    it('does not offer copy while the current turn is still running', () => {
        const messages: AgentTurnCopyMessage[] = [
            { kind: 'agent-text', id: 'streaming', text: 'Still working' },
            { kind: 'user-text', id: 'user', text: 'Do it' },
        ];

        expect(buildAgentTurnCopyTextByMessageId(messages, { currentTurnComplete: false }).size).toBe(0);
    });

    it('still offers copy for completed historical turns', () => {
        const messages: AgentTurnCopyMessage[] = [
            { kind: 'user-text', id: 'current-user', text: 'Next task' },
            { kind: 'agent-text', id: 'previous-final', text: 'Previous answer' },
            { kind: 'user-text', id: 'previous-user', text: 'Previous task' },
        ];

        expect(buildAgentTurnCopyTextByMessageId(messages, { currentTurnComplete: false })).toEqual(
            new Map([['previous-final', 'Previous answer']]),
        );
    });
});

/**
 * The copy glyph is gone and the hold carries it instead (DROVE-121), so this
 * is the only thing standing between a long press and an empty clipboard.
 */
describe('agentLongPressCopyText', () => {
    it('copies the whole turn where the glyph used to offer it', () => {
        expect(agentLongPressCopyText('First block\n\nSecond block', 'Second block'))
            .toBe('First block\n\nSecond block');
    });

    it('falls back to the block itself, so a turn still being written can be copied', () => {
        expect(agentLongPressCopyText(undefined, 'Still working on it')).toBe('Still working on it');
    });

    it('ignores a turn payload that is only whitespace', () => {
        expect(agentLongPressCopyText('   ', 'Real text')).toBe('Real text');
    });

    it('is null when there is nothing to copy, so no gesture is attached', () => {
        expect(agentLongPressCopyText(undefined, '   ')).toBeNull();
    });
});
