import * as React from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { ScopedTheme, StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ChatListInternal } from '@/components/ChatList';
import { useTickingNow } from '@/components/useTickingNow';
import { Typography } from '@/constants/Typography';
import { useSession, useSessionMessages, useSocketStatus } from '@/sync/storage';
import {
    clearSubagentMessages,
    publishSubagentMessages,
    SubagentScopeContext,
} from '@/sync/subagentMessages';
import {
    describeSubagent,
    findSubagentRun,
} from '@/sync/subagentTranscript';
import {
    createSubagentPollSnapshot,
    runSubagentTranscriptPoll,
    type SubagentPollSnapshot,
    type SubagentReach,
    type SubagentTrouble,
} from '@/sync/subagentTranscriptPoll';
import { fetchSubagentTranscript } from '@/sync/subagentTranscriptRpc';
import { t } from '@/text';
import { type AgentRunState } from '@/utils/agentCard';
import { formatElapsed, formatTokens } from '@/utils/liveStatus';
import { subagentThemeName, subagentTintPaletteFor } from '@/utils/subagentTint';

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
 *
 * The whole surface carries a light neutral grey wash (DROVE-109, restyled by
 * DROVE-145) so it is obvious at a glance that this is an agent and not the
 * session. The tint is a THEME OVERRIDE, not a fork: <ScopedTheme> swaps in
 * the tinted counterpart of the live theme for this subtree only, so
 * ChatListInternal and every card, tool view and row under it pick it up
 * without a prop, and the session screen is untouched by construction. The
 * pinned footer, not a painted edge rail, is what says Agent once the header
 * has scrolled away.
 */

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
    retryRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
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

/**
 * Off the card's own vocabulary (DROVE-115), so this screen and the inline
 * Agent card say the same word about the same agent. `unknown` is DROVE-132's
 * addition: when nothing readable states the run, the header says it does not
 * know rather than falling back to Running.
 */
function stateWord(state: AgentRunState | 'unknown'): string {
    if (state === 'finished') return t('subagent.done');
    if (state === 'failed') return t('subagent.failed');
    if (state === 'unknown') return t('subagent.stateUnknown');
    return t('subagent.running');
}

/**
 * The user's words for why the screen is empty (DROVE-132). The transport's
 * own sentence, `RPC target disconnected`, names a mechanism nobody outside
 * this repository has heard of and says nothing about what happens next; it
 * stays in the snapshot as `detail` and never reaches the screen.
 */
function troubleLine(trouble: SubagentTrouble): string {
    if (trouble.cause === 'offline') return t('subagent.waitingForNetwork');
    return trouble.cause === 'computer' ? t('subagent.waitingForComputer') : t('subagent.waitingUnknown');
}

export default React.memo(() => {
    const { id: sessionId, agentId, label } = useLocalSearchParams<{ id: string; agentId: string; label?: string }>();
    const { theme, rt } = useUnistyles();
    const styles = stylesheet;
    // Derived from the LIVE theme, outside the scope, so it follows a
    // light/dark switch. The navigator draws the header, which does not sit
    // under <ScopedTheme>, so it takes its colours from the palette directly.
    const tintName = subagentThemeName(rt.themeName);
    const tint = React.useMemo(() => subagentTintPaletteFor(theme), [theme]);
    const session = useSession(sessionId!);
    const { messages: sessionMessages } = useSessionMessages(sessionId!);
    const socket = useSocketStatus();

    const [snapshot, setSnapshot] = React.useState<SubagentPollSnapshot>(() => createSubagentPollSnapshot());

    // Read by the poll loop between renders, so it never closes over a stale
    // connection state when it has to say WHY a fetch failed. Both ends, not
    // just this one: the phone's socket goes to the SERVER, so it is no
    // evidence at all about the Mac (DROVE-211). The session's presence is.
    const reachRef = React.useRef<SubagentReach>({ phoneOnline: undefined, sessionOnline: undefined });
    reachRef.current = {
        phoneOnline: socket.status === 'connected',
        sessionOnline: session ? session.presence === 'online' : undefined,
    };
    // Set while the loop is sleeping between attempts; calling it retries now.
    const wakeRef = React.useRef<(() => void) | null>(null);

    React.useEffect(() => {
        if (!sessionId || !agentId) return;
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

        void runSubagentTranscriptPoll({
            fetch: (since) => fetchSubagentTranscript(sessionId, agentId, since),
            wait,
            reach: () => reachRef.current,
            isCancelled: () => cancelled,
            onSnapshot: (next) => {
                if (!cancelled) setSnapshot(next);
            },
        });

        return () => {
            cancelled = true;
            if (timer) clearTimeout(timer);
            // Let the sleeping loop wake once and see that it is cancelled,
            // rather than leaving a promise pending for the app's life.
            wakeRef.current?.();
        };
    }, [sessionId, agentId]);

    // A Mac that has come back, or a phone that has. Retry at once instead of
    // waiting out the ladder: Clay restarts the CLI on every change, and the
    // whole point of DROVE-132 is that the screen fills in on its own.
    const reachable = socket.status === 'connected' && session?.presence === 'online';
    React.useEffect(() => {
        if (reachable) wakeRef.current?.();
    }, [reachable]);

    const { transcript, agent, trouble, refusal, loaded } = snapshot;

    // These rows are not in the session's message map, so a row that opens
    // has to leave them somewhere the detail screen can read (DROVE-166).
    // Published on every poll, so a card tapped while its command was still
    // running keeps filling in.
    React.useEffect(() => {
        if (!sessionId || !agentId) return;
        publishSubagentMessages(sessionId, agentId, transcript.messagesMap);
    }, [sessionId, agentId, transcript.messagesMap]);
    React.useEffect(() => {
        if (!sessionId || !agentId) return;
        return () => clearSubagentMessages(sessionId, agentId);
    }, [sessionId, agentId]);

    // What the session itself recorded about this run, off DROVE-115's
    // terminal tool-call-end. Stored on the phone, so it is still true while
    // the CLI is down and it is the only reason the header can say `Finished`
    // rather than `unknown` during a restart.
    const known = React.useMemo(
        () => (agentId ? findSubagentRun(sessionMessages, agentId) : null),
        [sessionMessages, agentId],
    );

    const live = agent?.state ? agent.state === 'running' : known?.runState === 'running';
    const now = useTickingNow(!!live);
    const headline = describeSubagent(
        agent?.state ? { state: agent.state, updatedAt: agent.updatedAt ?? 0, endedAt: agent.endedAt } : null,
        transcript,
        now,
        known,
    );
    const title = agent?.label ?? label ?? t('subagent.title');
    const subtitleParts = [stateWord(headline.runState)];
    if (headline.elapsedMs !== undefined) subtitleParts.push(formatElapsed(headline.elapsedMs));
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
        // Nothing to draw yet. Say what is going on in the user's terms, show
        // that it is still trying, and if the session already holds the
        // agent's result show that rather than nothing at all.
        body = (
            <View style={styles.center}>
                <Text style={styles.reason}>{trouble ? troubleLine(trouble) : refusal ?? t('subagent.unavailable')}</Text>
                {trouble ? (
                    <View style={styles.retryRow}>
                        <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                        <Text style={styles.reason}>{t('subagent.retrying')}</Text>
                    </View>
                ) : null}
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
                live={!!live}
                showFooter={false}
            />
        );
    }

    // Stays on screen while the transcript scrolls, so the word "agent" is
    // still there once the header is gone. A transcript already drawn keeps
    // its rows through an outage; the footer is where it admits the rows have
    // stopped arriving.
    const footerLine = trouble ? `${t('subagent.title')} · ${subtitle} · ${t('subagent.retrying')}` : `${t('subagent.title')} · ${subtitle}`;

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
                    headerStyle: { backgroundColor: tint.header },
                    contentStyle: { backgroundColor: tint.ground },
                }}
            />
            <ScopedTheme name={tintName}>
                {/*
                  * Every row under here belongs to the agent, not the session,
                  * so the route it opens has to say so (DROVE-166). A context
                  * rather than a prop, for the same reason the tint is a
                  * scoped theme: the rows are several memoized components down
                  * and none of them should have to carry it.
                  */}
                <SubagentScopeContext.Provider value={agentId ?? null}>
                    <View style={{ flex: 1, backgroundColor: tint.ground }}>
                        {body}
                        {hasRows ? (
                            <View style={styles.footer}>
                                {live || trouble ? <ActivityIndicator size="small" color={theme.colors.textSecondary} /> : null}
                                <Text style={styles.footerText}>{footerLine}</Text>
                            </View>
                        ) : null}
                    </View>
                </SubagentScopeContext.Provider>
            </ScopedTheme>
        </>
    );
});
