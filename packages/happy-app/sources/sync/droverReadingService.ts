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
import { nudgeWatch } from '@/voice/watchSpeaker';
import { readingSnapshotOf, type ReadingPolicy, type ReadingSessionRow } from '@/voice/readingControl';
import {
    bridgeSessionIdOf,
    forgetAnsweredReadingCommands,
    handleReadingCommands,
    type ReadingReporter,
    type ReadingSessionLike,
} from './droverReading';

/**
 * The reader, answered with DROVE-297's own calls.
 *
 * There is no policy in here. Every member is a pass-through to the reader
 * that 297 gave a public per-session API: `readingReport`, `isSessionEnabled`,
 * `setSessionEnabled` (which is `voiceMove`), `readingStateOf`, `setPaused`.
 * That is the whole of "one rule, two entry points" — a thumb on the composer
 * control and `drover read <session>` typed in a pane both reach
 * setSessionEnabled, so a terminal cannot invent semantics the thumb does not
 * have, and neither can drift from the other.
 */
export function livePolicy(): ReadingPolicy {
    const sessions = () => storage.getState().sessions ?? {};
    return {
        report: () => readAloud.readingReport(),
        knows: (sessionId) => !!sessions()[sessionId],
        isEnabled: (sessionId) => readAloud.isSessionEnabled(sessionId),
        setEnabled: (sessionId, enabled) => readAloud.setSessionEnabled(sessionId, enabled),
        setPaused: (paused) => readAloud.setPaused(paused),
        rows: () => {
            // Only the sessions that are ARMED. A row per session in the app
            // would be a hundred lines of `off` in a terminal table, which says
            // nothing — and `off` is the default state of almost every session
            // almost all the time, which is exactly why the list on the phone
            // draws nothing for it either (readingRowMark, DROVE-297).
            const out: ReadingSessionRow[] = [];
            const all = sessions();
            for (const id of Object.keys(all)) {
                const state = readAloud.readingStateOf(id);
                if (state === 'off') continue;
                out.push({ sessionId: id, enabled: true, state, title: titleOf(all, id) });
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

    // What the reader was doing at the last transport change, so a PAUSE can
    // be told from a resume, a rate change and every other thing that fires
    // the same listener (DROVE-384). Null until the first one: a listener that
    // has not heard anything yet does not know.
    let wasPaused: boolean | null = null;

    const publish = () => {
        // The wrist's tap for a pause, and only for the edge INTO one. The
        // reader fires this listener for anything that moved, so buzzing on
        // every one of them would tap the wrist for a rate slider. Resuming
        // gets no tap of its own: `readingStarted` already covers a reply
        // beginning to be spoken, and a second beat for the same fact is the
        // duplicate noise DROVE-190 is about.
        const paused = readAloud.isPaused;
        if (wasPaused === false && paused) nudgeWatch('readingPaused');
        wasPaused = paused;
        const bridgeSessionId = bridgeSessionIdOf(readingSessions());
        if (!bridgeSessionId) return;
        void rpcReporter(bridgeSessionId, { state: readingSnapshotOf(policy) }).catch(() => {});
    };

    const unsubscribe = storage.subscribe(pump);
    const transport = readAloud.addTransportListener(publish);
    pump();
    // Seed the pause edge from where the reader actually is, so the first
    // transport change after this is compared against something true rather
    // than reading as a pause because nothing had been recorded.
    wasPaused = readAloud.isPaused;

    return () => {
        started = false;
        wasPaused = null;
        unsubscribe();
        transport();
        forgetAnsweredReadingCommands();
    };
}
