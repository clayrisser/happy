import * as React from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Typography } from '@/constants/Typography';
import { useSessionGates, type DroverGateEntry } from '@/hooks/usePendingGates';
import { sessionAllow, sessionDeny } from '@/sync/ops';
import { describePendingGates, type PendingGatesKind } from './pendingGatesSummary';
import { sessionGateAction, sessionGateReadOnlyHint } from './sessionGateAction';
import { droverTodoCard } from './tools/views/droverTodoCard';
import { DroverTodoBody } from './tools/views/DroverTodoView';
import {
    providerAnswersFor,
    questionCards,
    toInlineQuestions,
} from './tools/views/askUserQuestionAnswers';
import {
    InlineQuestionForm,
    type InlineQuestionAnswers,
} from './tools/views/InlineQuestionForm';

/**
 * The prompt this session raised, on this session's own screen (DROVE-19).
 *
 * Clay, watching a session work: "I was kinda hoping that I wouldn't have to
 * navigate away to see notifications that are popping up. Whatever the active
 * session I'm in, shouldn't it just, like, boom, pop up on it?" It did not. The
 * delivery path was healthy the whole time, the same question rendered on the
 * watch and was answered there, but the phone showed it only on the home
 * screen and the gates list, so watching a session live meant leaving the
 * session to find out it had stopped.
 *
 * It sits directly above the composer because that is where you are already
 * looking when you are waiting on an agent, and because the composer is the
 * thing the prompt is blocking.
 *
 * It shows ONLY this session's gates. useSessionGates does that matching on an
 * exact Claude session uuid; a prompt from one of the other four sessions
 * running right now must never take this screen, so there is no cwd match and
 * no "closest" match anywhere in the path.
 *
 * Each card is drawn BY TOOL (DROVE-89). A to-do gets the same body the
 * transcript's DroverTodoView draws, a question gets its own options, and only
 * a real permission gets Deny / Allow. Before this every non-question fell
 * through to the permission footer, so a `drover needs` to-do read as
 * "1 permission waiting" with Allow under it, and the bridge refused all eight
 * Allows Clay pressed because a to-do is answered only by naming Done or Drop
 * it. The title reads by kind for the same reason: "1 to-do for you" is not a
 * permission and must not be dressed as one.
 */
export function SessionGateBanner({ sessionId }: { sessionId: string }) {
    const { theme } = useUnistyles();
    const entries = useSessionGates(sessionId);
    const summary = describePendingGates(entries.map((entry) => entry.gate));

    // Collapse is remembered against the gate SET, not as a plain boolean, so a
    // new prompt re-opens the banner on its own. Collapsing one question and
    // then silently swallowing the next one is the bug this component exists to
    // fix, wearing a different hat.
    const gateKey = entries.map((entry) => entry.gate.id).join(' ');
    const [collapsedKey, setCollapsedKey] = React.useState<string | null>(null);
    const collapsed = collapsedKey === gateKey;

    if (!summary) return null;

    return (
        <View style={styles.container}>
            <Pressable
                style={styles.header}
                onPress={() => setCollapsedKey(collapsed ? null : gateKey)}
                accessibilityRole="button"
                accessibilityLabel={collapsed ? `Show ${summary.title}` : `Hide ${summary.title}`}
            >
                <Ionicons name={bannerIcon(summary.kind)} size={18} color={theme.colors.box.warning.text} />
                <View style={styles.headerText}>
                    <Text style={styles.headerTitle} numberOfLines={1}>{summary.title}</Text>
                    {collapsed && (
                        <Text style={styles.headerSubtitle} numberOfLines={2}>{summary.subtitle}</Text>
                    )}
                </View>
                <Ionicons
                    name={collapsed ? 'chevron-up' : 'chevron-down'}
                    size={18}
                    color={theme.colors.textSecondary}
                />
            </Pressable>
            {!collapsed && (
                <ScrollView
                    style={styles.body}
                    contentContainerStyle={styles.bodyContent}
                    // Bounded so a long question cannot push the composer off a
                    // phone screen. Answering a prompt you cannot reach the
                    // keyboard behind is not answering it.
                    nestedScrollEnabled={true}
                    // The keyboard is usually up when a prompt lands, and
                    // without this the first tap on an option only dismisses it.
                    keyboardShouldPersistTaps="handled"
                >
                    {entries.map((entry) => (
                        <SessionGateCard key={entry.gate.id} entry={entry} />
                    ))}
                </ScrollView>
            )}
        </View>
    );
}

/**
 * A checklist for a set that is only to-dos, which block nothing; a hand for
 * anything that is holding a session up. The same pair the inbox headings use.
 */
function bannerIcon(kind: PendingGatesKind): 'hand-left-outline' | 'checkbox-outline' {
    return kind === 'todo' ? 'checkbox-outline' : 'hand-left-outline';
}

const SessionGateCard = React.memo(({ entry }: { entry: DroverGateEntry }) => {
    const { theme } = useUnistyles();
    // `entry.sessionId` is who HOLDS the card, which for a drover gate is the
    // bridge session and not the session on screen. Answering the session you
    // are looking at would reach an agent that never asked anything.
    const { gate, sessionId, requestId } = entry;
    const [busy, setBusy] = React.useState<'allow' | 'deny' | null>(null);

    const cards = React.useMemo(() => questionCards(entry.args), [entry.args]);
    const questions = React.useMemo(() => toInlineQuestions(cards), [cards]);
    const action = sessionGateAction(gate.kind, entry.args, entry.tool);
    const todo = React.useMemo(
        () => (action === 'todo' ? droverTodoCard(entry.args) : null),
        [action, entry.args],
    );

    // Close a to-do by naming the button that was pressed. The same call
    // DroverTodoView and the inbox make: the bridge's busResolutionFor takes a
    // to-do answer only when it carries one of the card's option ids, so this
    // is the one shape that actually resolves it on the bus.
    const closeTodo = React.useCallback(async (optionId: string) => {
        await sessionAllow(sessionId, requestId, undefined, undefined, 'approved', { optionId });
    }, [requestId, sessionId]);

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
            console.error('Failed to answer gate in place:', error);
        } finally {
            setBusy(null);
        }
    }, [busy, requestId, sessionId]);

    if (action === 'todo') {
        // A to-do with no title is not renderable; droverTodoCard says so by
        // returning null, and drawing two buttons over nothing would close a
        // record the screen could not describe.
        if (!todo) return null;
        return (
            <View style={[styles.card, styles.todoCard]}>
                <DroverTodoBody card={todo} canInteract={true} onClose={closeTodo} chip={false} />
            </View>
        );
    }

    if (action === 'answer-question') {
        return (
            <View style={styles.card}>
                <InlineQuestionForm
                    questions={questions}
                    canInteract={true}
                    onSubmit={submitAnswer}
                />
            </View>
        );
    }

    return (
        <View style={styles.card}>
            <Text style={styles.cardTitle} numberOfLines={1}>{gate.title}</Text>
            <Text style={styles.preview}>{gate.preview || gate.title}</Text>
            {action === 'read-only' ? (
                <Text style={styles.hint}>{sessionGateReadOnlyHint}</Text>
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
    );
});

SessionGateCard.displayName = 'SessionGateCard';

const styles = StyleSheet.create((theme) => ({
    container: {
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
        gap: 10,
        paddingHorizontal: 12,
        paddingVertical: 10,
        minHeight: 44,
    },
    headerText: {
        flex: 1,
        minWidth: 0,
    },
    headerTitle: {
        ...Typography.default('semiBold'),
        fontSize: 14,
        color: theme.colors.text,
    },
    headerSubtitle: {
        ...Typography.default(),
        fontSize: 13,
        color: theme.colors.textSecondary,
    },
    body: {
        maxHeight: 320,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.divider,
    },
    bodyContent: {
        paddingHorizontal: 12,
        paddingTop: 12,
    },
    card: {
        // InlineQuestionForm's own ToolSectionView carries a bottom margin, so
        // the gap between stacked cards lives on the card, not on the list.
        marginBottom: 4,
    },
    todoCard: {
        // DroverTodoBody brings no section wrapper of its own, so it takes the
        // margin the form's ToolSectionView would have carried.
        marginBottom: 12,
    },
    cardTitle: {
        ...Typography.default('semiBold'),
        fontSize: 14,
        color: theme.colors.text,
        marginBottom: 4,
    },
    preview: {
        ...Typography.mono(),
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.text,
        marginBottom: 12,
    },
    hint: {
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
