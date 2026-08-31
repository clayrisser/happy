import { describe, expect, it } from 'vitest';

import {
    agentDescription,
    agentOutcome,
    agentPrompt,
    agentRunState,
    agentSubagentType,
} from './agentCard';

// The shapes Claude Code really sends (measured from transcripts).
const input = {
    description: 'Extract raft-triangle mechanics',
    subagent_type: 'Explore',
    prompt: 'Read the concept notes and report the mechanics.\n\nBe thorough.',
};

const cliResult = {
    status: 'completed',
    prompt: input.prompt,
    agentId: 'a0b3344093b18c783',
    agentType: 'general-purpose',
    content: [{ type: 'text', text: 'Verification complete. DROVE-16 stays **inreview**.' }],
    resolvedModel: 'claude-fable-5',
    totalDurationMs: 299410,
    totalTokens: 68250,
    totalToolUseCount: 38,
    usage: { input_tokens: 2 },
};

describe('the input half', () => {
    it('reads description, subagent type and prompt', () => {
        expect(agentDescription(input)).toBe('Extract raft-triangle mechanics');
        expect(agentSubagentType(input)).toBe('Explore');
        expect(agentPrompt(input)).toBe(input.prompt);
    });

    it('accepts the camelCase type key and tolerates a missing input', () => {
        expect(agentSubagentType({ subagentType: 'Plan' })).toBe('Plan');
        expect(agentDescription(undefined)).toBeUndefined();
        expect(agentSubagentType('x')).toBeUndefined();
        expect(agentPrompt({ prompt: '   ' })).toBeUndefined();
    });
});

describe('agentOutcome', () => {
    it("reads the CLI's toolUseResult: report text plus the run's numbers", () => {
        expect(agentOutcome(cliResult)).toEqual({
            text: 'Verification complete. DROVE-16 stays **inreview**.',
            status: 'completed',
            agentType: 'general-purpose',
            durationMs: 299410,
            tokens: 68250,
            toolUses: 38,
        });
    });

    it('reads a bare content-block array and a plain string', () => {
        expect(agentOutcome([{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }]))
            .toEqual({ text: 'first\n\nsecond' });
        expect(agentOutcome('plain report')).toEqual({ text: 'plain report' });
    });

    it('is null before the agent has reported', () => {
        expect(agentOutcome(undefined)).toBeNull();
        expect(agentOutcome(null)).toBeNull();
        expect(agentOutcome('')).toBeNull();
        expect(agentOutcome([])).toBeNull();
        expect(agentOutcome({ unrelated: true })).toBeNull();
    });
});

describe('agentRunState', () => {
    it('is running while the call is open', () => {
        expect(agentRunState({ state: 'running', result: undefined })).toBe('running');
    });

    it('is finished once the agent reported completed', () => {
        expect(agentRunState({ state: 'completed', result: cliResult })).toBe('finished');
        expect(agentRunState({ state: 'completed', result: 'plain report' })).toBe('finished');
    });

    it('is failed when the call errored or the agent reported anything else', () => {
        expect(agentRunState({ state: 'error', result: 'boom' })).toBe('failed');
        expect(agentRunState({ state: 'completed', result: { ...cliResult, status: 'aborted' } })).toBe('failed');
    });
});
