/**
 * Base Permission Handler
 *
 * Abstract base class for permission handlers that manage tool approval requests.
 * Shared by Codex and Gemini permission handlers.
 *
 * @module BasePermissionHandler
 */

import { logger } from "@/ui/logger";
import { ApiSessionClient } from "@/api/apiSession";
import { AgentState } from "@/api/types";

/**
 * Permission response from the mobile app.
 */
export interface PermissionResponse {
    id: string;
    approved: boolean;
    decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort';
}

/**
 * Pending permission request stored while awaiting user response.
 */
export interface PendingRequest {
    resolve: (value: PermissionResult) => void;
    reject: (error: Error) => void;
    toolName: string;
    input: unknown;
}

/**
 * Result of a permission request.
 */
export interface PermissionResult {
    decision: 'approved' | 'approved_for_session' | 'denied' | 'abort';
}

/**
 * Abstract base class for permission handlers.
 *
 * Subclasses must implement:
 * - `getLogPrefix()` - returns the log prefix (e.g., '[Codex]')
 */
export abstract class BasePermissionHandler {
    protected pendingRequests = new Map<string, PendingRequest>();
    protected session: ApiSessionClient;
    private isResetting = false;

    /**
     * Returns the log prefix for this handler.
     */
    protected abstract getLogPrefix(): string;

    constructor(session: ApiSessionClient) {
        this.session = session;
        this.setupRpcHandler();
    }

    /**
     * Update the session reference (used after offline reconnection swaps sessions).
     * This is critical for avoiding stale session references after onSessionSwap.
     */
    updateSession(newSession: ApiSessionClient): void {
        logger.debug(`${this.getLogPrefix()} Session reference updated`);
        this.session = newSession;
        // Re-setup RPC handler with new session
        this.setupRpcHandler();
    }

    /**
     * Setup RPC handler for permission responses.
     */
    protected setupRpcHandler(): void {
        this.session.rpcHandlerManager.registerHandler<PermissionResponse, void>(
            'permission',
            async (response) => {
                const pending = this.pendingRequests.get(response.id);
                if (!pending) {
                    logger.debug(`${this.getLogPrefix()} Permission request not found or already resolved`);
                    return;
                }

                // Remove from pending
                this.pendingRequests.delete(response.id);

                // Resolve the permission request
                const result: PermissionResult = response.approved
                    ? { decision: response.decision === 'approved_for_session' ? 'approved_for_session' : 'approved' }
                    : { decision: response.decision === 'denied' ? 'denied' : 'abort' };

                pending.resolve(result);

                // Move request to completed in agent state
                this.session.updateAgentState((currentState) => {
                    const request = currentState.requests?.[response.id];
                    if (!request) return currentState;

                    const { [response.id]: _, ...remainingRequests } = currentState.requests || {};

                    let res = {
                        ...currentState,
                        requests: remainingRequests,
                        completedRequests: {
                            ...currentState.completedRequests,
                            [response.id]: {
                                ...request,
                                completedAt: Date.now(),
                                status: response.approved ? 'approved' : 'denied',
                                decision: result.decision
                            }
                        }
                    } satisfies AgentState;
                    return res;
                });

                logger.debug(`${this.getLogPrefix()} Permission ${response.approved ? 'approved' : 'denied'} for ${pending.toolName}`);
            }
        );
    }

    /**
     * Add a pending request to the agent state.
     *
     * If the same id already sits in completedRequests (one codex item can
     * raise several sequential approvals — sandbox-escalation retries), the
     * completed entry must be dropped: the app reducer gives completed
     * entries precedence, so a re-raised request would otherwise never
     * render and the provider would hang awaiting an answer.
     */
    protected addPendingRequestToState(toolCallId: string, toolName: string, input: unknown): void {
        this.session.updateAgentState((currentState) => {
            const { [toolCallId]: _completed, ...remainingCompleted } = currentState.completedRequests || {};
            return {
                ...currentState,
                requests: {
                    ...currentState.requests,
                    [toolCallId]: {
                        tool: toolName,
                        arguments: input,
                        createdAt: Date.now()
                    }
                },
                completedRequests: remainingCompleted
            };
        });
    }

    /**
     * Raise a permission request and wait for an answer.
     *
     * Lifted here from CodexPermissionHandler (DROVE-316) unchanged, because pi
     * needs exactly this and a second copy of it is a second place for the
     * agent-state bookkeeping to drift. Codex still overrides it to run its
     * auto-approve allowlist first and then calls up to this.
     *
     * There is no timeout and no default. The promise settles only when a
     * surface answers or when abortAll/reset clears it, which is what makes an
     * unanswered gate a suspended tool rather than an approved one.
     */
    async handleToolCall(
        toolCallId: string,
        toolName: string,
        input: unknown
    ): Promise<PermissionResult> {
        return new Promise<PermissionResult>((resolve, reject) => {
            this.pendingRequests.set(toolCallId, { resolve, reject, toolName, input });
            this.addPendingRequestToState(toolCallId, toolName, input);
            logger.debug(`${this.getLogPrefix()} Permission request sent for tool: ${toolName} (${toolCallId})`);
        });
    }

    /**
     * Answer a pending request from somewhere that is not the app's RPC —
     * today, a Cattle Drover bus surface: the gum popup in tmux, or the watch
     * (DROVE-273, generalised in DROVE-316).
     *
     * Same three steps the 'permission' RPC handler takes, in the same order:
     * drop it from pending so a second answer is a no-op, resolve the promise
     * the approval handler is awaiting, and move the card from requests to
     * completedRequests so the app stops showing it. Without that last step the
     * phone would keep displaying a question that has already been answered on
     * the wrist.
     *
     * Returns false when the request is unknown or already answered, which is
     * the normal outcome of a race the other surface won.
     */
    resolveExternally(toolCallId: string, decision: PermissionResult['decision'], by: string): boolean {
        const pending = this.pendingRequests.get(toolCallId);
        if (!pending) return false;
        this.pendingRequests.delete(toolCallId);
        pending.resolve({ decision });

        this.session.updateAgentState((currentState) => {
            const request = currentState.requests?.[toolCallId];
            if (!request) return currentState;
            const { [toolCallId]: _dropped, ...remainingRequests } = currentState.requests || {};
            return {
                ...currentState,
                requests: remainingRequests,
                completedRequests: {
                    ...currentState.completedRequests,
                    [toolCallId]: {
                        ...request,
                        completedAt: Date.now(),
                        status: decision === 'approved' || decision === 'approved_for_session'
                            ? 'approved'
                            : 'denied',
                        decision,
                    },
                },
            } satisfies AgentState;
        });

        logger.debug(`${this.getLogPrefix()} Permission ${decision} for ${pending.toolName} (answered by ${by})`);
        return true;
    }

    /**
     * Abort all pending permission requests.
     * Unlike reset(), this resolves (not rejects) pending promises with { decision: 'abort' },
     * causing the approval response to send 'cancel' to the provider. This is used when the
     * user presses the abort/stop button — it unblocks any pending tool approval so the provider
     * can process the turn cancellation.
     */
    abortAll(): void {
        const pendingSnapshot = Array.from(this.pendingRequests.entries());
        if (pendingSnapshot.length === 0) return;

        this.pendingRequests.clear();

        for (const [id, pending] of pendingSnapshot) {
            try {
                pending.resolve({ decision: 'abort' });
            } catch (err) {
                logger.debug(`${this.getLogPrefix()} Error resolving aborted request ${id}:`, err);
            }
        }

        // Move pending requests to completed as canceled in agent state
        this.session.updateAgentState((currentState) => {
            const pendingRequests = currentState.requests || {};
            const completedRequests = { ...currentState.completedRequests };

            for (const [id, request] of Object.entries(pendingRequests)) {
                completedRequests[id] = {
                    ...request,
                    completedAt: Date.now(),
                    status: 'canceled',
                    reason: 'Aborted by user'
                };
            }

            return {
                ...currentState,
                requests: {},
                completedRequests
            };
        });

        logger.debug(`${this.getLogPrefix()} Aborted ${pendingSnapshot.length} pending permission(s)`);
    }

    /**
     * Reset state for new sessions.
     * This method is idempotent - safe to call multiple times.
     */
    reset(reason: string = 'Session reset'): void {
        // Guard against re-entrant/concurrent resets
        if (this.isResetting) {
            logger.debug(`${this.getLogPrefix()} Reset already in progress, skipping`);
            return;
        }
        this.isResetting = true;

        try {
            // Snapshot pending requests to avoid Map mutation during iteration
            const pendingSnapshot = Array.from(this.pendingRequests.entries());
            this.pendingRequests.clear(); // Clear immediately to prevent new entries being processed

            // Reject all pending requests from snapshot
            for (const [id, pending] of pendingSnapshot) {
                try {
                    pending.reject(new Error('Session reset'));
                } catch (err) {
                    logger.debug(`${this.getLogPrefix()} Error rejecting pending request ${id}:`, err);
                }
            }

            // Clear requests in agent state
            this.session.updateAgentState((currentState) => {
                const pendingRequests = currentState.requests || {};
                const completedRequests = { ...currentState.completedRequests };

                // Move all pending to completed as canceled
                for (const [id, request] of Object.entries(pendingRequests)) {
                    completedRequests[id] = {
                        ...request,
                        completedAt: Date.now(),
                        status: 'canceled',
                        reason
                    };
                }

                return {
                    ...currentState,
                    requests: {},
                    completedRequests
                };
            });

            logger.debug(`${this.getLogPrefix()} Permission handler reset`);
        } finally {
            this.isResetting = false;
        }
    }
}
