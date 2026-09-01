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
import { collectGateEntries, collectGates } from './droverGates';
import { newGateEntries, togglesFromSettings, wakeDeserved } from './droverChannels';
import { getCurrentAppState } from './apiSocket';
import {
    claimWristCues,
    noteWristRelay,
    releaseWristCues,
    rememberWristRelayState,
    seedWristCues,
    wristCarrierFor,
    wristCueIds,
    wristCueStateOf,
    wristRefusal,
} from './droverWristRelay';
import { demoLog, isDroverDemoId } from './droverDemo';
import { isCursorAccount } from '@/utils/droverAccounts';
import { isSessionArchived } from './sessionArchive';
import { isDroverBridgeSession } from './droverBridgeSession';
import { liveStatusSince, liveStatusWatchLine } from '@/utils/liveStatus';
import { sessionDisplayTitle } from '@/utils/sessionTitle';
import { deriveSessionTasks } from '@/utils/sessionTasks';
import { currentDroverAccountRow, droverAccountExpired, droverAccountsUsage } from '@/utils/droverUsage';
import type { DroverUsageAccountLike } from '@/utils/droverUsage';
import {
    droverBindingLimit,
    usageAccountBarGroup,
    usageFill,
    usageMeasures,
    type DroverBindingLimit,
    type UsageBarGroup,
    type UsageMeasure,
} from '@/components/agentInputUsage';
import { resolveSessionState } from './sessionState';
import { sessionDotFacts, sessionDotState } from '@/components/sessionDot';
import {
    addDroverAnswerListener,
    addDroverFlipListener,
    addDroverOpenedListener,
    addDroverRefreshListener,
    addDroverRouteListener,
    addDroverListenListener,
    addDroverSayListener,
    addDroverSpokenListener,
    addDroverTransportListener,
    sendDroverWatchVoice,
    describeDroverWakeBudget,
    getDroverWatchStatus,
    isDroverWatchAvailable,
    publishDroverSnapshot,
    sendDroverTranscript,
    type DroverAccountRow,
    type DroverAccountLimitRow,
    wakeDroverWatch,
    type DroverGate,
    type DroverSession,
    type DroverTranscript,
    type DroverReading,
} from 'drover-watch';
import { publishDroverWidgetFace, resetDroverWidgetMemory } from './droverWidgetPublish';
import { buildWristRows, createWristCoalescer, rowKey, transcriptDelta } from './droverWatchTranscript';
import { readAloud } from '@/voice/readAloudService';
import { setWatchRoute, settleWatchUtterance } from '@/voice/watchSpeaker';
import { WristDictation } from '@/voice/wristDictation';
import {
    addDictationEndedListener,
    addDictationPartialListener,
    cancelDictation,
    startWristDictation,
    stopDictation,
    wristDictationSupported,
} from 'drover-speech';
import type { Message } from './typesMessage';

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
 * One account's quota windows, folded to the wire (DROVE-339).
 *
 * The rows are the SHEET's, not a second derivation of them: percent, band and
 * trailing words all come off `usageAccountBarGroup`, so a window that reads
 * "window reset" on the phone reads "window reset" on the wrist, in the same
 * words, for the same reason.
 */
function wristLimitRows(group: UsageBarGroup, measures: UsageMeasure[]): DroverAccountLimitRow[] {
    // `usageAccountBarGroup` builds its rows by mapping over `measures`, so
    // row i is measure i. The id is not on the row itself — nothing on the
    // phone needs it there — and the wrist needs one to key a list on.
    return group.rows.map((row, index) => ({
        id: measures[index]?.id ?? row.key,
        // The FULL name, never the row's cut one: `truncateUsageName` cuts to
        // the PHONE's name column, and a wrist's is a different width.
        label: row.fullName,
        // The whole-number spelling of the fill the phone drew — the same
        // number `usageFill` calls percentUsed, since the fraction it returns
        // is that percentage over 100 (DROVE-230). Omitted where nothing was
        // measured, never sent as zero: zero used is a FRESH window and a real
        // reading, and the two must not share a spelling.
        ...(row.measured ? { used: Math.round(row.fraction * 100) } : {}),
        tone: row.tone,
        // Empty is the sheet's "nothing to say here"; the key just goes.
        ...(row.trailing ? { trailing: row.trailing } : {}),
        ...(row.binding ? { binding: true } : {}),
    }));
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
    let freshest: { capturedAt: number; modelFamily: string | null; accounts: unknown[] } | null = null;
    for (const session of Object.values(sessions)) {
        const usage = session?.metadata?.droverUsage as
            | { capturedAt?: unknown; modelFamily?: unknown; accounts?: unknown }
            | undefined;
        if (!usage || typeof usage.capturedAt !== 'number' || !Array.isArray(usage.accounts)) continue;
        if (!freshest || usage.capturedAt > freshest.capturedAt) {
            freshest = {
                capturedAt: usage.capturedAt,
                // The model the CLI computed `headroom` for (DROVE-173). The
                // wrist's binding limit has to be picked over the same rows,
                // or the bar and its label name different windows (DROVE-129).
                modelFamily: typeof usage.modelFamily === 'string' && usage.modelFamily
                    ? usage.modelFamily
                    : null,
                accounts: usage.accounts,
            };
        }
    }
    if (!freshest) return [];
    // THE BREAKDOWN, built by the phone's own sheet code (DROVE-339).
    //
    // Clay: "when I select a specific account to see the limit, it should
    // actually show the full breakdown of all the limits, just like it shows
    // in the mobile app." The wrist cannot build that itself — it is Swift and
    // `usageAccountBarGroup` is TypeScript — so the rows the sheet draws are
    // computed here, over this same snapshot, and sent (DROVE-129). One
    // function, two surfaces, no second ranking and no second set of words for
    // "window reset".
    //
    // No SDK override is passed, and there is nothing to pass: this feed is
    // not scoped to a session. So every wrist figure comes off the registry
    // snapshot, exactly as `headroom` and the binding limit already do.
    //
    // That used to be the whole difference between the wrist and the sheet,
    // and it is why Clay saw the watch up to date while the phone was minutes
    // behind (DROVE-340): the sheet handed `usageAccountBarGroup` the live
    // `agentState.usageLimits` for its own account UNCONDITIONALLY, and under
    // drover every session is a local TUI where the SDK's rate_limit_event
    // never fires, so that override was the oldest reading of the two. It is
    // now taken only while it is strictly newer than the snapshot
    // (`fresherUsageLimits`), which on a drover session it never is. One
    // function, one object, two surfaces.
    const usage = {
        capturedAt: freshest.capturedAt,
        modelFamily: freshest.modelFamily,
        accounts: freshest.accounts as DroverUsageAccountLike[],
    };
    const measured = droverAccountsUsage(usage);
    // Computed across ALL accounts, like the sheet's: the measures decide the
    // ROWS, and an account whose own windows are a subset still draws them so
    // two accounts' breakdowns can be read against each other.
    const measures = usageMeasures(measured);
    // Ranked over the snapshot's RAW rows, which is the set the CLI computed
    // `headroom` from — the same reason resolveUsageStrip ranks them there and
    // not over the mapped windows.
    const bindings = new Map<string, DroverBindingLimit | null>();
    for (const raw of usage.accounts) {
        if (!raw || typeof raw.name !== 'string' || !raw.name) continue;
        bindings.set(raw.name, droverBindingLimit(raw, freshest.modelFamily, freshest.capturedAt));
    }
    const groups = new Map(measured.map((account) => [
        account.name,
        usageAccountBarGroup(account, measures, { binding: bindings.get(account.name) ?? null }),
    ]));
    const rows: DroverAccountRow[] = [];
    for (const entry of freshest.accounts) {
        const account = entry as DroverUsageAccountLike & { cooling?: { until?: unknown } | null };
        if (!account || typeof account.name !== 'string' || !account.name) continue;
        // CURSOR ACCOUNTS ARE NOT ON THE WRIST (DROVE-270), because this list
        // is a flip picker and nothing else: a tap on a row sends `/flip
        // <name>`. A flip is a CLAUDE_CONFIG_DIR swap and a respawn, and a
        // cursor account has no directory to swap to — it carries a token, so
        // two cursor accounts already run side by side with no flip at all.
        //
        // Dropped rather than shown-and-disabled, and that is the one place
        // this fork folds something away instead of showing it. A wrist row is
        // a name and a bar with no room for a reason, and the only unavailable
        // state it has is `loggedIn: false` — which would read as "this account
        // is logged out" over an account that is perfectly fine. The phone's
        // Settings → Accounts lists every cursor account in full, with its own
        // group and its own explanation.
        if (isCursorAccount(account)) continue;
        const headroom = typeof account.headroom === 'number' && Number.isFinite(account.headroom)
            ? Math.round(Math.min(100, Math.max(0, account.headroom)))
            : undefined;
        const until = account.cooling && typeof account.cooling.until === 'number'
            ? account.cooling.until
            : undefined;
        // WHICH limit that headroom is about, decided by the phone's own
        // ranking rather than re-derived on the wrist (DROVE-131, DROVE-129).
        // Its percentLeft is the same number `headroom` is — both are 100
        // minus the fullest row — so the bar and the label always agree.
        const binding = bindings.get(account.name) ?? null;
        // A window that had already reset when the cache was read (DROVE-204).
        // The wrist cannot work this out: `droverRowUsable` compares against
        // the clock that was in the room at capture, and the watch has only
        // its own (DROVE-129).
        const expired = droverAccountExpired(account, freshest.capturedAt);
        // The FILL. `usageFill` is the one place headroom becomes a mark
        // (DROVE-230), and sending its output rather than its input is what
        // keeps the two surfaces from running opposite ways.
        //
        // Withheld when nothing was measured AND when the window had already
        // reset, so the wrist cannot draw a dead reading as a fresh window.
        // Under fill-as-used an empty bar is a real claim, "nothing used yet",
        // which is exactly the claim an unusable window must not make.
        const fill = usageFill(headroom === undefined ? null : headroom);
        const used = expired ? null : fill.percentUsed;
        const group = groups.get(account.name);
        // Sent only when the CLI actually recorded windows for this account.
        // The sheet draws bare Session and Week rows either way so its blocks
        // line up down a column; the wrist opens ONE account at a time and has
        // no column to keep straight, so two dashes there would be a table
        // that says nothing the account's own line does not already say.
        const limits = group && Array.isArray(account.limits) && account.limits.length > 0
            ? wristLimitRows(group, measures)
            : [];
        rows.push({
            name: account.name,
            // Omitted, never null: WatchConnectivity payloads take
            // property-list types only and one NSNull fails the whole publish.
            ...(headroom === undefined ? {} : { headroom }),
            ...(used === null ? {} : { used }),
            // `loggedIn` on the WRIST means "work can go here", which is a
            // coarser claim than the phone's and deliberately so: a watch row
            // is a name and a bar, with no room for two different reasons and
            // no way to act on either. So a never-run account (DROVE-246) sorts
            // and reads exactly like a logged-out one — it is equally not
            // somewhere the wrist should offer. The phone keeps both fields and
            // names the fix; this stays one boolean so the Swift payload shape
            // does not move.
            ...(account.loggedIn === false || account.onboarded === false
                ? { loggedIn: false }
                : { loggedIn: true }),
            ...(until ? { backAt: new Date(until).toISOString() } : {}),
            ...(account.current ? { current: true } : {}),
            ...(expired ? { expired: true } : {}),
            ...(binding
                ? {
                    limit: binding.label,
                    tone: binding.tone,
                    ...(binding.resetsAt ? { resetsAt: new Date(binding.resetsAt).toISOString() } : {}),
                }
                : {}),
            // What SELECTING this account opens (DROVE-339).
            ...(limits.length ? { limits } : {}),
            // The sheet's own heading, which is the one line that says which
            // of the four nothings an account with no figure is in.
            ...(group?.title ? { title: group.title } : {}),
            // Offered exactly where the phone offers it, refused exactly where
            // the phone refuses it.
            ...(group?.switchable ? { switchable: true } : {}),
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
        // The bridge is a mailbox, not a session (DROVE-238). This used to
        // match the summary string here and nowhere else, which is how the
        // phone's own list went on showing the row the wrist had already
        // learned to skip. One reader now, and it reads the CLI's flag first.
        if (isDroverBridgeSession(session)) continue;
        // Dead work is not wrist work. The same rule the phone's own list
        // uses, called rather than restated, because a second copy is how the
        // wrist ended up carrying every retired and test session `drover
        // sessions` still lists — they arrived as merely `active: false` and
        // sat among the live ones.
        if (isSessionArchived(session)) continue;
        const path = metadata.path ?? '';
        // The name the session was GIVEN, through the phone's own derivation
        // (DROVE-127). This line used to be `path.split('/').pop()`, which is
        // why Clay's wrist said `cattle-drover` while the phone header said
        // `DROVER` for the same session. sessionTitle.ts owns the rule and
        // still falls back to the basename when a session has no name, so the
        // wrist loses nothing and the two cannot answer differently.
        const title = sessionDisplayTitle(session);
        // The account the PHONE says this session is on (DROVE-127). Not the
        // `droverAccount` stamp alone: the CLI marks the live account
        // `current` on metadata.droverUsage, and the info screen and the
        // composer popup both resolve through this, so a wrist reading the
        // older stamp printed the account the session used to be on.
        const account = currentDroverAccountRow(metadata.droverUsage, metadata.droverAccount)?.name;
        // Running, not total: total counts the ones already finished, and the
        // wrist question is "how much is out right now".
        const subagents = metadata.activity?.subagents?.running;
        // The phone's own state precedence, resolved here and SENT, because
        // the wrist cannot import it (DROVE-129). The watch used to answer
        // "running"/"idle" off `active` alone, which is whether the process is
        // alive — a different question from the one the phone's list answers
        // with its dot, and one that says nothing about a session sitting on a
        // permission prompt.
        const state = resolveSessionState({
            agentState: session.agentState,
            thinking: !!session.thinking,
            isOnline: session.presence === 'online',
        });
        // What it is DOING, not just that it is on (DROVE-54). Absent while
        // the session is idle, and absent again once the snapshot goes stale,
        // so the wrist never shows a timer for a turn that ended.
        const status = liveStatusWatchLine(metadata.liveStatus, now);
        const statusSince = status ? liveStatusSince(metadata.liveStatus, now) : undefined;
        // THE DOT, resolved on the phone and sent whole (DROVE-257).
        //
        // `state` above is `SessionState`, five words about whether the
        // session wants a human. The DOT is `StatusDotState`, six, and the two
        // it adds are the two the wrist could never say: `recentlyDisconnected`
        // and `compacting`. Clay's rule is that the wrist may show less than
        // the phone and must never show something DIFFERENT, and a wrist
        // drawing green on a session mid-compaction is the phone's own bug
        // repeated one surface further out.
        //
        // Sent beside `state` rather than folded into it, because `state`
        // answers a question several other things on the wrist ask (needsYou,
        // the ordering) and widening that union would change all of them.
        const dotState = sessionDotState(sessionDotFacts(session, now), now);
        // The task list, decided here and SENT (DROVE-129, DROVE-167). Swift
        // cannot import the derivation, so the phone does the sorting and the
        // trimming and hands over the unfinished lines. `tasksDone` and
        // `tasksTotal` ride along because "2 of 7" is the sentence the wrist
        // wants at the top of a scroll it will not finish reading.
        const tasks = deriveSessionTasks(session.todos);
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
            ...(tasks.isEmpty ? {} : {
                tasks: tasks.remaining.map((task) => task.text),
                tasksDone: tasks.completedCount,
                tasksTotal: tasks.total,
            }),
            state,
            dotState,
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
    // The task list is in the key too (DROVE-167): a task ticking over to done
    // moves nothing else about the session, and a wrist list that only
    // refreshed when the tool changed would show yesterday's tasks.
    const key = (s: DroverSession) =>
        `${s.id}|${s.title}|${s.account ?? ''}|${s.active}|${s.state ?? ''}`
        + `|${s.dotState ?? ''}`
        + `|${s.subagents ?? ''}|${s.status ?? ''}|${s.statusSince ?? ''}`
        + `|${s.tasksDone ?? ''}/${s.tasksTotal ?? ''}|${(s.tasks ?? []).join('\u0001')}`;
    const keys = new Set(a.map(key));
    return b.every((s) => keys.has(key(s)));
}

/**
 * What read-aloud is doing, for the wrist (DROVE-275).
 *
 * Null when it is off, which is what keeps the key off the snapshot entirely
 * rather than sending an "off" the watch would have to know a third spelling
 * for.
 *
 * READ OFF THE READER, never off the settings toggle. That is the same call
 * DROVE-233 made for the lock screen's playback rate and for the same reason:
 * the toggle says what he asked for and the reader says what is happening, and
 * a wrist showing the toggle would say "Reading" through a pause.
 */
export function collectReading(): DroverReading | null {
    if (!readAloud.isEnabled) return null;
    // The session ACTUALLY SPEAKING, not merely the one focused (DROVE-297).
    // Reading is per session now, so a session he switched off keeps its
    // screen for a moment after it has given the voice up; the wrist scopes
    // its control by this id, and a control offered on a session that is not
    // talking would pause a voice he cannot see.
    const sessionId = readAloud.readingSessionId;
    return {
        state: readAloud.isPaused ? 'paused' : 'reading',
        // Spread rather than set to null: one NSNull fails the whole publish
        // with WCErrorCodePayloadUnsupportedTypes.
        ...(sessionId ? { sessionId } : {}),
    };
}

/**
 * Whether the reading is where the last publish left it.
 *
 * In the change guard because a pause moves NOTHING else about a snapshot: the
 * gates, the sessions and the account rows are all identical either side of
 * it, so a publish keyed on those three alone would drop it and the wrist
 * would sit on "Reading" until something unrelated happened. That is the exact
 * shape of the bug DROVE-131 fixed for the binding limit.
 */
function sameReading(a: DroverReading | null, b: DroverReading | null): boolean {
    if (a === null || b === null) return a === b;
    return a.state === b.state && (a.sessionId ?? '') === (b.sessionId ?? '');
}

function sameAccountRows(a: DroverAccountRow[], b: DroverAccountRow[]): boolean {
    if (a.length !== b.length) return false;
    // The binding limit and which account is current are in the key because
    // the wrist SHOWS them (DROVE-131): the window can change from Session to
    // Fable week, or the current account can move under a flip, with every
    // headroom figure unchanged, and a publish keyed only on the numbers would
    // leave the wrist naming yesterday's limit.
    // The BREAKDOWN is in the key too (DROVE-339), and for the same reason the
    // binding limit is: the wrist shows it. A week ticking from 61% to 62%
    // while the binding session window sits at 100% moves no field above, and
    // a publish keyed only on those would leave an open account detail reading
    // yesterday's rows.
    const limits = (r: DroverAccountRow) => (r.limits ?? [])
        .map((l) => `${l.id}:${l.used ?? ''}:${l.tone ?? ''}:${l.trailing ?? ''}:${l.binding === true}`)
        .join(',');
    const key = (r: DroverAccountRow) =>
        `${r.name}|${r.headroom ?? ''}|${r.used ?? ''}|${r.loggedIn}|${r.backAt ?? ''}`
        + `|${r.current === true}|${r.limit ?? ''}|${r.resetsAt ?? ''}|${r.tone ?? ''}`
        + `|${r.expired === true}|${r.title ?? ''}|${r.switchable === true}|${limits(r)}`;
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
    // ONE definition of what a cue is, shared with the relay and with the
    // watch's own WristCueDiff (DROVE-224). A second copy here is how the
    // phone and the wrist would come to disagree about what a buzz is for.
    return wristCueIds(wristCueStateOf(before), after).length > 0;
}

let started = false;
let lastGates: DroverGate[] = [];
let lastSessions: DroverSession[] = [];
let lastAccountRows: DroverAccountRow[] = [];
let lastReading: DroverReading | null = null;
/**
 * The first publish of a run has nothing to compare against, so every gate in
 * it reads as new. Waking for that would spend the budget on a wall of work
 * that was already there when the app launched — and the wrist filters it out
 * anyway (WristCueDiff.freshWindow), so the wake would buy a background launch
 * and no buzz.
 */
let publishedOnce = false;

/**
 * The session the watch says it has open, and the rows last built for it
 * (DROVE-91). One session, never all of them: the watch names it by sending
 * `opened`, and the feed builds and sends rows for that one alone.
 */
let watchedSessionId: string | null = null;
let lastTranscript: DroverTranscript | null = null;
/**
 * What the last build read, by identity. The store publishes on every change
 * anywhere, and folding thirty rows on each of them is work the phone would
 * do for every session's keystroke; the message array and the thinking flag
 * only move when this session did.
 */
let lastTranscriptSource: { messages: Message[] | undefined; thinking: boolean } = { messages: undefined, thinking: false };
/** Row versions a reachable watch has been sent, so a delta carries only news. */
let sentRows = new Map<string, string>();
let sentStreaming: boolean | null = null;

/**
 * The rows for the session the watch is showing, off the store (DROVE-91).
 *
 * Null with no session open. A session whose messages the phone has not
 * loaded yields an empty transcript rather than none, so the watch draws a
 * waiting state instead of the previous session's rows.
 */
export function collectTranscript(sessionId: string | null = watchedSessionId): DroverTranscript | null {
    if (!sessionId) return null;
    const state = storage.getState();
    const messages = state.sessionMessages?.[sessionId]?.messages ?? [];
    const thinking = !!state.sessions?.[sessionId]?.thinking;
    return {
        sessionId,
        rows: buildWristRows(messages, { sessionId, thinking }),
        streaming: thinking,
    };
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
        const reading = collectReading();
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
            // A pause moves nothing else, so without this the wrist keeps
            // yesterday's answer (DROVE-275).
            && sameReading(reading, lastReading)
        ) return;
        // Computed against the PREVIOUS sets, so it has to happen before they
        // are replaced below (DROVE-62).
        // A wake exists to BUZZ, so it is spent only when some new gate is
        // announced on haptic and this phone's haptic switch is on
        // (DROVE-72). A gate with no `delivery` came off a bus older than
        // the field and wakes as before. Read off the card's stamp and the
        // phone's own switch; the wrist keeps its own switch beside these.
        const fresh = newGateEntries(new Set(lastGates.map((g) => g.id)), collectGateEntries());
        // Every cue this change raises, named the way the WATCH names it, and
        // claimed here so nothing else carries it twice (DROVE-224). The
        // background task the silent wake push launches runs in its own JS
        // context, so only a ledger on disk sees across the two — which is
        // what makes an event arriving across a foreground or background
        // transition exactly one buzz rather than two.
        //
        // The first publish of a run reads the whole wall as new, so it is
        // SEEDED rather than claimed: no wake, but recorded, or the next
        // background wake would carry work that was already up.
        const cues = wristCueIds(
            wristCueStateOf({ gates: lastGates, sessions: lastSessions }),
            { gates, sessions },
        );
        let mine: string[] = [];
        if (publishedOnce) mine = claimWristCues(cues);
        else seedWristCues(cues);
        // Which path could reach the wrist at all. With this app frontmost iOS
        // does not forward a push to the watch, so the direct path is the ONLY
        // path and a refusal is a wrist that stays silent outright.
        const carrier = wristCarrierFor(getCurrentAppState());
        const wake =
            mine.length > 0 &&
            (fresh.length === 0 || wakeDeserved(fresh, togglesFromSettings(storage.getState().settings)));
        lastGates = gates;
        lastSessions = sessions;
        lastAccountRows = accountRows;
        lastReading = reading;
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
            // The open session's rows ride every publish, so the application
            // context, which is what a watch launched later reads, carries the
            // conversation it last saw (DROVE-91). Not in the change guard
            // above: a transcript change goes out as a delta by sendMessage,
            // rationed below, and republishing the whole context per token is
            // what that rationing exists to avoid.
            ...(lastTranscript ? { transcript: lastTranscript } : {}),
            // What the reader is doing, so the wrist can show it and press it
            // (DROVE-275). Omitted with read-aloud off, and it is a handful of
            // bytes when it is there: the sentence stays off the wire, because
            // every snapshot rides `sendMessage` to a reachable watch and that
            // wire is capped near 64KB (droverWatchTranscript.spec.ts).
            ...(reading ? { reading } : {}),
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
        // The home screen gets the same facts, resolved into the one line a
        // widget has room for (DROVE-260). It rides HERE rather than on the
        // gate push alone, and that is the whole freshness argument: the
        // heartbeat forces this every 60s while the app is up, so a widget
        // glanced at during a working session is at most a minute old, and the
        // hour it is allowed to claim "clear" for is an hour of the phone
        // being genuinely away. Only the BLOB is written that often — the
        // reload that actually costs budget is rationed inside
        // publishDroverWidgetFace.
        void publishDroverWidgetFace({ gates, sessions });
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
        //
        // A budget of exactly 0 is skipped and SAID: the native call would be
        // downgraded to a plain transfer, which the application context above
        // already covers, and the wrist would stay silent with nothing on
        // record as to why (DROVE-86). The same line is what the session info
        // screen shows, so Console and the screen agree.
        if (wake && !status.reachable) {
            if (status.wakes === 0) {
                // Claimed a moment ago and given straight back: a cue nobody
                // felt must stay carryable, or an exhausted budget would turn
                // into a gate that is silent forever (DROVE-224). The state is
                // not remembered either, so the next path still reads the cue
                // as new.
                releaseWristCues(mine);
                noteWristRelay(wristRefusal(mine, carrier, describeDroverWakeBudget(status)));
                return;
            }
            void wakeDroverWatch(snapshot).then((spent) => {
                if (spent) {
                    rememberWristRelayState({ gates, sessions });
                    return;
                }
                releaseWristCues(mine);
                noteWristRelay(`${wristRefusal(mine, carrier, describeDroverWakeBudget(status))}; the wake was not spent as a background launch`);
            });
            return;
        }
        // Either the wrist was reached (a reachable watch app buzzes off the
        // publish itself) or there was nothing new to carry. Both are a wrist
        // that is up to date, so this is what the next reader diffs against.
        rememberWristRelayState({ gates, sessions });
    };

    // Rebuild the open session's rows when THAT session moved, and hand them
    // to the coalescer, which sends at most four deltas a second (DROVE-91).
    const pushTranscript = () => {
        if (!watchedSessionId) return;
        const state = storage.getState();
        const messages = state.sessionMessages?.[watchedSessionId]?.messages;
        const thinking = !!state.sessions?.[watchedSessionId]?.thinking;
        if (messages === lastTranscriptSource.messages && thinking === lastTranscriptSource.thinking) return;
        lastTranscriptSource = { messages, thinking };
        lastTranscript = collectTranscript(watchedSessionId);
        coalescer.schedule(watchedSessionId);
    };

    const coalescer = createWristCoalescer((sessionId) => {
        const transcript = lastTranscript;
        if (!transcript || transcript.sessionId !== sessionId || sessionId !== watchedSessionId) return;
        const delta = transcriptDelta(sessionId, transcript.rows, transcript.streaming, sentRows, sentStreaming);
        if (!delta) return;
        void sendDroverTranscript(delta).then((sent) => {
            // Unreachable means unsent, and unsent means the next reachable
            // delta still carries it. The application context covers the
            // watch meanwhile, on the next publish.
            if (!sent || watchedSessionId !== sessionId) return;
            sentRows = new Map(transcript.rows.map((row) => [row.id, rowKey(row)]));
            sentStreaming = transcript.streaming;
        });
    });

    // The watch opened a session, or left the one it had (DROVE-91). Every
    // row goes again on an open, even of the same session: the watch that
    // says so may have just launched and hold nothing.
    const opened = addDroverOpenedListener((event) => {
        watchedSessionId = event.sessionId || null;
        sentRows = new Map();
        sentStreaming = null;
        lastTranscriptSource = { messages: undefined, thinking: false };
        if (!watchedSessionId) {
            lastTranscript = null;
            return;
        }
        // The phone loads a session's messages when a screen shows it; the
        // wrist showing it counts. The rows only, not a screen's git status
        // or the voice assistant's focus.
        try {
            sync.loadSessionMessages(watchedSessionId);
        } catch {
            // A session the phone does not hold yet: the rows come when it does.
        }
        pushTranscript();
    });

    const answers = addDroverAnswerListener((event) => {
        // The wrist's own demo refuses to send an answer for a `demo:` gate,
        // and no demo gate is ever in a snapshot. This is the phone-side
        // refusal for the same id, so a demo answer arriving off the wire by
        // any route is logged as a demo and dropped rather than replayed into
        // sessionAllow (DROVE-75).
        if (isDroverDemoId(event.id)) {
            demoLog(`wrist answered demo gate ${event.id}; dropped, nothing sent`);
            return;
        }
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
        // WHO answered, for the bus's ledger (DROVE-72). Only on a card the
        // drover bridge mirrored, where `updatedInput` is read by
        // busResolutionFor and nothing else; on a native permission it is the
        // tool's replacement input, and a stray key there would be typed into
        // the tool call.
        const mirrored = collectGateEntries().some((entry) => entry.gate.id === event.id && !!entry.event);
        const via = mirrored ? { via: 'watch' } : {};
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
                answered || many.length || mirrored
                    ? {
                        ...via,
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
        // The demo stages a session on the wrist so "Session finished" can play
        // by the real diff (DROVE-222). It is on the wall for under a second,
        // but a flip aimed at it must not reach sync: the same refusal the
        // demo GATE already gets below, for the other demo-namespaced id.
        if (isDroverDemoId(event.sessionId)) {
            demoLog(`wrist asked to flip demo session ${event.sessionId}; dropped, nothing sent`);
            return;
        }
        const text = event.account ? `/flip ${event.account}` : '/flip';
        void Promise.resolve(sync.sendMessage(event.sessionId, text)).catch(() => {});
    });

    // A message dictated on the wrist (DROVE-92). It leaves this phone by the
    // same sync.sendMessage the composer's Send calls, so it reaches the
    // session's inbox and lands in the transcript, on both devices, exactly
    // as a phone-typed message does. It goes through the same userSent as
    // SessionView's own Send (DROVE-122), so the wrist's capture stops while
    // the phone keeps narrating the old reply until the new one has its first
    // sentence to say.
    const says = addDroverSayListener((event) => {
        const text = (event.text ?? '').trim();
        if (!event.sessionId || !text) return;
        if (isDroverDemoId(event.sessionId)) {
            demoLog(`wrist dictated into demo session ${event.sessionId}; dropped, nothing sent`);
            return;
        }
        readAloud.userSent();
        void Promise.resolve(sync.sendMessage(event.sessionId, text, { source: 'voice' })).catch(() => {});
    });

    // The wrist's held-open recorder (DROVE-130).
    //
    // One press on the watch opens the microphone and it STAYS open across
    // pauses, which watchOS's own input sheet cannot do. The watch captures
    // and this phone transcribes, because `Speech.framework` is absent from
    // the watchOS SDK entirely — so the recogniser that survives a pause
    // correctly (DROVE-263) is the one already running here, inherited rather
    // than copied.
    //
    // The PCM does not pass through JS: it goes from the watch bridge to the
    // speech module inside the native process. What comes through here is the
    // control and the transcript, which is the part worth shipping OTA.
    const wrist = new WristDictation(
        {
            start: (capture) => startWristDictation(capture),
            stop: () => stopDictation(),
            cancel: () => cancelDictation(),
        },
        {
            heard: (capture, seq, text, final) => {
                void sendDroverWatchVoice({ kind: 'heard', capture, seq, text, final });
            },
            // Reporting only. Closing the wrist is the job of the final
            // `heard`, and doing it twice is how an empty message lands after
            // the real transcript and wipes it.
            error: (capture, message) => {
                demoLog(`wrist dictation failed on ${capture}: ${message}`);
            },
        },
    );
    // The recogniser's own output. Both of these no-op unless a WRIST capture
    // is open: the phone's composer mic emits the same events, and the native
    // module refuses to run two captures at once, so there is never a moment
    // when these two could be confused for each other.
    const wristPartials = addDictationPartialListener((text) => wrist.partial(text));
    const wristEnds = addDictationEndedListener((text, reason) => wrist.ended(text, reason));
    const listens = addDroverListenListener((event) => {
        if (!event.capture) return;
        // A build older than DROVE-130 has no native entry point for this. Say
        // so rather than opening a recorder nothing will listen to; the wrist
        // falls back to its one-shot sheet, which still works.
        if (!wristDictationSupported()) {
            void sendDroverWatchVoice({
                kind: 'heard', capture: event.capture, seq: -1, text: '', final: true,
            });
            return;
        }
        if (event.state === 'start') {
            if (!event.sessionId || isDroverDemoId(event.sessionId)) return;
            // The phone stops narrating the old reply while he talks, exactly
            // as it does for the phone's own mic (DROVE-122).
            readAloud.userSent();
            wrist.open(event.capture);
            return;
        }
        if (event.state === 'stop') {
            wrist.close(event.capture);
            return;
        }
        if (event.state === 'cancel') wrist.discard(event.capture);
    });

    // The wrist's audio route, and the wrist finishing a sentence the phone
    // sent it (DROVE-92). Both are facts the voice side owns; the feed only
    // carries them off the wire.
    // Pause or resume from the WRIST (DROVE-275).
    //
    // It reaches the one reader every other surface drives, so the pause taken
    // here is the pause the lock screen and the headphones take, holding the
    // same place. Explicit rather than a toggle, and unknown actions are
    // dropped: the wrist presses off a snapshot that may be a minute old, and
    // a toggle from a stale screen would resume exactly what he just paused.
    //
    // `setPaused(false)` on a reader that is OFF does nothing at all, which is
    // DROVE-189's rule and the reason this cannot turn the voice back on for a
    // session he walked away from.
    const transport = addDroverTransportListener((event) => {
        if (event.action !== 'pause' && event.action !== 'resume') return;
        try {
            readAloud.setPaused(event.action === 'pause');
        } catch {
            // A dead wrist button is better than a dead reader.
        }
    });

    // And a pause taken ANYWHERE republishes at once, so the wrist redraws off
    // the press rather than off the next heartbeat up to a minute later. The
    // change guard is what makes this cheap: an unchanged reading still stops
    // at the top of `push`.
    const readingChanged = readAloud.addTransportListener(() => { push(); });

    const routes = addDroverRouteListener((event) => setWatchRoute(!!event.headphones));
    const spoken = addDroverSpokenListener((event) => {
        if (event.id) settleWatchUtterance(event.id, !!event.finished);
    });

    // The wrist asked, which means iOS has just woken this app in the
    // background to answer (DROVE-22). Forced, because the ask is about the
    // TIMESTAMP: the gate set is usually identical and the change check would
    // drop the publish, leaving the watch holding the same stale snapshot it
    // asked to replace. The native side is holding the watch's reply open until
    // this publish lands.
    const refreshes = addDroverRefreshListener(() => push(true));

    const unsubscribe = storage.subscribe(() => {
        push();
        pushTranscript();
    });
    // Forced, so an unchanged snapshot still restamps updatedAt. That restamp
    // is the whole signal: see HEARTBEAT_MS.
    const heartbeat = setInterval(() => push(true), HEARTBEAT_MS);
    push(true);

    return () => {
        started = false;
        // So a restarted feed does not wake the wrist for gates that were
        // already on the wall when it restarted (DROVE-62).
        publishedOnce = false;
        // And so it does not inherit a reload decision from a run that is over
        // (DROVE-260). A restarted feed tells the widget once on its first
        // publish, which is the same rule the line above applies to the wrist.
        resetDroverWidgetMemory();
        answers.remove();
        flips.remove();
        refreshes.remove();
        opened.remove();
        says.remove();
        listens.remove();
        wristPartials.remove();
        wristEnds.remove();
        // A feed torn down mid-capture leaves the microphone open on the
        // wrist over a recogniser nobody is reading. Close it.
        if (wrist.openCapture) wrist.discard(wrist.openCapture);
        routes.remove();
        spoken.remove();
        transport.remove();
        readingChanged();
        lastReading = null;
        coalescer.stop();
        watchedSessionId = null;
        lastTranscript = null;
        lastTranscriptSource = { messages: undefined, thinking: false };
        sentRows = new Map();
        sentStreaming = null;
        clearInterval(heartbeat);
        unsubscribe();
    };
}
