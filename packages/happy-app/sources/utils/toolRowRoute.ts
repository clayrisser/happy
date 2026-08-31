import type { Href } from 'expo-router';

import { ToolCall } from '@/sync/typesMessage';

/**
 * Where a tool row opens onto.
 *
 * Consolidation folds a run of calls into one `Ran 25 shell commands` card to
 * save vertical space, not to throw the contents away (DROVE-152). Every row
 * inside such a card opens the same detail a standalone card opens: the
 * command, its output, its status. One function so the group rows, the folded
 * single child and the standalone card can never drift apart. It is also the
 * only place that knows a row can be a subagent's rather than the session's
 * (DROVE-166); there is no second resolver for agent screens.
 */

const fileEditToolNames = new Set(['Edit', 'MultiEdit', 'Write']);

export function isFileEditToolName(toolName: string): boolean {
    return fileEditToolNames.has(toolName);
}

/** The file a file-editing call opens onto, or null for every other tool. */
export function getToolRowFilePath(tool: Pick<ToolCall, 'name' | 'input'>): string | null {
    if (!isFileEditToolName(tool.name)) {
        return null;
    }
    const filePath = tool.input?.file_path;
    if (typeof filePath !== 'string') {
        return null;
    }
    const trimmed = filePath.trim();
    return trimmed.length > 0 ? trimmed : null;
}

/**
 * The route a tool row opens, or null when it has no detail to open.
 *
 * A row is openable while its call is still running: the detail screen reads
 * the same store the row does, so it follows the stream rather than freezing
 * on whatever was there at the tap.
 */
export function getToolRowRoute(params: {
    sessionId: string | null | undefined;
    messageId: string | null | undefined;
    tool: Pick<ToolCall, 'name' | 'input'>;
    /**
     * Set while the rows on screen are a subagent's rather than the session's
     * (DROVE-166). The ids in a subagent transcript are the AGENT's and are
     * not in the session's message map, so without this the detail screen
     * looked up an id it could never find and popped straight back: the row
     * looked dead. The file route needs nothing, because a file is read off
     * the machine by path and the session is the same either way.
     */
    agentId?: string | null;
}): Href | null {
    const { sessionId, messageId, tool, agentId } = params;
    if (!sessionId) {
        return null;
    }
    const filePath = getToolRowFilePath(tool);
    if (filePath) {
        // Cast once here rather than at each call site. expo-router's typed
        // routes cannot see through an interpolated id, and these two paths are
        // covered by toolRowRoute.spec.ts.
        return `/session/${sessionId}/file?path=${btoa(filePath)}` as Href;
    }
    if (!messageId) {
        return null;
    }
    const scope = agentId ? `?agentId=${encodeURIComponent(agentId)}` : '';
    return `/session/${sessionId}/message/${messageId}${scope}` as Href;
}
