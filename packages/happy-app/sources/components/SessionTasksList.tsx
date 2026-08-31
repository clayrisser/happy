/**
 * A session's task list, drawn once and reused everywhere (DROVE-167).
 *
 * The transcript already has a TodoWrite card, and it is good. The problem is
 * that it scrolls away: by the time Clay looks, twenty tool calls have gone
 * past it. So the same list gets a fixed home — a sheet off the status row,
 * a group on the session info screen, and a card in the longhorn's inbox — and
 * all three render THIS, off the derivation in utils/sessionTasks.
 *
 * The empty case is a sentence, never a blank box. That is the whole of the
 * screenshot on the ticket: a black screen with nothing on it tells you
 * nothing about whether the list is empty or the app is broken.
 */
import * as React from 'react';
import { Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { useSession } from '@/sync/storage';
import { deriveSessionTasks, type SessionTask, type SessionTasks } from '@/utils/sessionTasks';

/**
 * The live list for one session, straight off the store.
 *
 * Nothing is fetched. `session.todos` is written by the reducer on every
 * TodoWrite that lands, which is why the sheet moves while the session works
 * and there is nothing to pull to refresh. Takes an optional id so the status
 * row, which renders with no session behind it on a preview, can still call it
 * unconditionally.
 */
export function useSessionTasks(sessionId: string | undefined): SessionTasks {
    const session = useSession(sessionId ?? '');
    const todos = session?.todos;
    return React.useMemo(() => deriveSessionTasks(todos), [todos]);
}

/**
 * `●` done, `◐` in hand, `○` waiting — the same three marks the transcript
 * card draws, so the sheet and the card cannot disagree about what a row means.
 */
function bullet(status: SessionTask['status']): string {
    if (status === 'completed') return '●';
    if (status === 'in_progress') return '◐';
    return '○';
}

export function SessionTaskRow({ task }: { task: SessionTask }) {
    const { theme } = useUnistyles();
    const done = task.status === 'completed';
    const current = task.status === 'in_progress';
    return (
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
            <Text
                style={{
                    fontSize: 13,
                    lineHeight: 19,
                    color: done ? theme.colors.textSecondary : theme.colors.text,
                    ...Typography.default(),
                }}
            >
                {bullet(task.status)}
            </Text>
            <Text
                style={{
                    flex: 1,
                    fontSize: 13,
                    lineHeight: 19,
                    color: done ? theme.colors.textSecondary : theme.colors.text,
                    textDecorationLine: done ? 'line-through' : 'none',
                    ...Typography.default(current ? 'semiBold' : 'regular'),
                }}
            >
                {task.text}
            </Text>
        </View>
    );
}

export function SessionTasksList({ tasks }: { tasks: SessionTasks }) {
    const { theme } = useUnistyles();
    if (tasks.isEmpty) {
        return (
            <Text
                style={{
                    fontSize: 13,
                    lineHeight: 19,
                    color: theme.colors.textSecondary,
                    ...Typography.default(),
                }}
            >
                {/* Said in full, and saying what would fill it (DROVE-192).
                    "No tasks yet" on its own reads like a failure to load, and
                    leaves you with nothing to do about it. */}
                No task list yet. Claude writes one when it plans multi-step
                work, and this session has not.
            </Text>
        );
    }
    return (
        <View style={{ gap: 6 }}>
            {tasks.tasks.map((task, index) => (
                <SessionTaskRow key={`${index}-${task.text}`} task={task} />
            ))}
        </View>
    );
}
