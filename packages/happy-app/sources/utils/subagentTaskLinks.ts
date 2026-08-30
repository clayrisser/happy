import { Message } from '@/sync/typesMessage';

/**
 * Links a subagent lifecycle row to the tool call that spawned it, so tapping
 * "Running agent" can open that Task's drill-in.
 *
 * The CLI stamps `sessionSubagent` onto the Task/Agent tool-call args, which is
 * the same id the start/stop envelopes carry. Claude's own `Task` tool is
 * suppressed on the envelope path (the CLI never emits a tool-call-start for
 * it), so in a drover session there is usually no match — the row then reads as
 * information only, which is still more than the nothing it showed before.
 */
export function collectSubagentTaskMessageIds(messages: readonly Message[]): Map<string, string> {
    const result = new Map<string, string>();
    for (const message of messages) {
        if (message.kind !== 'tool-call') continue;
        const subagent = message.tool.input?.sessionSubagent;
        if (typeof subagent !== 'string' || subagent.length === 0) continue;
        if (result.has(subagent)) continue;
        result.set(subagent, message.id);
    }
    return result;
}
