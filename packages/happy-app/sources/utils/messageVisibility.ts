import { Message } from '@/sync/typesMessage';
import { knownTools } from '@/components/tools/knownTools';
import { isEmptyThinking } from '@/utils/thinkingText';

/** True for messages that render as null and should be excluded from the list entirely. */
export function isInvisibleMessage(msg: Message): boolean {
    // Hidden tools (ToolSearch, CodexReasoning, etc.)
    if (msg.kind === 'tool-call') {
        const known = knownTools[msg.tool.name as keyof typeof knownTools] as any;
        return known?.hidden === true;
    }
    // Thinking is kept, it draws as a collapsed "Thought process" row. Only an
    // empty block has nothing to show.
    if (msg.kind === 'agent-text') {
        if (msg.isThinking) return isEmptyThinking(msg.text);
        if (msg.text.trim().length === 0) return true;
    }
    return false;
}

/** User-sent file/image attachments should never be collapsed into a group. */
export function isUserAttachment(msg: Message): boolean {
    return msg.kind === 'tool-call' && msg.tool.name === 'file';
}
