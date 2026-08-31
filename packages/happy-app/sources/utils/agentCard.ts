/**
 * What an Agent card says (DROVE-51). Claude Code spawns a subagent with the
 * Agent tool (older transcripts: Task): `{description, subagent_type, prompt}`.
 * The result, as the CLI's `toolUseResult`, is
 * `{status, prompt, agentId, agentType, content:[{type:'text',text}],
 *   totalDurationMs, totalTokens, totalToolUseCount, usage}`; on the SDK path
 * it is the bare content-block array or a string. All three shapes are read
 * here so the card never has to look at raw JSON.
 *
 * The launch receipt is now followed by a real one (DROVE-115): the CLI sends
 * a SECOND `tool-call-end` on the same call when the agent's
 * `<task-notification>` reaches the parent transcript, carrying the agent id
 * and its terminal status in that same shape. So everything below reads one
 * result and one result only, and the agent screen behind the card reads the
 * same notification through the same CLI.
 *
 * A FOURTH shape broke this (DROVE-110). An async agent's tool call ends the
 * moment the agent is launched, with `{isAsync: true, status: 'async_launched',
 * agentId, description, resolvedModel, prompt, outputFile, canReadOutputFile}`
 * (measured on session 19c2f0a8, toolu_01ChtSUF4BxNmvYEeRcoKxxi). The old rule
 * read anything but `completed` as a failure, so every background agent showed
 * a red `Failed` while it was working. Absent or unrecognised now means
 * RUNNING; failed is only for a result that says so. A run that has shown no
 * sign of life for a while is described as quiet, in the same words and off the
 * same threshold as DROVE-93's agent screen, so the card is never more
 * confident than the screen behind it.
 */
import { ToolCall } from '@/sync/typesMessage';

/** The keys the card writes in its own hand, so generic rows must skip them. */
export const agentOwnKeys = ['description', 'subagent_type', 'subagentType', 'prompt'];

export type AgentRunState = 'running' | 'finished' | 'failed';

export interface AgentOutcome {
    /** The subagent's final report, as it wrote it. */
    text: string;
    status?: string;
    agentType?: string;
    durationMs?: number;
    tokens?: number;
    toolUses?: number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

function nonEmpty(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Joins the text blocks of a Claude content array; empty when there are none. */
function blocksText(value: unknown): string {
    if (typeof value === 'string') {
        return value;
    }
    if (!Array.isArray(value)) {
        return '';
    }
    return value
        .map((block) => {
            const record = asRecord(block);
            return record && record.type === 'text' ? nonEmpty(record.text) ?? '' : '';
        })
        .filter((text) => text.length > 0)
        .join('\n\n');
}

export function agentDescription(input: unknown): string | undefined {
    return nonEmpty(asRecord(input)?.description)?.trim();
}

export function agentSubagentType(input: unknown): string | undefined {
    const record = asRecord(input);
    return (nonEmpty(record?.subagent_type) ?? nonEmpty(record?.subagentType))?.trim();
}

export function agentPrompt(input: unknown): string | undefined {
    return nonEmpty(asRecord(input)?.prompt);
}

/** Null until the subagent has reported; an empty result is not a report. */
export function agentOutcome(result: unknown): AgentOutcome | null {
    if (result === null || result === undefined) {
        return null;
    }
    const record = asRecord(result);
    if (record && ('content' in record || 'status' in record || 'agentId' in record)) {
        const text = blocksText(record.content).trim();
        const outcome: AgentOutcome = {
            text,
            status: nonEmpty(record.status),
            agentType: nonEmpty(record.agentType),
            durationMs: finiteNumber(record.totalDurationMs),
            tokens: finiteNumber(record.totalTokens),
            toolUses: finiteNumber(record.totalToolUseCount),
        };
        return text.length > 0 || outcome.status ? outcome : null;
    }
    const text = blocksText(result).trim();
    if (text.length > 0) {
        return { text };
    }
    if (record) {
        return null;
    }
    const fallback = String(result).trim();
    return fallback.length > 0 ? { text: fallback } : null;
}

/**
 * The exact receipt an async Agent's tool call ends with, before the agent has
 * done anything at all.
 *
 * Named here because two places have to agree on it: this file, which must not
 * read it as an outcome, and the reducer, which must let the REAL result land
 * on a call this receipt already closed (DROVE-115). Matched on the status
 * word rather than `isAsync`, because the terminal result carries `isAsync`
 * too and a second receipt is exactly what it is not.
 */
export function isAsyncAgentLaunch(result: unknown): boolean {
    return asRecord(result)?.status === 'async_launched';
}

/** A status that means the agent stopped and reported. */
const finishedStatuses = new Set(['completed', 'complete', 'success', 'succeeded', 'done', 'ok', 'finished']);

/** A status that means the agent stopped and it went wrong. Only these fail. */
const failedStatuses = new Set([
    'failed', 'failure', 'error', 'errored', 'aborted', 'cancelled', 'canceled',
    'killed', 'crashed', 'interrupted', 'timeout', 'timed_out', 'denied', 'rejected',
]);

/** A result that reports its own failure, whatever its status says. */
function reportsFailure(result: unknown): boolean {
    const record = asRecord(result);
    if (!record) {
        return false;
    }
    return record.is_error === true || record.isError === true || nonEmpty(record.error) !== undefined;
}

/**
 * The one place a stop status becomes a state. Null for a status nobody here
 * recognises, which is not the same as a failure: the CLI may invent a word
 * after this ships, and an agent that is working must never be drawn dead.
 */
export function agentStateFromStatus(status: string | null | undefined): AgentRunState | null {
    const word = typeof status === 'string' ? status.trim().toLowerCase() : '';
    if (!word) {
        return null;
    }
    if (failedStatuses.has(word)) {
        return 'failed';
    }
    return finishedStatuses.has(word) ? 'finished' : null;
}

/**
 * The CLI's subagent vocabulary in the card's words (DROVE-93 -> DROVE-115).
 *
 * `subagentTranscript` speaks running/done/failed and the card speaks
 * running/finished/failed. One translation, in the file that owns the card's
 * state, so the agent screen and the card cannot end up saying different
 * things about the same agent.
 */
export function agentRunStateOf(state: 'running' | 'done' | 'failed' | null | undefined): AgentRunState {
    if (state === 'done') {
        return 'finished';
    }
    return state === 'failed' ? 'failed' : 'running';
}

/**
 * How alive the agent is (DROVE-110).
 *
 * Running while the call is open, and running again for anything we cannot
 * read: no result, an unrecognised shape, a status the CLI invented after this
 * was written. Failed only when the call itself errored or the result says it
 * failed. An agent that is working must never be drawn as dead, because a
 * false Failed invites redispatching work that is already running.
 */
export function agentRunState(tool: Pick<ToolCall, 'state' | 'result'>): AgentRunState {
    if (tool.state === 'running') {
        return 'running';
    }
    if (tool.state === 'error' || reportsFailure(tool.result)) {
        return 'failed';
    }
    const outcome = agentOutcome(tool.result);
    const status = outcome?.status;
    if (status && status.trim().length > 0) {
        // `async_launched` and anything else unknown: the tool call is over,
        // the agent is not. The CLI sends the real result later (DROVE-115).
        return agentStateFromStatus(status) ?? 'running';
    }
    // No status at all: a report is a finish, silence is a run we cannot see.
    return outcome && outcome.text.length > 0 ? 'finished' : 'running';
}

/**
 * How long a running agent may go unwritten before we say so.
 *
 * Lives here rather than beside the agent screen so the card and the screen
 * cannot drift apart; `sources/sync/subagentTranscript.ts` re-exports it under
 * its old name.
 */
export const SUBAGENT_QUIET_MS = 90_000;

/**
 * The one quiet rule, shared by the card and the agent screen (DROVE-93,
 * DROVE-110). `movedAt` is the last sign of life; undefined or 0 means we have
 * never seen one, which is not the same as silence and says nothing.
 */
export function agentQuietFor(running: boolean, movedAt: number | undefined, now: number): number | undefined {
    if (!running || !movedAt || movedAt <= 0) {
        return undefined;
    }
    const quiet = now - movedAt;
    return quiet > SUBAGENT_QUIET_MS ? quiet : undefined;
}
