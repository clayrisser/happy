/**
 * What an agent id is called on this phone (DROVE-392).
 *
 * An `<agent-message from="aaefbd4ef38db65e9">` names its sender by id, and
 * the id is the one thing on the card Clay cannot read. The app already
 * knows the agent by name in two places, tried in this order:
 *
 *   1. The live task tree the Agents sheet draws (DROVE-54, DROVE-361):
 *      `liveStatus.agents[].label`, published by the CLI while the agent
 *      runs and for a while after.
 *   2. The transcript's own Agent tool call, whose result carries `agentId`
 *      and whose input carries the description the card drew when it was
 *      launched (DROVE-51). This one survives a CLI restart, which the live
 *      tree does not.
 *
 * Null when neither knows, and the caller shows the id's first eight
 * characters, which is how the terminal abbreviates it too.
 */
import type { Message, ToolCall } from '@/sync/typesMessage';
import { agentDescription, agentSubagentType } from './agentCard';

export type LabelledAgent = { id: string; label: string };

function agentIdOf(tool: Pick<ToolCall, 'input' | 'result'>): string | undefined {
    const from = (value: unknown): string | undefined => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
        const id = (value as Record<string, unknown>).agentId;
        return typeof id === 'string' && id.length > 0 ? id : undefined;
    };
    return from(tool.result) ?? from(tool.input);
}

/** Depth-first, because a Task card folds its own calls underneath it. */
function findAgentToolCall(messages: readonly Message[], agentId: string): ToolCall | null {
    for (const message of messages) {
        if (message.kind !== 'tool-call') continue;
        if ((message.tool.name === 'Task' || message.tool.name === 'Agent') && agentIdOf(message.tool) === agentId) {
            return message.tool;
        }
        const nested = findAgentToolCall(message.children, agentId);
        if (nested) return nested;
    }
    return null;
}

export function agentLabelFrom(
    agents: readonly LabelledAgent[] | null | undefined,
    messages: readonly Message[] | null | undefined,
    agentId: string,
): string | null {
    const live = agents?.find((agent) => agent.id === agentId)?.label;
    if (live && live.trim().length > 0) return live;
    const tool = messages ? findAgentToolCall(messages, agentId) : null;
    if (tool) {
        const described = agentDescription(tool.input) ?? agentSubagentType(tool.input);
        if (described && described.length > 0) return described;
    }
    return null;
}
