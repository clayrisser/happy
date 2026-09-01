/**
 * The flip policy every NEW session starts with, per machine (DROVE-3).
 *
 * "A reasonable default set at the app level, overridable per session, is the
 * shape to aim for — Clay should not have to configure every session by hand."
 * So this screen writes the machine layer of the store, and the per-session
 * screen writes the layer above it; the bus merges session over machine over
 * built-in, and a session that has set its own keeps it.
 *
 * Addressed to the DAEMON, not to a session, because the case this exists for
 * is setting the default while nothing is running — it is what the next session
 * picks up. The daemon carries the same `drover-policy` handler for exactly
 * that reason.
 *
 * Per machine, and it says which. The store is a file on one Mac; calling it
 * "the app default" and hiding the machine would be a lie the moment Clay has
 * two.
 */

import * as React from 'react';
import { Platform } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { DroverPolicyGroups } from '@/components/DroverPolicyGroups';
import { MOBILE_GLASS_HEADER_HEIGHT } from '@/components/navigation/headerMetrics';
import { useAllMachines } from '@/sync/storage';
import { machineDroverPolicy, type PolicyKey, type PolicyPatch } from '@/sync/droverPolicy';
import type { DroverPolicy } from '@/sync/storageTypes';

export default function FlipPolicyDefaultsScreen() {
    const params = useLocalSearchParams<{ machineId?: string }>();
    const machines = useAllMachines({ includeOffline: true });
    // The machine named by whoever pushed us here, else the only one there is.
    // With several and no hint, a picker rather than a guess: writing the
    // default onto the wrong Mac is silent and would not be noticed until a
    // session behaved unexpectedly weeks later.
    const [chosen, setChosen] = React.useState<string | null>(params.machineId ?? null);
    const machineId = chosen ?? (machines.length === 1 ? machines[0].id : null);

    const [policy, setPolicy] = React.useState<DroverPolicy | undefined>(undefined);
    const [busyKey, setBusyKey] = React.useState<PolicyKey | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const [loading, setLoading] = React.useState(false);

    // Read on open and on every machine change. There is no stamp to read from
    // here — a machine record carries no policy — so the daemon is asked
    // directly, which is also the only way this works with no session running.
    React.useEffect(() => {
        if (!machineId) return;
        let cancelled = false;
        setLoading(true);
        void machineDroverPolicy(machineId, { scope: 'defaults', action: 'get' }).then((result) => {
            if (cancelled) return;
            setLoading(false);
            if (result.policy) setPolicy(result.policy);
            if (!result.ok) setError(result.error ?? 'the machine did not answer');
            else setError(null);
        });
        return () => { cancelled = true; };
    }, [machineId]);

    const write = React.useCallback(async (patch: PolicyPatch) => {
        if (!machineId) return;
        const key = Object.keys(patch)[0] as PolicyKey | undefined;
        setBusyKey(key ?? null);
        setError(null);
        const result = await machineDroverPolicy(machineId, {
            scope: 'defaults',
            action: 'set',
            patch,
            by: 'phone',
        });
        setBusyKey(null);
        if (result.policy) setPolicy(result.policy);
        if (!result.ok) setError(result.error ?? 'the change was refused');
    }, [machineId]);

    if (!machineId) {
        return (
            <>
                <Stack.Screen options={{ title: 'Account switching defaults' }} />
                <ItemList containerStyle={{ paddingTop: Platform.OS === 'ios' ? MOBILE_GLASS_HEADER_HEIGHT : 0 }}>
                    <ItemGroup
                        title="Which machine"
                        footer="The policy lives on that Mac."
                    >
                        {machines.length === 0 ? (
                            <Item title="No machines connected" showChevron={false} />
                        ) : machines.map((machine) => (
                            <Item
                                key={machine.id}
                                title={machine.metadata?.displayName || machine.metadata?.host || machine.id.substring(0, 8)}
                                subtitle={machine.active ? 'online' : 'offline'}
                                onPress={() => setChosen(machine.id)}
                            />
                        ))}
                    </ItemGroup>
                </ItemList>
            </>
        );
    }

    return (
        <>
            <Stack.Screen options={{ title: 'Account switching defaults' }} />
            <ItemList containerStyle={{ paddingTop: Platform.OS === 'ios' ? MOBILE_GLASS_HEADER_HEIGHT : 0 }}>
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

                {loading && !policy && (
                    <ItemGroup>
                        <Item title="Reading the machine…" showChevron={false} loading />
                    </ItemGroup>
                )}

                {policy && (
                    <DroverPolicyGroups
                        policy={policy}
                        scope="defaults"
                        busyKey={busyKey}
                        onChange={write}
                    />
                )}
            </ItemList>
        </>
    );
}
