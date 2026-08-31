/**
 * cursor-agent's `--output-format stream-json` frames, mapped onto the
 * AgentMessage vocabulary every non-Claude runner already speaks (DROVE-57).
 *
 * This is a PURE function on purpose: the mapping is the part that can be
 * wrong, and it is the part a test can hold a real captured stream against.
 * The fixture beside it is a byte-for-byte capture of a live run.
 *
 * The frames, measured on cursor-agent 2026.08.25:
 *
 *   {"type":"system","subtype":"init","session_id":..,"model":..,"cwd":..}
 *   {"type":"user","message":{"role":"user","content":[{"type":"text",..}]}}
 *   {"type":"thinking","subtype":"delta"|"completed","text":..}
 *   {"type":"assistant","message":{"role":"assistant","content":[{"type":"text",..}]}}
 *   {"type":"tool_call","subtype":"started"|"completed","call_id":..,
 *    "tool_call":{"<name>ToolCall":{"args":{..},"result":{..}}}}
 *   {"type":"result","subtype":"success","is_error":false,"result":..}
 *
 * Two things are deliberately dropped. The `user` frame is the prompt the
 * phone already sent, so replaying it would double every message. The
 * `thinking` `completed` frame carries no text; the accumulated thinking is
 * flushed by the session manager when the stream changes type or the turn
 * ends.
 */

import type { AgentMessage } from '@/agent/core';

export interface CursorFrame {
    type?: string;
    subtype?: string;
    text?: string;
    call_id?: string;
    session_id?: string;
    model?: string;
    is_error?: boolean;
    result?: unknown;
    error?: unknown;
    message?: { role?: string; content?: unknown };
    tool_call?: Record<string, unknown>;
}

/**
 * The tool's name, from the single `<name>ToolCall` key Cursor wraps it in.
 * `readToolCall` -> `Read`, `shellToolCall` -> `Shell`. Capitalised because
 * that is how every other harness's tool names reach the app, and a card
 * reading `read` beside `Bash` looks like a bug.
 */
export function cursorToolName(toolCall: Record<string, unknown> | undefined): { name: string; key: string | null } {
    if (!toolCall) return { name: 'Tool', key: null };
    const key = Object.keys(toolCall).find((k) => k.endsWith('ToolCall'));
    if (!key) return { name: 'Tool', key: null };
    const bare = key.slice(0, -'ToolCall'.length);
    if (!bare) return { name: 'Tool', key };
    return { name: bare.charAt(0).toUpperCase() + bare.slice(1), key };
}

function textOf(content: unknown): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    let out = '';
    for (const block of content) {
        if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
            const t = (block as { text?: unknown }).text;
            if (typeof t === 'string') out += t;
        }
    }
    return out;
}

/** One stream frame -> zero or more AgentMessages. */
export function mapCursorFrame(frame: CursorFrame): AgentMessage[] {
    if (!frame || typeof frame !== 'object') return [];

    if (frame.type === 'system' && frame.subtype === 'init') {
        return [{ type: 'status', status: 'running' }];
    }

    if (frame.type === 'thinking') {
        if (frame.subtype !== 'delta') return [];
        const text = typeof frame.text === 'string' ? frame.text : '';
        if (!text) return [];
        return [{ type: 'event', name: 'thinking', payload: { text, streaming: true } }];
    }

    if (frame.type === 'assistant') {
        const text = textOf(frame.message?.content);
        if (!text) return [];
        return [{ type: 'model-output', textDelta: text }];
    }

    if (frame.type === 'tool_call') {
        const { name, key } = cursorToolName(frame.tool_call);
        const callId = typeof frame.call_id === 'string' ? frame.call_id : `${name}-unknown`;
        const inner = (key && frame.tool_call ? frame.tool_call[key] : null) as
            | { args?: Record<string, unknown>; result?: unknown }
            | null;
        if (frame.subtype === 'started') {
            return [{ type: 'tool-call', toolName: name, args: inner?.args ?? {}, callId }];
        }
        if (frame.subtype === 'completed') {
            return [{ type: 'tool-result', toolName: name, result: inner?.result ?? null, callId }];
        }
        return [];
    }

    if (frame.type === 'result') {
        // `is_error` is the authority, not `subtype`: a run can end
        // `subtype:"success"` on a turn the agent itself reported as failed.
        if (frame.is_error === true) {
            const detail = typeof frame.error === 'string'
                ? frame.error
                : typeof frame.result === 'string' ? frame.result : 'the turn ended with an error';
            return [{ type: 'status', status: 'error', detail }];
        }
        return [{ type: 'status', status: 'idle' }];
    }

    return [];
}

/**
 * Split a chunk of stdout into whole JSON lines, keeping the remainder.
 * cursor-agent writes one JSON object per line, but a pipe hands them over in
 * arbitrary pieces, so a half-line has to survive to the next chunk.
 */
export function splitFrames(buffer: string): { frames: CursorFrame[]; rest: string } {
    const parts = buffer.split('\n');
    const rest = parts.pop() ?? '';
    const frames: CursorFrame[] = [];
    for (const line of parts) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
            frames.push(JSON.parse(trimmed) as CursorFrame);
        } catch {
            // Not JSON. cursor-agent puts update notices and warnings on
            // stdout too; they are not frames and they are not errors.
        }
    }
    return { frames, rest };
}
