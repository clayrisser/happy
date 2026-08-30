import * as React from 'react';
import { ActivityIndicator, Platform, Pressable, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ItemList } from '@/components/ItemList';
import { layout } from '@/components/layout';
import { MOBILE_GLASS_HEADER_HEIGHT } from '@/components/navigation/headerMetrics';
import { Typography } from '@/constants/Typography';
import { usePendingGates, type DroverGateEntry } from '@/hooks/usePendingGates';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
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
 * Every pending gate, from every session, in one place (BASED-98).
 *
 * The wrist has had this list since the watch shipped — GateListView reads the
 * snapshot the feed publishes. The phone never did: a request rendered only
 * inside its own session's transcript, so answering one meant knowing which
 * session to open. This screen is the phone's GateListView.
 *
 * It answers through sessionAllow / sessionDeny, the same ops the transcript's
 * own buttons call, and builds a question's payload with the same helper the
 * transcript card uses. There is no second decision path here, only a second
 * way in.
 */
export default function GatesScreen() {
    const gates = usePendingGates();
    // The header is transparent glass on iOS, so the first card would sit under
    // it. Same inset the settings screen applies for the same header.
    const topContentInset = Platform.OS === 'ios' ? MOBILE_GLASS_HEADER_HEIGHT : 0;

    if (gates.length === 0) {
        return <EmptyGates topContentInset={topContentInset} />;
    }

    return (
        <ItemList
            style={{ paddingTop: 0 }}
            containerStyle={{ paddingTop: topContentInset }}
        >
            <View style={styles.list}>
                {gates.map((entry) => (
                    <GateCard key={entry.gate.id} entry={entry} />
                ))}
            </View>
        </ItemList>
    );
}

function EmptyGates({ topContentInset }: { topContentInset: number }) {
    const { theme } = useUnistyles();
    return (
        <View style={[styles.emptyContainer, { paddingTop: topContentInset }]}>
            <Ionicons name="checkmark-circle-outline" size={48} color={theme.colors.textSecondary} />
            <Text style={styles.emptyTitle}>Nothing waiting</Text>
            <Text style={styles.emptyBody}>
                Questions and permission requests from every session land here.
            </Text>
        </View>
    );
}

const GateCard = React.memo(({ entry }: { entry: DroverGateEntry }) => {
    const { theme } = useUnistyles();
    const navigateToSession = useNavigateToSession();
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

    // A question has no "no". Denying one resolves it for every other surface
    // with no answer to hand back, which is why the bus refuses a bare allow on
    // a question and why this card offers Allow/Deny only for a permission.
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
            <Pressable
                onPress={() => navigateToSession(sessionId)}
                style={styles.cardHeader}
                accessibilityRole="button"
                accessibilityLabel={`Open the session asking: ${gate.title}`}
            >
                <View style={styles.cardHeaderText}>
                    <View style={styles.cardTitleRow}>
                        <Ionicons
                            name={gate.kind === 'question' ? 'help-circle-outline' : 'lock-closed-outline'}
                            size={16}
                            color={theme.colors.box.warning.text}
                        />
                        <Text style={styles.cardTitle} numberOfLines={1}>{gate.title}</Text>
                    </View>
                    {!!gate.reason && (
                        <Text style={styles.cardReason} numberOfLines={1}>{gate.reason}</Text>
                    )}
                </View>
                {!!gate.account && (
                    <View style={styles.accountChip}>
                        <Text style={styles.accountChipText} numberOfLines={1}>{gate.account}</Text>
                    </View>
                )}
                <Ionicons name="chevron-forward" size={16} color={theme.colors.textSecondary} />
            </Pressable>

            {answerable ? (
                <View style={styles.cardBody}>
                    <InlineQuestionForm
                        questions={questions}
                        canInteract={true}
                        onSubmit={submitAnswer}
                    />
                </View>
            ) : (
                <View style={styles.cardBody}>
                    <Text style={styles.preview}>{gate.preview || gate.title}</Text>
                    {gate.kind === 'question' ? (
                        // A question with no options came through without the
                        // choices the form needs. Answering it blind would
                        // resolve it for every other surface with nothing to
                        // inject, so the only honest action is to go read it.
                        <Text style={styles.cardHint}>Open the session to answer this one.</Text>
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

GateCard.displayName = 'GateCard';

const styles = StyleSheet.create((theme) => ({
    list: {
        width: '100%',
        maxWidth: layout.maxWidth,
        alignSelf: 'center',
        paddingHorizontal: 16,
        paddingTop: 16,
        gap: 16,
    },
    emptyContainer: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 32,
        gap: 12,
        backgroundColor: theme.colors.groupped.background,
    },
    emptyTitle: {
        ...Typography.default('semiBold'),
        fontSize: 18,
        color: theme.colors.text,
    },
    emptyBody: {
        ...Typography.default(),
        fontSize: 14,
        lineHeight: 20,
        color: theme.colors.textSecondary,
        textAlign: 'center',
    },
    card: {
        backgroundColor: theme.colors.surface,
        borderRadius: Platform.select({ web: 16, default: 14 }),
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        overflow: 'hidden',
    },
    cardHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.divider,
    },
    cardHeaderText: {
        flex: 1,
        gap: 2,
    },
    cardTitleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    cardTitle: {
        ...Typography.default('semiBold'),
        flexShrink: 1,
        fontSize: 15,
        color: theme.colors.text,
    },
    cardReason: {
        ...Typography.default(),
        fontSize: 12,
        color: theme.colors.textSecondary,
    },
    accountChip: {
        maxWidth: 120,
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: 10,
        backgroundColor: theme.colors.surfaceHigh,
    },
    accountChipText: {
        ...Typography.default(),
        fontSize: 11,
        color: theme.colors.textSecondary,
    },
    cardBody: {
        paddingHorizontal: 12,
        paddingTop: 12,
        // InlineQuestionForm's own ToolSectionView already carries a 12pt
        // bottom margin, so the card would otherwise sit lopsided.
        paddingBottom: 4,
    },
    preview: {
        ...Typography.mono(),
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.text,
        marginBottom: 12,
    },
    cardHint: {
        ...Typography.default(),
        fontSize: 12,
        color: theme.colors.textSecondary,
        marginBottom: 12,
    },
    actions: {
        flexDirection: 'row',
        gap: 8,
        marginBottom: 12,
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
