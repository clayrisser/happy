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
 *
 * A THIRD, added with `--stream-partial-output` (DROVE-253). With that flag an
 * assistant run arrives as real deltas and is then REPEATED once in full:
 *
 *   {"type":"assistant",..,"text":"alpha"},   "timestamp_ms":1788217805664
 *   {"type":"assistant",..,"text":" beta"},   "timestamp_ms":1788217805667
 *   {"type":"assistant",..,"text":" gamma"},  "timestamp_ms":1788217805670
 *   {"type":"assistant",..,"text":"alpha beta gamma"}      <- no timestamp_ms
 *
 * Byte-for-byte off a live run. Emitting that last frame would double every
 * answer, so it is dropped — but only when BOTH signals agree: it carries no
 * `timestamp_ms` AND its text equals everything accumulated since the last
 * non-assistant frame. Both, because WITHOUT the flag the final segment of a
 * turn also arrives with no `timestamp_ms` and is the only carrier of that
 * text (see the fixture's `hello`). One signal alone either doubles the text
 * or loses it; together they are exact in both modes.
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
    /** Present on a STREAMED frame, absent on the repeated full-text one. */
    timestamp_ms?: number;
    /** `system/init` only: `login` | `env` | `flag`. See cursorEnv.ts. */
    apiKeySource?: string;
    /** `result` only. */
    usage?: Record<string, unknown>;
    request_id?: string;
}

/** The four counts on the `result` frame, as cursor-agent spells them. */
export interface CursorUsage {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
}

/** A running total. Cursor reports per turn, at turn end, and nothing finer. */
export interface CursorUsageTally extends CursorUsage {
    turns: number;
}

function count(source: Record<string, unknown>, key: string): number {
    const v = source[key];
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : 0;
}

/**
 * `usage` off a `result` frame, or null on any frame that has none.
 *
 * MEASURED that `inputTokens` EXCLUDES `cacheReadTokens`, Anthropic-style
 * rather than OpenAI-style, by running two turns down one chat:
 *
 *   turn 1  inputTokens 25516  cacheReadTokens  7616   (sum 33132)
 *   turn 2  inputTokens    60  cacheReadTokens 33152
 *
 * Turn 2 read back the whole of turn 1's prompt from cache. 33152 matches the
 * SUM, not `inputTokens` alone, so the two fields do not overlap and adding
 * them is the real prompt size. That is what the app's context ring wants; had
 * they overlapped it would have drawn every session at double.
 */
export function readCursorUsage(frame: CursorFrame): CursorUsage | null {
    if (frame?.type !== 'result') return null;
    const raw = frame.usage;
    if (!raw || typeof raw !== 'object') return null;
    return {
        inputTokens: count(raw, 'inputTokens'),
        outputTokens: count(raw, 'outputTokens'),
        cacheReadTokens: count(raw, 'cacheReadTokens'),
        cacheWriteTokens: count(raw, 'cacheWriteTokens'),
    };
}

/** Cursor's counts in the shape the session protocol's `usage` key takes. */
export function cursorUsageToSessionUsage(u: CursorUsage): Record<string, number> {
    return {
        input_tokens: u.inputTokens,
        output_tokens: u.outputTokens,
        cache_read_input_tokens: u.cacheReadTokens,
        cache_creation_input_tokens: u.cacheWriteTokens,
    };
}

export function addCursorUsage(tally: CursorUsageTally, u: CursorUsage): CursorUsageTally {
    return {
        turns: tally.turns + 1,
        inputTokens: tally.inputTokens + u.inputTokens,
        outputTokens: tally.outputTokens + u.outputTokens,
        cacheReadTokens: tally.cacheReadTokens + u.cacheReadTokens,
        cacheWriteTokens: tally.cacheWriteTokens + u.cacheWriteTokens,
    };
}

export const emptyCursorUsageTally: CursorUsageTally = {
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
};

/**
 * `apiKeySource` off a `system/init` frame, or null.
 *
 * Read out of the bundle, so the values are the whole set and not a guess:
 *
 *     Pe = Ee||Me ? "env" : (o.apiKey||o.authToken ? "flag" : "login")
 *
 * `login` is the machine's own credential. Anything else means this turn ran
 * as whoever owns that key, which is the thing that must not be silent.
 */
export function readCursorApiKeySource(frame: CursorFrame): string | null {
    if (frame?.type !== 'system' || frame.subtype !== 'init') return null;
    return typeof frame.apiKeySource === 'string' ? frame.apiKeySource : null;
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

/**
 * The frame -> AgentMessage mapping, holding the one piece of state the
 * mapping needs: the text accumulated across the current assistant run, so the
 * repeated full-text frame can be recognised. Everything else is pure.
 */
export class CursorFrameMapper {
    /** Text seen since the last non-assistant frame. */
    private assistantRun = '';

    map(frame: CursorFrame): AgentMessage[] {
        if (!frame || typeof frame !== 'object') return [];
        if (frame.type !== 'assistant') this.assistantRun = '';
        return mapCursorFrameWith(frame, this);
    }

    /**
     * True when this assistant frame is the trailing repeat rather than a
     * delta. Both signals must agree; see the header for why one is not enough.
     */
    isTrailingFullText(text: string, frame: CursorFrame): boolean {
        return frame.timestamp_ms === undefined
            && this.assistantRun.length > 0
            && text === this.assistantRun;
    }

    noteAssistantDelta(text: string): void {
        this.assistantRun += text;
    }

    resetAssistantRun(): void {
        this.assistantRun = '';
    }
}

/**
 * One stream frame -> zero or more AgentMessages.
 *
 * Stateless, so it cannot recognise the trailing repeat: each call starts a
 * fresh run and therefore drops nothing. That is the right answer for a caller
 * that is not passing `--stream-partial-output`. A caller that IS passing it
 * must drive a `CursorFrameMapper` instead.
 */
export function mapCursorFrame(frame: CursorFrame): AgentMessage[] {
    return mapCursorFrameWith(frame, new CursorFrameMapper());
}

function mapCursorFrameWith(frame: CursorFrame, mapper: CursorFrameMapper): AgentMessage[] {
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
        if (mapper.isTrailingFullText(text, frame)) {
            mapper.resetAssistantRun();
            return [];
        }
        mapper.noteAssistantDelta(text);
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
        // Usage is published even on a failed turn: the tokens were spent
        // either way, and a tally that quietly skips the expensive failures is
        // worse than no tally.
        const usage = readCursorUsage(frame);
        const tokens: AgentMessage[] = usage
            ? [{ type: 'token-count', usage: cursorUsageToSessionUsage(usage) }]
            : [];
        // `is_error` is the authority, not `subtype`: a run can end
        // `subtype:"success"` on a turn the agent itself reported as failed.
        if (frame.is_error === true) {
            const detail = typeof frame.error === 'string'
                ? frame.error
                : typeof frame.result === 'string' ? frame.result : 'the turn ended with an error';
            return [...tokens, { type: 'status', status: 'error', detail }];
        }
        return [...tokens, { type: 'status', status: 'idle' }];
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
