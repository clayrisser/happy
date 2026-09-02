/**
 * What the Todos tab actually draws, decided here rather than in the view
 * (DROVE-380).
 *
 * Clay, on the photograph of the tab: "Is there a richer way to display this,
 * or to communicate this?" It showed NEEDS YOU over "Nothing waiting", TASK
 * LIST over "No task list yet", and then black. Two captions and two grey
 * lines is not a screen; it is the residue of DROVE-359 having correctly
 * deleted the paragraphs that were there before.
 *
 * Three states per section, and all three are named in one place so a spec can
 * pin them without mounting reanimated — the same split worktreeSheetTabs.ts
 * and sessionTasks.ts already use:
 *
 *   EMPTY      a glyph and ONE fragment, centred in real room off the cap.
 *   POPULATED  needs-you cards, or a checklist with a progress bar over it.
 *   WORKING    the one task in hand, marked and pulsing, done rows dimmed.
 *
 * The needs-you card is parsed by `droverTodoCard`, which is the SAME parse the
 * transcript card and the gate overlay use (DROVE-69). That matters: a to-do
 * must be closed by naming its OPTION, and re-deriving the options here would
 * be a second way to answer one, which is exactly the bug DROVE-69 was.
 */

import { ageLabel, type DroverGateEntry } from '@/sync/droverGates';
import { nothingWaitingFragment } from './worktreeSheetTabs';
import { droverTodoCard, type DroverTodoCard } from '@/components/tools/views/droverTodoCard';
import { noTasksHeadline, sessionTaskProgress, type SessionTask, type SessionTaskProgress, type SessionTasks } from './sessionTasks';

/**
 * The two empty fragments, by name, re-exported from where copyDensity.spec
 * can reach them without loading React Native (see worktreeSheetTabs.ts).
 * Held to the 40-character bar there: a string that reaches JSX through a
 * variable is invisible to that file's scan, which is the hole DROVE-359
 * closed for `paneTrouble` and would reopen here otherwise.
 */
export { nothingWaitingFragment } from './worktreeSheetTabs';

/** The glyphs the empty states draw. Named, so the view cannot pick a third. */
export type TodosEmptyGlyph = 'needs' | 'tasks';

export interface NeedsCardRow {
    /** How the answer is addressed: the session holding the card, and the request. */
    sessionId: string;
    requestId: string;
    /** The to-do as the gate cards read it. Handed straight to DroverTodoBody. */
    card: DroverTodoCard;
    /** One fragment of context: why, or failing that the command it named. */
    context: string;
    /** `40s`, `7m`, `2h` — the same three bands `drover todos` prints. */
    age: string;
}

export interface NeedsSection {
    caption: string;
    empty: boolean;
    glyph: TodosEmptyGlyph;
    fragment: string;
    cards: NeedsCardRow[];
}

/** One checklist line, with everything the row needs to draw itself. */
export interface TaskRow {
    text: string;
    status: SessionTask['status'];
    /** `check` done, `working` the one in hand, `pending` the rest. */
    mark: 'check' | 'working' | 'pending';
    /** Done rows step back so the unfinished ones read first. */
    dimmed: boolean;
    /** Only the row being worked, and only ever one of them. */
    pulsing: boolean;
}

export interface TasksSection {
    caption: string;
    empty: boolean;
    glyph: TodosEmptyGlyph;
    fragment: string;
    progress: SessionTaskProgress | null;
    rows: TaskRow[];
}

export interface TodosTabSections {
    needs: NeedsSection;
    tasks: TasksSection;
    /** How many of the two are drawing an empty state, which is what sizes them. */
    emptySections: number;
}

/** `NEEDS YOU`, or `NEEDS YOU · 3`. The count is on the caption, never in the body. */
export function needsCaption(count: number): string {
    return count === 0 ? 'NEEDS YOU' : `NEEDS YOU · ${count}`;
}

/**
 * The context line: the why the agent gave, else the command it named, else
 * nothing at all.
 *
 * ONE fragment (DROVE-346). An empty line is not drawn — a card with a blank
 * second row reads as a card that failed to load.
 */
export function needsContext(card: DroverTodoCard): string {
    return card.reason || card.command || '';
}

function needsRow(entry: DroverGateEntry, now: number): NeedsCardRow | null {
    // `args` is the tool input the bridge mirrored, which is what the
    // transcript card parses. A gate whose args never carried the shape still
    // has the gate's own title and reason, so it is rebuilt rather than dropped:
    // a to-do that vanishes because a field moved is the worst failure here.
    const card = droverTodoCard(entry.args)
        ?? droverTodoCard({
            title: entry.gate.title,
            reason: entry.gate.reason,
            command: entry.event?.command ?? '',
        });
    if (!card) return null;
    return {
        sessionId: entry.sessionId,
        requestId: entry.requestId,
        card,
        context: needsContext(card),
        age: ageLabel(entry.event?.createdAt ?? entry.gate.createdAt, now),
    };
}

/**
 * Ordered as the CLI emitted them.
 *
 * `splitInbox` already sorted the entries oldest first and this keeps that,
 * because the row Clay is reaching for must not move as a new to-do lands
 * above it. Same reason the task rows below keep `deriveSessionTasks`' order.
 */
export function todosTabSections(input: {
    todos: readonly DroverGateEntry[];
    tasks: SessionTasks;
    now?: number;
}): TodosTabSections {
    const now = input.now ?? Date.now();
    const cards: NeedsCardRow[] = [];
    for (const entry of input.todos) {
        const row = needsRow(entry, now);
        if (row) cards.push(row);
    }

    const rows: TaskRow[] = input.tasks.tasks.map((task) => {
        const done = task.status === 'completed';
        const working = task.status === 'in_progress';
        return {
            text: task.text,
            status: task.status,
            mark: done ? 'check' : working ? 'working' : 'pending',
            dimmed: done,
            pulsing: working,
        };
    });

    const needs: NeedsSection = {
        caption: needsCaption(cards.length),
        empty: cards.length === 0,
        glyph: 'needs',
        fragment: nothingWaitingFragment,
        cards,
    };
    const tasks: TasksSection = {
        caption: 'TASK LIST',
        empty: rows.length === 0,
        glyph: 'tasks',
        fragment: noTasksHeadline,
        progress: sessionTaskProgress(input.tasks),
        rows,
    };

    return {
        needs,
        tasks,
        emptySections: Number(needs.empty) + Number(tasks.empty),
    };
}
