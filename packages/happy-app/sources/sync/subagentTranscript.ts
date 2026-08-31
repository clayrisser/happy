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

import { agentOutcome, agentQuietFor, agentRunState, agentRunStateOf, isAsyncAgentLaunch, SUBAGENT_QUIET_MS, type AgentRunState } from '@/utils/agentCard';

import { createReducer, reducer, type ReducerState } from './reducer/reducer';
import type { Message, ToolCall } from './typesMessage';
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
    /**
     * The CLI stopped at its page cap, not at the end of the file, so there
     * is more waiting past `cursor` (DROVE-211). Ask again at once.
     */
    more?: boolean;
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
    /**
     * What the CLI last said, or `unknown` when nothing readable says
     * anything. `unknown` is not a state the agent can be in; it is this
     * screen admitting it cannot see (DROVE-132).
     */
    state: SubagentState | 'unknown';
    /**
     * The same word the inline Agent card uses for the same agent, off the
     * same function (DROVE-115). The card reads the CLI's terminal
     * tool-call-end and this screen reads the CLI's subagentTranscript RPC,
     * and both are the CLI reading one task-notification, so the two surfaces
     * cannot disagree unless this translation does.
     */
    runState: AgentRunState | 'unknown';
    /**
     * Elapsed while running; the run's total once it has stopped. UNDEFINED
     * when nothing readable carries a start, because a header that prints
     * `0s` for an agent that ran for minutes is worse than a header that
     * prints nothing (DROVE-132).
     */
    elapsedMs?: number;
    /** Set while running and the transcript has not moved for a while. */
    quietMs?: number;
    tokens: number;
}

/**
 * What the SESSION already knows about an agent, read off its own tool call
 * rather than off the transcript RPC (DROVE-132).
 *
 * The transcript lives on the Mac and is only reachable while the CLI is up.
 * The agent's launch receipt and, since DROVE-115, its terminal result travel
 * as ordinary session messages, which are stored on the phone and survive a
 * CLI restart. So when the RPC cannot be reached the header still has a
 * truthful answer, and only says `unknown` when there is genuinely nothing.
 */
export interface SubagentKnownRun {
    runState: AgentRunState;
    /** When the Agent tool call opened, epoch ms. */
    startedAt?: number;
    /** The run's total, from the CLI's terminal result. */
    durationMs?: number;
}

function agentIdOf(tool: Pick<ToolCall, 'input' | 'result'>): string | undefined {
    const from = (value: unknown): string | undefined => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
        const id = (value as Record<string, unknown>).agentId;
        return typeof id === 'string' && id.length > 0 ? id : undefined;
    };
    return from(tool.result) ?? from(tool.input);
}

/** Depth-first, because a Task card folds its own calls underneath it. */
function findSubagentToolCall(messages: Message[], agentId: string): ToolCall | null {
    for (const message of messages) {
        if (message.kind !== 'tool-call') continue;
        if (agentIdOf(message.tool) === agentId) return message.tool;
        const nested = findSubagentToolCall(message.children, agentId);
        if (nested) return nested;
    }
    return null;
}

/**
 * The agent's run as the session itself recorded it, or null when the session
 * knows nothing worth asserting. Pure, so the screen can hand it whatever the
 * message store holds and a test can hand it three messages.
 *
 * A BARE LAUNCH RECEIPT IS NOT KNOWLEDGE. `agentRunState` answers `running`
 * for anything it cannot read, which is the right default for a card that
 * must never draw a working agent as dead (DROVE-110) and the wrong one here:
 * the header in DROVE-132's screenshot said `Running` for an agent that had
 * finished, off exactly that default. So a call still holding only
 * `async_launched` reports nothing, and the header says it does not know.
 */
export function findSubagentRun(messages: Message[], agentId: string): SubagentKnownRun | null {
    const tool = findSubagentToolCall(messages, agentId);
    if (!tool) return null;
    const runState = agentRunState(tool);
    if (runState === 'running' && !(tool.state === 'running' && !isAsyncAgentLaunch(tool.result))) {
        return null;
    }
    const outcome = agentOutcome(tool.result);
    const startedAt = tool.startedAt ?? tool.createdAt;
    return {
        runState,
        ...(typeof startedAt === 'number' && startedAt > 0 ? { startedAt } : {}),
        ...(outcome?.durationMs !== undefined && outcome.durationMs > 0 ? { durationMs: outcome.durationMs } : {}),
    };
}

/**
 * The numbers the header draws, from what the CLI said, what the rows held
 * and what the session already knew.
 *
 * `now` is the phone's clock and the elapsed counter ticks off it while the
 * agent runs; once it has stopped the clock freezes at the parent's
 * notification, or failing that the newest row.
 *
 * When the transcript cannot be read at all (the CLI is restarting, the phone
 * is off the network) the CLI says nothing, and the header falls back to the
 * session's own record of the run (`known`, off DROVE-115's terminal
 * tool-call-end). With neither, it says `unknown` and prints no clock rather
 * than claiming `Running · 0s` for an agent that finished minutes ago.
 */
export function describeSubagent(
    agent: Pick<SubagentTranscriptAgent, 'state' | 'updatedAt' | 'endedAt'> | null | undefined,
    transcript: Pick<SubagentTranscriptState, 'startedAt' | 'lastAt' | 'tokens'>,
    now: number,
    known?: SubagentKnownRun | null,
): SubagentHeadline {
    if (agent?.state) {
        const state = agent.state;
        const startedAt = transcript.startedAt ?? agent.updatedAt ?? now;
        const stoppedAt = agent.endedAt ?? transcript.lastAt ?? agent.updatedAt ?? now;
        const elapsedMs = Math.max(0, (state === 'running' ? now : stoppedAt) - startedAt);
        const movedAt = Math.max(agent.updatedAt ?? 0, transcript.lastAt ?? 0);
        const quietMs = agentQuietFor(state === 'running', movedAt, now);
        return {
            state,
            runState: agentRunStateOf(state),
            elapsedMs,
            ...(quietMs !== undefined ? { quietMs } : {}),
            tokens: transcript.tokens,
        };
    }

    // Nothing from the CLI. Whatever the session recorded is still true.
    const runState = known?.runState;
    const rowSpan = transcript.startedAt !== undefined && transcript.lastAt !== undefined
        ? Math.max(0, transcript.lastAt - transcript.startedAt)
        : undefined;
    let elapsedMs: number | undefined;
    if (runState === 'running') {
        const startedAt = transcript.startedAt ?? known?.startedAt;
        elapsedMs = startedAt !== undefined ? Math.max(0, now - startedAt) : undefined;
    } else if (runState !== undefined) {
        elapsedMs = known?.durationMs ?? rowSpan;
    } else {
        elapsedMs = rowSpan;
    }

    return {
        state: 'unknown',
        runState: runState ?? 'unknown',
        ...(elapsedMs !== undefined ? { elapsedMs } : {}),
        tokens: transcript.tokens,
    };
}
