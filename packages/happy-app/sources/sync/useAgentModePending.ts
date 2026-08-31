/**
 * Which of the composer's three controls are still waiting on the pane
 * (DROVE-217).
 *
 * Three things can end a wait and the hook has to re-render for all three. Two
 * are already reactive: the pane's value and the stored request both live on
 * the session, so a metadata update re-renders the tree that reads them. The
 * third is the give-up bound, which is a clock rather than an event, so this
 * arms one timer for the earliest deadline that is actually outstanding and
 * nothing at all when none is.
 *
 * The rule itself is in agentModeRequests.ts and is pure. This is only the
 * wiring.
 */

import * as React from 'react';
import {
    AGENT_MODE_CONTROLS,
    AGENT_MODE_PENDING_GIVE_UP_MS,
    agentModePendingState,
    getAgentModeRequest,
    paneObservedMode,
    subscribeAgentModeRequests,
    type AgentModeControl,
} from './agentModeRequests';
import type { Session } from './storageTypes';

export type AgentModePendingFlags = Record<AgentModeControl, boolean>;

const NONE_PENDING: AgentModePendingFlags = {
    permissionMode: false,
    modelMode: false,
    effortLevel: false,
};

export function useAgentModePending(session: Session): AgentModePendingFlags {
    const [, bump] = React.useReducer((tick: number) => tick + 1, 0);
    React.useEffect(() => subscribeAgentModeRequests(bump), []);

    const sessionId = session.id;
    const metadata = session.metadata;
    const stored: Record<AgentModeControl, string | null> = {
        permissionMode: session.permissionMode ?? null,
        modelMode: session.modelMode ?? null,
        effortLevel: session.effortLevel ?? null,
    };

    const now = Date.now();
    let anyPending = false;
    let earliestDeadline = Number.POSITIVE_INFINITY;
    const flags: AgentModePendingFlags = { ...NONE_PENDING };
    for (const field of AGENT_MODE_CONTROLS) {
        const request = getAgentModeRequest(sessionId, field);
        const pending = agentModePendingState(field, {
            request,
            stored: stored[field],
            observed: paneObservedMode(metadata, field),
            now,
        }) === 'pending';
        flags[field] = pending;
        if (pending && request) {
            anyPending = true;
            earliestDeadline = Math.min(earliestDeadline, request.at + AGENT_MODE_PENDING_GIVE_UP_MS);
        }
    }

    // `anyPending` keeps the effect off the dependency treadmill when nothing is
    // waiting, which is nearly always.
    const deadline = anyPending ? earliestDeadline : null;
    React.useEffect(() => {
        if (deadline === null) return;
        const timer = setTimeout(bump, Math.max(0, deadline - Date.now()) + 1);
        return () => clearTimeout(timer);
    }, [deadline]);

    return anyPending ? flags : NONE_PENDING;
}
