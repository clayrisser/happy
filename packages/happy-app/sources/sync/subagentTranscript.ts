/**
 * A subagent's transcript, fetched from the CLI over the session RPC channel
 * and turned into the same Message objects a session renders (DROVE-93).
 *
 * Tapping a running agent in the status row opened a screen with the agent's
 * name and a green check and nothing else. The agent's transcript is a JSONL
 * file on the Mac in the session transcript's own format; the CLI serves its
 * rows (`subagentTranscript {agentId, since}`) and this side wraps each row
 * exactly the way a session message arrives (`role: 'agent', content:
 * {type: 'output', data: row}`) and runs it through the normalizer and the
 * reducer the chat already uses. Tool cards, the thinking fold and the
 * DROVE-84 run folding all come from that, not from anything written here.
 *
 * Everything here is pure; the RPC call lives in subagentTranscriptRpc.ts so
 * the row mapping and the cursor handling are testable without a socket (the
 * socket module pulls in react-native, which vitest cannot parse).
 */

import { agentQuietFor, SUBAGENT_QUIET_MS } from '@/utils/agentCard';

import { createReducer, reducer, type ReducerState } from './reducer/reducer';
import type { Message } from './typesMessage';
import { normalizeRawMessage, RawRecordSchema } from './typesRaw';

export type SubagentState = 'running' | 'done' | 'failed';

export interface SubagentTranscriptAgent {
    id: string;
    label: string;
    agentType?: string;
    toolId?: string;
    state: SubagentState;
    /** mtime of the transcript on the Mac, epoch ms. */
    updatedAt: number;
    /** When the parent saw it stop, epoch ms. */
    endedAt?: number;
    /** The result text the parent received. */
    result?: string;
}

export type SubagentTranscriptRow = Record<string, unknown>;

export type SubagentTranscriptResponse = {
    ok: true;
    rows: SubagentTranscriptRow[];
    /** Byte offset to hand back as `since`. */
    cursor: number;
    agent: SubagentTranscriptAgent;
} | {
    ok: false;
    reason: string;
    cursor: 0;
    agent?: Partial<SubagentTranscriptAgent>;
};

export interface SubagentTranscriptRequest {
    agentId: string;
    since?: number;
}

/** What the screen holds between polls. */
export interface SubagentTranscriptState {
    reducer: ReducerState;
    messagesMap: Record<string, Message>;
    /** Newest first, the shape the inverted chat list wants. */
    messages: Message[];
    /** Byte offset of the next poll. */
    cursor: number;
    /** The first row's timestamp. */
    startedAt?: number;
    /** The newest row's timestamp. */
    lastAt?: number;
    /** input + output + cache creation, the terminal's own count (DROVE-54). */
    tokens: number;
    /** How many rows have been folded in, for ids when a row has no uuid. */
    rowCount: number;
}

export function createSubagentTranscriptState(): SubagentTranscriptState {
    return {
        reducer: createReducer(),
        messagesMap: {},
        messages: [],
        cursor: 0,
        tokens: 0,
        rowCount: 0,
    };
}

function timestampOf(row: SubagentTranscriptRow): number {
    const value = row.timestamp;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'string') return 0;
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : 0;
}

function tokensOf(row: SubagentTranscriptRow): number {
    const message = row.message;
    if (!message || typeof message !== 'object') return 0;
    const usage = (message as Record<string, unknown>).usage;
    if (!usage || typeof usage !== 'object') return 0;
    const n = (key: string): number => {
        const value = (usage as Record<string, unknown>)[key];
        return typeof value === 'number' && Number.isFinite(value) ? value : 0;
    };
    return n('input_tokens') + n('output_tokens') + n('cache_creation_input_tokens');
}

/**
 * Fold a poll's rows into the state. The reducer mutates its own state in
 * place, the way storage.ts drives it; everything else is copied so a React
 * state setter sees a new object.
 */
export function applySubagentTranscriptRows(
    state: SubagentTranscriptState,
    rows: SubagentTranscriptRow[],
    cursor: number,
): SubagentTranscriptState {
    const next: SubagentTranscriptState = {
        ...state,
        messagesMap: { ...state.messagesMap },
        cursor,
    };
    let previousAt = state.lastAt ?? 0;
    for (const row of rows) {
        next.rowCount += 1;
        const at = timestampOf(row) || previousAt + 1;
        previousAt = Math.max(previousAt, at);
        if (next.startedAt === undefined || at < next.startedAt) next.startedAt = at;
        if (next.lastAt === undefined || at > next.lastAt) next.lastAt = at;
        next.tokens += tokensOf(row);

        const id = typeof row.uuid === 'string' && row.uuid.length > 0 ? row.uuid : `row-${next.rowCount}`;
        // The wire already clears isSidechain; cleared again here because a
        // sidechain record is filed under a Task card by the reducer, and this
        // transcript IS the conversation. A user record with no uuid is
        // dropped by the normalizer, so one is minted.
        const parsed = RawRecordSchema.safeParse({
            role: 'agent',
            content: { type: 'output', data: { ...row, isSidechain: false, uuid: typeof row.uuid === 'string' ? row.uuid : id } },
        });
        if (!parsed.success) continue;
        const normalized = normalizeRawMessage(id, null, at, parsed.data);
        if (!normalized) continue;
        const result = reducer(next.reducer, [normalized]);
        for (const message of result.messages) {
            next.messagesMap[message.id] = message;
        }
    }
    next.messages = Object.values(next.messagesMap).sort((a, b) => b.createdAt - a.createdAt);
    return next;
}

/**
 * How long a running agent may go unwritten before the header says so. The
 * threshold and the rule live in utils/agentCard.ts now, so the inline Agent
 * card says exactly what this screen says (DROVE-110).
 */
export { SUBAGENT_QUIET_MS };

export interface SubagentHeadline {
    state: SubagentState;
    /** Elapsed while running; the run's total once it has stopped. */
    elapsedMs: number;
    /** Set while running and the transcript has not moved for a while. */
    quietMs?: number;
    tokens: number;
}

/**
 * The numbers the header draws, from what the CLI said and what the rows
 * held. `now` is the phone's clock and the elapsed counter ticks off it while
 * the agent runs; once it has stopped the clock freezes at the parent's
 * notification, or failing that the newest row.
 */
export function describeSubagent(
    agent: Pick<SubagentTranscriptAgent, 'state' | 'updatedAt' | 'endedAt'> | null | undefined,
    transcript: Pick<SubagentTranscriptState, 'startedAt' | 'lastAt' | 'tokens'>,
    now: number,
): SubagentHeadline {
    const state = agent?.state ?? 'running';
    const startedAt = transcript.startedAt ?? agent?.updatedAt ?? now;
    const stoppedAt = agent?.endedAt ?? transcript.lastAt ?? agent?.updatedAt ?? now;
    const elapsedMs = Math.max(0, (state === 'running' ? now : stoppedAt) - startedAt);
    const movedAt = Math.max(agent?.updatedAt ?? 0, transcript.lastAt ?? 0);
    const quietMs = agentQuietFor(state === 'running', movedAt, now);
    return {
        state,
        elapsedMs,
        ...(quietMs !== undefined ? { quietMs } : {}),
        tokens: transcript.tokens,
    };
}
