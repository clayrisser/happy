/**
 * The reader this phone actually owns, wired to the terminal's remote (DROVE-298).
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
 * A third remote, not a third policy. The wrist has driven pause/resume
 * through `readAloud` since DROVE-275 and the lock screen since DROVE-233;
 * this reaches the same reader by the same calls. The rule about what taking
 * the voice MEANS is DROVE-297's and lives behind `ReadingPolicy` — see
 * livePolicy below for exactly which line 297 replaces.
 */

import { apiSocket } from './apiSocket';
import { storage } from './storage';
import { sessionDisplayTitle } from '@/utils/sessionTitle';
import { readAloud } from '@/voice/readAloudService';
import { readingSnapshotOf, type ReadingPolicy, type ReadingSessionRow } from '@/voice/readingControl';
import {
    bridgeSessionIdOf,
    forgetAnsweredReadingCommands,
    handleReadingCommands,
    type ReadingReporter,
    type ReadingSessionLike,
} from './droverReading';

/**
 * The reader, answering the six questions applyReadingCommand asks.
 *
 * ★ DROVE-297'S SEAM. Per-session reading enablement does not exist yet: the
 * app has ONE global switch (`localSettings.readAloudEnabled`) and ONE focused
 * session (`readAloud.focus`/`blur`). So today `isEnabled` means "this is the
 * focused session and reading is on", `take` is `focus` — which restores that
 * session's held position and auto-resumes it, DROVE-289's machinery, while
 * whatever was speaking is held at its own place — and `disable` is `blur`.
 *
 * When DROVE-297 lands, per-session enablement replaces the bodies of
 * `globalEnabled`, `isEnabled`, `take`, `disable` and `rows` HERE and nothing
 * in readingControl.ts moves. The two entry points stay one rule: a thumb
 * navigating to a session and a terminal naming one both end up in `take`.
 */
export function livePolicy(): ReadingPolicy {
    const sessions = () => storage.getState().sessions ?? {};
    return {
        globalEnabled: () => !!storage.getState().localSettings?.readAloudEnabled && readAloud.isEnabled,
        speaking: () => {
            const sessionId = readAloud.focusedSessionId;
            return {
                sessionId,
                playing: readAloud.isSpeaking && !readAloud.isPaused,
                sentence: readAloud.playhead?.sentence ?? null,
            };
        },
        knows: (sessionId) => !!sessions()[sessionId],
        take: (sessionId) => {
            // DROVE-297's rules 3 and 4, as the reader can express them today:
            // focus() stashes whatever had the voice through holdFocused (its
            // position, its pause and its held place all survive) and restores
            // this session's own, resuming where IT stopped. Never a stop and
            // never a jump ahead, which is the half of the rule that matters.
            readAloud.focus(sessionId, 'switched-session');
        },
        disable: (sessionId) => {
            // `off` is not a pause: it gives up the voice rather than holding
            // it. blur() is the reader's own leave-this-session path, so a
            // terminal turning a session off looks to the reader exactly like
            // walking away from it.
            if (readAloud.focusedSessionId === sessionId) readAloud.blur(sessionId, 'left-session');
        },
        setPaused: (paused) => readAloud.setPaused(paused),
        rows: () => {
            // Only the sessions with a reading state worth reporting: the one
            // holding the voice, and every one holding a place. A row per
            // session in the app would be a hundred lines of `off` in a
            // terminal table, which says nothing.
            const out: ReadingSessionRow[] = [];
            const focused = readAloud.focusedSessionId;
            const all = sessions();
            if (focused) {
                out.push({
                    sessionId: focused,
                    enabled: true,
                    state: readAloud.isPaused ? 'paused' : 'speaking',
                    title: titleOf(all, focused),
                });
            }
            for (const id of Object.keys(all)) {
                if (id === focused) continue;
                if (!readAloud.hasHeldReading(id)) continue;
                // Held but not speaking IS `yielded`, and it has to be
                // tellable from `off`. That distinction is the visible half of
                // DROVE-297's rule on every surface, this table included.
                out.push({ sessionId: id, enabled: true, state: 'yielded', title: titleOf(all, id) });
            }
            return out;
        },
        titleOf: (sessionId) => titleOf(sessions(), sessionId),
    };
}

function titleOf(all: Record<string, unknown>, sessionId: string): string | null {
    const session = all[sessionId];
    if (!session) return null;
    try {
        return sessionDisplayTitle(session as Parameters<typeof sessionDisplayTitle>[0]);
    } catch {
        return null;
    }
}

/**
 * The one call that carries a verdict off this phone: an RPC on the drover
 * bridge session, exactly as answering a gate does. The handler is registered
 * by happy-cli's droverBridge, which turns it into an ack on the bus.
 */
const rpcReporter: ReadingReporter = async (bridgeSessionId, body) => {
    await apiSocket.sessionRPC(bridgeSessionId, 'drover-reading', body);
};

/**
 * The store's rows, as the pure side reads them. A cast rather than a widening
 * of `Session`: the store's agentState is the full parsed shape and this only
 * ever looks at `metadata` and `droverReading`, so narrowing here keeps the
 * pure module free of the store's types (and of react-native with them).
 */
function readingSessions(): Record<string, ReadingSessionLike | undefined> {
    return (storage.getState().sessions ?? {}) as unknown as Record<string, ReadingSessionLike | undefined>;
}

let started = false;

/**
 * Start listening. Idempotent, and safe to call from a layout effect.
 *
 * Two jobs. Commands, applied as they arrive; and an UNPROMPTED report every
 * time the reading changes for any reason at all — a thumb, the wrist, the
 * headphones, an unplug — so `drover read` has something true to show even
 * when the app is too busy to answer a round trip. The report is cheap because
 * the reader only fires a transport change when something actually moved.
 */
export function startDroverReading(): () => void {
    if (started) return () => {};
    started = true;
    const policy = livePolicy();

    const pump = () => {
        void handleReadingCommands(readingSessions(), policy, rpcReporter);
    };

    const publish = () => {
        const bridgeSessionId = bridgeSessionIdOf(readingSessions());
        if (!bridgeSessionId) return;
        void rpcReporter(bridgeSessionId, { state: readingSnapshotOf(policy) }).catch(() => {});
    };

    const unsubscribe = storage.subscribe(pump);
    const transport = readAloud.addTransportListener(publish);
    pump();

    return () => {
        started = false;
        unsubscribe();
        transport();
        forgetAnsweredReadingCommands();
    };
}
