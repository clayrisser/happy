/**
 * A gate answer that is never allowed to spin forever (DROVE-218).
 *
 * Clay's screenshot: two Run Bash prompts, 17 and 18 minutes old, Allow
 * replaced by a spinner. He had answered them. The socket RPC underneath waits
 * 50 seconds for an acknowledgement, and an app that is backgrounded while it
 * waits can sit far past that with no timer running — so the screen said
 * "working on it" for a quarter of an hour and told him nothing.
 *
 * A spinner that never ends is worse than a visible failure, because he waits
 * instead of retrying. So: a few seconds, then the buttons come back with a
 * line saying the answer was not acknowledged.
 *
 * What this does NOT do, and must never do: decide anything. It sends nothing
 * on timeout, it does not fall back to allow, it does not fall back to deny.
 * DROVE-203 is a gate that resolved `allow` with nobody at the terminal, and a
 * timeout that picked a side would be the same bug with a nicer name. The
 * answer already in flight is left alone: if it lands late the card comes down
 * on its own, and if it never lands the buttons are already back.
 */

/** Long enough for a healthy round trip on a slow phone, short enough to notice. */
export const GATE_ANSWER_TIMEOUT_MS = 8_000;

export type GateAnswerOutcome =
    /** Acknowledged. The card comes down when the store catches up. */
    | { kind: 'ok' }
    /** The RPC threw — no connection, a bridge that refused, a bad id. */
    | { kind: 'failed'; message: string }
    /** No acknowledgement inside the budget. Still possibly in flight. */
    | { kind: 'timeout' };

/**
 * Run an answer with a deadline, and say which of the three things happened.
 *
 * The promise is not cancelled on timeout — nothing here can cancel a socket
 * RPC — it is merely stopped from holding the button hostage. Its late
 * rejection is swallowed so a timed-out answer cannot surface as an unhandled
 * rejection minutes later.
 */
export async function answerWithDeadline(
    answer: () => Promise<unknown>,
    timeoutMs: number = GATE_ANSWER_TIMEOUT_MS,
    schedule: (fn: () => void, ms: number) => unknown = setTimeout,
    cancel: (handle: never) => void = clearTimeout as never,
): Promise<GateAnswerOutcome> {
    let handle: unknown;
    const deadline = new Promise<GateAnswerOutcome>((resolve) => {
        handle = schedule(() => resolve({ kind: 'timeout' }), timeoutMs);
    });
    const running = answer().then(
        (): GateAnswerOutcome => ({ kind: 'ok' }),
        (error): GateAnswerOutcome => ({ kind: 'failed', message: messageFor(error) }),
    );
    const outcome = await Promise.race([running, deadline]);
    if (outcome.kind !== 'timeout') cancel(handle as never);
    return outcome;
}

function messageFor(error: unknown): string {
    if (error instanceof Error && error.message) return error.message;
    const text = String(error ?? '').trim();
    return text || 'Unknown error';
}

/**
 * What the card says when the answer did not land.
 *
 * Names the state and the next move, and never implies anything happened on
 * the agent's side. "Not acknowledged" is the honest word for a timeout: the
 * answer may yet arrive, and if it does the card goes away by itself.
 */
export function gateAnswerTrouble(outcome: GateAnswerOutcome): string | null {
    if (outcome.kind === 'ok') return null;
    if (outcome.kind === 'timeout') {
        return 'No acknowledgement. Nothing was decided — try again, or dismiss this prompt.';
    }
    return `Could not send that answer: ${outcome.message}. Nothing was decided.`;
}
