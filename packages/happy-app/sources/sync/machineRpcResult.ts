/**
 * What a machine RPC actually answers when the daemon's handler THREW, and
 * why the phone used to lose the reason (DROVE-337).
 *
 * Every handler on the daemon runs inside `RpcHandlerManager.handleRequest`,
 * and that function catches. It does not reject the call: it ENCRYPTS
 * `{ error: '<the thrown message>' }` and returns it as an ordinary, ok
 * response. `apiSocket.machineRPC` sees `result.ok` and hands that object
 * back verbatim, typed as whatever the caller declared.
 *
 * So a caller expecting `{ type: 'success' | 'error' | ... }` gets an object
 * with NO `type` at all. Every `result.type === 'error' ? result.errorMessage
 * : <generic sentence>` in the app then takes the generic branch and throws
 * away the only sentence that said what happened. Measured on 2026-09-01:
 * Clay forked a session, the daemon said "Could not open a tmux window for
 * this session: Failed to extract PID from tmux output", and the phone said
 * "Failed to fork the session."
 *
 * This is the one place that translates. It is deliberately narrow -- a bare
 * `{ error }` with no `type` -- because that shape is exactly and only what
 * the daemon's catch produces, and widening it would start rewriting real
 * results that happen to carry an `error` field of their own.
 */

/** A non-empty string, or null. Keeps every caller's guard identical. */
function reason(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/**
 * The daemon's thrown-handler message, or null when this is a real result.
 */
export function daemonThrownReason(value: unknown): string | null {
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    // A real result always names its own kind. Only the catch does not.
    if (typeof record.type === 'string') return null;
    return reason(record.error);
}

/**
 * Turn whatever came back into a result the caller's `switch` can read.
 *
 * Three cases, in order: the daemon threw and said why; the daemon returned a
 * real tagged result; the daemon returned something this build does not
 * understand, which becomes an error carrying `fallback` rather than being
 * passed on to be silently treated as "not success" by the caller.
 */
export function normalizeMachineRpcResult<T extends { type: string }>(
    value: unknown,
    fallback: string,
): T | { type: 'error'; errorMessage: string } {
    const thrown = daemonThrownReason(value);
    if (thrown) {
        return { type: 'error', errorMessage: thrown };
    }
    if (value && typeof value === 'object' && typeof (value as { type?: unknown }).type === 'string') {
        return value as T;
    }
    return { type: 'error', errorMessage: fallback };
}

/**
 * The message for a caught exception on the app side of the same call: a
 * dropped socket, a machine with no encryption key, a server refusal.
 */
export function machineRpcCatchMessage(error: unknown, fallback: string): string {
    if (error instanceof Error) {
        return reason(error.message) ?? fallback;
    }
    return reason(error) ?? fallback;
}
