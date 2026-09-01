import * as React from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';

import type { WorkflowDetailResponse, WorkflowWave, WorkflowWaveAgent } from '@slopus/happy-wire';
import { WORKFLOW_UNATTRIBUTED_INDEX } from '@slopus/happy-wire';

import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useTickingNow } from '@/components/useTickingNow';
import { Typography } from '@/constants/Typography';
import { fetchWorkflowDetail } from '@/sync/workflowDetailRpc';
import { t } from '@/text';
import { formatElapsed } from '@/utils/liveStatus';

/**
 * The wave view of one workflow run (DROVE-290).
 *
 * Clay, with the terminal's /workflows panel beside his phone: "in the mobile
 * app how do I see all of my waves?" The terminal drew the run as phases —
 * Wave0 3/3, Wave1 16/16, Wave2 0/8 — while the phone drew one line, and the
 * line could not say WHERE its 22 failures clustered. This screen is the
 * phases list: every wave with its counts, the current one marked, and a
 * tapped wave opening into its agents, failures first, each tappable through
 * to the agent's own transcript (DROVE-93).
 *
 * The counts frame always travels; a wave's agent rows travel only for the
 * wave that is open, and the CLI bounds the whole answer (DROVE-211's socket
 * close, DROVE-274's 64 KiB pipe), so a 60-agent run never rides one frame.
 *
 * WAVE ATTRIBUTION IS THE HARNESS'S, never guessed. While a first run is
 * live, its agents sit under "Awaiting wave" — the run record that maps
 * agents to phases is written when a run ends or is killed, and Clay's long
 * runs are kill-resume chains, so the previous kill attributes most of what
 * this screen shows mid-run. The footnote under that section says exactly
 * this.
 */

const POLL_MS = 2500;
const POLL_TROUBLE_MS = 5000;

function countsLine(wave: WorkflowWave): string {
    const parts: string[] = [];
    if (wave.running > 0) parts.push(`${wave.running} ${t('workflowWaves.running')}`);
    if (wave.queued > 0) parts.push(`${wave.queued} ${t('workflowWaves.queued')}`);
    if (wave.done > 0) parts.push(`${wave.done} ${t('workflowWaves.done')}`);
    if (wave.failed > 0) parts.push(`${wave.failed} ${t('workflowWaves.failed')}`);
    if (wave.quiet > 0) parts.push(`${wave.quiet} ${t('workflowWaves.quiet')}`);
    if (parts.length === 0) return t('workflowWaves.notStarted');
    return parts.join(' · ');
}

function agentStateWord(state: WorkflowWaveAgent['state']): string {
    switch (state) {
        case 'done': return t('workflowWaves.done');
        case 'failed': return t('workflowWaves.failed');
        case 'running': return t('workflowWaves.running');
        case 'queued': return t('workflowWaves.queued');
        default: return t('workflowWaves.quiet');
    }
}

export default React.memo(() => {
    const { id: sessionId, runId, name } = useLocalSearchParams<{ id: string; runId: string; name?: string }>();
    const { theme } = useUnistyles();
    const router = useRouter();

    const [detail, setDetail] = React.useState<WorkflowDetailResponse | null>(null);
    // The open wave, whose agents ride the poll. Null is counts only.
    const [selected, setSelected] = React.useState<number | null>(null);
    const selectedRef = React.useRef<number | null>(null);
    selectedRef.current = selected;
    const wakeRef = React.useRef<(() => void) | null>(null);

    React.useEffect(() => {
        if (!sessionId || !runId) return;
        let cancelled = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const wait = (ms: number) => new Promise<void>((resolve) => {
            let settled = false;
            const finish = () => {
                if (settled) return;
                settled = true;
                wakeRef.current = null;
                if (timer) {
                    clearTimeout(timer);
                    timer = null;
                }
                resolve();
            };
            wakeRef.current = finish;
            timer = setTimeout(finish, ms);
        });
        void (async () => {
            while (!cancelled) {
                let delay = POLL_MS;
                try {
                    const next = await fetchWorkflowDetail(sessionId, runId, selectedRef.current ?? undefined);
                    if (cancelled) return;
                    setDetail(next);
                } catch {
                    // The Mac is restarting or out of reach; keep the last
                    // frame on screen and retry on the slower cadence.
                    delay = POLL_TROUBLE_MS;
                }
                await wait(delay);
            }
        })();
        return () => {
            cancelled = true;
            if (timer) clearTimeout(timer);
            wakeRef.current?.();
        };
    }, [sessionId, runId]);

    const anyRunning = detail?.ok === true
        && detail.waves.some((wave) => wave.running > 0 || (wave.agents ?? []).some((agent) => agent.state === 'running'));
    const now = useTickingNow(!!anyRunning);

    const openWave = React.useCallback((index: number) => {
        setSelected((current) => (current === index ? null : index));
        // Refetch at once so the agents appear on the tap, not on the tick.
        wakeRef.current?.();
    }, []);

    const openAgent = React.useCallback((agent: WorkflowWaveAgent) => {
        if (!agent.id) return;
        router.push({
            pathname: '/session/[id]/agent/[agentId]',
            params: { id: sessionId!, agentId: agent.id, label: agent.label },
        });
    }, [router, sessionId]);

    const title = (detail?.ok ? detail.name : undefined) ?? name ?? t('workflowWaves.title');

    let body: React.ReactNode;
    if (!detail) {
        body = (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, padding: 24 }}>
                <ActivityIndicator />
                <Text style={{ color: theme.colors.textSecondary, fontSize: 14, ...Typography.default() }}>
                    {t('workflowWaves.loading')}
                </Text>
            </View>
        );
    } else if (!detail.ok) {
        body = (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
                <Text style={{ color: theme.colors.textSecondary, fontSize: 14, textAlign: 'center', ...Typography.default() }}>
                    {t('workflowWaves.unavailable')}
                </Text>
            </View>
        );
    } else {
        const waves = detail.waves;
        body = (
            <ItemList>
                {waves.map((wave) => {
                    const isUnattributed = wave.index === WORKFLOW_UNATTRIBUTED_INDEX;
                    const open = selected === wave.index;
                    const waveTitle = isUnattributed ? t('workflowWaves.unattributed') : wave.title;
                    return (
                        <ItemGroup
                            key={`wave-${wave.index}`}
                            footer={isUnattributed && detail.source === 'journal'
                                ? t('workflowWaves.unattributedFootnote')
                                : undefined}
                        >
                            <Item
                                title={wave.current ? `${waveTitle} · ${t('workflowWaves.current')}` : waveTitle}
                                subtitle={countsLine(wave)}
                                subtitleStyle={wave.failed > 0 ? { color: theme.colors.textDestructive } : undefined}
                                onPress={() => openWave(wave.index)}
                                showChevron={false}
                                rightElement={
                                    <Text style={{ color: theme.colors.textSecondary, fontSize: 13, ...Typography.mono() }}>
                                        {open ? '▾' : '▸'}
                                    </Text>
                                }
                            />
                            {open && wave.agents ? wave.agents.map((agent, position) => {
                                const elapsed = agent.state === 'running' && agent.startedAt
                                    ? formatElapsed(now - agent.startedAt)
                                    : agent.endedAt && agent.startedAt
                                        ? formatElapsed(agent.endedAt - agent.startedAt)
                                        : undefined;
                                const bits = [agentStateWord(agent.state)];
                                if (elapsed) bits.push(elapsed);
                                return (
                                    <Item
                                        key={`agent-${wave.index}-${agent.id || position}`}
                                        title={agent.label}
                                        subtitle={bits.join(' · ')}
                                        subtitleStyle={agent.state === 'failed' ? { color: theme.colors.textDestructive } : undefined}
                                        onPress={agent.id ? () => openAgent(agent) : undefined}
                                        showChevron={!!agent.id}
                                    />
                                );
                            }) : null}
                            {open && wave.elided ? (
                                <Item
                                    title={t('workflowWaves.agentsElided', { count: wave.elided })}
                                    disabled
                                />
                            ) : null}
                        </ItemGroup>
                    );
                })}
            </ItemList>
        );
    }

    return (
        <>
            <Stack.Screen
                options={{
                    title,
                    ...(detail?.ok && detail.status ? { headerBackTitle: undefined } : {}),
                }}
            />
            {body}
        </>
    );
});
