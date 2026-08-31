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
 * belongs to one. Claude is the only harness in the registry today: a clone is
 * another harness, not another account, so nothing else has rows to show yet
 * and none are invented.
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
import { Linking, Platform, RefreshControl } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { MOBILE_GLASS_HEADER_HEIGHT } from '@/components/navigation/headerMetrics';
import { Modal } from '@/modal';
import { storage, useAllMachines } from '@/sync/storage';
import { machineDroverAccountLogin } from '@/sync/ops';
import {
    machineDroverAccountRemove,
    machineDroverAccounts,
    type MachineAccountsResult,
} from '@/sync/machineAccounts';
import {
    accountCanRun,
    accountSubtitle,
    addAccountBusy,
    addAccountIdle,
    addAccountStatus,
    advanceAddAccount,
    autoOpenLoginUrl,
    autoStartAddAccount,
    pendingAccountLogins,
    type AddAccountEvent,
    type AddAccountPhase,
    type MachineAccount,
    type PendingAccountLogin,
} from '@/sync/machineAccountsFlow';
import { hostOf } from '@/components/tools/views/droverAccountLogin';

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

function machineName(machine: { id: string; metadata?: { displayName?: string; host?: string } | null }): string {
    return machine.metadata?.displayName || machine.metadata?.host || machine.id.substring(0, 8);
}

export default function AccountsScreen() {
    const machines = useAllMachines({ includeOffline: true });
    const [loaded, setLoaded] = React.useState<Record<string, Loaded>>({});
    const [phases, setPhases] = React.useState<Record<string, AddAccountPhase>>({});
    const [refreshing, setRefreshing] = React.useState(false);
    const [busyRemove, setBusyRemove] = React.useState<string | null>(null);

    /**
     * The pending login cards, as a STABLE key.
     *
     * `pendingAccountLogins` mints fresh objects, so selecting them straight out
     * of the store would hand React a new array on every unrelated store change
     * and re-render this screen for nothing. The key is a string, which compares
     * by value; the cards are rebuilt only when it moves.
     */
    const loginKey = storage((state) => pendingAccountLogins(state.sessions)
        .map((c) => `${c.machineId}|${c.sessionId}|${c.url ?? ''}|${c.createdAt ?? ''}`)
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
            });
        } else {
            // A read that failed still tells the truth about the time. Only
            // the account list is unknown, not the clock.
            dispatch(machineId, { type: 'tick', at: Date.now() });
        }
        return result;
    }, [dispatch]);

    const machineIds = machines.map((m) => m.id).join(',');
    React.useEffect(() => {
        for (const id of machineIds ? machineIds.split(',') : []) void load(id);
    }, [machineIds, load]);

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
        await Promise.all(machines.map((m) => load(m.id)));
        setRefreshing(false);
    }, [machineIds, load]);

    /**
     * Start a login on that machine. Nothing is asked first (DROVE-212).
     *
     * No name is collected and none is sent. `drover account login` names the
     * account after the address Claude Code reports once the login succeeds,
     * which is the only name that is true without asking for one.
     */
    const addAccount = React.useCallback(async (machineId: string, existing: string[]) => {
        dispatch(machineId, { type: 'start' });
        try {
            await machineDroverAccountLogin(machineId);
            dispatch(machineId, { type: 'started', at: Date.now(), before: existing });
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
        void addAccount(requested!, before);
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

                {machines.map((machine) => {
                    const state = loaded[machine.id];
                    const accounts = state?.result?.ok ? state.result.accounts : [];
                    const phase = phases[machine.id] ?? addAccountIdle;
                    const status = addAccountStatus(phase);
                    const card = cardFor(machine.id);
                    const online = machine.active;
                    return (
                        <ItemGroup
                            key={machine.id}
                            title={`${machineName(machine)} · Claude`}
                            footer={online
                                ? 'These accounts are logged in on this machine and only exist here.'
                                : 'This machine is offline, so its account list cannot be read or changed.'}
                        >
                            {state?.loading && !state.result && (
                                <Item title="Reading that machine…" showChevron={false} loading />
                            )}

                            {state?.result && !state.result.ok && (
                                <Item
                                    title="Could not read the accounts"
                                    subtitle={state.result.error}
                                    subtitleLines={0}
                                    icon={<Ionicons name="warning-outline" size={29} color="#FF9500" />}
                                    showChevron={false}
                                />
                            )}

                            {accounts.map((account) => (
                                <Item
                                    key={account.name}
                                    title={account.name}
                                    subtitle={accountSubtitle(account)}
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

                            {status && (
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
                              * The link, on THIS screen (DROVE-212).
                              *
                              * It opens the browser directly rather than the share sheet the card
                              * in the bridge thread raises: from a phone, Start login has to end at
                              * a sign-in page. The sheet stays on that card for the times Clay
                              * wants the link somewhere other than the default browser.
                              *
                              * The code still goes back on the card and nowhere else. That is the
                              * DROVE-61 path, it is the only thing wired to the waiting login, and
                              * a second code field here would be a second thing to keep in step.
                              */}
                            {status?.hasLink && card?.url && (
                                <>
                                    <Item
                                        title="Open the sign-in page"
                                        subtitle={hostOf(card.url)}
                                        icon={<Ionicons name="open-outline" size={29} color="#007AFF" />}
                                        onPress={() => openLogin(machine.id, card.url!)}
                                        detail="Open"
                                        showChevron={false}
                                    />
                                    <Item
                                        title="Enter the code"
                                        subtitle="Paste what that page gives you back"
                                        icon={<Ionicons name="key-outline" size={29} color="#007AFF" />}
                                        onPress={() => router.push(`/session/${card.sessionId}` as never)}
                                    />
                                </>
                            )}

                            <Item
                                title="Add a Claude account"
                                subtitle="Opens the sign-in page in your browser. Named after the address you sign in as."
                                subtitleLines={0}
                                icon={<Ionicons name="add-circle-outline" size={29} color="#34C759" />}
                                disabled={!online || addAccountBusy(phase)}
                                onPress={() => void addAccount(machine.id, accounts.map((a) => a.name))}
                            />
                        </ItemGroup>
                    );
                })}

                <ItemGroup
                    title="Why this is per machine"
                    footer="A Claude account is a login, and a login lives on the machine that ran it — on a Mac the credential is in that machine’s Keychain. Nothing about an account is copied between machines, and no account, code or token is ever held by this app."
                >
                    <Item
                        title="Switching account mid-session"
                        subtitle="Use the quota bars under the composer, which know which session you are in"
                        icon={<Ionicons name="swap-horizontal-outline" size={29} color="#FF9500" />}
                        showChevron={false}
                    />
                </ItemGroup>
            </ItemList>
        </>
    );
}
