/**
 * The terminal's remote control, on the wire (DROVE-298).
 *
 * `drover read pause` in a tmux pane ends up here. The path is the one gates
 * already take, in both directions, which is the whole reason this is a
 * command KIND rather than a new channel:
 *
 *   drover read → the drover bus → SSE → happy-cli's droverBridge, which
 *   writes the command into the bridge session's agent state → this app sees
 *   an `update-session` → applyReadingCommand decides → sessionRPC
 *   `drover-reading` back to the bridge → the bridge acks on the bus → the
 *   terminal, still long-polling, prints what the PHONE said.
 *
 * THE PHONE DECIDES, and that is what makes two terminals safe: neither of
 * them applies anything, so a race between two panes cannot desync the voice.
 *
 * PURE, and apart from droverReadingService for the same reason droverGates
 * is apart from droverWatchFeed: this is what a test can drive off a plain
 * object, and importing the service would drag in the store, the socket and
 * react-native to assert on a rule that needs none of them.
 */

import { isDroverBridgeSession } from './droverBridgeSession';
import {
    applyReadingCommand,
    readingCommandExpired,
    type ReadingCommand,
    type ReadingPolicy,
    type ReadingSnapshot,
} from '@/voice/readingControl';

/** What the bridge writes into the bridge session's agent state. */
export interface DroverReadingState {
    command?: ReadingCommand | null;
}

export interface ReadingSessionLike {
    metadata?: unknown;
    agentState?: { droverReading?: DroverReadingState | null } | null;
}

/**
 * The bridge session, and the command it is holding.
 *
 * Exported so a test can drive it off a plain object rather than the store —
 * the same reason droverGates takes its sessions as an argument.
 */
export function pendingReadingCommand(
    sessions: Record<string, ReadingSessionLike | undefined>,
): { sessionId: string; command: ReadingCommand } | null {
    for (const [sessionId, session] of Object.entries(sessions)) {
        if (!isDroverBridgeSession(session as { metadata?: never })) continue;
        const command = session?.agentState?.droverReading?.command;
        if (!command || typeof command.id !== 'string' || typeof command.verb !== 'string') continue;
        return { sessionId, command: command as ReadingCommand };
    }
    return null;
}

/** The bridge session's id, for the unprompted state reports. */
export function bridgeSessionIdOf(sessions: Record<string, ReadingSessionLike | undefined>): string | null {
    for (const [sessionId, session] of Object.entries(sessions)) {
        if (isDroverBridgeSession(session as { metadata?: never })) return sessionId;
    }
    return null;
}

/**
 * Ids already answered, so a re-render, a reconnect or the bridge re-writing
 * the same agent state cannot apply one command twice. Bounded because the
 * store publishes on every change anywhere and this must not grow with it.
 */
const answered = new Set<string>();
const maxAnswered = 64;

export function forgetAnsweredReadingCommands(): void {
    answered.clear();
}

function remember(id: string): void {
    answered.add(id);
    while (answered.size > maxAnswered) {
        const oldest = answered.values().next().value;
        if (oldest === undefined) break;
        answered.delete(oldest);
    }
}

export interface ReadingReporter {
    (bridgeSessionId: string, body: { id?: string; applied?: boolean; reason?: string; state: ReadingSnapshot }): Promise<void>;
}

/**
 * Apply whatever the bridge session is holding. Returns what it did, so a test
 * can assert on it without a socket.
 */
export async function handleReadingCommands(
    sessions: Record<string, ReadingSessionLike | undefined>,
    policy: ReadingPolicy,
    report: ReadingReporter,
    now: number = Date.now(),
): Promise<'none' | 'expired' | 'answered'> {
    const found = pendingReadingCommand(sessions);
    if (!found) return 'none';
    if (answered.has(found.command.id)) return 'none';
    remember(found.command.id);
    // AN EXPIRED COMMAND IS NOT APPLIED AND NOT ANSWERED. The bus expired it on
    // its side and the terminal has already been told nothing happened; acking
    // it would only earn a 409. Refusing to APPLY it is the half that matters:
    // an app that was closed when the ask went out must not start talking now.
    if (readingCommandExpired(found.command, now)) return 'expired';
    const verdict = applyReadingCommand(found.command, policy, now);
    try {
        await report(found.sessionId, {
            id: found.command.id,
            applied: verdict.applied,
            reason: verdict.reason,
            state: verdict.state,
        });
    } catch {
        // A bridge that cannot be reached is a terminal that gets "the phone
        // did not answer", which is true and is the honest outcome. Never a
        // throw: this runs inside a store subscription.
    }
    return 'answered';
}

