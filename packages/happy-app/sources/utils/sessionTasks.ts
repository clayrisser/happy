/**
 * A session's task list, derived once for the phone and the wrist (DROVE-167).
 *
 * Clay, three times: "Why when I click on the drover icon it doesn't show the
 * todo", "When I press the Longhorn button nothing happens", "why does this
 * not let me see my fucking tasks". The data was already here the whole time.
 * Claude Code's task list lands on `session.todos` in the reducer, and
 * it has been kept up to date on every message since long before this ticket.
 * It simply had nowhere to land but the inline card in the transcript, which
 * scrolls away the moment the next tool runs.
 *
 * So nothing here fetches anything. It takes what the store already holds and
 * turns it into the lines a sheet and a watch row draw, and both surfaces read
 * THIS, per DROVE-129: the wrist mirrors the phone from one derivation, never
 * from a second parse of the same JSON.
 */

import type { TodoItem } from '@/sync/storageTypes';

export type SessionTaskStatus = 'in_progress' | 'pending' | 'completed';

export interface SessionTask {
    /** One line, whitespace collapsed. Never empty. */
    text: string;
    status: SessionTaskStatus;
}

export interface SessionTasks {
    /** Every task: the one in progress, then what is pending, then what is done. */
    tasks: SessionTask[];
    /** What the wrist shows: everything not finished, in the same order. */
    remaining: SessionTask[];
    total: number;
    completedCount: number;
    /** The task Claude Code says it is on right now, if it named one. */
    current: SessionTask | null;
    /** `3 of 7 done`, or why the list is empty. */
    headline: string;
    /** No tasks at all, which is a sentence on screen and not a blank box. */
    isEmpty: boolean;
}

/**
 * What an empty list says.
 *
 * A session that has never written a list is the common case, not an error:
 * a one-question session never keeps one. The screenshot on this ticket is
 * a black watch face, so the empty case gets a sentence, always — and the
 * sentence has to name what WOULD fill it (DROVE-192), because "No tasks yet"
 * on its own is indistinguishable from a surface that is broken.
 */
export const noTasksHeadline = 'No task list yet';

/**
 * A blank line is not a task. Claude Code will happily write `""` into the
 * list, and a row of nothing on a watch is indistinguishable from the bug this
 * ticket is about.
 */
function taskText(raw: string): string | null {
    const text = raw.replace(/\s+/g, ' ').trim();
    return text.length > 0 ? text : null;
}

/** In progress first, then pending, then done; original order inside each. */
const statusRank: Record<SessionTaskStatus, number> = {
    in_progress: 0,
    pending: 1,
    completed: 2,
};

export function deriveSessionTasks(todos: readonly TodoItem[] | null | undefined): SessionTasks {
    const tasks: SessionTask[] = [];
    for (const todo of todos ?? []) {
        const text = taskText(todo.content ?? '');
        if (!text) continue;
        tasks.push({ text, status: todo.status });
    }

    // Stable: two pending tasks keep the order Claude Code wrote them in, so
    // the list does not reshuffle under a thumb every time one completes.
    tasks.sort((a, b) => statusRank[a.status] - statusRank[b.status]);

    const completedCount = tasks.filter((task) => task.status === 'completed').length;
    const remaining = tasks.filter((task) => task.status !== 'completed');
    const current = tasks.find((task) => task.status === 'in_progress') ?? null;

    return {
        tasks,
        remaining,
        total: tasks.length,
        completedCount,
        current,
        headline: tasks.length === 0
            ? noTasksHeadline
            : `${completedCount} of ${tasks.length} done`,
        isEmpty: tasks.length === 0,
    };
}

/**
 * The one line the status row shows without opening anything: `2/7 tasks`.
 *
 * Null when there is nothing to say, because a strip segment reading `0/0` is
 * furniture. The empty sentence belongs inside the sheet, where there is room
 * for it.
 */
export function sessionTasksBadge(tasks: SessionTasks): string | null {
    if (tasks.isEmpty) return null;
    return `${tasks.completedCount}/${tasks.total} tasks`;
}

/**
 * What the wrist reads aloud and what a notification says: the task in hand,
 * or how many are left.
 */
export function sessionTasksSummary(tasks: SessionTasks): string {
    if (tasks.isEmpty) return noTasksHeadline;
    if (tasks.remaining.length === 0) {
        return tasks.total === 1 ? 'Task done' : `All ${tasks.total} tasks done`;
    }
    if (tasks.current) return tasks.current.text;
    return `${tasks.remaining.length} ${tasks.remaining.length === 1 ? 'task' : 'tasks'} left`;
}

/** One session's list, as the longhorn's inbox and the wrist both stack them. */
export interface SessionTasksCard {
    sessionId: string;
    title: string;
    tasks: SessionTasks;
}

export interface SessionTasksSource {
    sessionId: string;
    title: string;
    todos: readonly TodoItem[] | null | undefined;
}

/**
 * Every session that still has something to do, most urgent first.
 *
 * Only sessions with UNFINISHED work: a session whose list is finished has
 * nothing to ask of Clay, and stacking a wall of struck-through lines under
 * the longhorn is how the inbox stops being read. The one a session is on
 * right now sorts above the ones merely queued, and ties keep the order the
 * caller gave, which is the session list's own.
 */
export function collectSessionTasks(sources: readonly SessionTasksSource[]): SessionTasksCard[] {
    const cards: SessionTasksCard[] = [];
    for (const source of sources) {
        const tasks = deriveSessionTasks(source.todos);
        if (tasks.remaining.length === 0) continue;
        cards.push({ sessionId: source.sessionId, title: source.title, tasks });
    }
    return cards.sort((a, b) => Number(!!b.tasks.current) - Number(!!a.tasks.current));
}

/** `2 sessions have tasks left`, for the inbox heading. */
export function sessionTasksSectionLabel(cards: readonly SessionTasksCard[]): string {
    const left = cards.reduce((sum, card) => sum + card.tasks.remaining.length, 0);
    const tasks = left === 1 ? '1 task' : `${left} tasks`;
    const across = cards.length === 1 ? '1 session' : `${cards.length} sessions`;
    return `${tasks} in ${across}`;
}
