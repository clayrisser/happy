/**
 * This session's flip and model-fallback policy (DROVE-3).
 *
 * Clay is not at the terminal when a session runs out — that is the whole
 * reason Cattle Drover exists — so the phone is where the policy has to be
 * settable. DROVE-4 put the store behind the bus on the Mac and gave it an HTTP
 * surface; this screen is the other end of it.
 *
 * The phone never reaches the store. Every read arrives stamped on
 * `metadata.droverPolicy` by the CLI, and every write goes back out as the
 * `drover-policy` session RPC, which the CLI forwards to the bus keyed by the
 * CLAUDE session id. That keying is what makes a change typed in the terminal
 * and a tap here land on the same row rather than two rows that never meet.
 *
 * A write does NOT wait for the next poll: the RPC answers with the state
 * after the write and re-stamps at once, so the row moves when you tap it. It
 * is still the machine's answer, not an optimistic local one — a refusal from
 * the bus (an unknown key, a value outside its enum) shows as the bus's own
 * sentence.
 */

import * as React from 'react';
import { Platform, Text, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { DroverPolicyGroups } from '@/components/DroverPolicyGroups';
import { MOBILE_GLASS_HEADER_HEIGHT } from '@/components/navigation/headerMetrics';
import { Typography } from '@/constants/Typography';
import { useSession } from '@/sync/storage';
import { sessionDroverPolicy, type PolicyKey, type PolicyPatch } from '@/sync/droverPolicy';

export default function SessionPolicyScreen() {
    const { id } = useLocalSearchParams<{ id: string }>();
    const router = useRouter();
    const session = useSession(id);
    const { theme } = useUnistyles();

    // The stamped snapshot is the source of truth. `pending` holds only what a
    // write returned, so a tap shows immediately without the screen ever
    // inventing a value the machine has not confirmed — the metadata catches up
    // on the CLI's re-stamp a moment later and takes over again.
    const stamped = session?.metadata?.droverPolicy;
    const [pending, setPending] = React.useState<typeof stamped>(undefined);
    const [busyKey, setBusyKey] = React.useState<PolicyKey | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const stampedAt = stamped?.capturedAt ?? 0;
    const pendingAt = pending?.capturedAt ?? 0;
    const policy = pendingAt > stampedAt ? pending : stamped;

    const write = React.useCallback(async (patch: PolicyPatch) => {
        if (!id) return;
        const key = Object.keys(patch)[0] as PolicyKey | undefined;
        setBusyKey(key ?? null);
        setError(null);
        const result = await sessionDroverPolicy(id, {
            scope: 'session',
            action: 'set',
            patch,
            by: 'phone',
        });
        setBusyKey(null);
        if (result.policy) setPending(result.policy);
        if (!result.ok) setError(result.error ?? 'the change was refused');
    }, [id]);

    const clear = React.useCallback(async () => {
        if (!id) return;
        setBusyKey(null);
        setError(null);
        const result = await sessionDroverPolicy(id, { scope: 'session', action: 'clear', by: 'phone' });
        if (result.policy) setPending(result.policy);
        if (!result.ok) setError(result.error ?? 'the change was refused');
    }, [id]);

    if (!session) {
        return (
            <>
                <Stack.Screen options={{ title: 'Account switching' }} />
                <ItemList>
                    <ItemGroup>
                        <Item title="Session not found" showChevron={false} />
                    </ItemGroup>
                </ItemList>
            </>
        );
    }

    const customised = policy?.overrides ? Object.keys(policy.overrides).length > 0 : false;

    return (
        <>
            <Stack.Screen options={{ title: 'Account switching' }} />
            <ItemList
                containerStyle={{ paddingTop: Platform.OS === 'ios' ? MOBILE_GLASS_HEADER_HEIGHT : 0 }}
            >
                {/* A session with no drover install has no policy to set, and
                    saying that is better than showing controls that write into
                    nothing. */}
                {!policy && (
                    <ItemGroup title="Account switching">
                        <Item
                            title="Nothing reported yet"
                            subtitle="no policy sent yet"
                            showChevron={false}
                        />
                    </ItemGroup>
                )}

                {error && (
                    <ItemGroup>
                        <Item
                            title="The machine refused that"
                            subtitle={error}
                            subtitleLines={0}
                            icon={<Ionicons name="warning-outline" size={29} color="#FF9500" />}
                            showChevron={false}
                        />
                    </ItemGroup>
                )}

                {policy && (
                    <DroverPolicyGroups
                        policy={policy}
                        scope="session"
                        busyKey={busyKey}
                        onChange={write}
                    />
                )}

                {policy && !policy.unavailable && (
                    <ItemGroup>
                        <Item
                            title="Back to the defaults"
                            subtitle={customised
                                ? 'Drops every override on this session.'
                                : 'This session has no overrides — it already follows the defaults.'}
                            subtitleLines={0}
                            disabled={!customised}
                            destructive={customised}
                            showChevron={false}
                            onPress={clear}
                        />
                        <Item
                            title="Defaults for new sessions"
                            subtitle="what every session starts with"
                            icon={<Ionicons name="options-outline" size={29} color="#5AC8FA" />}
                            onPress={() => router.push(session.metadata?.machineId
                                ? `/settings/flip-policy?machineId=${session.metadata.machineId}`
                                : '/settings/flip-policy')}
                        />
                    </ItemGroup>
                )}

                {policy?.sessionId && (
                    <View style={{ paddingHorizontal: 16, paddingBottom: 24 }}>
                        <Text style={{ fontSize: 12, color: theme.colors.textSecondary, ...Typography.default() }}>
                            {`Stored against Claude session ${policy.sessionId.substring(0, 8)} — the same key drover settings uses in the terminal.`}
                        </Text>
                    </View>
                )}
            </ItemList>
        </>
    );
}
