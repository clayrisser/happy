/**
 * The transcript half of the wrist feed (DROVE-91): turns a session's message
 * list into rows a watch can draw, and rations how often those rows are sent.
 *
 * Pure. Nothing here reads storage or touches the native module, so the row
 * shape and the send rhythm are both unit-tested on their own; the feed
 * (droverWatchFeed.ts) is what wires them to the store and to the wire.
 */

import type { Message, ToolCall, ToolCallMessage } from './typesMessage';
import type { DroverTranscriptDelta, DroverTranscriptRow } from 'drover-watch';
import { groupSameToolRuns, isGateCard, toolRunLabel } from '@/utils/toolRunGroups';
import { getToolActivityLabel } from '@/utils/toolDisplay';
import { previewFor, titleFor } from './droverGates';

/** Rows a transcript carries, and how long a row's text may be. */
export const droverWristRowLimit = 30;
export const droverWristTextLimit = 500;

/**
 * What a row past the limit ends with. The wrist shows the head of the text;
 * the phone has the rest, and saying so is what stops a cut-off reply reading
 * as a reply that ended there.
 */
export const droverWristMoreTail = '… more on the phone';

/** Head of `text` up to the wrist limit, with the tail when anything was cut. */
export function trimForWrist(text: string, limit: number = droverWristTextLimit): string {
    const whole = text.trim();
    if (whole.length <= limit) return whole;
    // Cut on the last whitespace inside the window when there is one near the
    // end, so a word is not sliced in half; a wall of characters with no
    // break is cut at the limit.
    const head = whole.slice(0, limit);
    const breakAt = head.search(/\s\S*$/);
    const kept = breakAt > limit * 0.6 ? head.slice(0, breakAt) : head;
    return `${kept.trimEnd()}\n${droverWristMoreTail}`;
}

/**
 * Build the wrist rows for one session.
 *
 * `messages` is the store's list, NEWEST FIRST, exactly as the inverted
 * FlatList holds it. Runs of same-tool calls fold through the phone's own
 * `groupSameToolRuns`, so the wrist reads `Ran 4 shell commands` where the
 * phone does (DROVE-84). The result is OLDEST FIRST and at most `limit` rows,
 * because the watch appends and reads the bottom as newest.
 *
 * `thinking` is `Session.thinking`, the turn is running. It marks the newest
 * row as streaming when that row is the assistant's, and is carried on the
 * transcript itself so the wrist can draw a streaming row even before the
 * reply has a first block.
 */
export function buildWristRows(
    messages: Message[],
    options: { sessionId: string; thinking: boolean; limit?: number; textLimit?: number },
): DroverTranscriptRow[] {
    const limit = options.limit ?? droverWristRowLimit;
    const textLimit = options.textLimit ?? droverWristTextLimit;
    const newestFirst: DroverTranscriptRow[] = [];
    for (const item of groupSameToolRuns(messages)) {
        if (newestFirst.length >= limit) break;
        if (item.type === 'tool-group') {
            const newest = item.messages[item.messages.length - 1];
            newestFirst.push({
                id: item.id,
                kind: 'tools',
                text: trimForWrist(toolRunLabel(item.runCategory ?? 'other', item.messages.length), textLimit),
                ...(item.hasRunning ? { streaming: true } : {}),
                at: new Date(newest.createdAt).toISOString(),
            });
            continue;
        }
        if (item.type !== 'message') continue;
        const row = rowFor(item.message, options.sessionId, textLimit);
        if (row) newestFirst.push(row);
    }
    // The newest row is the one being written, when anything is: a reply
    // grows by whole blocks on this store, so "streaming" is the turn running
    // and this being its latest line. A user message is never streaming, it
    // is what the turn is answering.
    if (options.thinking && newestFirst.length) {
        const head = newestFirst[0];
        if (head.kind === 'assistant' || head.kind === 'tools') {
            newestFirst[0] = { ...head, streaming: true };
        }
    }
    return newestFirst.reverse();
}

function rowFor(message: Message, sessionId: string, textLimit: number): DroverTranscriptRow | null {
    const at = new Date(message.createdAt).toISOString();
    switch (message.kind) {
        case 'user-text': {
            const text = trimForWrist(message.displayText ?? message.text, textLimit);
            return text ? { id: message.id, kind: 'user', text, at } : null;
        }
        case 'agent-text': {
            // Thinking is folded away on the phone too; on a wrist it is a
            // paragraph of scratch work between the lines that matter.
            if (message.isThinking) return null;
            const text = trimForWrist(message.text, textLimit);
            return text ? { id: message.id, kind: 'assistant', text, at } : null;
        }
        case 'tool-call':
            return toolRow(message, sessionId, textLimit, at);
        default:
            return null;
    }
}

function toolRow(
    message: ToolCallMessage,
    sessionId: string,
    textLimit: number,
    at: string,
): DroverTranscriptRow | null {
    const tool = message.tool;
    if (isGateCard(message)) {
        // A gate WHERE IT HAPPENED. Pending, it links to the same gate the
        // wall lists, so the wrist answers it from the conversation; settled,
        // it stays as the line it was, so the transcript still reads.
        const pending = tool.permission?.status === 'pending';
        const title = titleFor(tool.name, tool.input);
        const preview = previewFor(tool.name, tool.input);
        const text = trimForWrist(preview && preview !== title ? `${title}\n${preview}` : title, textLimit);
        return {
            id: message.id,
            kind: 'gate',
            text,
            at,
            ...(pending && tool.permission ? { gateId: `${sessionId}:${tool.permission.id}` } : {}),
        };
    }
    const text = trimForWrist(getToolActivityLabel(tool as Pick<ToolCall, 'name' | 'input' | 'description'>), textLimit);
    return {
        id: message.id,
        kind: 'tools',
        text,
        at,
        ...(tool.state === 'running' ? { streaming: true } : {}),
    };
}

/** What a row is, for telling whether the watch already has this version. */
export function rowKey(row: DroverTranscriptRow): string {
    return `${row.kind}|${row.at}|${row.streaming ? 1 : 0}|${row.gateId ?? ''}|${row.text}`;
}

/**
 * The delta between what the watch was last sent and `rows`.
 *
 * `ids` is the whole window in order, always; `rows` carries only what
 * changed. A watch that finds an id in `ids` it holds no row for asks for a
 * snapshot, which carries the full transcript, so the delta never has to be
 * complete to be safe. Returns null when nothing changed, which is what stops
 * the heartbeat from re-sending a transcript that stood still.
 */
export function transcriptDelta(
    sessionId: string,
    rows: DroverTranscriptRow[],
    streaming: boolean,
    sent: Map<string, string>,
    sentStreaming: boolean | null,
    now: Date = new Date(),
): DroverTranscriptDelta | null {
    const changed = rows.filter((row) => sent.get(row.id) !== rowKey(row));
    const ids = rows.map((row) => row.id);
    const dropped = [...sent.keys()].some((id) => !ids.includes(id));
    if (!changed.length && !dropped && sentStreaming === streaming) return null;
    return {
        kind: 'transcript',
        sessionId,
        streaming,
        ids,
        rows: changed,
        updatedAt: now.toISOString(),
    };
}

/**
 * At most one send per session per `intervalMs`, carrying the LATEST state
 * (DROVE-91).
 *
 * Trailing edge: the first change in a quiet period arms a timer, every
 * change inside the window is folded into it, and the send happens when it
 * fires. So a reply arriving as forty store updates in a second reaches the
 * wrist as four messages, each with everything up to that moment, and a lone
 * change reaches it within one interval. The timer is what makes the cap a
 * cap rather than a hope: nothing here sends on the leading edge, so there is
 * no burst to ration.
 */
export function createWristCoalescer(
    send: (sessionId: string) => void,
    intervalMs: number = 250,
): { schedule: (sessionId: string) => void; stop: () => void } {
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    return {
        schedule(sessionId) {
            if (timers.has(sessionId)) return;
            timers.set(
                sessionId,
                setTimeout(() => {
                    timers.delete(sessionId);
                    send(sessionId);
                }, intervalMs),
            );
        },
        stop() {
            for (const timer of timers.values()) clearTimeout(timer);
            timers.clear();
        },
    };
}
