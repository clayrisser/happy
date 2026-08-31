/**
 * What an Agent card says (DROVE-51). Claude Code spawns a subagent with the
 * Agent tool (older transcripts: Task): `{description, subagent_type, prompt}`.
 * The result, as the CLI's `toolUseResult`, is
 * `{status, prompt, agentId, agentType, content:[{type:'text',text}],
 *   totalDurationMs, totalTokens, totalToolUseCount, usage}`; on the SDK path
 * it is the bare content-block array or a string. All three shapes are read
 * here so the card never has to look at raw JSON.
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
 * Running while the call is open; failed when the call errored or the agent
 * itself reported anything but completed; finished otherwise.
 */
export function agentRunState(tool: Pick<ToolCall, 'state' | 'result'>): AgentRunState {
    if (tool.state === 'running') {
        return 'running';
    }
    if (tool.state === 'error') {
        return 'failed';
    }
    const status = agentOutcome(tool.result)?.status;
    if (status && status !== 'completed' && status !== 'success' && status !== 'done') {
        return 'failed';
    }
    return 'finished';
}
