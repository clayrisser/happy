import * as React from 'react';
import {
    ActivityIndicator,
    type LayoutChangeEvent,
    Platform,
    Pressable,
    ScrollView,
    Text,
    TouchableOpacity,
    View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ItemList } from '@/components/ItemList';
import { layout } from '@/components/layout';
import { MOBILE_GLASS_HEADER_HEIGHT } from '@/components/navigation/headerMetrics';
import { Typography } from '@/constants/Typography';
import { usePendingGates, type DroverGateEntry } from '@/hooks/usePendingGates';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { ageLabel, splitInbox } from '@/sync/droverGates';
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
 * The drover inbox: everything Clay has to respond to, in one place
 * (BASED-98, DROVE-71).
 *
 * Reached by tapping the longhorn top-left of the Sessions screen, and from
 * the "N waiting" banner. The wrist has had this list since the watch shipped;
 * the phone had nothing until BASED-98, and had no TO-DO half at all until
 * DROVE-71 — `drover needs` wrote records the app could not show, so Clay went
 * looking for his list and found nothing.
 *
 * TWO GROUPS, NEVER ONE COUNT. A pending PROMPT — a permission gate, a
 * question — is blocking a session right now: a turn is stopped and it can
 * time out. A TO-DO is a job to do when he can; nothing is stalled on it and
 * it never expires. Prompts come first because they are the blocking ones, and
 * both halves are oldest first, which for a prompt is not a preference: the
 * oldest is the one that has held a session up longest.
 *
 * It answers through sessionAllow / sessionDeny, the same ops the transcript's
 * own buttons call, and builds a question's payload with the same helper the
 * transcript card uses. There is no second decision path here, only a second
 * way in.
 */
export default function GatesScreen() {
    const gates = usePendingGates();
    const { prompts, todos } = React.useMemo(() => splitInbox(gates), [gates]);
    // The header is transparent glass on iOS, so the first card would sit under
    // it. Same inset the settings screen applies for the same header.
    const topContentInset = Platform.OS === 'ios' ? MOBILE_GLASS_HEADER_HEIGHT : 0;

    // `?focus=` is a tap on a gate push whose raising session the bridge did
    // not know (DROVE-94): the card is lit and scrolled to, once, when it
    // lays out. Matched on the bus event id the push carries as well as the
    // store's own card id.
    const { focus } = useLocalSearchParams<{ focus?: string }>();
    const focusId = typeof focus === 'string' && focus.trim() ? focus.trim() : null;
    const listRef = React.useRef<ScrollView>(null);
    const scrolledTo = React.useRef<string | null>(null);
    const isFocused = React.useCallback(
        (entry: DroverGateEntry) => !!focusId && (entry.gate.id === focusId || entry.requestId === focusId),
        [focusId],
    );
    const handleFocusedLayout = React.useCallback((event: LayoutChangeEvent) => {
        if (!focusId || scrolledTo.current === focusId) return;
        scrolledTo.current = focusId;
        listRef.current?.scrollTo({ y: Math.max(0, event.nativeEvent.layout.y), animated: true });
    }, [focusId]);

    if (gates.length === 0) {
        return <EmptyGates topContentInset={topContentInset} />;
    }

    const card = (entry: DroverGateEntry) => (
        isFocused(entry)
            ? <View key={entry.gate.id} onLayout={handleFocusedLayout}><GateCard entry={entry} focused={true} /></View>
            : <GateCard key={entry.gate.id} entry={entry} focused={false} />
    );

    return (
        <ItemList
            ref={listRef}
            style={{ paddingTop: 0 }}
            containerStyle={{ paddingTop: topContentInset }}
        >
            <View style={styles.list}>
                {prompts.length > 0 && (
                    <SectionHeading
                        icon="hand-left-outline"
                        label={prompts.length === 1 ? '1 prompt waiting' : `${prompts.length} prompts waiting`}
                        note="A session is stopped until you answer"
                        loud={true}
                    />
                )}
                {prompts.map(card)}
                {todos.length > 0 && (
                    <SectionHeading
                        icon="checkbox-outline"
                        label={todos.length === 1 ? '1 to-do' : `${todos.length} to-dos`}
                        note="Nothing is blocked; these wait until you do them"
                        loud={false}
                    />
                )}
                {todos.map(card)}
            </View>
        </ItemList>
    );
}

/**
 * Which half of the inbox you are looking at.
 *
 * The count is spelled out rather than badged because the heading is where the
 * DIFFERENCE is explained — "a session is stopped" against "nothing is
 * blocked" — and that sentence is the whole reason the two are not one list.
 */
function SectionHeading({ icon, label, note, loud }: {
    icon: 'hand-left-outline' | 'checkbox-outline';
    label: string;
    note: string;
    loud: boolean;
}) {
    const { theme } = useUnistyles();
    return (
        <View style={styles.sectionHeading}>
            <Ionicons
                name={icon}
                size={16}
                color={loud ? theme.colors.box.warning.text : theme.colors.textSecondary}
            />
            <View style={styles.sectionHeadingText}>
                <Text style={[styles.sectionLabel, loud && { color: theme.colors.box.warning.text }]}>
                    {label}
                </Text>
                <Text style={styles.sectionNote}>{note}</Text>
            </View>
        </View>
    );
}

function EmptyGates({ topContentInset }: { topContentInset: number }) {
    const { theme } = useUnistyles();
    return (
        <View style={[styles.emptyContainer, { paddingTop: topContentInset }]}>
            <Ionicons name="checkmark-circle-outline" size={48} color={theme.colors.textSecondary} />
            <Text style={styles.emptyTitle}>Nothing waiting</Text>
            <Text style={styles.emptyBody}>
                Prompts from every session land here, and so does anything an
                agent has asked you to do.
            </Text>
        </View>
    );
}

const GateCard = React.memo(({ entry, focused }: { entry: DroverGateEntry; focused: boolean }) => {
    const { theme } = useUnistyles();
    const navigateToSession = useNavigateToSession();
    const { gate, sessionId, requestId } = entry;
    const [busy, setBusy] = React.useState<'allow' | 'deny' | null>(null);

    const cards = React.useMemo(() => questionCards(entry.args), [entry.args]);
    const questions = React.useMemo(() => toInlineQuestions(cards), [cards]);
    const answerable = gate.kind === 'question' && hasAnswerableOptions(cards);
    // Recomputed on every render rather than ticked on a timer: this list is
    // re-rendered by the store whenever anything on the bus changes, and a
    // per-card interval to move "3m" to "4m" would keep the screen awake for
    // a digit nobody is watching.
    const age = ageLabel(entry.event?.createdAt ?? gate.createdAt);
    const command = entry.event?.command?.trim() || '';

    /**
     * Close a to-do by naming the button that was pressed (DROVE-69).
     *
     * The option id is what makes this an answer at all. happy-cli's
     * busResolutionFor refuses a to-do answer that names neither Done nor Drop
     * it, because the old `approved ? done : drop` let every generic approve
     * path in the app close one — which is how event 4c3f5082 was acked with
     * nobody having touched it. Both buttons go through sessionAllow because
     * the bus reads the OPTION and not the verb; a drop is not a denial of
     * anything, it is a choice to not do the job.
     */
    const close = React.useCallback(async (optionId: 'done' | 'drop') => {
        if (busy) return;
        setBusy(optionId === 'done' ? 'allow' : 'deny');
        try {
            await sessionAllow(sessionId, requestId, undefined, undefined, 'approved', { optionId });
        } catch (error) {
            console.error('Failed to close a to-do:', error);
        } finally {
            setBusy(null);
        }
    }, [busy, requestId, sessionId]);

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
        <View style={[styles.card, focused && styles.cardFocused]}>
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
                {/* How long it has been waiting, in the same three bands
                    `drover todos` prints, so a row reads the same on the phone
                    and in the terminal. */}
                {!!age && <Text style={styles.ageText}>{age}</Text>}
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
            ) : entry.todo ? (
                <View style={styles.cardBody}>
                    {/* What to do is the card TITLE, in the header above. This
                        is the command, if the agent gave one — `drover needs
                        --do` — and nothing at all if it did not, because an
                        empty mono line reads as a command that failed to
                        render. */}
                    {!!command && <Text style={styles.preview}>{command}</Text>}
                    <View style={styles.actions}>
                        <TouchableOpacity
                            style={[styles.action, styles.deny]}
                            onPress={() => close('drop')}
                            disabled={busy !== null}
                            activeOpacity={0.7}
                        >
                            {busy === 'deny'
                                ? <ActivityIndicator size="small" color={theme.colors.text} />
                                : <Text style={styles.denyText}>Drop it</Text>}
                        </TouchableOpacity>
                        <TouchableOpacity
                            style={[styles.action, styles.allow]}
                            onPress={() => close('done')}
                            disabled={busy !== null}
                            activeOpacity={0.7}
                        >
                            {busy === 'allow'
                                ? <ActivityIndicator size="small" color={theme.colors.button.primary.tint} />
                                : <Text style={styles.allowText}>Done</Text>}
                        </TouchableOpacity>
                    </View>
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
    cardFocused: {
        // The card a push tap asked for. The same warning edge the session
        // overlay draws, so "this one" reads the same on both screens.
        borderWidth: 1,
        borderColor: theme.colors.box.warning.text,
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
    sectionHeading: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingTop: 4,
    },
    sectionHeadingText: {
        flex: 1,
        gap: 1,
    },
    sectionLabel: {
        ...Typography.default('semiBold'),
        fontSize: 13,
        color: theme.colors.textSecondary,
    },
    sectionNote: {
        ...Typography.default(),
        fontSize: 11,
        color: theme.colors.textSecondary,
    },
    ageText: {
        ...Typography.default(),
        fontSize: 11,
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
