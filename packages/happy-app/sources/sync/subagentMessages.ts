/**
 * Where an agent screen's rows are reachable from (DROVE-166).
 *
 * A subagent's transcript is fetched over RPC and folded in the agent
 * screen's own state (DROVE-93). It is never in `storage.sessionMessages`,
 * which holds the SESSION's messages. So a row inside a consolidated card on
 * an agent screen resolved to `/session/<sessionId>/message/<an agent message
 * id>`, the detail screen looked that id up in the session's map, found
 * nothing and popped straight back. Tapping the row did nothing visible.
 *
 * The route carries the agent now, and the agent screen publishes the
 * messages it is drawing here, so the detail screen reads the same objects
 * from the same place a row was drawn from. It stays live: a command still
 * running when it was tapped keeps filling in, exactly as in the main
 * transcript.
 *
 * Nothing is persisted. A scope lives as long as the agent screen that
 * published it, which is the whole time a detail pushed from it is on top.
 */

import * as React from 'react';

import type { Message } from './typesMessage';

type Ids = string | null | undefined;

const scopes = new Map<string, Record<string, Message>>();
const listeners = new Set<() => void>();

/** Encoded rather than joined, so no session/agent pair can spell another's key. */
export function subagentScopeKey(sessionId: string, agentId: string): string {
    return JSON.stringify([sessionId, agentId]);
}

function emit(): void {
    for (const listener of listeners) {
        listener();
    }
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/** What the agent screen is drawing, by message id. */
export function publishSubagentMessages(
    sessionId: string,
    agentId: string,
    messages: Record<string, Message>,
): void {
    const key = subagentScopeKey(sessionId, agentId);
    if (scopes.get(key) === messages) {
        return;
    }
    scopes.set(key, messages);
    emit();
}

export function clearSubagentMessages(sessionId: string, agentId: string): void {
    if (scopes.delete(subagentScopeKey(sessionId, agentId))) {
        emit();
    }
}

/** Tests only. */
export function resetSubagentMessages(): void {
    scopes.clear();
    emit();
}

/** True once the agent screen has published anything for this pair. */
export function hasSubagentScope(sessionId: Ids, agentId: Ids): boolean {
    if (!sessionId || !agentId) {
        return false;
    }
    return scopes.has(subagentScopeKey(sessionId, agentId));
}

export function getSubagentMessage(sessionId: Ids, agentId: Ids, messageId: Ids): Message | null {
    if (!sessionId || !agentId || !messageId) {
        return null;
    }
    return scopes.get(subagentScopeKey(sessionId, agentId))?.[messageId] ?? null;
}

export function useSubagentMessage(sessionId: Ids, agentId: Ids, messageId: Ids): Message | null {
    const read = React.useCallback(
        () => getSubagentMessage(sessionId, agentId, messageId),
        [sessionId, agentId, messageId],
    );
    return React.useSyncExternalStore(subscribe, read, read);
}

export function useSubagentScopeLoaded(sessionId: Ids, agentId: Ids): boolean {
    const read = React.useCallback(
        () => hasSubagentScope(sessionId, agentId),
        [sessionId, agentId],
    );
    return React.useSyncExternalStore(subscribe, read, read);
}

/**
 * The agent whose transcript the rows under this belong to, or null in the
 * session's own transcript. A context rather than a prop because the row is
 * five memoized components below the screen, and the answer is the same for
 * every one of them.
 */
export const SubagentScopeContext = React.createContext<string | null>(null);

export function useSubagentScope(): string | null {
    return React.useContext(SubagentScopeContext);
}
