import * as React from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ChatListInternal } from '@/components/ChatList';
import { useTickingNow } from '@/components/useTickingNow';
import { Typography } from '@/constants/Typography';
import { useSession } from '@/sync/storage';
import {
    applySubagentTranscriptRows,
    createSubagentTranscriptState,
    describeSubagent,
    type SubagentTranscriptAgent,
    type SubagentTranscriptState,
} from '@/sync/subagentTranscript';
import { fetchSubagentTranscript } from '@/sync/subagentTranscriptRpc';
import { t } from '@/text';
import { formatElapsed, formatTokens } from '@/utils/liveStatus';

/**
 * A subagent's own transcript (DROVE-93).
 *
 * Reached from an agent row in the status row's task tree. The header carries
 * the agent's name and, under it, its state, its clock and its token count;
 * the body is the prompt as a user turn followed by everything the agent did,
 * drawn with the same cards the session uses, and its final text at the
 * bottom. While the agent runs the CLI is polled every two seconds with the
 * cursor it handed back, so only new rows travel. Once it stops the screen
 * stays as it is, readable for as long as the session lives.
 */

const POLL_MS = 2_000;

const stylesheet = StyleSheet.create((theme) => ({
    center: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        gap: 8,
    },
    reason: {
        color: theme.colors.textSecondary,
        fontSize: 14,
        textAlign: 'center',
        ...Typography.default(),
    },
    resultBox: {
        marginTop: 12,
        padding: 12,
        borderRadius: 10,
        backgroundColor: theme.colors.surface,
        alignSelf: 'stretch',
    },
    resultLabel: {
        color: theme.colors.textSecondary,
        fontSize: 11,
        marginBottom: 4,
        ...Typography.default('semiBold'),
    },
    resultText: {
        color: theme.colors.text,
        fontSize: 14,
        lineHeight: 20,
        ...Typography.default(),
    },
    headerTitle: {
        color: theme.colors.header.tint,
        fontSize: 16,
        ...Typography.default('semiBold'),
    },
    headerSubtitle: {
        color: theme.colors.header.tint,
        opacity: 0.7,
        fontSize: 12,
        ...Typography.mono(),
    },
    footer: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        paddingVertical: 8,
        paddingHorizontal: 16,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
    },
    footerText: {
        color: theme.colors.textSecondary,
        fontSize: 12,
        ...Typography.mono(),
    },
}));

function stateWord(state: 'running' | 'done' | 'failed'): string {
    if (state === 'done') return t('subagent.done');
    if (state === 'failed') return t('subagent.failed');
    return t('subagent.running');
}

export default React.memo(() => {
    const { id: sessionId, agentId, label } = useLocalSearchParams<{ id: string; agentId: string; label?: string }>();
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const session = useSession(sessionId!);

    const [transcript, setTranscript] = React.useState<SubagentTranscriptState>(() => createSubagentTranscriptState());
    const [agent, setAgent] = React.useState<Partial<SubagentTranscriptAgent> | null>(null);
    const [reason, setReason] = React.useState<string | null>(null);
    const [loaded, setLoaded] = React.useState(false);

    // The cursor lives in a ref as well as in state: the poll loop reads it
    // between renders and must never re-fetch from the top because a render
    // has not landed yet.
    const cursorRef = React.useRef(0);
    const transcriptRef = React.useRef(transcript);
    transcriptRef.current = transcript;

    React.useEffect(() => {
        if (!sessionId || !agentId) return;
        let cancelled = false;
        let timer: ReturnType<typeof setTimeout> | null = null;

        const poll = async () => {
            let running = true;
            try {
                const response = await fetchSubagentTranscript(sessionId, agentId, cursorRef.current);
                if (cancelled) return;
                if (response.ok) {
                    if (response.rows.length > 0 || response.cursor !== cursorRef.current) {
                        const next = applySubagentTranscriptRows(transcriptRef.current, response.rows, response.cursor);
                        cursorRef.current = response.cursor;
                        setTranscript(next);
                    }
                    setAgent(response.agent);
                    setReason(null);
                    running = response.agent.state === 'running';
                } else {
                    setReason(response.reason);
                    if (response.agent) setAgent(response.agent);
                    running = response.agent?.state === 'running' || response.agent?.state === undefined;
                }
            } catch (error) {
                if (cancelled) return;
                // A dropped socket, a CLI that is mid-restart. Keep asking;
                // the reason clears on the next answer.
                setReason(error instanceof Error ? error.message : t('subagent.unavailable'));
            } finally {
                if (!cancelled) {
                    setLoaded(true);
                    if (running) timer = setTimeout(poll, POLL_MS);
                }
            }
        };
        void poll();

        return () => {
            cancelled = true;
            if (timer) clearTimeout(timer);
        };
    }, [sessionId, agentId]);

    const state = agent?.state ?? 'running';
    const now = useTickingNow(state === 'running');
    const headline = describeSubagent(
        agent ? { state, updatedAt: agent.updatedAt ?? 0, endedAt: agent.endedAt } : null,
        transcript,
        now,
    );
    const title = agent?.label ?? label ?? t('subagent.title');
    const subtitleParts = [stateWord(headline.state), formatElapsed(headline.elapsedMs)];
    if (headline.tokens > 0) subtitleParts.push(formatTokens(headline.tokens));
    if (headline.quietMs !== undefined) subtitleParts.push(t('subagent.quiet', { duration: formatElapsed(headline.quietMs) }));
    const subtitle = subtitleParts.join(' · ');

    const hasRows = transcript.messages.length > 0;

    let body: React.ReactNode;
    if (!loaded) {
        body = (
            <View style={styles.center}>
                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                <Text style={styles.reason}>{t('subagent.loading')}</Text>
            </View>
        );
    } else if (!hasRows) {
        // Nothing to draw: say why in one line, and if the parent already
        // holds the result, show that rather than nothing at all.
        body = (
            <View style={styles.center}>
                <Text style={styles.reason}>{reason ?? t('subagent.unavailable')}</Text>
                {agent?.result ? (
                    <View style={styles.resultBox}>
                        <Text style={styles.resultLabel}>{t('subagent.result')}</Text>
                        <Text style={styles.resultText}>{agent.result}</Text>
                    </View>
                ) : null}
            </View>
        );
    } else {
        body = (
            <ChatListInternal
                metadata={session?.metadata ?? null}
                sessionId={sessionId!}
                messages={transcript.messages}
                hasMoreOlder={false}
                isLoadingOlder={false}
                live={state === 'running'}
                showFooter={false}
            />
        );
    }

    return (
        <>
            <Stack.Screen
                options={{
                    headerTitle: () => (
                        <View style={{ alignItems: 'center', maxWidth: 260 }}>
                            <Text numberOfLines={1} style={styles.headerTitle}>{title}</Text>
                            <Text numberOfLines={1} style={styles.headerSubtitle}>{subtitle}</Text>
                        </View>
                    ),
                    headerTintColor: theme.colors.header.tint,
                    headerShadowVisible: false,
                }}
            />
            <View style={{ flex: 1 }}>
                {body}
                {hasRows ? (
                    <View style={styles.footer}>
                        {state === 'running' ? <ActivityIndicator size="small" color={theme.colors.textSecondary} /> : null}
                        <Text style={styles.footerText}>
                            {reason && state === 'running' ? `${subtitle} · ${reason}` : subtitle}
                        </Text>
                    </View>
                ) : null}
            </View>
        </>
    );
});
