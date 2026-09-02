/**
 * One MCP server, tapped (DROVE-291).
 *
 * DROVE-274 put forty server names on the machine page and its blue dots meant
 * nothing. Clay, holding it: "Shouldn't I be able to click on these and
 * reconnect authenticate etc…". This is what a row opens.
 *
 * THREE THINGS, IN VALUE ORDER, and the order is the ticket's:
 *
 *   1. What the machine saw, and WHEN it saw it. The timestamp is not a detail
 *      here, it is half the fact — an MCP connection belongs to a SESSION, so
 *      "connected" always means "when the machine last asked", never "now".
 *      Two of the five harnesses answer for all forty servers at once and their
 *      reading can be a minute old; the line under the state says so.
 *   2. Reconnect, with the sentence that stops a green tick meaning more than
 *      it does: a session already running keeps its own connection until it
 *      restarts.
 *   3. Re-authenticate, and ONLY where the server has an auth flow to re-run. A
 *      stdio subprocess does not, and the row says why rather than vanishing —
 *      a missing button is a question, a disabled one with a reason is an
 *      answer.
 *
 * NO CREDENTIAL, EVER, AND NOT EVEN A FIELD FOR ONE (DROVE-304, DROVE-318).
 * Re-authenticate opens the harness's own sign-in in a named tmux window on the
 * Mac and hands back the window's NAME. The browser step is Clay's, on his own
 * machine. This sheet has no text input, no clipboard write and no storage,
 * because there is nothing here to hold.
 *
 * ONE FRAGMENT PER LINE (DROVE-346). Every sentence rendered comes from the
 * machine or from sources/sync/mcpText.ts, and none of them is a paragraph.
 */

import * as React from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ComposerSheet } from '@/components/ComposerSheet';
import type { McpHealth, McpServerSummary } from '@slopus/happy-wire';
import {
    machineMcpHealth,
    machineMcpReauth,
    machineMcpReconnect,
} from '@/sync/machineMcpHealth';
import { mcpHealthTitle, mcpHealthTone, mcpObservedAgo } from '@/sync/mcpText';

/** iOS systemGreen / systemOrange / systemGrey, beside the blue this screen uses. */
const green = '#34C759';
const amber = '#FF9500';
const grey = '#8E8E93';
const blue = '#007AFF';

export interface McpServerSheetProps {
    machineId: string;
    harness: string;
    /** The harness's own label, so the header reads "Claude Code" not "claude". */
    harnessLabel: string;
    server: McpServerSummary;
    /** Injected by the modal infra. */
    onClose?: () => void;
    /** Injectable so the clock is not a reason a test flakes. */
    now?: number;
}

type Busy = null | 'loading' | 'reconnecting' | 'reauthing';

/** The colour a state gets, from the judgement mcpText owns. */
function toneColor(state: McpHealth['state']): string {
    const tone = mcpHealthTone(state);
    if (tone === 'ok') return green;
    if (tone === 'warn') return amber;
    return grey;
}

export const McpServerSheet = React.memo(function McpServerSheet(props: McpServerSheetProps) {
    const { machineId, harness, harnessLabel, server, onClose, now } = props;
    const { theme } = useUnistyles();

    const [health, setHealth] = React.useState<McpHealth | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const [busy, setBusy] = React.useState<Busy>('loading');
    /**
     * The last thing an action said, kept separately from `error` because the
     * two are different: a failed reconnect on a server that is genuinely down
     * is a SUCCESSFUL action reporting bad news, and showing it as an error
     * would make a broken server look like a broken button.
     */
    const [outcome, setOutcome] = React.useState<string | null>(null);

    const ref = React.useMemo(() => ({ harness, server: server.name }), [harness, server.name]);

    const load = React.useCallback(async () => {
        setBusy('loading');
        setError(null);
        const result = await machineMcpHealth(machineId, ref);
        if (result.ok) {
            setHealth(result.health);
            setError(null);
        } else {
            setError(result.error);
        }
        setBusy(null);
    }, [machineId, ref]);

    React.useEffect(() => {
        void load();
    }, [load]);

    const onReconnect = React.useCallback(async () => {
        setBusy('reconnecting');
        setOutcome(null);
        const done = await machineMcpReconnect(machineId, ref);
        // The machine's own sentence, whichever way it went. Nothing is
        // rewritten here: `says` already carries what it found and `note`
        // already carries what it did not do.
        setOutcome(done.ok ? (done.says ?? done.did ?? 'Asked the machine') : (done.error ?? 'The machine refused'));
        setBusy(null);
        // Re-read, because the reconnect took a fresh reading and the panel
        // above should be showing it rather than the one from before the tap.
        if (done.ok) await load();
    }, [machineId, ref, load]);

    const onReauth = React.useCallback(async () => {
        setBusy('reauthing');
        setOutcome(null);
        const started = await machineMcpReauth(machineId, ref);
        // `says` is already "Watch it in tmux: <session>:<window>". That IS the
        // answer — there is no code to show and nothing to copy.
        setOutcome(started.ok ? (started.says ?? started.window ?? 'Opened') : (started.error ?? 'The machine refused'));
        setBusy(null);
    }, [machineId, ref]);

    const state = health?.state ?? 'unknown';
    const stateColor = toneColor(state);
    const reconnect = health?.reconnect;
    const reauth = health?.reauth;

    return (
        <ComposerSheet open onClose={() => onClose?.()}>
            <View style={{ paddingBottom: 12 }}>
                <View style={{ paddingHorizontal: 16, paddingTop: 4, paddingBottom: 8 }}>
                    <Text style={{ color: theme.colors.text, fontSize: 20, fontWeight: '600' }}>
                        {server.name}
                    </Text>
                    <Text style={{ color: theme.colors.textSecondary, fontSize: 13, marginTop: 2 }}>
                        {`${harnessLabel} · ${server.transport}${server.enabled ? '' : ' · disabled'}`}
                    </Text>
                </View>

                {busy === 'loading' && !health && (
                    <View style={{ paddingVertical: 24, alignItems: 'center' }}>
                        <ActivityIndicator />
                    </View>
                )}

                {error && (
                    <ItemGroup>
                        <Item
                            title="The machine did not answer"
                            subtitle={error}
                            subtitleLines={0}
                            icon={<Ionicons name="cloud-offline-outline" size={29} color={amber} />}
                            showChevron={false}
                        />
                        <Item
                            title="Try again"
                            icon={<Ionicons name="refresh-outline" size={29} color={blue} />}
                            onPress={() => void load()}
                        />
                    </ItemGroup>
                )}

                {health && (
                    <>
                        {/*
                          * WHAT, then WHEN, and they are two rows because they
                          * are two facts. A single line reading "Connected"
                          * would be the one sentence this feature may not say.
                          */}
                        <ItemGroup title="Health">
                            <Item
                                title={mcpHealthTitle(state)}
                                subtitle={health.says}
                                subtitleLines={0}
                                icon={<Ionicons
                                    name={state === 'connected' ? 'ellipse' : 'ellipse-outline'}
                                    size={13}
                                    color={stateColor}
                                    style={{ width: 29, textAlign: 'center' }}
                                />}
                                showChevron={false}
                            />
                            <Item
                                title={mcpObservedAgo(health.observedAt, now)}
                                subtitle="An MCP server belongs to a session — this is a reading, not a live light"
                                subtitleLines={0}
                                icon={<Ionicons name="time-outline" size={29} color={grey} />}
                                showChevron={false}
                            />
                            {health.lastError?.text && (
                                <Item
                                    title="Last error a session logged"
                                    subtitle={health.lastError.text}
                                    subtitleLines={0}
                                    icon={<Ionicons name="alert-circle-outline" size={29} color={amber} />}
                                    showChevron={false}
                                />
                            )}
                            {!health.lastError && health.lastSeen !== null && (
                                <Item
                                    title="No error in the last session log"
                                    subtitle={health.observedFrom ?? undefined}
                                    subtitleLines={0}
                                    icon={<Ionicons name="document-text-outline" size={29} color={grey} />}
                                    showChevron={false}
                                />
                            )}
                        </ItemGroup>

                        <ItemGroup title="Actions" footer={outcome ?? undefined}>
                            {/*
                              * Both rows are ALWAYS drawn, available or not. A
                              * hidden button is a question ("why is this one
                              * different?"); a dimmed one carrying the reason
                              * is the answer. Codex has no verb that opens a
                              * connection and a stdio server has no OAuth flow,
                              * and both of those are worth reading once.
                              */}
                            <Item
                                title="Reconnect"
                                subtitle={reconnect?.says}
                                subtitleLines={0}
                                icon={<Ionicons
                                    name="refresh-circle-outline"
                                    size={29}
                                    color={reconnect?.available ? blue : grey}
                                />}
                                onPress={reconnect?.available && !busy ? () => void onReconnect() : undefined}
                                showChevron={false}
                                rightElement={busy === 'reconnecting' ? <ActivityIndicator /> : undefined}
                            />
                            <Item
                                title="Re-authenticate"
                                subtitle={reauth?.says}
                                subtitleLines={0}
                                icon={<Ionicons
                                    name="key-outline"
                                    size={29}
                                    color={reauth?.available ? blue : grey}
                                />}
                                onPress={reauth?.available && !busy ? () => void onReauth() : undefined}
                                showChevron={false}
                                rightElement={busy === 'reauthing' ? <ActivityIndicator /> : undefined}
                            />
                        </ItemGroup>
                    </>
                )}
            </View>
        </ComposerSheet>
    );
});
