import * as React from 'react';
import { ActivityIndicator, Pressable, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { useSessionGates, type DroverGateEntry } from '@/hooks/usePendingGates';
import { sessionAllow, sessionDeny } from '@/sync/ops';
import {
    hasAnswerableOptions,
    providerAnswersFor,
    questionCards,
    toInlineQuestions,
} from '@/components/tools/views/askUserQuestionAnswers';
import {
    InlineQuestionForm,
    type InlineQuestionAnswers,
} from '@/components/tools/views/InlineQuestionForm';

/**
 * The prompt this session is waiting on, presented on this session's own view
 * (BASED-113).
 *
 * Clay: "Whatever the active session I'm in, shouldn't it just, like, boom, pop
 * up on it?" Delivery was never the problem — a gate reaches the phone and is
 * answerable. It just had nowhere to appear except the /gates list or a card
 * somewhere up the transcript, so seeing it meant navigating away from the
 * session you were already watching.
 *
 * This sits above the composer, so it is on screen whatever the scrollback is
 * doing. The transcript still renders its own card for the same request; both
 * call the same ops and the request leaves agentState.requests once either one
 * answers, so the two cannot disagree and there is no second decision path.
 *
 * Scoped to ONE session by useSessionGates. A gate belonging to a different
 * session never reaches this component, so it cannot take over the screen you
 * are on — which matters because driving several sessions at once is the
 * normal case here.
 */
export function SessionGateBanner({ sessionId }: { sessionId: string }) {
    const gates = useSessionGates(sessionId);
    // Oldest first, so the prompt actually holding this session up is the one
    // presented. The rest are a count, not a stack of cards over the composer.
    const entry = gates[0];
    if (!entry) return null;
    return <SessionGateCard entry={entry} waiting={gates.length - 1} />;
}

const SessionGateCard = React.memo(({ entry, waiting }: {
    entry: DroverGateEntry;
    waiting: number;
}) => {
    const { theme } = useUnistyles();
    const router = useRouter();
    const { gate, sessionId, requestId } = entry;
    const [busy, setBusy] = React.useState<'allow' | 'deny' | null>(null);

    const cards = React.useMemo(() => questionCards(entry.args), [entry.args]);
    const questions = React.useMemo(() => toInlineQuestions(cards), [cards]);
    const answerable = gate.kind === 'question' && hasAnswerableOptions(cards);

    const submitAnswer = React.useCallback(async (answers: InlineQuestionAnswers) => {
        await sessionAllow(
            sessionId,
            requestId,
            undefined,
            undefined,
            'approved',
            { answers: providerAnswersFor(cards, answers) },
        );
    }, [cards, requestId, sessionId]);

    // A question has no "no": denying one resolves it for every other surface
    // with no answer to hand back. Allow/Deny is offered for a permission only,
    // the same split the gates list makes.
    const decide = React.useCallback(async (allow: boolean) => {
        if (busy) return;
        setBusy(allow ? 'allow' : 'deny');
        try {
            if (allow) {
                await sessionAllow(sessionId, requestId);
            } else {
                await sessionDeny(sessionId, requestId);
            }
        } catch (error) {
            console.error('Failed to answer gate:', error);
        } finally {
            setBusy(null);
        }
    }, [busy, requestId, sessionId]);

    return (
        <View style={styles.card}>
            <View style={styles.header}>
                <Ionicons
                    name={gate.kind === 'question' ? 'help-circle-outline' : 'lock-closed-outline'}
                    size={18}
                    color={theme.colors.box.warning.text}
                />
                <Text style={styles.title} numberOfLines={1}>{gate.title}</Text>
                {waiting > 0 && (
                    <Pressable
                        onPress={() => router.push('/gates')}
                        hitSlop={8}
                        accessibilityRole="button"
                        accessibilityLabel={`${waiting} more waiting on this session`}
                    >
                        <Text style={styles.more}>+{waiting}</Text>
                    </Pressable>
                )}
            </View>

            {answerable ? (
                <View style={styles.body}>
                    <InlineQuestionForm
                        questions={questions}
                        canInteract={true}
                        onSubmit={submitAnswer}
                    />
                </View>
            ) : (
                <View style={styles.body}>
                    <Text style={styles.preview} numberOfLines={4}>
                        {gate.preview || gate.title}
                    </Text>
                    {gate.kind === 'question' ? (
                        // A question that arrived without its options cannot be
                        // answered here: submitting blind would resolve it for
                        // every other surface with nothing to inject. The
                        // transcript card is the honest place to read it.
                        <Text style={styles.hint}>Scroll up to answer this one.</Text>
                    ) : (
                        <View style={styles.actions}>
                            <TouchableOpacity
                                style={[styles.action, styles.deny]}
                                onPress={() => decide(false)}
                                disabled={busy !== null}
                                activeOpacity={0.7}
                            >
                                {busy === 'deny'
                                    ? <ActivityIndicator size="small" color={theme.colors.text} />
                                    : <Text style={styles.denyText}>Deny</Text>}
                            </TouchableOpacity>
                            <TouchableOpacity
                                style={[styles.action, styles.allow]}
                                onPress={() => decide(true)}
                                disabled={busy !== null}
                                activeOpacity={0.7}
                            >
                                {busy === 'allow'
                                    ? <ActivityIndicator size="small" color={theme.colors.button.primary.tint} />
                                    : <Text style={styles.allowText}>Allow</Text>}
                            </TouchableOpacity>
                        </View>
                    )}
                </View>
            )}
        </View>
    );
});

SessionGateCard.displayName = 'SessionGateCard';

const styles = StyleSheet.create((theme) => ({
    // Same slot and margins as AgentQuestionBanner, which sits beside this one
    // above the composer, so the two never look like different furniture.
    card: {
        marginHorizontal: 12,
        marginBottom: 8,
        borderRadius: 14,
        backgroundColor: theme.colors.surface,
        borderWidth: 1,
        borderColor: theme.colors.box.warning.text,
        overflow: 'hidden',
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 12,
        paddingTop: 10,
    },
    title: {
        ...Typography.default('semiBold'),
        flex: 1,
        fontSize: 14,
        color: theme.colors.text,
    },
    more: {
        ...Typography.default('semiBold'),
        fontSize: 13,
        color: theme.colors.textLink,
    },
    body: {
        paddingHorizontal: 12,
        paddingTop: 8,
        // InlineQuestionForm's ToolSectionView carries its own 12pt bottom
        // margin, so a matching pad here would sit the card lopsided.
        paddingBottom: 4,
    },
    preview: {
        ...Typography.mono(),
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.text,
        marginBottom: 10,
    },
    hint: {
        ...Typography.default(),
        fontSize: 12,
        color: theme.colors.textSecondary,
        marginBottom: 10,
    },
    actions: {
        flexDirection: 'row',
        gap: 8,
        marginBottom: 10,
    },
    action: {
        flex: 1,
        minHeight: 44,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 10,
        borderWidth: 1,
    },
    deny: {
        backgroundColor: 'transparent',
        borderColor: theme.colors.divider,
    },
    denyText: {
        ...Typography.default('semiBold'),
        fontSize: 15,
        color: theme.colors.text,
    },
    allow: {
        backgroundColor: theme.colors.button.primary.background,
        borderColor: theme.colors.button.primary.background,
    },
    allowText: {
        ...Typography.default('semiBold'),
        fontSize: 15,
        color: theme.colors.button.primary.tint,
    },
}));
