/**
 * Phone-side feed for the Cattle Drover wrist surface (BASED-98).
 *
 * Collects every permission request currently waiting on a human — across all
 * sessions, not only the drover bridge session, so any Happy session's prompt
 * reaches the wrist — publishes them to the watch, and replays the watch's
 * answers through the app's own sessionAllow / sessionDeny. The watch is
 * therefore just another surface answering the same RPC the Yes button calls;
 * there is no second decision path to keep in sync.
 *
 * Gate ids are `${sessionId}:${requestId}`. Request ids can themselves contain
 * a colon (the CLI uses `agentID:toolUseID` for subagent-scoped requests), so
 * routing splits on the FIRST colon only — session ids never contain one.
 */

import { storage } from './storage';
import { sessionAllow, sessionDeny } from './ops';
import {
    addDroverAnswerListener,
    getDroverWatchStatus,
    isDroverWatchAvailable,
    publishDroverSnapshot,
    type DroverGate,
} from 'drover-watch';

const PREVIEW_LIMIT = 240;

function previewFor(tool: string, args: unknown): string {
    const input = (args ?? {}) as Record<string, unknown>;
    const raw =
        typeof input.command === 'string' ? input.command
        : typeof input.file_path === 'string' ? input.file_path
        : typeof input.description === 'string' ? input.description
        : JSON.stringify(input);
    const text = raw ?? '';
    return text.length > PREVIEW_LIMIT ? `${text.slice(0, PREVIEW_LIMIT)}…` : text;
}

/** Every pending request in storage, flattened into wrist-sized gates. */
export function collectGates(): DroverGate[] {
    const sessions = storage.getState().sessions ?? {};
    const gates: DroverGate[] = [];
    for (const [sessionId, session] of Object.entries(sessions)) {
        const requests = session?.agentState?.requests;
        if (!requests) continue;
        for (const [requestId, request] of Object.entries(requests)) {
            const tool = (request as { tool?: string }).tool ?? 'Tool';
            const args = (request as { arguments?: unknown }).arguments;
            const createdAt = (request as { createdAt?: number }).createdAt ?? Date.now();
            const account = session?.metadata?.droverAccount;
            gates.push({
                id: `${sessionId}:${requestId}`,
                title: tool === 'AskUserQuestion' ? 'Question' : `Run ${tool}`,
                reason: session?.metadata?.summary?.text ?? session?.metadata?.path ?? '',
                preview: previewFor(tool, args),
                kind: tool === 'AskUserQuestion' ? 'question' : 'permission',
                createdAt: new Date(createdAt).toISOString(),
                // Omitted, never null: WatchConnectivity payloads take
                // property-list types only and JSON null becomes NSNull,
                // which fails the whole publish. Swift sanitizes too, but
                // not emitting it is the honest fix.
                ...(account ? { account } : {}),
            });
        }
    }
    return gates;
}

function sameGateSet(a: DroverGate[], b: DroverGate[]): boolean {
    if (a.length !== b.length) return false;
    const ids = new Set(a.map((g) => g.id));
    return b.every((g) => ids.has(g.id));
}

let started = false;
let lastGates: DroverGate[] = [];

/**
 * Start the feed. Idempotent, and a no-op where the native module is absent
 * (Android, web, any build without the watch graft).
 */
export function startDroverWatchFeed(): () => void {
    if (started || !isDroverWatchAvailable()) return () => {};
    started = true;

    const push = (force = false) => {
        const gates = collectGates();
        // Only publish on a real change: updateApplicationContext throttles,
        // and a redundant write can displace a fresh one.
        if (!force && sameGateSet(gates, lastGates)) return;
        lastGates = gates;
        const status = getDroverWatchStatus();
        void publishDroverSnapshot({
            gates,
            updatedAt: new Date().toISOString(),
            // "connected" is about whether the WRIST is being fed, which is
            // what the watch's empty state needs to distinguish all-clear
            // from not-watching.
            connected: !!status.activated && status.paired && status.installed,
        });
    };

    const answers = addDroverAnswerListener((event) => {
        const split = event.id.indexOf(':');
        if (split <= 0) return;
        const sessionId = event.id.slice(0, split);
        const requestId = event.id.slice(split + 1);
        const call = event.allow
            ? sessionAllow(sessionId, requestId)
            : sessionDeny(sessionId, requestId);
        // Fire and forget with an explicit catch: an answer that fails to send
        // must not reject unhandled, and the gate simply stays pending, which
        // the next push re-publishes to the wrist.
        void Promise.resolve(call).catch(() => {});
    });

    const unsubscribe = storage.subscribe(() => push());
    push(true);

    return () => {
        started = false;
        answers.remove();
        unsubscribe();
    };
}
