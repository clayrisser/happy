import { Message, ToolCallMessage } from '@/sync/typesMessage';
import type { DisplayItem, ToolGroupItem } from '@/hooks/useGroupedMessages';
import { getToolSummaryCategory, isGateToolName, isInteractiveQuestionToolName, ToolSummaryCategory } from '@/utils/toolDisplay';
import { isInvisibleMessage, isUserAttachment } from '@/utils/messageVisibility';
import { t } from '@/text';

/**
 * Folds a run of consecutive same-tool calls into one row, the way Claude
 * Code's terminal draws `Ran 4 shell commands` (DROVE-84).
 *
 * Messages are newest-first, as the inverted list stores them. A run is two or
 * more adjacent tool calls of the same family (shell, read, search, edit, web)
 * with nothing visible between them. Anything else that draws a row breaks
 * the run: a text block, a user message, an event, and every gate card (a
 * pending permission, a question, the todo list, DroverTodo). Messages that
 * render as nothing (hidden tools, empty thinking) are skipped without
 * breaking the run.
 */
export function groupSameToolRuns(messages: Message[]): DisplayItem[] {
    const result: DisplayItem[] = [];
    // Pending run, newest member first.
    let run: ToolCallMessage[] = [];
    let runCategory: ToolSummaryCategory | null = null;

    const flush = () => {
        if (run.length === 0) return;
        if (run.length === 1) {
            result.push({ type: 'message', id: run[0].id, message: run[0] });
        } else {
            result.push(buildToolRunGroup(run, runCategory!));
        }
        run = [];
        runCategory = null;
    };

    for (const msg of messages) {
        if (isInvisibleMessage(msg)) continue;
        const category = getToolRunCategory(msg);
        if (category === null) {
            flush();
            result.push({ type: 'message', id: msg.id, message: msg });
            continue;
        }
        if (runCategory !== null && runCategory !== category) {
            flush();
        }
        runCategory = category;
        run.push(msg as ToolCallMessage);
    }
    flush();

    return result;
}

const FOLDABLE_CATEGORIES = new Set<ToolSummaryCategory>(['terminal', 'read', 'search', 'edit', 'web']);

/** A card that is a gate the user acts on never folds into a run. */
export function isGateCard(msg: Message): boolean {
    if (msg.kind !== 'tool-call') return false;
    if (msg.tool.permission?.status === 'pending') return true;
    if (isInteractiveQuestionToolName(msg.tool.name)) return true;
    return isGateToolName(msg.tool.name);
}

/** The family a call folds under, or null when it always stands on its own. */
export function getToolRunCategory(msg: Message): ToolSummaryCategory | null {
    if (msg.kind !== 'tool-call') return null;
    if (isUserAttachment(msg) || isGateCard(msg)) return null;
    const category = getToolSummaryCategory(msg.tool.name);
    return FOLDABLE_CATEGORIES.has(category) ? category : null;
}

export function hasRunningToolCall(messages: Message[]): boolean {
    return messages.some((msg) => msg.kind === 'tool-call' && msg.tool.state === 'running');
}

/** A denied or canceled permission is the user's choice, not a failure. */
export function hasFailedToolCall(messages: Message[]): boolean {
    return messages.some((msg) => {
        if (msg.kind !== 'tool-call' || msg.tool.state !== 'error') return false;
        const status = msg.tool.permission?.status;
        return status !== 'denied' && status !== 'canceled';
    });
}

/** `Ran 4 shell commands`, `Read 3 files`, `Searched 2 times`, `Edited 2 files`. */
export function toolRunLabel(category: ToolSummaryCategory, count: number): string {
    switch (category) {
        case 'terminal':
            return t('toolGroup.ranShellCommands', { count });
        case 'read':
            return t('toolGroup.readFiles', { count });
        case 'search':
            return t('toolGroup.searched', { count });
        case 'edit':
            return t('toolGroup.editedFiles', { count });
        case 'web':
            return t('toolGroup.fetchedUrls', { count });
        default:
            return t('toolGroup.usedTools', { count });
    }
}

function buildToolRunGroup(newestFirst: ToolCallMessage[], category: ToolSummaryCategory): ToolGroupItem {
    const chronological = [...newestFirst].reverse();
    return {
        type: 'tool-group',
        // Keyed by the oldest member so the id, and with it the expanded state
        // the user chose, survives a new call joining at the newest end.
        id: `group-${chronological[0].id}`,
        messages: chronological,
        hasRunning: hasRunningToolCall(chronological),
        hasError: hasFailedToolCall(chronological),
        hasPendingPermission: false,
        runCategory: category,
    };
}
