/**
 * The Todos tab of the worktree sheet (DROVE-330).
 *
 * Clay: "a tab there that shows the todo". Two lists, because the app keeps
 * two things called that, and a tab that showed one and hid the other would
 * read as broken:
 *
 *   NEEDS YOU   the drover's to-dos: `drover needs` raised them, `drover
 *               todos` lists them, and they reach the phone as gates of kind
 *               `todo` through the bridge. LIVE, not a snapshot: this reads
 *               the same store the inbox reads, so a to-do closed in the
 *               terminal leaves this list the moment the bus says so. Each
 *               one closes the way the inbox closes it, with the option id
 *               the bus expects (DROVE-69).
 *
 *   TASK LIST   Claude's own plan for the session, off TodoWrite, drawn by
 *               SessionTasksList, which is drawn once and reused everywhere
 *               (DROVE-167). It is here so the tab is complete, and nothing
 *               about it is new.
 */
import * as React from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { useSessionGates, type DroverGateEntry } from '@/hooks/usePendingGates';
import { ageLabel, splitInbox } from '@/sync/droverGates';
import { sessionAllow } from '@/sync/ops';
import { answerWithDeadline, gateAnswerTrouble } from './gateAnswerTimeout';
import { SessionTasksList, useSessionTasks } from './SessionTasksList';

const stylesheet = StyleSheet.create((theme) => ({
    section: {
        paddingHorizontal: 20,
        paddingTop: 4,
        paddingBottom: 10,
        gap: 8,
    },
    sectionTitle: {
        fontSize: 10,
        color: theme.colors.textSecondary,
        ...Typography.default('semiBold'),
    },
    empty: {
        fontSize: 13,
        lineHeight: 19,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    card: {
        gap: 6,
        paddingVertical: 8,
        paddingHorizontal: 12,
        borderRadius: 12,
        backgroundColor: theme.colors.surfaceHigh,
    },
    titleRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 8,
    },
    title: {
        flex: 1,
        fontSize: 14,
        lineHeight: 19,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    age: {
        fontSize: 12,
        lineHeight: 19,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    reason: {
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    command: {
        fontSize: 12,
        lineHeight: 16,
        color: theme.colors.text,
        ...Typography.mono(),
    },
    trouble: {
        fontSize: 12,
        lineHeight: 16,
        color: theme.colors.warning,
        ...Typography.default(),
    },
    actions: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        gap: 8,
        paddingTop: 2,
    },
    action: {
        minWidth: 72,
        minHeight: 32,
        paddingHorizontal: 14,
        borderRadius: 16,
        alignItems: 'center',
        justifyContent: 'center',
    },
    drop: {
        backgroundColor: theme.colors.surface,
    },
    done: {
        backgroundColor: theme.colors.button.primary.background,
    },
    dropText: {
        fontSize: 13,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    doneText: {
        fontSize: 13,
        color: theme.colors.button.primary.tint,
        ...Typography.default('semiBold'),
    },
}));

/**
 * One to-do, closed by naming the button (DROVE-69). Both go through
 * sessionAllow with an optionId, because the bus reads the OPTION and not the
 * verb: a drop is not a denial, it is a choice to not do the job.
 */
function TodoCard({ entry }: { entry: DroverGateEntry }) {
    const styles = stylesheet;
    const [busy, setBusy] = React.useState<'done' | 'drop' | null>(null);
    const [trouble, setTrouble] = React.useState<string | null>(null);
    const { sessionId, requestId, gate } = entry;
    const age = ageLabel(entry.event?.createdAt ?? gate.createdAt);
    const command = entry.event?.command?.trim() || '';
    const close = React.useCallback(async (optionId: 'done' | 'drop') => {
        if (busy) return;
        setBusy(optionId);
        setTrouble(null);
        const outcome = await answerWithDeadline(
            () => sessionAllow(sessionId, requestId, undefined, undefined, 'approved', { optionId }),
        );
        setBusy(null);
        setTrouble(gateAnswerTrouble(outcome));
    }, [busy, requestId, sessionId]);
    return (
        <View style={styles.card} accessibilityLabel={`To-do: ${gate.title}`}>
            <View style={styles.titleRow}>
                <Text style={styles.title}>{gate.title}</Text>
                {!!age && <Text style={styles.age}>{age}</Text>}
            </View>
            {!!gate.reason && <Text style={styles.reason}>{gate.reason}</Text>}
            {/* The command, if the agent gave one (`drover needs --do`), and
                nothing at all if not: an empty mono line reads as a command
                that failed to render. */}
            {!!command && <Text style={styles.command} selectable>{command}</Text>}
            {!!trouble && <Text style={styles.trouble}>{trouble}</Text>}
            <View style={styles.actions}>
                <Pressable
                    onPress={() => { void close('drop'); }}
                    disabled={busy !== null}
                    accessibilityRole="button"
                    accessibilityLabel="Drop it"
                    style={({ pressed }) => [styles.action, styles.drop, pressed && { opacity: 0.7 }]}
                >
                    {busy === 'drop' ? <ActivityIndicator size="small" /> : <Text style={styles.dropText}>Drop it</Text>}
                </Pressable>
                <Pressable
                    onPress={() => { void close('done'); }}
                    disabled={busy !== null}
                    accessibilityRole="button"
                    accessibilityLabel="Done"
                    style={({ pressed }) => [styles.action, styles.done, pressed && { opacity: 0.7 }]}
                >
                    {busy === 'done' ? <ActivityIndicator size="small" /> : <Text style={styles.doneText}>Done</Text>}
                </Pressable>
            </View>
        </View>
    );
}

export function WorktreeTodosTab({ sessionId }: { sessionId: string }) {
    const styles = stylesheet;
    const gates = useSessionGates(sessionId);
    const todos = React.useMemo(() => splitInbox(gates).todos, [gates]);
    const tasks = useSessionTasks(sessionId);
    return (
        <View>
            <View style={styles.section}>
                <Text style={styles.sectionTitle}>
                    {todos.length === 0 ? 'NEEDS YOU' : todos.length === 1 ? 'NEEDS YOU · 1' : `NEEDS YOU · ${todos.length}`}
                </Text>
                {todos.length === 0 ? (
                    /* One fragment, the same one the inbox screen shows
                       (DROVE-359). The paragraph that was here explained
                       `drover needs` to the person least able to run it. */
                    <Text style={styles.empty}>Nothing waiting</Text>
                ) : todos.map((entry) => (
                    <TodoCard key={entry.requestId} entry={entry} />
                ))}
            </View>
            <View style={styles.section}>
                <Text style={styles.sectionTitle}>TASK LIST</Text>
                <SessionTasksList tasks={tasks} />
            </View>
        </View>
    );
}
