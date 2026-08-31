/**
 * A background agent finishing, all the way from the wire to the card
 * (DROVE-115).
 *
 * The bug this pins: an async Agent tool call ENDS AT LAUNCH, milliseconds
 * after it starts, with a receipt that says `async_launched` and nothing else.
 * DROVE-110 stopped the card reading that as a failure, which was right, and
 * left a finished agent drawing `Running · quiet for 40m` for the rest of the
 * session, because nothing ever arrived to say otherwise.
 *
 * Now the CLI sends the real result on the SAME call once the agent's
 * task-notification reaches the parent transcript. Two things have to hold for
 * that to reach the card, and both are asserted here rather than assumed:
 * the reducer must let a second result land on a call the receipt already
 * completed, and `agentRunState` must read the result it lands.
 */
import { describe, expect, it } from 'vitest';

import { createReducer, reducer } from './reducer/reducer';
import { normalizeRawMessage } from './typesRaw';
import type { ToolCall } from './typesMessage';
import { agentRunState, agentOutcome, isAsyncAgentLaunch } from '@/utils/agentCard';

const call = 'toolu_01ChtSUF4BxNmvYEeRcoKxxi';
const agentId = 'a752a2a9e89efbca8';

function envelope(id: string, at: number, ev: Record<string, unknown>) {
    return {
        role: 'agent' as const,
        content: {
            type: 'session' as const,
            data: { id, time: at, role: 'agent', turn: 'turn-1', ev },
        },
    };
}

/** The Agent tool_use, as the CLI maps it. */
const launchStart = envelope('env-1', 1000, {
    t: 'tool-call-start',
    call,
    name: 'Agent',
    title: 'Agent',
    description: 'DROVE-115 card',
    args: { description: 'DROVE-115 card', subagent_type: 'general-purpose', prompt: 'fix the card' },
});

/** The receipt, ~19ms later. Measured on session 19c2f0a8. */
const launchReceipt = envelope('env-2', 1019, {
    t: 'tool-call-end',
    call,
    result: {
        isAsync: true,
        status: 'async_launched',
        agentId,
        description: 'DROVE-115 card',
        prompt: 'fix the card',
        outputFile: `/tmp/claude-501/x/tasks/${agentId}.output`,
        canReadOutputFile: true,
    },
    isError: false,
});

/** The real result, minutes later, off the parent's task-notification. */
function terminal(status: string, isError: boolean, text = 'Pushed as 55c43f95.') {
    return envelope('env-3', 601_019, {
        t: 'tool-call-end',
        call,
        result: {
            isAsync: true,
            status,
            agentId,
            description: 'DROVE-115 card',
            content: [{ type: 'text', text }],
            totalDurationMs: 600_000,
        },
        isError,
    });
}

/** Drive the real reducer over a run of envelopes and hand back the Agent card. */
function cardAfter(...envelopes: ReturnType<typeof envelope>[]): ToolCall {
    const state = createReducer();
    envelopes.forEach((raw, index) => {
        const normalized = normalizeRawMessage(`db-${index}`, null, raw.content.data.time, raw as never);
        expect(normalized).toBeTruthy();
        reducer(state, [normalized!]);
    });
    const card = [...state.messages.values()].find((message) => message.tool?.name === 'Agent');
    expect(card?.tool).toBeTruthy();
    return card!.tool!;
}

describe('a background agent, launch to card', () => {
    it('draws a launched agent as running, on the receipt alone', () => {
        const card = cardAfter(launchStart, launchReceipt);
        // The call really is over: this is the shape DROVE-110 read as Failed.
        expect(card.state).toBe('completed');
        expect(isAsyncAgentLaunch(card.result)).toBe(true);
        expect(agentRunState(card)).toBe('running');
    });

    it('draws it as finished when the completion arrives after the call ended', () => {
        const card = cardAfter(launchStart, launchReceipt, terminal('completed', false));
        expect(agentRunState(card)).toBe('finished');
        // And with the agent's own report and a frozen clock, so the card
        // stops counting up at the moment the agent actually stopped.
        const outcome = agentOutcome(card.result);
        expect(outcome?.text).toBe('Pushed as 55c43f95.');
        expect(outcome?.durationMs).toBe(600_000);
    });

    it('draws it as failed when the failure arrives the same way', () => {
        const card = cardAfter(launchStart, launchReceipt, terminal('failed', true, 'Ran out of context.'));
        expect(agentRunState(card)).toBe('failed');
        expect(agentOutcome(card.result)?.text).toBe('Ran out of context.');
    });

    it('reads a killed agent as failed even though the call did not error', () => {
        const card = cardAfter(launchStart, launchReceipt, terminal('killed', false));
        expect(agentRunState(card)).toBe('failed');
    });

    it('keeps a repeated notification from reopening a settled card', () => {
        const card = cardAfter(launchStart, launchReceipt, terminal('completed', false), terminal('failed', true));
        // The receipt is gone the moment the real result replaces it, so the
        // second one is dropped by the reducer's ordinary rule.
        expect(agentRunState(card)).toBe('finished');
    });

    it('leaves an ordinary tool\'s first result alone', () => {
        const state = createReducer();
        const run = [
            envelope('env-b1', 1, { t: 'tool-call-start', call: 'call-bash', name: 'Bash', title: 'ls', description: 'ls', args: { command: 'ls' } }),
            envelope('env-b2', 2, { t: 'tool-call-end', call: 'call-bash', result: { stdout: 'first', stderr: '' }, isError: false }),
            envelope('env-b3', 3, { t: 'tool-call-end', call: 'call-bash', result: { stdout: 'second', stderr: '' }, isError: true }),
        ];
        run.forEach((raw, index) => {
            const normalized = normalizeRawMessage(`db-b${index}`, null, raw.content.data.time, raw as never);
            reducer(state, [normalized!]);
        });
        const bash = [...state.messages.values()].find((message) => message.tool?.name === 'Bash');
        expect(bash?.tool?.state).toBe('completed');
        expect(bash?.tool?.result).toMatchObject({ stdout: 'first' });
    });
});
