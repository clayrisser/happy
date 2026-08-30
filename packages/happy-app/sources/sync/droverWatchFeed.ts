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
import { collectGates, questionTextFor } from './droverGates';
import { isSessionArchived } from './sessionArchive';
import { liveStatusSince, liveStatusWatchLine } from '@/utils/liveStatus';
import {
    addDroverAnswerListener,
    addDroverFlipListener,
    addDroverRefreshListener,
    getDroverWatchStatus,
    isDroverWatchAvailable,
    publishDroverSnapshot,
    type DroverAccountRow,
    wakeDroverWatch,
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
 * It stops when iOS suspends the app. That was described here as the point
 * rather than a flaw, and it was half right: the wrist does need to know when
 * it is no longer being fed. What it got instead was that message ALWAYS, since
 * Clay looks at his watch precisely when the phone is in his pocket and the app
 * off screen (DROVE-22). The wrist can now ask for a snapshot, which wakes this
 * app in the background — see the onRefresh listener below — so the heartbeat
 * is what keeps the wrist current while the app is up, and the ask is what
 * covers it while the app is asleep.
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
/**
 * The accounts the wrist can flip ONTO, most headroom first (DROVE-28's watch
 * half).
 *
 * Read off `metadata.droverUsage`, which the CLI stamps with every registry
 * account and its headroom (DROVE-47) — not off the sessions' own
 * `droverAccount` stamps, which can only ever name an account something is
 * ALREADY running on. That is the opposite of what a flip wants: the account
 * worth moving to is the one with room, and by definition the emptiest account
 * has no session to be named by.
 *
 * The freshest snapshot wins, because every drover session carries its own copy
 * of the same registry and an idle session's can be hours old.
 */
export function collectAccountRows(
    sessions: Record<string, { metadata?: { droverUsage?: unknown } | null } | undefined>,
): DroverAccountRow[] {
    let freshest: { capturedAt: number; accounts: unknown[] } | null = null;
    for (const session of Object.values(sessions)) {
        const usage = session?.metadata?.droverUsage as
            | { capturedAt?: unknown; accounts?: unknown }
            | undefined;
        if (!usage || typeof usage.capturedAt !== 'number' || !Array.isArray(usage.accounts)) continue;
        if (!freshest || usage.capturedAt > freshest.capturedAt) {
            freshest = { capturedAt: usage.capturedAt, accounts: usage.accounts };
        }
    }
    if (!freshest) return [];
    const rows: DroverAccountRow[] = [];
    for (const entry of freshest.accounts) {
        const account = entry as {
            name?: unknown;
            loggedIn?: unknown;
            headroom?: unknown;
            cooling?: { until?: unknown } | null;
        };
        if (!account || typeof account.name !== 'string' || !account.name) continue;
        const headroom = typeof account.headroom === 'number' && Number.isFinite(account.headroom)
            ? Math.round(Math.min(100, Math.max(0, account.headroom)))
            : undefined;
        const until = account.cooling && typeof account.cooling.until === 'number'
            ? account.cooling.until
            : undefined;
        rows.push({
            name: account.name,
            // Omitted, never null: WatchConnectivity payloads take
            // property-list types only and one NSNull fails the whole publish.
            ...(headroom === undefined ? {} : { headroom }),
            ...(account.loggedIn === false ? { loggedIn: false } : { loggedIn: true }),
            ...(until ? { backAt: new Date(until).toISOString() } : {}),
        });
    }
    // Most headroom first, logged-out last: the wrist reads top down and the
    // first row is the one it is offering. An account never measured sorts
    // below every measured one rather than above them — no figure is not a
    // claim of a full tank.
    return rows.sort((a, b) => {
        if ((a.loggedIn !== false) !== (b.loggedIn !== false)) return a.loggedIn === false ? 1 : -1;
        return (b.headroom ?? -1) - (a.headroom ?? -1);
    });
}

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
export function collectAccounts(sessions: DroverSession[], rows: DroverAccountRow[] = []): string[] {
    // The registry, when there is one, in the order the picker offers it — so
    // an old watch reading only this key still gets the headroom ordering, it
    // just cannot print the numbers.
    if (rows.length) return rows.map((r) => r.name);
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
    // `status` and `statusSince` are in the key because the wrist SHOWS them
    // and a line that only refreshes when something else moved is a stale line
    // dressed as a live one. Neither carries an elapsed time, so
    // they change on a transition and not on a tick.
    const key = (s: DroverSession) =>
        `${s.id}|${s.account ?? ''}|${s.active}|${s.subagents ?? ''}|${s.status ?? ''}|${s.statusSince ?? ''}`;
    const keys = new Set(a.map(key));
    return b.every((s) => keys.has(key(s)));
}

function sameAccountRows(a: DroverAccountRow[], b: DroverAccountRow[]): boolean {
    if (a.length !== b.length) return false;
    const key = (r: DroverAccountRow) => `${r.name}|${r.headroom ?? ''}|${r.loggedIn}|${r.backAt ?? ''}`;
    return a.every((row, i) => key(row) === key(b[i]));
}

/**
 * Whether the wrist should be WOKEN for this publish, not merely fed (DROVE-62).
 *
 * A publish reaches a sleeping watch app "on next launch", which for a watch
 * means whenever Clay next opens it — so an ordinary publish cannot buzz
 * anything. `wakeDroverWatch` spends one of a small daily budget to launch the
 * watch app in the background instead, and that budget is why this is a
 * question rather than something done on every publish: the 60s heartbeat
 * would drain it before lunch.
 *
 * True for a gate that was not there before, and for a session that was
 * running and has stopped. Both are things Clay would want to feel; a
 * subagent count moving is not.
 */
export function deservesAWake(
    before: { gates: DroverGate[]; sessions: DroverSession[] },
    after: { gates: DroverGate[]; sessions: DroverSession[] },
): boolean {
    const known = new Set(before.gates.map((g) => g.id));
    if (after.gates.some((g) => !known.has(g.id))) return true;
    const wasRunning = new Set(before.sessions.filter((s) => s.active).map((s) => s.id));
    return after.sessions.some((s) => !s.active && wasRunning.has(s.id));
}

let started = false;
let lastGates: DroverGate[] = [];
let lastSessions: DroverSession[] = [];
let lastAccountRows: DroverAccountRow[] = [];
/**
 * The first publish of a run has nothing to compare against, so every gate in
 * it reads as new. Waking for that would spend the budget on a wall of work
 * that was already there when the app launched — and the wrist filters it out
 * anyway (WristCueDiff.freshWindow), so the wake would buy a background launch
 * and no buzz.
 */
let publishedOnce = false;

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
        const accountRows = collectAccountRows(storage.getState().sessions ?? {});
        // Only publish on a real change: updateApplicationContext throttles,
        // and a redundant write can displace a fresh one. A flip changes the
        // SESSION set and not the gate set, so both are compared — checking
        // gates alone meant the wrist kept showing the old account after a
        // flip it had asked for itself.
        if (
            !force
            && sameGateSet(gates, lastGates)
            && sameSessionSet(sessions, lastSessions)
            // Headroom moves without the session set moving at all, and it is
            // what the flip picker orders on — so a picker fed only by the
            // other two comparisons offers yesterday's ranking.
            && sameAccountRows(accountRows, lastAccountRows)
        ) return;
        // Computed against the PREVIOUS sets, so it has to happen before they
        // are replaced below (DROVE-62).
        const wake =
            publishedOnce &&
            deservesAWake({ gates: lastGates, sessions: lastSessions }, { gates, sessions });
        lastGates = gates;
        lastSessions = sessions;
        lastAccountRows = accountRows;
        publishedOnce = true;
        const status = getDroverWatchStatus();
        const snapshot = {
            gates,
            sessions,
            accounts: collectAccounts(sessions, accountRows),
            // Sent beside `accounts` and never instead of it: the watch app is
            // a TestFlight binary and cannot be updated OTA, so a build that
            // does not know this key has to keep working off the names alone.
            ...(accountRows.length ? { accountRows } : {}),
            updatedAt: new Date().toISOString(),
            // "connected" is WatchConnectivity pairing state and nothing more:
            // this phone is activated, a watch is paired, and it has the app.
            // The watch's own doc used to call it "the bridge is not connected
            // to the bus", which it cannot be — this is only ever written BY a
            // publish, so the failure it was written for (the phone stops
            // feeding the wrist) is the one it can never report. `updatedAt`
            // and the heartbeat carry that instead.
            connected: !!status.activated && status.paired && status.installed,
        };
        void publishDroverSnapshot(snapshot);
        // The wake is a SECOND delivery of the SAME snapshot, and deliberately
        // so: the watch runs both through one apply and works out the buzz from
        // the snapshot diff, so there is no cue format on the wire to keep in
        // step with anything (DROVE-62).
        //
        // Skipped when the watch is reachable, because reachable means the
        // watch app is already frontmost — publish's own sendMessage has
        // reached it and the wrist is being looked at. Spending a background
        // launch on a screen someone is holding up is the one case where the
        // budget buys nothing.
        if (wake && !status.reachable) void wakeDroverWatch(snapshot);
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
        // A MULTI-SELECT carries the whole list alongside (DROVE-53).
        // `optionId` still holds the first pick, so a CLI that only reads that
        // key behaves exactly as it did; happy-cli's answerCandidates reads
        // optionIds first and busResolutionFor turns it into the bus's
        // `optionIds` array. Dropping it here is where three ticks would have
        // become one word, since this function copies the fields it names.
        const many = event.optionIds?.filter((id) => !!id) ?? [];
        const call = event.allow
            ? sessionAllow(
                sessionId,
                requestId,
                undefined,
                undefined,
                // 'approved_for_session' rather than an allowTools entry,
                // because the wrist does not know the tool name — the gate is a
                // bus event to it, not a Bash call. happy-cli's busResolutionFor
                // accepts either spelling and turns both into scope 'session'.
                event.scope === 'session' ? 'approved_for_session' : undefined,
                answered || many.length
                    ? {
                        ...(answered ? { optionId: answered } : {}),
                        ...(many.length > 1 ? { optionIds: many } : {}),
                    }
                    : undefined,
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

    // The wrist asked, which means iOS has just woken this app in the
    // background to answer (DROVE-22). Forced, because the ask is about the
    // TIMESTAMP: the gate set is usually identical and the change check would
    // drop the publish, leaving the watch holding the same stale snapshot it
    // asked to replace. The native side is holding the watch's reply open until
    // this publish lands.
    const refreshes = addDroverRefreshListener(() => push(true));

    const unsubscribe = storage.subscribe(() => push());
    // Forced, so an unchanged snapshot still restamps updatedAt. That restamp
    // is the whole signal: see HEARTBEAT_MS.
    const heartbeat = setInterval(() => push(true), HEARTBEAT_MS);
    push(true);

    return () => {
        started = false;
        // So a restarted feed does not wake the wrist for gates that were
        // already on the wall when it restarted (DROVE-62).
        publishedOnce = false;
        answers.remove();
        flips.remove();
        refreshes.remove();
        clearInterval(heartbeat);
        unsubscribe();
    };
}
