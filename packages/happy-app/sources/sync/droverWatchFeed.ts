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
import {
    addDroverAnswerListener,
    addDroverFlipListener,
    addDroverRefreshListener,
    getDroverWatchStatus,
    isDroverWatchAvailable,
    publishDroverSnapshot,
    type DroverAccountRow,
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
/**
 * One line of what a session is doing right now, and when it started
 * (DROVE-54).
 *
 * Clay's words: "I wish I could see all this rich information on my mobile app
 * as it's working. Right now it just says online and I can't see what it's
 * doing." The full task tree is DROVE-54's own work on the phone; the wrist has
 * room for the top line, and this builds it out of what the phone already
 * holds — no new producer, nothing added to the CLI.
 *
 * The elapsed time is deliberately NOT in the string. The feed republishes
 * whenever the session set changes and the change key includes this, so a
 * status carrying a timer would publish once a second forever. `since` is a
 * stamp the wrist counts up from on its own.
 */
export function statusFor(session: {
    thinking?: boolean;
    thinkingAt?: number;
    metadata?: {
        lifecycleState?: string;
        lifecycleStateSince?: number;
        activity?: { subagents?: { running?: number } } | null;
    } | null;
}): { status?: string; statusSince?: string } {
    const running = session.metadata?.activity?.subagents?.running;
    // Thinking beats the subagent count: it is the thing that ends, and it is
    // what the terminal's own status line leads with.
    if (session.thinking) {
        const since = typeof session.thinkingAt === 'number' && session.thinkingAt > 0
            ? new Date(session.thinkingAt).toISOString()
            : undefined;
        const status = typeof running === 'number' && running > 0
            ? `thinking · ${running} out`
            : 'thinking';
        return { status, ...(since ? { statusSince: since } : {}) };
    }
    if (typeof running === 'number' && running > 0) {
        const since = typeof session.metadata?.lifecycleStateSince === 'number'
            ? new Date(session.metadata.lifecycleStateSince).toISOString()
            : undefined;
        return {
            status: running === 1 ? '1 subagent' : `${running} subagents`,
            ...(since ? { statusSince: since } : {}),
        };
    }
    // Nothing is running. The wrist says nothing rather than inventing "idle":
    // the row's own dot already carries that, and a second word for it is a
    // line of noise on a 40mm screen.
    return {};
}

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
        out.push({
            id: sessionId,
            title,
            active: metadata.lifecycleState === 'running',
            // Omitted, never null: WatchConnectivity rejects NSNull.
            ...(path ? { path } : {}),
            ...(account ? { account } : {}),
            ...(typeof subagents === 'number' ? { subagents } : {}),
            ...statusFor(session as Parameters<typeof statusFor>[0]),
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
 * Sessions change identity, account, running state and subagent count.
 * The count is in the key because the wrist now SHOWS it, and a number that
 * only refreshes when something else about the set changed is a stale number
 * dressed as a live one. It does mean more publishes; the application context
 * keeps only the latest value, so the cost is throttling, never a lost gate.
 */
function sameSessionSet(a: DroverSession[], b: DroverSession[]): boolean {
    if (a.length !== b.length) return false;
    // `status` and `statusSince` are in the key because the wrist SHOWS them
    // and a line that only refreshes when something else moved is a stale line
    // dressed as a live one. Neither carries an elapsed time (statusFor), so
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

let started = false;
let lastGates: DroverGate[] = [];
let lastSessions: DroverSession[] = [];
let lastAccountRows: DroverAccountRow[] = [];

/**
 * What a wrist answer has to look like for BOTH consumers of it.
 *
 * There are two, and they read different keys. happy-cli's bus bridge reads
 * `updatedInput.optionId` (and the card's `answers`) and matches the string
 * against the mirrored event's options — that is the drover path, and
 * `optionId` alone has always worked for it. Claude's OWN AskUserQuestion is
 * resolved through the permission callback, which merges `updatedInput` into
 * the tool input and reads the answer back under the QUESTION'S OWN TEXT
 * (askUserQuestionAnswers.ts builds exactly that for the phone). So a native
 * question answered from the wrist merged a stray `optionId` key into the input
 * and the harness saw no answer at all — the tap travelled the whole way and
 * landed nowhere, which is the same shape of failure as bus event "Step 1
 * order" and the reason `text` had to be carried in the first place.
 *
 * Sending both keys is what makes one tap satisfy both readers. The extra
 * `optionId` on a native card is an unread key in the tool input, which costs
 * nothing; a missing `answers` was a lost answer.
 *
 * The multi-select selection arrives here already joined with ", " by the watch
 * — the same separator the phone's own card uses, because happy-cli splits on
 * it when matching a label back to a bus option.
 */
export function updatedInputFor(
    sessionId: string,
    requestId: string,
    answered: string,
    sessions: Record<string, Parameters<typeof questionTextFor>[0][string]> = storage.getState().sessions ?? {},
): Record<string, unknown> {
    const question = questionTextFor(sessions, sessionId, requestId);
    return question
        ? { optionId: answered, answers: { [question]: answered } }
        : { optionId: answered };
}

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
        lastGates = gates;
        lastSessions = sessions;
        lastAccountRows = accountRows;
        const status = getDroverWatchStatus();
        void publishDroverSnapshot({
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
                answered ? updatedInputFor(sessionId, requestId, answered) : undefined,
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

    // The wrist asking for a snapshot (DROVE-22). A watch-to-phone message
    // launches this app in the background when iOS has suspended it, so the
    // forced push below runs with the phone locked in a pocket — which is the
    // only state Clay is ever in when he looks at the watch, and the reason it
    // said "Out of date" every single time.
    const refreshes = addDroverRefreshListener(() => push(true));

    const unsubscribe = storage.subscribe(() => push());
    // Forced, so an unchanged snapshot still restamps updatedAt. That restamp
    // is the whole signal: see HEARTBEAT_MS.
    const heartbeat = setInterval(() => push(true), HEARTBEAT_MS);
    push(true);

    return () => {
        started = false;
        answers.remove();
        flips.remove();
        refreshes.remove();
        clearInterval(heartbeat);
        unsubscribe();
    };
}
