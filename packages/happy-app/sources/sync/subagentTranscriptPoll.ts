/**
 * Keeping the agent screen alive while the Mac's CLI is away (DROVE-132).
 *
 * The screen polls `subagentTranscript` every two seconds (DROVE-93). Clay
 * rebuilds the CLI and kickstarts the daemon on every change, so the target
 * behind that RPC goes away several times an hour, and the screen he was
 * reading turned into a bare `RPC target disconnected` on an empty page with
 * a header claiming `Running · 0s` for an agent that had already finished.
 *
 * Three things had to change and they all live here except the header:
 *
 * 1. UNREACHABLE IS NEVER AN ENDING. The loop only ever stops because the CLI
 *    told us the agent settled. Every other answer, including no answer at
 *    all, schedules another attempt, and the ladder below keeps a long outage
 *    from hammering the server: 2s, 4s, 8s, 16s, then 30s for as long as it
 *    takes. The very first good answer resets it, so a restart costs at most
 *    one ladder step of extra wait and then the screen repaints itself.
 *
 * 2. THE PHONE'S SIDE COUNTS TOO. A phone off the network fails in exactly
 *    the same place as a Mac that is rebooting, so the cause is classified
 *    from the socket's own status rather than from the words in the error,
 *    and both recover through the same loop.
 *
 * 3. THE TRANSPORT'S WORDS ARE NOT THE USER'S. `RPC target disconnected` is
 *    kept as `detail` for a log line and never shown as the headline; the
 *    screen renders the cause instead.
 *
 * Everything here is pure or dependency-injected, so the whole disconnect →
 * retry → reconnect → repaint story is a unit test rather than a device.
 */

import {
    applySubagentTranscriptRows,
    createSubagentTranscriptState,
    type SubagentTranscriptAgent,
    type SubagentTranscriptResponse,
    type SubagentTranscriptState,
} from './subagentTranscript';

/** The cadence while everything is answering. */
export const SUBAGENT_POLL_MS = 2_000;
/** The first retry after a failure, doubling from there. */
export const SUBAGENT_RETRY_MIN_MS = 2_000;
/** The ceiling. A restart is over long before this, an outage is not. */
export const SUBAGENT_RETRY_MAX_MS = 30_000;

/**
 * Why the transcript could not be read. `offline` is this phone, `computer`
 * is the Mac, `unknown` is neither answer being available — all three keep
 * retrying, they differ only in what the screen says.
 */
export type SubagentTroubleCause = 'offline' | 'computer' | 'unknown';

export interface SubagentTrouble {
    cause: SubagentTroubleCause;
    /** The transport's own words. For a log line, never for the headline. */
    detail: string;
}

export interface SubagentPollSnapshot {
    transcript: SubagentTranscriptState;
    /** What the CLI last said about the agent; null until it has said anything. */
    agent: Partial<SubagentTranscriptAgent> | null;
    /** Set while the transcript cannot be reached at all. */
    trouble: SubagentTrouble | null;
    /** Set when the CLI answered and would not serve the transcript. */
    refusal: string | null;
    /** True once a poll has come back one way or the other. */
    loaded: boolean;
    /** Consecutive polls that produced no transcript; drives the ladder. */
    failures: number;
}

export function createSubagentPollSnapshot(): SubagentPollSnapshot {
    return {
        transcript: createSubagentTranscriptState(),
        agent: null,
        trouble: null,
        refusal: null,
        loaded: false,
        failures: 0,
    };
}

/**
 * The cause, from the socket rather than the sentence.
 *
 * A phone with no connection and a Mac that is restarting both surface as an
 * rpc error, and the error text is the server's, not something to parse for
 * meaning. So: no socket means it is us, a socket means it is the computer,
 * and an error raised with no socket answer either way is left unnamed rather
 * than blamed on the wrong end.
 */
export function classifySubagentFailure(online: boolean | undefined): SubagentTroubleCause {
    if (online === false) return 'offline';
    return online === true ? 'computer' : 'unknown';
}

export function errorDetail(error: unknown): string {
    if (error instanceof Error && error.message.trim().length > 0) return error.message;
    const text = typeof error === 'string' ? error.trim() : '';
    return text.length > 0 ? text : 'unknown error';
}

/** Fold one good answer in. */
export function applyPollResponse(
    snapshot: SubagentPollSnapshot,
    response: SubagentTranscriptResponse,
): SubagentPollSnapshot {
    if (response.ok) {
        const moved = response.rows.length > 0 || response.cursor !== snapshot.transcript.cursor;
        return {
            transcript: moved
                ? applySubagentTranscriptRows(snapshot.transcript, response.rows, response.cursor)
                : snapshot.transcript,
            agent: response.agent,
            trouble: null,
            refusal: null,
            loaded: true,
            failures: 0,
        };
    }
    // The CLI answered. That is a working connection, so the ladder resets
    // whenever it can still name the agent's state — a transcript that has
    // not been written yet is an ordinary two-second wait, not an outage. An
    // answer that knows nothing about the agent does back off, because the
    // CLI may have restarted into a session that never had it.
    const knowsAgent = response.agent?.state !== undefined;
    return {
        ...snapshot,
        agent: response.agent ?? snapshot.agent,
        trouble: null,
        refusal: response.reason,
        loaded: true,
        failures: knowsAgent ? 0 : snapshot.failures + 1,
    };
}

/** Fold one failure in. The transcript and the last known agent are kept. */
export function applyPollFailure(
    snapshot: SubagentPollSnapshot,
    detail: string,
    online: boolean | undefined,
): SubagentPollSnapshot {
    return {
        ...snapshot,
        trouble: { cause: classifySubagentFailure(online), detail },
        refusal: null,
        loaded: true,
        failures: snapshot.failures + 1,
    };
}

/**
 * The one rule that ends the loop: the CLI said the agent has stopped. Not
 * being able to reach the CLI is not an ending, which is the whole bug.
 */
export function shouldPollAgain(snapshot: SubagentPollSnapshot): boolean {
    if (snapshot.trouble) return true;
    const state = snapshot.agent?.state;
    return state !== 'done' && state !== 'failed';
}

export function pollDelayMs(snapshot: SubagentPollSnapshot): number {
    if (snapshot.failures <= 0) return SUBAGENT_POLL_MS;
    const step = SUBAGENT_RETRY_MIN_MS * 2 ** (snapshot.failures - 1);
    return Math.min(SUBAGENT_RETRY_MAX_MS, step);
}

export interface SubagentPollDeps {
    /** One `subagentTranscript` call, from the given byte offset. */
    fetch(since: number): Promise<SubagentTranscriptResponse>;
    /**
     * Sleep before the next attempt. The screen resolves this early when the
     * socket reconnects, so a Mac that comes back is picked up at once rather
     * than at the far end of the ladder.
     */
    wait(ms: number): Promise<void>;
    /** Whether the phone currently has a server connection; undefined if unknown. */
    isOnline(): boolean | undefined;
    isCancelled(): boolean;
    onSnapshot(snapshot: SubagentPollSnapshot): void;
}

/**
 * The whole loop. Returns the last snapshot, which is what the tests read.
 */
export async function runSubagentTranscriptPoll(
    deps: SubagentPollDeps,
    initial: SubagentPollSnapshot = createSubagentPollSnapshot(),
): Promise<SubagentPollSnapshot> {
    let snapshot = initial;
    while (!deps.isCancelled()) {
        try {
            const response = await deps.fetch(snapshot.transcript.cursor);
            if (deps.isCancelled()) break;
            snapshot = applyPollResponse(snapshot, response);
        } catch (error) {
            if (deps.isCancelled()) break;
            snapshot = applyPollFailure(snapshot, errorDetail(error), deps.isOnline());
        }
        deps.onSnapshot(snapshot);
        if (!shouldPollAgain(snapshot)) break;
        await deps.wait(pollDelayMs(snapshot));
    }
    return snapshot;
}
