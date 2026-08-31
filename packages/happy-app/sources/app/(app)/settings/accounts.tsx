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
 */

import * as React from 'react';
import { Platform, RefreshControl } from 'react-native';
import { Stack, router } from 'expo-router';
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
    accountSubtitle,
    addAccountBusy,
    addAccountIdle,
    addAccountStatus,
    advanceAddAccount,
    pendingAccountLogins,
    type AddAccountEvent,
    type AddAccountPhase,
    type MachineAccount,
    type PendingAccountLogin,
} from '@/sync/machineAccountsFlow';

/** How often a machine with a login in flight is asked again. */
const watchPollMs = 4_000;

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
        .map((c) => `${c.machineId}|${c.sessionId}|${c.url ?? ''}`)
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
        // row, which it only does once Claude Code says it is logged in.
        if (result.ok) {
            dispatch(machineId, { type: 'accounts', at: Date.now(), names: result.accounts.map((a) => a.name) });
        }
        return result;
    }, [dispatch]);

    const machineIds = machines.map((m) => m.id).join(',');
    React.useEffect(() => {
        for (const id of machineIds ? machineIds.split(',') : []) void load(id);
    }, [machineIds, load]);

    /** The card for a machine, or null. Only one with a real URL counts. */
    const cardFor = React.useCallback(
        (machineId: string) => logins.find((c) => c.machineId === machineId && c.url !== null) ?? null,
        [logins],
    );

    // Tell the flow whether there is a card to open yet, so the screen can stop
    // saying "waiting for the link" the moment the link exists.
    React.useEffect(() => {
        for (const id of machineIds ? machineIds.split(',') : []) {
            dispatch(id, { type: 'link', ready: cardFor(id) !== null });
        }
    }, [cardFor, machineIds, dispatch]);

    // Poll only while something is actually in flight. An idle Accounts screen
    // costs one round trip per machine on open and nothing after.
    const watching = machines.filter((m) => addAccountBusy(phases[m.id] ?? addAccountIdle)).map((m) => m.id).join(',');
    React.useEffect(() => {
        if (!watching) return;
        const ids = watching.split(',');
        const timer = setInterval(() => { for (const id of ids) void load(id); }, watchPollMs);
        return () => clearInterval(timer);
    }, [watching, load]);

    const refresh = React.useCallback(async () => {
        setRefreshing(true);
        await Promise.all(machines.map((m) => load(m.id)));
        setRefreshing(false);
    }, [machineIds, load]);

    /**
     * Start a login on that machine.
     *
     * The name is optional on purpose: left out, the account is called after
     * the address it logs in as, so there is nothing to invent and nothing to
     * remember it by but the address.
     */
    const addAccount = React.useCallback(async (machineId: string, existing: string[]) => {
        const name = await Modal.prompt(
            'Add a Claude account',
            'It will be logged in and kept ON THIS MACHINE. Leave the name empty to call it after '
            + 'the address you sign in as.',
            { defaultValue: '', placeholder: 'Optional name', cancelText: 'Cancel', confirmText: 'Start login' },
        );
        if (name === null) return;
        const requested = name.trim() || null;
        dispatch(machineId, { type: 'start' });
        try {
            await machineDroverAccountLogin(machineId, requested ?? undefined);
            dispatch(machineId, { type: 'started', at: Date.now(), before: existing, requested });
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
                                    icon={<Ionicons
                                        name={account.loggedIn ? 'person-circle-outline' : 'alert-circle-outline'}
                                        size={29}
                                        color={account.loggedIn ? '#007AFF' : '#FF9500'}
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
                                    loading={status.watching && !status.hasLink}
                                    icon={<Ionicons
                                        name={phase.kind === 'added' ? 'checkmark-circle-outline'
                                            : phase.kind === 'failed' ? 'warning-outline' : 'time-outline'}
                                        size={29}
                                        color={phase.kind === 'added' ? '#34C759'
                                            : phase.kind === 'failed' ? '#FF9500' : '#8E8E93'}
                                    />}
                                    // Straight to the card holding the link. It is the existing
                                    // account-login card (DROVE-61) and it is where the code is
                                    // typed; drawing a second copy of it here would be a second
                                    // thing to keep in step with the bus.
                                    onPress={status.hasLink && card
                                        ? () => router.push(`/session/${card.sessionId}` as never)
                                        : phase.kind === 'added' || phase.kind === 'failed' || phase.kind === 'stoppedWatching'
                                            ? () => dispatch(machine.id, { type: 'dismiss' })
                                            : undefined}
                                    detail={status.hasLink ? 'Open card' : undefined}
                                    showChevron={false}
                                />
                            )}

                            <Item
                                title="Add a Claude account"
                                subtitle="Signs in on this machine. You finish the login in a browser."
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
