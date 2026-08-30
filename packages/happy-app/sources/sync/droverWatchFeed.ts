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
import { sync } from './sync';
import { sessionAllow, sessionDeny } from './ops';
import { collectGates } from './droverGates';
import { isSessionArchived } from './sessionArchive';
import { liveStatusSince, liveStatusWatchLine } from '@/utils/liveStatus';
import {
    addDroverAnswerListener,
    addDroverFlipListener,
    getDroverWatchStatus,
    isDroverWatchAvailable,
    publishDroverSnapshot,
    type DroverGate,
    type DroverSession,
} from 'drover-watch';

/**
 * Gate collection lives in droverGates, not here. A SCREEN needs the same list,
 * and importing this file to get it would load the WatchConnectivity native
 * module and start the feed as a side effect of rendering. Re-exported because
 * this feed and the background republish are the two publishers of the wrist
 * snapshot and both read the collector from here.
 */
export { collectGates };

/**
 * How often the feed republishes an unchanged snapshot.
 *
 * `updatedAt` is the wrist's only liveness signal, and a feed that publishes
 * only on change cannot produce one: a two-hour-old snapshot means "nothing
 * happened" and "the phone died" equally, so the watch had to trust every list
 * it was holding. The heartbeat is what makes the timestamp mean something.
 *
 * It stops when iOS suspends the app, and that is the point rather than a
 * flaw — a suspended app IS the phone no longer feeding the wrist, and the
 * watch now says so instead of rendering a stale wall of gates as confidently
 * as a live one.
 */
const HEARTBEAT_MS = 60_000;

/**
 * Live sessions the wrist may flip.
 *
 * The drover bridge's own session is excluded: it holds no Claude
 * conversation, so flipping it means nothing, and it would sit at the top of
 * the wrist list being the most tempting thing to tap.
 *
 * A session's id is what the wrist holds onto, and it survives a flip: the CLI
 * keeps the Happy session when it moves onto another account, the title comes
 * off the working directory rather than the account, and the watch's list is
 * keyed on the id. So a flip moves the account line on a row that stays put,
 * which is what makes flipping from the wrist and then watching the same row
 * possible at all.
 */
export function collectSessions(): DroverSession[] {
    const sessions = storage.getState().sessions ?? {};
    const out: DroverSession[] = [];
    const now = Date.now();
    for (const [sessionId, session] of Object.entries(sessions)) {
        const metadata = session?.metadata;
        if (!metadata) continue;
        if (metadata.summary?.text?.startsWith('Cattle Drover —')) continue;
        // Dead work is not wrist work. The same rule the phone's own list
        // uses, called rather than restated, because a second copy is how the
        // wrist ended up carrying every retired and test session `drover
        // sessions` still lists — they arrived as merely `active: false` and
        // sat among the live ones.
        if (isSessionArchived(session)) continue;
        const path = metadata.path ?? '';
        const title = path.split('/').filter(Boolean).pop() || 'session';
        const account = metadata.droverAccount;
        // Running, not total: total counts the ones already finished, and the
        // wrist question is "how much is out right now".
        const subagents = metadata.activity?.subagents?.running;
        // What it is DOING, not just that it is on (DROVE-54). Absent while
        // the session is idle, and absent again once the snapshot goes stale,
        // so the wrist never shows a timer for a turn that ended.
        const status = liveStatusWatchLine(metadata.liveStatus, now);
        const statusSince = status ? liveStatusSince(metadata.liveStatus, now) : undefined;
        out.push({
            id: sessionId,
            title,
            active: metadata.lifecycleState === 'running',
            // Omitted, never null: WatchConnectivity rejects NSNull.
            ...(path ? { path } : {}),
            ...(account ? { account } : {}),
            ...(typeof subagents === 'number' ? { subagents } : {}),
            ...(status ? { status } : {}),
            ...(statusSince ? { statusSince } : {}),
        });
    }
    return out;
}

/**
 * Account names the sessions report, in first-seen order.
 *
 * Live sessions only, since that is what collectSessions now hands over. An
 * account shows up by name because work is on it; "next with headroom" is the
 * answer for the rest, and the CLI holds the real registry either way.
 */
export function collectAccounts(sessions: DroverSession[]): string[] {
    const seen: string[] = [];
    for (const s of sessions) {
        if (s.account && !seen.includes(s.account)) seen.push(s.account);
    }
    return seen;
}

function sameGateSet(a: DroverGate[], b: DroverGate[]): boolean {
    if (a.length !== b.length) return false;
    const ids = new Set(a.map((g) => g.id));
    return b.every((g) => ids.has(g.id));
}

/**
 * Sessions change identity, account, running state, subagent count and what
 * they are doing.
 *
 * The count is in the key because the wrist now SHOWS it, and a number that
 * only refreshes when something else about the set changed is a stale number
 * dressed as a live one. `status` is in the key for the same reason and
 * `statusSince` is NOT: the line changes when the work changes, and the start
 * time only moves with it, so keying on both would republish nothing extra.
 * It does mean more publishes; the application context keeps only the latest
 * value, so the cost is throttling, never a lost gate.
 */
function sameSessionSet(a: DroverSession[], b: DroverSession[]): boolean {
    if (a.length !== b.length) return false;
    const key = (s: DroverSession) => `${s.id}|${s.account ?? ''}|${s.active}|${s.subagents ?? ''}|${s.status ?? ''}`;
    const keys = new Set(a.map(key));
    return b.every((s) => keys.has(key(s)));
}

let started = false;
let lastGates: DroverGate[] = [];
let lastSessions: DroverSession[] = [];

/**
 * Start the feed. Idempotent, and a no-op where the native module is absent
 * (Android, web, any build without the watch graft).
 */
export function startDroverWatchFeed(): () => void {
    if (started || !isDroverWatchAvailable()) return () => {};
    started = true;

    const push = (force = false) => {
        const gates = collectGates();
        const sessions = collectSessions();
        // Only publish on a real change: updateApplicationContext throttles,
        // and a redundant write can displace a fresh one. A flip changes the
        // SESSION set and not the gate set, so both are compared — checking
        // gates alone meant the wrist kept showing the old account after a
        // flip it had asked for itself.
        if (!force && sameGateSet(gates, lastGates) && sameSessionSet(sessions, lastSessions)) return;
        lastGates = gates;
        lastSessions = sessions;
        const status = getDroverWatchStatus();
        void publishDroverSnapshot({
            gates,
            sessions,
            accounts: collectAccounts(sessions),
            updatedAt: new Date().toISOString(),
            // "connected" is WatchConnectivity pairing state and nothing more:
            // this phone is activated, a watch is paired, and it has the app.
            // The watch's own doc used to call it "the bridge is not connected
            // to the bus", which it cannot be — this is only ever written BY a
            // publish, so the failure it was written for (the phone stops
            // feeding the wrist) is the one it can never report. `updatedAt`
            // and the heartbeat carry that instead.
            connected: !!status.activated && status.paired && status.installed,
        });
    };

    const answers = addDroverAnswerListener((event) => {
        const split = event.id.indexOf(':');
        if (split <= 0) return;
        const sessionId = event.id.slice(0, split);
        const requestId = event.id.slice(split + 1);
        // What the wrist answered WITH, whether it was picked or typed. The bus
        // refuses a bare allow on a question — it dismisses every surface and
        // hands the waiting hook nothing to inject — so the answer has to carry
        // the choice all the way through.
        //
        // Both go out on the one `updatedInput.optionId` key on purpose. It is
        // the only string happy-cli's answerCandidates reads (beside the
        // question card's own `answers`), and busResolutionFor is what decides
        // which kind of answer it was: it matches the string against the
        // question's options and resolves action=option on a hit, action=text
        // on a miss. So a typed answer needs no second channel, and inventing
        // one would land it where nothing is looking.
        const answered = event.optionId || event.text;
        const call = event.allow
            ? sessionAllow(
                sessionId,
                requestId,
                undefined,
                undefined,
                undefined,
                answered ? { optionId: answered } : undefined,
            )
            : sessionDeny(sessionId, requestId);
        // Fire and forget with an explicit catch: an answer that fails to send
        // must not reject unhandled, and the gate simply stays pending, which
        // the next push re-publishes to the wrist.
        void Promise.resolve(call).catch(() => {});
    });

    // A wrist flip becomes the `/flip` message the CLI already intercepts, so
    // the watch reaches the flip by exactly the path the phone and a tmux key
    // binding use. Nothing new crosses the Happy server: `/flip` is an
    // ordinary session message, and the CLI takes it before Claude ever sees
    // it.
    const flips = addDroverFlipListener((event) => {
        if (!event.sessionId) return;
        const text = event.account ? `/flip ${event.account}` : '/flip';
        void Promise.resolve(sync.sendMessage(event.sessionId, text)).catch(() => {});
    });

    const unsubscribe = storage.subscribe(() => push());
    // Forced, so an unchanged snapshot still restamps updatedAt. That restamp
    // is the whole signal: see HEARTBEAT_MS.
    const heartbeat = setInterval(() => push(true), HEARTBEAT_MS);
    push(true);

    return () => {
        started = false;
        answers.remove();
        flips.remove();
        clearInterval(heartbeat);
        unsubscribe();
    };
}
