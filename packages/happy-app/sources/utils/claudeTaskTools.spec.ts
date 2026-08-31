import { describe, it, expect } from 'vitest';
import {
    applyClaudeTaskTool,
    claudeTaskListToTodos,
    createClaudeTaskList,
    isClaudeTaskTool,
} from './claudeTaskTools';
import { deriveSessionTasks } from './sessionTasks';

/** The exact strings out of Clay's transcripts, not invented ones. */
const created = (id: number, subject: string) => `Task #${id} created successfully: ${subject}`;

describe('isClaudeTaskTool', () => {
    it('claims the three task tools and nothing else', () => {
        expect(isClaudeTaskTool('TaskCreate')).toBe(true);
        expect(isClaudeTaskTool('TaskUpdate')).toBe(true);
        expect(isClaudeTaskTool('TaskList')).toBe(true);
        for (const other of ['TodoWrite', 'Task', 'Agent', 'TaskOutput', 'TaskStop', 'Bash']) {
            expect(isClaudeTaskTool(other)).toBe(false);
        }
    });
});

describe('applyClaudeTaskTool', () => {
    it('builds the list from creates and takes the id out of the result line', () => {
        const list = createClaudeTaskList();
        expect(applyClaudeTaskTool(list, 'TaskCreate', { subject: 'Boot local fork server', activeForm: 'Booting' }, created(1, 'Boot local fork server'))).toBe(true);
        expect(applyClaudeTaskTool(list, 'TaskCreate', { subject: 'Create test user' }, created(2, 'Create test user'))).toBe(true);
        expect(claudeTaskListToTodos(list)).toEqual([
            { id: '1', content: 'Boot local fork server', status: 'pending' },
            { id: '2', content: 'Create test user', status: 'pending' },
        ]);
    });

    it('moves a task the update names, and leaves the rest alone', () => {
        const list = createClaudeTaskList();
        applyClaudeTaskTool(list, 'TaskCreate', { subject: 'One' }, created(1, 'One'));
        applyClaudeTaskTool(list, 'TaskCreate', { subject: 'Two' }, created(2, 'Two'));
        expect(applyClaudeTaskTool(list, 'TaskUpdate', { taskId: '1', status: 'in_progress' }, 'Updated task #1 status')).toBe(true);
        expect(applyClaudeTaskTool(list, 'TaskUpdate', { taskId: '1', status: 'completed' }, 'Updated task #1 status')).toBe(true);
        expect(claudeTaskListToTodos(list)).toEqual([
            { id: '1', content: 'One', status: 'completed' },
            { id: '2', content: 'Two', status: 'pending' },
        ]);
    });

    it('reports no change when an update says what the list already says', () => {
        const list = createClaudeTaskList();
        applyClaudeTaskTool(list, 'TaskCreate', { subject: 'One' }, created(1, 'One'));
        applyClaudeTaskTool(list, 'TaskUpdate', { taskId: '1', status: 'completed' }, '');
        expect(applyClaudeTaskTool(list, 'TaskUpdate', { taskId: '1', status: 'completed' }, '')).toBe(false);
    });

    it('accepts the other spellings the same tool names arrive with', () => {
        const list = createClaudeTaskList();
        applyClaudeTaskTool(list, 'TaskCreate', { taskName: 'Snake case id', status: 'in_progress' }, created(7, 'Snake case id'));
        applyClaudeTaskTool(list, 'TaskUpdate', { task_id: 7, state: 'done' }, '');
        expect(claudeTaskListToTodos(list)).toEqual([{ id: '7', content: 'Snake case id', status: 'completed' }]);
    });

    it('takes a batch of creates in one call, in order', () => {
        const list = createClaudeTaskList();
        applyClaudeTaskTool(
            list,
            'TaskCreate',
            { tasks: [{ subject: 'A' }, { subject: 'B' }] },
            `${created(4, 'A')}\n${created(5, 'B')}`,
        );
        expect(claudeTaskListToTodos(list).map((t) => t.id)).toEqual(['4', '5']);
    });

    it('still records a create whose result never stated an id', () => {
        const list = createClaudeTaskList();
        expect(applyClaudeTaskTool(list, 'TaskCreate', { subject: 'Nameless' }, 'ok')).toBe(true);
        expect(claudeTaskListToTodos(list)).toEqual([{ id: '1', content: 'Nameless', status: 'pending' }]);
    });

    it('reads a result carried as content blocks, not just a bare string', () => {
        const list = createClaudeTaskList();
        applyClaudeTaskTool(list, 'TaskCreate', { subject: 'Blocked up' }, [{ type: 'text', text: created(9, 'Blocked up') }]);
        expect(claudeTaskListToTodos(list)).toEqual([{ id: '9', content: 'Blocked up', status: 'pending' }]);
    });

    it('takes a TaskList result as the whole truth', () => {
        const list = createClaudeTaskList();
        applyClaudeTaskTool(list, 'TaskCreate', { subject: 'Stale' }, created(1, 'Stale'));
        applyClaudeTaskTool(
            list,
            'TaskList',
            {},
            '#41 [pending] Item 7: one-binary commands\n#42 [in_progress] Item 16: docs Starlight h1\n#43 [completed] Item 22: readability sweep',
        );
        expect(claudeTaskListToTodos(list)).toEqual([
            { id: '41', content: 'Item 7: one-binary commands', status: 'pending' },
            { id: '42', content: 'Item 16: docs Starlight h1', status: 'in_progress' },
            { id: '43', content: 'Item 22: readability sweep', status: 'completed' },
        ]);
    });

    it('empties the list when TaskList says there are none', () => {
        const list = createClaudeTaskList();
        applyClaudeTaskTool(list, 'TaskCreate', { subject: 'Gone' }, created(1, 'Gone'));
        expect(applyClaudeTaskTool(list, 'TaskList', {}, 'No tasks found')).toBe(true);
        expect(claudeTaskListToTodos(list)).toEqual([]);
    });

    it('leaves the list alone when a TaskList result is unreadable', () => {
        const list = createClaudeTaskList();
        applyClaudeTaskTool(list, 'TaskCreate', { subject: 'Keep me' }, created(1, 'Keep me'));
        expect(applyClaudeTaskTool(list, 'TaskList', {}, undefined)).toBe(false);
        expect(claudeTaskListToTodos(list)).toHaveLength(1);
    });

    it('feeds the derivation every surface reads', () => {
        const list = createClaudeTaskList();
        applyClaudeTaskTool(list, 'TaskCreate', { subject: 'Boot server' }, created(1, 'Boot server'));
        applyClaudeTaskTool(list, 'TaskCreate', { subject: 'Smoke sign-in' }, created(2, 'Smoke sign-in'));
        applyClaudeTaskTool(list, 'TaskUpdate', { taskId: '1', status: 'completed' }, '');
        applyClaudeTaskTool(list, 'TaskUpdate', { taskId: '2', status: 'in_progress' }, '');
        const tasks = deriveSessionTasks(claudeTaskListToTodos(list));
        expect(tasks.isEmpty).toBe(false);
        expect(tasks.headline).toBe('1 of 2 done');
        expect(tasks.current?.text).toBe('Smoke sign-in');
    });
});
