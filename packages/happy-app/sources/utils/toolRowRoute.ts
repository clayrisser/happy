import { ToolCall } from '@/sync/typesMessage';

/**
 * Where a tool row opens onto.
 *
 * Consolidation folds a run of calls into one `Ran 25 shell commands` card to
 * save vertical space, not to throw the contents away (DROVE-152). Every row
 * inside such a card opens the same detail a standalone card opens: the
 * command, its output, its status. One function so the group rows, the folded
 * single child and the standalone card can never drift apart.
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
}): string | null {
    const { sessionId, messageId, tool } = params;
    if (!sessionId) {
        return null;
    }
    const filePath = getToolRowFilePath(tool);
    if (filePath) {
        return `/session/${sessionId}/file?path=${btoa(filePath)}`;
    }
    if (!messageId) {
        return null;
    }
    return `/session/${sessionId}/message/${messageId}`;
}
