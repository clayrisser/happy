import { describe, expect, it } from 'vitest';

import {
    agentDescription,
    agentOutcome,
    agentPrompt,
    agentQuietFor,
    agentRunState,
    agentRunStateOf,
    agentStateFromStatus,
    agentSubagentType,
    isAsyncAgentLaunch,
    SUBAGENT_QUIET_MS,
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

// What an ASYNC agent's tool call really ends with, measured on session
// 19c2f0a8, toolu_01ChtSUF4BxNmvYEeRcoKxxi: the call is over the moment the
// agent is launched, and the agent then works for minutes or hours.
const asyncLaunch = {
    isAsync: true,
    status: 'async_launched',
    agentId: 'a6d2fa31ad530909f',
    description: 'DROVE-44 flip resets app session',
    resolvedModel: 'claude-opus-5',
    prompt: 'You are working on Cattle Drover…',
    outputFile: '/private/tmp/claude-501/…/tasks/a6d2fa31ad530909f.output',
    canReadOutputFile: true,
};

describe('agentRunState', () => {
    it('is running while the call is open', () => {
        expect(agentRunState({ state: 'running', result: undefined })).toBe('running');
    });

    it('is finished once the agent reported, in each of the three known shapes', () => {
        expect(agentRunState({ state: 'completed', result: cliResult })).toBe('finished');
        expect(agentRunState({ state: 'completed', result: [{ type: 'text', text: 'report' }] })).toBe('finished');
        expect(agentRunState({ state: 'completed', result: 'plain report' })).toBe('finished');
    });

    it('is failed only when something says so', () => {
        expect(agentRunState({ state: 'error', result: 'boom' })).toBe('failed');
        expect(agentRunState({ state: 'completed', result: { ...cliResult, status: 'aborted' } })).toBe('failed');
        expect(agentRunState({ state: 'completed', result: { ...cliResult, status: 'failed' } })).toBe('failed');
        expect(agentRunState({ state: 'completed', result: { error: 'agent crashed' } })).toBe('failed');
        expect(agentRunState({ state: 'completed', result: { ...cliResult, is_error: true } })).toBe('failed');
    });

    // DROVE-110: this is the whole bug. A launched background agent was drawn
    // as a red Failed while it was mid-work.
    it('is running for a background agent that has only been launched', () => {
        expect(agentRunState({ state: 'completed', result: asyncLaunch })).toBe('running');
    });

    it('is running when there is no result at all', () => {
        expect(agentRunState({ state: 'completed', result: undefined })).toBe('running');
        expect(agentRunState({ state: 'completed', result: null })).toBe('running');
        expect(agentRunState({ state: 'completed', result: '' })).toBe('running');
    });

    it('is running for a shape or a status it does not recognise, never failed', () => {
        expect(agentRunState({ state: 'completed', result: { unrelated: true } })).toBe('running');
        expect(agentRunState({ state: 'completed', result: { status: 'whatever_the_cli_invents_next' } })).toBe('running');
        expect(agentRunState({ state: 'completed', result: { status: 'in_progress' } })).toBe('running');
    });
});

describe('agentQuietFor', () => {
    it('says nothing until the silence is long enough to matter', () => {
        expect(agentQuietFor(true, 1000, 1000 + SUBAGENT_QUIET_MS)).toBeUndefined();
        expect(agentQuietFor(true, 1000, 1000 + SUBAGENT_QUIET_MS + 5000)).toBe(SUBAGENT_QUIET_MS + 5000);
    });

    it('says nothing about an agent that is not running, or one never heard from', () => {
        expect(agentQuietFor(false, 1000, 9_999_999)).toBeUndefined();
        expect(agentQuietFor(true, undefined, 9_999_999)).toBeUndefined();
        expect(agentQuietFor(true, 0, 9_999_999)).toBeUndefined();
    });

    // The card and the agent screen must reach the same words from the same
    // facts: a launched agent nobody has heard from is quiet, not failed.
    it('describes a launched background agent nobody has heard from as quiet', () => {
        const launchedAt = 1_000_000;
        const now = launchedAt + 12 * 60_000;
        const state = agentRunState({ state: 'completed', result: asyncLaunch });
        expect(state).toBe('running');
        expect(agentQuietFor(state === 'running', launchedAt, now)).toBe(12 * 60_000);
    });
});

/**
 * DROVE-115. The receipt has to be told from the outcome, because the reducer
 * lets the outcome land on a call the receipt already closed, and only that
 * one.
 */
describe('isAsyncAgentLaunch', () => {
    it('is the launch receipt and nothing else', () => {
        expect(isAsyncAgentLaunch(asyncLaunch)).toBe(true);
        expect(isAsyncAgentLaunch({ isAsync: true, status: 'completed', agentId: 'a1' })).toBe(false);
        expect(isAsyncAgentLaunch({ status: 'completed' })).toBe(false);
        expect(isAsyncAgentLaunch(null)).toBe(false);
        expect(isAsyncAgentLaunch('async_launched')).toBe(false);
    });
});

describe('agentStateFromStatus', () => {
    it('knows the two terminal vocabularies and admits when it does not', () => {
        expect(agentStateFromStatus('completed')).toBe('finished');
        expect(agentStateFromStatus(' DONE ')).toBe('finished');
        expect(agentStateFromStatus('killed')).toBe('failed');
        expect(agentStateFromStatus('timed_out')).toBe('failed');
        expect(agentStateFromStatus('async_launched')).toBeNull();
        expect(agentStateFromStatus('whatever_the_cli_invents_next')).toBeNull();
        expect(agentStateFromStatus(undefined)).toBeNull();
    });
});

describe('agentRunStateOf', () => {
    // The card says finished, the agent screen's CLI says done. One
    // translation, so the two surfaces cannot drift apart.
    it('speaks the agent screen vocabulary in the words the card uses', () => {
        expect(agentRunStateOf('done')).toBe('finished');
        expect(agentRunStateOf('failed')).toBe('failed');
        expect(agentRunStateOf('running')).toBe('running');
        expect(agentRunStateOf(undefined)).toBe('running');
    });
});

describe('a background agent that has reported', () => {
    const stop = (status: string) => ({
        isAsync: true,
        status,
        agentId: 'a752a2a9e89efbca8',
        content: [{ type: 'text', text: 'Pushed as 55c43f95.' }],
        totalDurationMs: 600_000,
    });

    it('is finished, with its report and a duration that has stopped moving', () => {
        const tool = { state: 'completed' as const, result: stop('completed') };
        expect(agentRunState(tool)).toBe('finished');
        expect(agentOutcome(tool.result)).toMatchObject({ text: 'Pushed as 55c43f95.', durationMs: 600_000 });
        // Nothing left for the ticking clock to key off.
        expect(agentQuietFor(false, 1000, 9_999_999)).toBeUndefined();
    });

    it('is failed on a failure status even when the call itself did not error', () => {
        expect(agentRunState({ state: 'completed', result: stop('failed') })).toBe('failed');
        expect(agentRunState({ state: 'completed', result: stop('killed') })).toBe('failed');
    });

    it('reaches the same word the agent screen reaches for the same agent', () => {
        expect(agentRunState({ state: 'completed', result: stop('completed') })).toBe(agentRunStateOf('done'));
        expect(agentRunState({ state: 'completed', result: stop('failed') })).toBe(agentRunStateOf('failed'));
        expect(agentRunState({ state: 'completed', result: asyncLaunch })).toBe(agentRunStateOf('running'));
    });
});
