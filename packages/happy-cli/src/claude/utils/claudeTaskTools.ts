/**
 * The OTHER task list: TaskCreate / TaskUpdate / TaskList (DROVE-192).
 *
 * Mirror of happy-app/sources/utils/claudeTaskTools.ts, minus the app's
 * TodoItem shaping. DROVE-167 wired `session.todos` to `TodoWrite` and shipped
 * three surfaces on top of it. Clay then said, a fourth time, that he still could not see his
 * tasks. The reason is not the surfaces and it is not a session that never
 * planned. It is that his Claude Code does not have TodoWrite at all. Across
 * 6.8 GB of his transcripts there are ZERO `"name":"TodoWrite"` tool calls and
 * 25 files' worth of `TaskCreate` / `TaskUpdate`. The newer harness keeps the
 * list in a task TOOL FAMILY instead of one write-the-whole-array call:
 *
 *   TaskCreate  { subject, description, activeForm }  -> "Task #3 created successfully: ..."
 *   TaskUpdate  { taskId, status }                    -> "Updated task #3 status"
 *   TaskList    {}                                    -> "#3 [pending] ...\n#4 [completed] ..."
 *
 * Every result is a PLAIN STRING, which is the same shape DROVE-167 already
 * found breaks a result-only reader. So the list is rebuilt from the inputs,
 * with the create's id read out of its result line because that is the only
 * place the id is stated, and TaskList treated as an authoritative snapshot
 * when one happens to run.
 *
 * Deliberately tolerant about field names. The same three tool names appear in
 * Clay's transcripts with `taskName`, `task_id`, `state`, a batched `tasks`
 * array and a batched `updates` array, because more than one harness answers
 * to them. Guessing wrong here costs an empty screen, which is the bug.
 */



export type ClaudeTaskStatus = 'pending' | 'in_progress' | 'completed';

/** Insertion-ordered, keyed by the id the tool prints. */
export type ClaudeTaskList = Map<string, { content: string; status: ClaudeTaskStatus }>;

export function createClaudeTaskList(): ClaudeTaskList {
    return new Map();
}

const createNames = new Set(['TaskCreate']);
const updateNames = new Set(['TaskUpdate']);
const listNames = new Set(['TaskList']);

/** Does this tool touch the session's task list at all? */
export function isClaudeTaskTool(name: string): boolean {
    return createNames.has(name) || updateNames.has(name) || listNames.has(name);
}

function normalizeStatus(raw: unknown): ClaudeTaskStatus | null {
    if (typeof raw !== 'string') return null;
    const value = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (value === 'pending' || value === 'todo' || value === 'not_started' || value === 'queued') return 'pending';
    if (value === 'in_progress' || value === 'active' || value === 'running') return 'in_progress';
    if (value === 'completed' || value === 'complete' || value === 'done') return 'completed';
    return null;
}

/**
 * A tool result is whatever the CLI put on the wire: the string itself, a
 * content block, or the array of blocks an SDK hands back. Flatten to text so
 * one regex can read an id out of any of them.
 */
function resultText(result: unknown): string {
    if (typeof result === 'string') return result;
    if (Array.isArray(result)) return result.map(resultText).join('\n');
    if (result && typeof result === 'object') {
        const record = result as Record<string, unknown>;
        if (typeof record.text === 'string') return record.text;
        if (record.content !== undefined) return resultText(record.content);
    }
    return '';
}

function firstString(source: Record<string, unknown>, keys: readonly string[]): string | null {
    for (const key of keys) {
        const value = source[key];
        if (typeof value === 'string' && value.trim().length > 0) return value.trim();
    }
    return null;
}

const subjectKeys = ['subject', 'taskName', 'task_name', 'content', 'title', 'name', 'activeForm', 'description'] as const;
const idKeys = ['taskId', 'task_id', 'id'] as const;

function taskId(source: Record<string, unknown>): string | null {
    for (const key of idKeys) {
        const value = source[key];
        if (typeof value === 'string' && value.trim().length > 0) return value.trim();
        if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    }
    return null;
}

function asRecords(value: unknown): Record<string, unknown>[] {
    if (Array.isArray(value)) {
        return value.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object');
    }
    return [];
}

/** `Task #3 created successfully: …`, in the order the batch created them. */
function createdIds(result: unknown): string[] {
    const ids: string[] = [];
    const text = resultText(result);
    const pattern = /#(\d+)/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) ids.push(match[1]);
    return ids;
}

/** `#41 [pending] Item 7: …` — the whole list, one line each. */
function parseListSnapshot(result: unknown): { id: string; content: string; status: ClaudeTaskStatus }[] | null {
    const text = resultText(result);
    if (!text.trim()) return null;
    if (/^\s*no tasks found\s*$/i.test(text)) return [];
    const rows: { id: string; content: string; status: ClaudeTaskStatus }[] = [];
    for (const line of text.split('\n')) {
        const match = /^\s*#(\d+)\s*\[([^\]]+)\]\s*(.*)$/.exec(line);
        if (!match) continue;
        const status = normalizeStatus(match[2]);
        const content = match[3].trim();
        if (!status || !content) continue;
        rows.push({ id: match[1], content, status });
    }
    return rows.length > 0 ? rows : null;
}

/**
 * Fold one finished task-tool call into the list. Returns true when the list
 * actually moved, so a caller can avoid a needless re-render.
 */
export function applyClaudeTaskTool(
    list: ClaudeTaskList,
    name: string,
    input: unknown,
    result: unknown,
): boolean {
    const inputRecord = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;

    if (listNames.has(name)) {
        const snapshot = parseListSnapshot(result);
        if (!snapshot) return false;
        list.clear();
        for (const row of snapshot) list.set(row.id, { content: row.content, status: row.status });
        return true;
    }

    if (createNames.has(name)) {
        const batch = asRecords(inputRecord.tasks);
        const entries = batch.length > 0 ? batch : [inputRecord];
        const ids = createdIds(result);
        let changed = false;
        entries.forEach((entry, index) => {
            const content = firstString(entry, subjectKeys);
            if (!content) return;
            // The result states the id. Without one, fall back to position so a
            // later TaskUpdate at least has something to hit.
            const id = ids[index] ?? taskId(entry) ?? String(list.size + index + 1);
            list.set(id, { content, status: normalizeStatus(entry.status) ?? 'pending' });
            changed = true;
        });
        return changed;
    }

    if (updateNames.has(name)) {
        const batch = asRecords(inputRecord.updates);
        const entries = batch.length > 0 ? batch : [inputRecord];
        let changed = false;
        for (const entry of entries) {
            const id = taskId(entry);
            if (!id) continue;
            const status = normalizeStatus(entry.status) ?? normalizeStatus(entry.state);
            const content = firstString(entry, subjectKeys);
            const existing = list.get(id);
            if (!existing) {
                // An update to a task created before this transcript window.
                // Better a line with the right status than a silently missing one.
                if (!content) continue;
                list.set(id, { content, status: status ?? 'pending' });
                changed = true;
                continue;
            }
            if (status && status !== existing.status) {
                existing.status = status;
                changed = true;
            }
            if (content && content !== existing.content) {
                existing.content = content;
                changed = true;
            }
        }
        return changed;
    }

    return false;
}
