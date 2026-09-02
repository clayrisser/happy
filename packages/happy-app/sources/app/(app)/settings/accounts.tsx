/**
 * Accounts — every Claude account, under the machine it is logged in on
 * (DROVE-165, folding in DROVE-136).
 *
 * Clay: "we should have an option called Accounts, and when you open that up
 * you can see all the accounts sorted by their harness" (DROVE-136), and then
 * "AND ADDING CLAUDE ACCOUNTS FROM THE MOBILE APP", followed unprompted by the
 * constraint that decides the shape of it: "I think Claude accounts we add are
 * specific to a machine because that's where they're logged in."
 *
 * He is right, and it is why this screen groups by MACHINE first. An account is
 * a login; the login lives in a `CLAUDE_CONFIG_DIR` on one Mac; on macOS the
 * credential is a Keychain item keyed to that directory's path. None of it
 * travels. A flat pool would be a lie the moment there are two machines — it
 * would offer to flip a session onto an account that does not exist where that
 * session runs. So the machine is the group, the same way the sessions list
 * groups by machine, and the harness is named on the group because an account
 * belongs to one.
 *
 * TWO HARNESSES NOW, AND THE SECOND ONE IS NOT SHAPED LIKE THE FIRST
 * (DROVE-270). Clay, with this page open: "Why doesn't it have an option to
 * add a cursor account Or a cursor agent whatever thing". It did not, and the
 * page was already drawn for it — the heading has said `<machine> · CLAUDE`
 * since DROVE-165 — so what was missing was the second group and the row that
 * starts it. This file used to say Claude was the only harness in the
 * registry; `drover account login --harness cursor` (DROVE-256) is what made
 * that stop being true.
 *
 * The difference is worth stating because the ORIGINAL EXPLANATION ON THIS
 * PAGE IS WRONG FOR CURSOR, and copying it would be the bug:
 *
 *   a CLAUDE account is a LOGIN in a CLAUDE_CONFIG_DIR. On a Mac its
 *     credential is a Keychain item keyed to sha256 of that directory, so it
 *     is bound to one machine and only ONE of them is in use at a time —
 *     hence the flip, which is a config-dir swap and a respawn.
 *   a CURSOR account is a TOKEN. cursor-agent reads CURSOR_AUTH_TOKEN and it
 *     OUTRANKS both an API key and the machine's own stored login (measured:
 *     `authSource: r ? "auth-token" : u ? "api-key" : "login"`, and a bogus
 *     token fails even with a perfectly valid stored login present — which is
 *     the control that proves it never silently falls back). So drover hands
 *     each session its own token, two cursor accounts run side by side, and
 *     there is nothing to take turns over. No flip is offered onto one, here
 *     or on the quota sheet or the wrist.
 *
 * Both are still PER MACHINE, so the page's shape does not move: the token is
 * stored on the machine that logged in, exactly as the Keychain item is.
 *
 * A CURSOR ROW IS UNMEASURED, NEVER A HEALTHY 100%. Cursor publishes no quota
 * anywhere — no usage cache, no limits, no reset — because its accounting is
 * server-side. That is structural rather than a reading that has not happened,
 * so the row says so in the trailing slot instead of showing a percentage, in
 * DROVE-230's existing vocabulary.
 *
 * WHAT THE PHONE CAN AND CANNOT DO, because that is the whole risk here.
 * Claude Code's login is a browser round trip and this app cannot perform it.
 * It can start the login on that machine, show the link the machine printed,
 * and watch that machine's registry for the new row. The signing in is Clay's,
 * and the code he gets back goes from the card straight into the waiting
 * `claude auth login` — no agent, and nothing in this app, ever holds that code
 * or the token it buys. The states are in sync/machineAccountsFlow.ts and each
 * one moves on something genuinely observed; a watch that runs out says it
 * stopped watching, never that the login failed.
 *
 * NOTHING IS ASKED BEFORE THE LOGIN (DROVE-212). Clay: "when I try to add
 * account it's still asking me to name the account. I told you the account gets
 * named after you login based on what you logged in with." Adding an account is
 * one tap: the login starts, the sign-in page opens in HIS browser as soon as
 * the machine sends the link, and `drover account login` names the account
 * after the address that signed in. Renaming one afterwards is a different
 * feature and is not built here.
 *
 * DROVE-208 gave this screen a second way in. The quota sheet under the
 * composer is where Clay compares accounts and notices one missing, so its
 * list ends in an add row; that row lands here with `addMachineId` set and the
 * login starts on that machine by itself. Nothing about the flow is duplicated
 * over there — the poll, the browser, the card link and the watch are all still
 * only here, which is the point, and the machine detail screen sends its own
 * add button to this same route for the same reason.
 */

import * as React from 'react';
import { Linking, Platform, RefreshControl, View } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet } from 'react-native-unistyles';

import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { MOBILE_GLASS_HEADER_HEIGHT } from '@/components/navigation/headerMetrics';
import { Modal } from '@/modal';
import { storage, useAllMachines } from '@/sync/storage';
import { machineDroverAccountLogin, sessionAllow } from '@/sync/ops';
import {
    machineDroverAccountRemove,
    machineDroverAccounts,
    type MachineAccountsResult,
} from '@/sync/machineAccounts';
import {
    accountCanRun,
    accountGroupFooter,
    accountGroupTitle,
    accountSubtitle,
    accountsByHarness,
    addAccountBusy,
    freshCursorAccounts,
    staleCursorAccounts,
    addAccountIdle,
    addAccountStatus,
    advanceAddAccount,
    autoOpenLoginUrl,
    autoStartAddAccount,
    pendingAccountLogins,
    phaseHarness,
    type AccountHarness,
    type AddAccountEvent,
    type AddAccountPhase,
    type MachineAccount,
    type PendingAccountLogin,
} from '@/sync/machineAccountsFlow';
import { harnessName } from '@/utils/harnessName';
import { DroverAccountLoginBody } from '@/components/tools/views/DroverAccountLoginBody';
import { MachineMcpRows } from '@/components/MachineMcpRows';
import { machineDroverMcps, type MachineMcpsResult } from '@/sync/machineMcps';
import { mcpOnlyFooter } from '@/sync/mcpText';

/** How often a machine with a login in flight is asked again. */
const watchPollMs = 4_000;

/**
 * How often the clock is moved on, whatever the machine is doing (DROVE-212).
 *
 * Separate from the poll, and that separation is the fix. The deadlines used
 * to advance only when a `drover-accounts` read came back OK, so a phone that
 * was backgrounded, reconnecting, or looking at a machine that had stopped
 * answering never reached the sixty-second sentence: `machineRPC` throws, the
 * result is `{ ok: false }`, no event is dispatched, and the spinner runs
 * forever. A tick costs nothing and cannot fail.
 */
const watchTickMs = 1_000;

type Loaded = { loading: boolean; result: MachineAccountsResult | null };

/**
 * A machine's MCP report, held beside its accounts (DROVE-274).
 *
 * Its own slot rather than a field on `Loaded`, because the two are fetched on
 * different schedules and for different reasons. The account list is POLLED
 * while a login is in flight; the MCP report is read ONCE when the screen
 * opens, because it is config and config does not move on its own. Folding
 * them together would put a file read on a four-second timer for nothing.
 */
type LoadedMcps = { loading: boolean; result: MachineMcpsResult | null };

function machineName(machine: { id: string; metadata?: { displayName?: string; host?: string } | null }): string {
    return machine.metadata?.displayName || machine.metadata?.host || machine.id.substring(0, 8);
}

export default function AccountsScreen() {
    const machines = useAllMachines({ includeOffline: true });
    const [loaded, setLoaded] = React.useState<Record<string, Loaded>>({});
    const [phases, setPhases] = React.useState<Record<string, AddAccountPhase>>({});
    const [refreshing, setRefreshing] = React.useState(false);
    const [busyRemove, setBusyRemove] = React.useState<string | null>(null);
    const [mcps, setMcps] = React.useState<Record<string, LoadedMcps>>({});
    // Which harness section is open, keyed `machineId:harness`. Collapsed by
    // default and not remembered between visits: forty rows is a thing you go
    // and look at, not a thing you want waiting for you.
    const [openMcp, setOpenMcp] = React.useState<Record<string, boolean>>({});

    /**
     * The pending login cards, as a STABLE key.
     *
     * `pendingAccountLogins` mints fresh objects, so selecting them straight out
     * of the store would hand React a new array on every unrelated store change
     * and re-render this screen for nothing. The key is a string, which compares
     * by value; the cards are rebuilt only when it moves.
     */
    const loginKey = storage((state) => pendingAccountLogins(state.sessions)
        .map((c) => `${c.machineId}|${c.sessionId}|${c.requestId}|${c.url ?? ''}|${c.createdAt ?? ''}`)
        .join(','));
    const logins = React.useMemo<PendingAccountLogin[]>(
        () => pendingAccountLogins(storage.getState().sessions),
        [loginKey],
    );

    const dispatch = React.useCallback((machineId: string, event: AddAccountEvent) => {
        setPhases((prev) => {
            const next = advanceAddAccount(prev[machineId] ?? addAccountIdle, event);
            return next === (prev[machineId] ?? addAccountIdle) ? prev : { ...prev, [machineId]: next };
        });
    }, []);

    const load = React.useCallback(async (machineId: string) => {
        setLoaded((prev) => ({ ...prev, [machineId]: { loading: true, result: prev[machineId]?.result ?? null } }));
        const result = await machineDroverAccounts(machineId);
        setLoaded((prev) => ({ ...prev, [machineId]: { loading: false, result } }));
        // The list is also the success signal for a login in flight: a name that
        // was not there before the start means the machine wrote the registry
        // row, which it only does once the account has PASSED a real check —
        // first run settled and `claude auth status` reading it as signed in
        // (DROVE-246). Rows that cannot run are filtered out here as well, so a
        // half-made account can never be what makes this screen say "added".
        if (result.ok) {
            dispatch(machineId, {
                type: 'accounts',
                at: Date.now(),
                names: result.accounts.filter(accountCanRun).map((a) => a.name),
                // The other way a cursor login succeeds (DROVE-270): a repeat
                // one replaces the token under a row that already exists, so no
                // name appears. A row that was inside its last week — or dead —
                // and now reads live is that login having landed.
                fresh: freshCursorAccounts(result.accounts),
            });
        } else {
            // A read that failed still tells the truth about the time. Only
            // the account list is unknown, not the clock.
            dispatch(machineId, { type: 'tick', at: Date.now() });
        }
        return result;
    }, [dispatch]);

    /**
     * Read that machine's MCP config once.
     *
     * No polling and no push, deliberately: this is what is in four config
     * files, and it changes when somebody edits one. The row says when it was
     * read so the screen is honest about that rather than implying it is live,
     * and pull-to-refresh is how you ask again.
     */
    const loadMcps = React.useCallback(async (machineId: string) => {
        setMcps((prev) => ({ ...prev, [machineId]: { loading: true, result: prev[machineId]?.result ?? null } }));
        const result = await machineDroverMcps(machineId);
        setMcps((prev) => ({ ...prev, [machineId]: { loading: false, result } }));
        return result;
    }, []);

    const machineIds = machines.map((m) => m.id).join(',');
    React.useEffect(() => {
        for (const id of machineIds ? machineIds.split(',') : []) void load(id);
    }, [machineIds, load]);

    React.useEffect(() => {
        for (const id of machineIds ? machineIds.split(',') : []) void loadMcps(id);
    }, [machineIds, loadMcps]);

    /**
     * The card for a machine, or null. Only one with a real URL counts, and the
     * NEWEST of those wins: a retry mints a fresh URL and an abandoned login
     * leaves its card behind, so taking the first would open a page whose login
     * is already gone.
     */
    const cardFor = React.useCallback(
        (machineId: string) => {
            const mine = logins.filter((c) => c.machineId === machineId && c.url !== null);
            if (mine.length === 0) return null;
            return mine.reduce((best, c) => ((c.createdAt ?? 0) > (best.createdAt ?? 0) ? c : best));
        },
        [logins],
    );

    // Tell the flow whether there is a card to open yet, so the screen can stop
    // saying "waiting for the link" the moment the link exists.
    React.useEffect(() => {
        for (const id of machineIds ? machineIds.split(',') : []) {
            dispatch(id, { type: 'link', ready: cardFor(id) !== null });
        }
    }, [cardFor, machineIds, dispatch]);

    /**
     * His browser, opened for him (DROVE-212).
     *
     * Clay: "Happen when I did this I should've opened my browser". The link
     * used to sit two taps away on a card in another thread, behind a button
     * that raises the iOS share sheet, so from a phone Start login looked like a
     * button that did nothing. The page now opens itself the moment the machine
     * sends the link, and the row below it stays for a second go.
     *
     * `opened` is per machine and holds the URL, so one link opens once. A
     * refused open is not announced: the row is right there, and a modal over a
     * browser that is already coming up would be the worse noise.
     */
    const [opened, setOpened] = React.useState<Record<string, string>>({});
    const openLogin = React.useCallback((machineId: string, url: string) => {
        setOpened((prev) => (prev[machineId] === url ? prev : { ...prev, [machineId]: url }));
        void Linking.openURL(url).catch(() => {});
    }, []);

    React.useEffect(() => {
        for (const id of machineIds ? machineIds.split(',') : []) {
            const url = autoOpenLoginUrl({
                phase: phases[id] ?? addAccountIdle,
                url: cardFor(id)?.url,
                opened: opened[id] ?? null,
            });
            if (url) openLogin(id, url);
        }
    }, [machineIds, phases, cardFor, opened, openLogin]);

    // Poll only while something is actually in flight. An idle Accounts screen
    // costs one round trip per machine on open and nothing after.
    const watching = machines.filter((m) => addAccountBusy(phases[m.id] ?? addAccountIdle)).map((m) => m.id).join(',');
    React.useEffect(() => {
        if (!watching) return;
        const ids = watching.split(',');
        const timer = setInterval(() => { for (const id of ids) void load(id); }, watchPollMs);
        return () => clearInterval(timer);
    }, [watching, load]);

    /**
     * The clock, which never depends on the machine answering (DROVE-212).
     *
     * `load` can hang, throw, or come back `{ ok: false }` for as long as the
     * socket is down, and every one of those used to stop the deadlines dead.
     * This one only reads `Date.now()`, so "no sign-in link came back" and
     * "stopped watching" arrive on time or, after the phone has been asleep,
     * on the first tick after it wakes.
     */
    React.useEffect(() => {
        if (!watching) return;
        const ids = watching.split(',');
        const timer = setInterval(() => {
            const at = Date.now();
            for (const id of ids) dispatch(id, { type: 'tick', at });
        }, watchTickMs);
        return () => clearInterval(timer);
    }, [watching, dispatch]);

    const refresh = React.useCallback(async () => {
        setRefreshing(true);
        await Promise.all(machines.flatMap((m) => [load(m.id), loadMcps(m.id)]));
        setRefreshing(false);
    }, [machineIds, load, loadMcps]);

    /**
     * Start a login on that machine. Nothing is asked first (DROVE-212).
     *
     * No name is collected and none is sent, for EITHER harness (DROVE-270).
     * `drover account login` names a Claude account after the address Claude
     * Code reports; the cursor login names one after the address cursor-agent
     * resolved, falling back to its token's own subject. Both are the only
     * name that is true without asking for one, and Clay has said three times
     * that he will not type an account name.
     */
    const addAccount = React.useCallback(async (
        machineId: string,
        /** Both halves of "what did this machine look like before", because a
         *  cursor login can succeed without changing the name set. */
        existing: { names: string[]; stale: string[] },
        harness: AccountHarness,
    ) => {
        dispatch(machineId, { type: 'start', harness });
        try {
            await machineDroverAccountLogin(machineId, { harness });
            dispatch(machineId, {
                type: 'started',
                at: Date.now(),
                before: existing.names,
                stale: existing.stale,
            });
        } catch (error) {
            // Named outright rather than swallowed: the login runs on a Mac
            // nobody is looking at, so a failure that only logs there is a
            // button that did nothing.
            dispatch(machineId, {
                type: 'startFailed',
                reason: error instanceof Error ? error.message : 'that machine did not answer',
            });
        }
    }, [dispatch]);

    /**
     * Arrived from the quota sheet's add row, for ONE machine (DROVE-208).
     *
     * It waits for that machine's list, because `before` is the whole basis of
     * "a new name appeared, so the login worked". Fired on an empty list, the
     * first account ever read back would look like the one just added and the
     * screen would announce a success that never happened. Offline is a no for
     * the same honesty: the group already says the list cannot be changed, so
     * starting a login there would be a spinner in front of a refusal.
     */
    const params = useLocalSearchParams<{ addMachineId?: string }>();
    const requested = typeof params.addMachineId === 'string' && params.addMachineId ? params.addMachineId : null;
    const autoStarted = React.useRef(false);
    const requestedState = requested ? loaded[requested] : undefined;
    const requestedOnline = !!machines.find((m) => m.id === requested)?.active;
    React.useEffect(() => {
        const before = autoStartAddAccount({
            requested,
            started: autoStarted.current,
            online: requestedOnline,
            accounts: requestedState?.result?.ok ? requestedState.result.accounts.map((a) => a.name) : null,
        });
        if (!before) return;
        autoStarted.current = true;
        // CLAUDE, because the quota sheet that sends people here is a Claude
        // sheet: it exists to compare headroom and pick somewhere to flip, and
        // a cursor account has neither. Adding a cursor account is a deliberate
        // tap on the Cursor group's own row (DROVE-270).
        void addAccount(requested!, { names: before, stale: [] }, 'claude');
    }, [requested, requestedOnline, requestedState, addAccount]);

    const removeAccount = React.useCallback(async (machineId: string, account: MachineAccount) => {
        const ok = await Modal.confirm(
            `Remove ${account.name}?`,
            'It comes off this machine’s account list, so no session can be sent there. The config '
            + 'directory and the login in the Keychain are left alone — remove those at the Mac if '
            + 'you want the subscription forgotten.',
            { confirmText: 'Remove', cancelText: 'Cancel', destructive: true },
        );
        if (!ok) return;
        setBusyRemove(`${machineId}:${account.name}`);
        const result = await machineDroverAccountRemove(machineId, account.name);
        setBusyRemove(null);
        if (!result.ok) {
            Modal.alert('That machine refused', result.error);
            return;
        }
        await load(machineId);
    }, [load]);

    return (
        <>
            <Stack.Screen options={{ title: 'Accounts' }} />
            <ItemList
                containerStyle={{ paddingTop: Platform.OS === 'ios' ? MOBILE_GLASS_HEADER_HEIGHT : 0 }}
                refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
            >
                {machines.length === 0 && (
                    <ItemGroup footer="An account is a login on a machine, so there is nothing to list until a machine is connected.">
                        <Item title="No machines connected" showChevron={false} />
                    </ItemGroup>
                )}

                {machines.flatMap((machine) => {
                    const state = loaded[machine.id];
                    const accounts = state?.result?.ok ? state.result.accounts : [];
                    const phase = phases[machine.id] ?? addAccountIdle;
                    const status = addAccountStatus(phase);
                    const card = cardFor(machine.id);
                    const online = machine.active;
                    const mcpState = mcps[machine.id];
                    const report = mcpState?.result?.ok ? mcpState.result.report : null;
                    /*
                     * TWO TICKETS MET HERE IN A MERGE. DROVE-270 split this
                     * screen into ONE GROUP PER HARNESS — the heading already
                     * named a harness, so a cursor account inside a group
                     * headed `· Claude` would be the heading lying, and a
                     * machine with no cursor account still draws the Cursor
                     * group because that group is the only place its add row
                     * can live. DROVE-274 brought each harness its MCP servers.
                     * So each harness group carries its own servers, and a
                     * harness with MCP config but no accounts (Codex, OpenCode)
                     * gets an MCP-only group below.
                     */
                    const mcpFor = (h: string) => report?.harnesses.find((x) => x.harness === h) ?? null;
                    const mcpRow = (mh: NonNullable<ReturnType<typeof mcpFor>>) => (
                        <MachineMcpRows
                            harness={mh}
                            readAt={report!.readAt}
                            expanded={!!openMcp[`${machine.id}:${mh.harness}`]}
                            onToggle={() => setOpenMcp((prev) => ({
                                ...prev,
                                [`${machine.id}:${mh.harness}`]: !prev[`${machine.id}:${mh.harness}`],
                            }))}
                            /* The providers disclosure is its own (DROVE-296).
                               Same map, a different key, so opening OpenCode's
                               141 models does not also unfold its 37 servers. */
                            providersExpanded={!!openMcp[`${machine.id}:${mh.harness}:providers`]}
                            onToggleProviders={() => setOpenMcp((prev) => ({
                                ...prev,
                                [`${machine.id}:${mh.harness}:providers`]: !prev[`${machine.id}:${mh.harness}:providers`],
                            }))}
                            /* Editing them is a screen of its own (DROVE-276):
                               a provider is five fields and a list of models,
                               and this is a summary. Only OpenCode takes a
                               provider list, so only OpenCode gets the row. */
                            onEditProviders={mh.harness === 'opencode'
                                ? () => router.push(`/settings/opencode-providers?machineId=${machine.id}`)
                                : undefined}
                        />
                    );
                    // One row, used by every harness section, so a machine that
                    // cannot be read says the same thing under each heading
                    // rather than three of them silently showing nothing.
                    const mcpProblem = (
                        <>
                            {mcpState?.loading && !mcpState.result && (
                                <Item title="Reading this machine’s MCP config…" showChevron={false} loading />
                            )}
                            {mcpState?.result && !mcpState.result.ok && (
                                <Item
                                    title="Could not read the MCP config"
                                    subtitle={mcpState.result.error}
                                    subtitleLines={0}
                                    icon={<Ionicons name="warning-outline" size={29} color="#FF9500" />}
                                    showChevron={false}
                                />
                            )}
                        </>
                    );
                    const accountGroups = accountsByHarness(accounts);
                    const mcpOnly = report?.harnesses.filter((h) => !accountGroups.some((g) => g.harness === h.harness)) ?? [];
                    return (
                        <React.Fragment key={machine.id}>
                        {accountGroups.map(({ harness, accounts: rows }) => (
                        <ItemGroup
                            key={`${machine.id}:${harness}`}
                            title={accountGroupTitle(machineName(machine), harness)}
                            footer={accountGroupFooter(harness, online)}
                        >
                            {/* The read is per MACHINE, so its loading row and
                                its error belong to the first group only —
                                repeated under each harness it would read as two
                                separate failures. */}
                            {harness === 'claude' && state?.loading && !state.result && (
                                <Item title="Reading that machine…" showChevron={false} loading />
                            )}

                            {harness === 'claude' && state?.result && !state.result.ok && (
                                <Item
                                    title="Could not read the accounts"
                                    subtitle={state.result.error}
                                    subtitleLines={0}
                                    icon={<Ionicons name="warning-outline" size={29} color="#FF9500" />}
                                    showChevron={false}
                                />
                            )}

                            {rows.map((account) => (
                                <Item
                                    key={account.name}
                                    title={account.name}
                                    // The MACHINE's whole list, not this
                                    // harness group, because a back-door twin
                                    // is recognised by sharing the ambient
                                    // row's login and the two can be grouped
                                    // apart (DROVE-333).
                                    subtitle={accountSubtitle(account, accounts)}
                                    subtitleLines={0}
                                    // Amber for BOTH dead ends, not just the
                                    // one with no credential (DROVE-246): an
                                    // account whose config dir has never been
                                    // through Claude Code's first run looked
                                    // identical to a working one here, and
                                    // tapping through to it is what stranded
                                    // Clay on a theme picker. The subtitle says
                                    // which of the two it is.
                                    icon={<Ionicons
                                        name={accountCanRun(account) ? 'person-circle-outline' : 'alert-circle-outline'}
                                        size={29}
                                        color={accountCanRun(account) ? '#007AFF' : '#FF9500'}
                                    />}
                                    // The ambient login is the account every plain `claude` on that
                                    // Mac uses. Removing it from a phone is not undoable from a
                                    // phone, so it is shown and left alone.
                                    onPress={account.ambient || !online ? undefined : () => void removeAccount(machine.id, account)}
                                    showChevron={false}
                                    loading={busyRemove === `${machine.id}:${account.name}`}
                                    detail={account.ambient ? 'main' : online ? 'Remove' : undefined}
                                />
                            ))}

                            {/* The status row and the card belong to the login
                                in flight, so they are drawn under the harness
                                that started it and nowhere else. `phase.kind`
                                narrows to a phase carrying a harness; idle has
                                no status at all. */}
                            {status && phaseHarness(phase) === harness && (
                                <Item
                                    title={status.title}
                                    subtitle={status.detail || undefined}
                                    subtitleLines={0}
                                    loading={status.spinner}
                                    icon={<Ionicons
                                        name={phase.kind === 'added' ? 'checkmark-circle-outline'
                                            : phase.kind === 'failed' ? 'warning-outline' : 'time-outline'}
                                        size={29}
                                        color={phase.kind === 'added' ? '#34C759'
                                            : phase.kind === 'failed' ? '#FF9500' : '#8E8E93'}
                                    />}
                                    // A terminal state is tapped to clear it. While a link is
                                    // live the two rows below are what to press, so this one is
                                    // read, not pressed.
                                    onPress={phase.kind === 'added' || phase.kind === 'failed' || phase.kind === 'stoppedWatching'
                                        ? () => dispatch(machine.id, { type: 'dismiss' })
                                        : undefined}
                                    showChevron={false}
                                />
                            )}

                            {/*
                              * THE WHOLE LOGIN, ON THIS SCREEN (DROVE-238).
                              *
                              * DROVE-212 put the LINK here and left the code field on the mirrored
                              * card, reasoning that "a second code field here would be a second
                              * thing to keep in step". Clay finished the login and said what that
                              * cost him: "Why did it make me enter the code in a question prompt
                              * instead of in the same accounts page where we clicked the link. That
                              * was very confusing." He tapped Enter the code, was pushed into a
                              * thread titled "Cattle Drover — pending…", and the thread answered
                              * "This session is inactive."
                              *
                              * So the card's body is rendered here instead — the same component the
                              * gate overlay, the gates screen and the transcript draw, with the same
                              * answer call. There is no second field to keep in step because there
                              * is no second field: DroverAccountLoginBody is the one implementation
                              * and this is one more surface for it.
                              *
                              * The link row comes with it, share icon and all, which is why the
                              * screen's own Open the sign-in page Item is gone. Two identical rows
                              * one above the other was the alternative.
                              *
                              * The answer is addressed to the session HOLDING the card — the
                              * bridge's, never one Clay can see — and it never navigates there.
                              */}
                            {status?.hasLink && card?.url && phaseHarness(phase) === harness && (
                                <View style={styles.loginCard}>
                                    <DroverAccountLoginBody
                                        args={card.args}
                                        canInteract
                                        onAnswer={(input) => sessionAllow(
                                            card.sessionId,
                                            card.requestId,
                                            undefined,
                                            undefined,
                                            'approved',
                                            input,
                                        )}
                                    />
                                </View>
                            )}

                            {/*
                              * THE ROW CLAY ASKED FOR, once per harness
                              * (DROVE-270). The promise is word for word the
                              * Claude row's, because it is word for word true
                              * of both: each login opens a page in HIS browser
                              * and each names the account after what he signed
                              * in as. Neither asks him to type a name.
                              *
                              * `existing` is every account ON THE MACHINE, not
                              * just this harness's. "A new name appeared" is
                              * how the flow decides a login worked, and the two
                              * harnesses share one registry — so a `before`
                              * missing the Claude rows would see one of them as
                              * the cursor account just added.
                              *
                              * Both rows go quiet while EITHER login runs: the
                              * two share a private tmux server whose session
                              * name is the lock, so the machine can only run
                              * one, and the card is addressed to a machine
                              * rather than to a harness.
                              */}
                            <Item
                                title={`Add a ${harnessName(harness)} account`}
                                subtitle="Opens the sign-in page in your browser. Named after the address you sign in as."
                                subtitleLines={0}
                                icon={<Ionicons name="add-circle-outline" size={29} color="#34C759" />}
                                disabled={!online || addAccountBusy(phase)}
                                onPress={() => void addAccount(
                                    machine.id,
                                    {
                                        names: accounts.map((a) => a.name),
                                        stale: staleCursorAccounts(accounts),
                                    },
                                    harness,
                                )}
                            />

                            {/*
                              * Claude's MCP servers, under Claude's own heading
                              * (DROVE-274). Per ACCOUNT, which is why they are
                              * here and not on their own: the accounts are
                              * right above, and the thing worth seeing is
                              * whether they all still carry the same servers.
                              */}
                            {harness === 'claude' && mcpProblem}
                            {(() => { const hm = mcpFor(harness); return hm ? mcpRow(hm) : null; })()}
                        </ItemGroup>
                        ))}

                        {/*
                          * A heading per harness, which is what Clay asked for:
                          * "under each harness you see the MCPs". A harness
                          * with MCP config but no account group above (Codex,
                          * OpenCode today) still gets its heading here, and one
                          * with nothing configured says none — dropping the
                          * section would read as "this harness cannot have
                          * MCPs", which is a different and wrong claim.
                          */}
                        {mcpOnly.map((mh) => (
                            <ItemGroup
                                key={`${machine.id}:mcp:${mh.harness}`}
                                title={`${machineName(machine)} · ${mh.label}`}
                                footer={mcpOnlyFooter(mh)}
                            >
                                {mcpRow(mh)}
                            </ItemGroup>
                        ))}
                        </React.Fragment>
                    );
                })}

                {/*
                  * THE EXPLANATION, CORRECTED FOR BOTH KINDS (DROVE-270).
                  *
                  * What stood here was Claude-shaped and would have been a lie
                  * over a cursor row: "a login lives on the machine that ran it
                  * — on a Mac the credential is in that machine's Keychain."
                  * True of Claude, whose Keychain item is keyed to sha256 of
                  * its config dir. A cursor account is a TOKEN, which is
                  * exactly why two of them run at once where two Claude
                  * accounts cannot.
                  *
                  * What both share is the part the heading claims: the
                  * credential is written by the machine that ran the login and
                  * stays there. That is still why this page groups by machine,
                  * and it is still true that this app never holds a credential.
                  */}
                <ItemGroup
                    title="Why this is per machine"
                    footer="Both kinds are written by the machine that ran the login and stay on it. A Claude account is a LOGIN in a config directory — on a Mac its credential is a Keychain item belonging to that directory — and only one is in use at a time, which is what a flip moves between. A cursor account is a TOKEN this machine holds, handed to each session, so two cursor sessions run side by side and there is nothing to flip. No account, code or token is ever held by this app."
                >
                    <Item
                        title="Switching account mid-session"
                        subtitle="Use the quota bars under the composer, which know which session you are in. Claude accounts only — a cursor session already has its own token and never needs one."
                        subtitleLines={0}
                        icon={<Ionicons name="swap-horizontal-outline" size={29} color="#FF9500" />}
                        showChevron={false}
                    />
                    <Item
                        title="Why a cursor account shows no percentage"
                        subtitle="Cursor publishes no quota anywhere — its accounting is server-side — so there is nothing to read. The row says so rather than showing a figure nobody measured."
                        subtitleLines={0}
                        icon={<Ionicons name="remove-circle-outline" size={29} color="#8E8E93" />}
                        showChevron={false}
                    />
                    {/*
                      * THE SIXTY-DAY FUSE, said where the countdown is
                      * explained rather than only where it appears (DROVE-270).
                      *
                      * A cursor token cannot be refreshed — cursor-agent has no
                      * redemption call for one — so the repair is always Clay
                      * at a browser, and it has to be asked for while the token
                      * still works. That is why the row starts saying `renew in
                      * 3d` a week out instead of going quiet until it dies.
                      */}
                    <Item
                        title="Why a cursor account counts down"
                        subtitle="A cursor login lasts 60 days and cannot renew itself, so the row starts saying “renew in 3d” a week before it expires. Tap Add a Cursor account again to sign in — the account keeps its name."
                        subtitleLines={0}
                        icon={<Ionicons name="time-outline" size={29} color="#FF9500" />}
                        showChevron={false}
                    />
                </ItemGroup>
            </ItemList>
        </>
    );
}

// The login card sits INSIDE an ItemGroup, which supplies the surface and the
// rounded corners; all this adds is the padding an Item would have given it.
const styles = StyleSheet.create(() => ({
    loginCard: {
        paddingHorizontal: 16,
        paddingVertical: 14,
    },
}));
