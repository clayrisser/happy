/**
 * A session's task list, drawn once and reused everywhere (DROVE-167).
 *
 * The transcript already has a TodoWrite card, and it is good. The problem is
 * that it scrolls away: by the time Clay looks, twenty tool calls have gone
 * past it. So the same list gets a fixed home — a sheet off the status row,
 * a group on the session info screen, and a card in the longhorn's inbox — and
 * all three render THIS, off the derivation in utils/sessionTasks.
 *
 * A CHECKLIST, not a paragraph of bullets (DROVE-380). Clay, on the Todos tab:
 * "Is there a richer way to display this?" Three marks that a glance can tell
 * apart — a ring for waiting, a live core for the one in hand, a filled tick
 * for done — the working row carrying the app's ONE pulse (StatusDot, so
 * reduced motion stops it dead), and the done rows stepping back so the
 * unfinished ones read first. Every surface gets that, because there is one
 * list.
 *
 * The empty case says something, never a blank box: a black screen with
 * nothing on it tells you nothing about whether the list is empty or the app
 * is broken. One fragment is enough to say it (DROVE-359).
 */
import * as React from 'react';
import { Text, View } from 'react-native';
import { Octicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { statusDotColors } from '@/components/statusDotState';
import { useSession } from '@/sync/storage';
import { deriveSessionTasks, noTasksHeadline, sessionTaskProgress, type SessionTask, type SessionTasks } from '@/utils/sessionTasks';
import {
    taskGlyphCoreSize,
    taskGlyphColumn,
    taskGlyphSize,
    taskProgressBarHeight,
    taskProgressGap,
    taskProgressLabelHeight,
    taskRowGap,
    taskRowLineHeight,
    taskRowMaxLines,
} from './worktreeSheetLayout';
import { StatusDot } from './StatusDot';

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
 * The mark at the head of a row.
 *
 * The blue is `statusDotColors.working` and not a colour picked here, so the
 * row being worked and the dot in the status strip are saying the same thing
 * in the same hue (DROVE-231). It pulses through StatusDot, the app's one
 * pulse, which means reduced motion stops it at full opacity for free.
 */
function TaskMark({ status }: { status: SessionTask['status'] }) {
    const { theme } = useUnistyles();
    if (status === 'completed') {
        return (
            <Octicons
                name="check-circle-fill"
                size={taskGlyphSize}
                color={theme.colors.textSecondary}
                accessibilityLabel="done"
            />
        );
    }
    if (status === 'in_progress') {
        return (
            <View style={{ width: taskGlyphSize, height: taskGlyphSize, alignItems: 'center', justifyContent: 'center' }}>
                <Octicons
                    name="circle"
                    size={taskGlyphSize}
                    color={statusDotColors.working}
                    style={{ position: 'absolute' }}
                />
                <StatusDot
                    color={statusDotColors.working}
                    size={taskGlyphCoreSize}
                    isPulsing
                    accessibilityLabel="in progress"
                />
            </View>
        );
    }
    return (
        <Octicons
            name="circle"
            size={taskGlyphSize}
            color={theme.colors.textSecondary}
            accessibilityLabel="waiting"
        />
    );
}

export function SessionTaskRow({ task }: { task: SessionTask }) {
    const { theme } = useUnistyles();
    const done = task.status === 'completed';
    const current = task.status === 'in_progress';
    return (
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
            <View
                style={{
                    width: taskGlyphColumn,
                    height: taskRowLineHeight,
                    alignItems: 'center',
                    justifyContent: 'center',
                }}
            >
                <TaskMark status={task.status} />
            </View>
            <Text
                // Two lines and then it stops (DROVE-380). A task Claude Code
                // wrote as a paragraph would otherwise push the rest of the
                // list off the sheet, and the rest of the list is the point.
                numberOfLines={taskRowMaxLines}
                ellipsizeMode="tail"
                style={{
                    flex: 1,
                    fontSize: 13,
                    lineHeight: taskRowLineHeight,
                    color: done ? theme.colors.textSecondary : theme.colors.text,
                    opacity: done ? 0.6 : 1,
                    textDecorationLine: done ? 'line-through' : 'none',
                    ...Typography.default(current ? 'semiBold' : 'regular'),
                }}
            >
                {task.text}
            </Text>
        </View>
    );
}

/**
 * `3 of 7` over a thin bar (DROVE-380).
 *
 * The arithmetic is `sessionTaskProgress` in utils/sessionTasks, where the
 * wrist reads it too (DROVE-129), so the bar on the phone and the headline on
 * the watch cannot come to different numbers.
 *
 * OFF by default. Every other surface that draws this list already prints
 * `tasks.headline` directly above it — the sheet, the info group's footer, the
 * inbox card — and two counts one over the other is noise. The Todos tab has
 * only a caption, which is why it asks for this.
 */
export function SessionTasksProgress({ tasks }: { tasks: SessionTasks }) {
    const { theme } = useUnistyles();
    const progress = sessionTaskProgress(tasks);
    if (!progress) return null;
    return (
        <View style={{ gap: taskProgressGap, paddingBottom: taskRowGap }}>
            <Text
                accessibilityLabel={`${progress.label} tasks done`}
                style={{
                    fontSize: 12,
                    lineHeight: taskProgressLabelHeight,
                    color: theme.colors.textSecondary,
                    ...Typography.default(),
                }}
            >
                {progress.label}
            </Text>
            <View
                style={{
                    height: taskProgressBarHeight,
                    borderRadius: taskProgressBarHeight / 2,
                    backgroundColor: theme.colors.divider,
                    overflow: 'hidden',
                }}
            >
                <View
                    style={{
                        width: `${progress.fraction * 100}%`,
                        height: '100%',
                        borderRadius: taskProgressBarHeight / 2,
                        backgroundColor: statusDotColors.working,
                    }}
                />
            </View>
        </View>
    );
}

export function SessionTasksList({ tasks, progress = false }: { tasks: SessionTasks; progress?: boolean }) {
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
                {/* The same fragment the watch and the summary use, so
                    three surfaces cannot word this differently. The sentence
                    that followed it explained TodoWrite (DROVE-359). */}
                {noTasksHeadline}
            </Text>
        );
    }
    return (
        <View>
            {progress ? <SessionTasksProgress tasks={tasks} /> : null}
            <View style={{ gap: taskRowGap }}>
                {tasks.tasks.map((task, index) => (
                    <SessionTaskRow key={`${index}-${task.text}`} task={task} />
                ))}
            </View>
        </View>
    );
}
