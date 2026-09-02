import { describe, it, expect } from 'vitest';
import {
    collectSessionTasks,
    deriveSessionTasks,
    noTasksHeadline,
    sessionTasksBadge,
    sessionTaskProgress,
    sessionTasksSectionLabel,
    sessionTasksSummary,
} from './sessionTasks';
import type { TodoItem } from '@/sync/storageTypes';

const todo = (content: string, status: TodoItem['status']): TodoItem => ({ content, status });

describe('deriveSessionTasks', () => {
    it('says so when there are no tasks rather than handing back a blank list', () => {
        for (const input of [undefined, null, []]) {
            const tasks = deriveSessionTasks(input);
            expect(tasks.isEmpty).toBe(true);
            expect(tasks.total).toBe(0);
            expect(tasks.headline).toBe(noTasksHeadline);
            expect(tasks.current).toBeNull();
            expect(tasks.remaining).toEqual([]);
        }
    });

    it('counts what is done against the whole list', () => {
        const tasks = deriveSessionTasks([
            todo('Read the reducer', 'completed'),
            todo('Write the sheet', 'in_progress'),
            todo('Wire the wrist', 'pending'),
        ]);
        expect(tasks.total).toBe(3);
        expect(tasks.completedCount).toBe(1);
        expect(tasks.headline).toBe('1 of 3 done');
        expect(tasks.isEmpty).toBe(false);
    });

    it('puts the task in hand first, then what is left, then what is done', () => {
        const tasks = deriveSessionTasks([
            todo('done a', 'completed'),
            todo('pending a', 'pending'),
            todo('working', 'in_progress'),
            todo('done b', 'completed'),
            todo('pending b', 'pending'),
        ]);
        expect(tasks.tasks.map((task) => task.text)).toEqual([
            'working',
            'pending a',
            'pending b',
            'done a',
            'done b',
        ]);
        expect(tasks.current?.text).toBe('working');
    });

    it('gives the wrist only what is not finished', () => {
        const tasks = deriveSessionTasks([
            todo('done', 'completed'),
            todo('working', 'in_progress'),
            todo('later', 'pending'),
        ]);
        expect(tasks.remaining.map((task) => task.text)).toEqual(['working', 'later']);
    });

    it('collapses whitespace and drops rows that are only whitespace', () => {
        const tasks = deriveSessionTasks([
            todo('  keep   this\n line ', 'pending'),
            todo('   ', 'pending'),
            todo('', 'in_progress'),
        ]);
        expect(tasks.tasks).toEqual([{ text: 'keep this line', status: 'pending' }]);
        expect(tasks.current).toBeNull();
        expect(tasks.total).toBe(1);
    });

    it('is empty when every row was blank', () => {
        const tasks = deriveSessionTasks([todo('  ', 'pending'), todo('', 'completed')]);
        expect(tasks.isEmpty).toBe(true);
        expect(tasks.headline).toBe(noTasksHeadline);
    });

    it('reads all done when the list finished', () => {
        const tasks = deriveSessionTasks([todo('a', 'completed'), todo('b', 'completed')]);
        expect(tasks.headline).toBe('2 of 2 done');
        expect(tasks.remaining).toEqual([]);
    });
});

describe('sessionTasksBadge', () => {
    it('is nothing at all when the session has no list', () => {
        expect(sessionTasksBadge(deriveSessionTasks([]))).toBeNull();
    });

    it('is done over total', () => {
        const tasks = deriveSessionTasks([
            todo('a', 'completed'),
            todo('b', 'in_progress'),
            todo('c', 'pending'),
        ]);
        expect(sessionTasksBadge(tasks)).toBe('1/3 tasks');
    });
});

describe('sessionTasksSummary', () => {
    it('names the task in hand', () => {
        const tasks = deriveSessionTasks([todo('Wire the wrist', 'in_progress'), todo('b', 'pending')]);
        expect(sessionTasksSummary(tasks)).toBe('Wire the wrist');
    });

    it('counts what is left when nothing is marked in progress', () => {
        expect(sessionTasksSummary(deriveSessionTasks([todo('a', 'pending'), todo('b', 'pending')])))
            .toBe('2 tasks left');
        expect(sessionTasksSummary(deriveSessionTasks([todo('a', 'pending')])))
            .toBe('1 task left');
    });

    it('says the list is finished, and does not say "all 1 tasks"', () => {
        expect(sessionTasksSummary(deriveSessionTasks([todo('a', 'completed')]))).toBe('Task done');
        expect(sessionTasksSummary(deriveSessionTasks([todo('a', 'completed'), todo('b', 'completed')])))
            .toBe('All 2 tasks done');
    });

    it('falls back to the empty sentence', () => {
        expect(sessionTasksSummary(deriveSessionTasks([]))).toBe(noTasksHeadline);
    });
});

describe('collectSessionTasks', () => {
    const source = (sessionId: string, todos: TodoItem[]) => ({ sessionId, title: sessionId, todos });

    it('drops sessions with nothing left to do', () => {
        const cards = collectSessionTasks([
            source('done', [todo('a', 'completed')]),
            source('empty', []),
            source('live', [todo('b', 'pending')]),
        ]);
        expect(cards.map((card) => card.sessionId)).toEqual(['live']);
    });

    it('puts the session actually working above the ones merely queued', () => {
        const cards = collectSessionTasks([
            source('queued', [todo('a', 'pending')]),
            source('working', [todo('b', 'in_progress')]),
            source('queued-2', [todo('c', 'pending')]),
        ]);
        expect(cards.map((card) => card.sessionId)).toEqual(['working', 'queued', 'queued-2']);
    });

    it('counts what is left across sessions', () => {
        const cards = collectSessionTasks([
            source('one', [todo('a', 'in_progress'), todo('b', 'pending'), todo('c', 'completed')]),
            source('two', [todo('d', 'pending')]),
        ]);
        expect(sessionTasksSectionLabel(cards)).toBe('3 tasks in 2 sessions');
        expect(sessionTasksSectionLabel(cards.slice(1))).toBe('1 task in 1 session');
    });
});

describe('sessionTaskProgress', () => {
    it('says how far in, in the words the bar is drawn from (DROVE-380)', () => {
        const tasks = deriveSessionTasks([
            todo('a', 'completed'),
            todo('b', 'completed'),
            todo('c', 'completed'),
            todo('d', 'in_progress'),
            todo('e', 'pending'),
            todo('f', 'pending'),
            todo('g', 'pending'),
        ]);
        expect(sessionTaskProgress(tasks)).toEqual({ done: 3, total: 7, label: '3 of 7', fraction: 3 / 7 });
    });

    it('draws nothing at all for an empty list, because a bar at zero over 0 of 0 is furniture', () => {
        expect(sessionTaskProgress(deriveSessionTasks([]))).toBeNull();
    });

    it('starts at nothing filled and ends full', () => {
        expect(sessionTaskProgress(deriveSessionTasks([todo('a', 'pending'), todo('b', 'pending')])))
            .toEqual({ done: 0, total: 2, label: '0 of 2', fraction: 0 });
        expect(sessionTaskProgress(deriveSessionTasks([todo('a', 'completed'), todo('b', 'completed')])))
            .toEqual({ done: 2, total: 2, label: '2 of 2', fraction: 1 });
    });

    it('handles a list of one, which is the shape a bar is easiest to get wrong on', () => {
        expect(sessionTaskProgress(deriveSessionTasks([todo('a', 'in_progress')])))
            .toEqual({ done: 0, total: 1, label: '0 of 1', fraction: 0 });
        expect(sessionTaskProgress(deriveSessionTasks([todo('a', 'completed')])))
            .toEqual({ done: 1, total: 1, label: '1 of 1', fraction: 1 });
    });

    it('never hands a parent a fraction outside the bar', () => {
        // Clamped rather than trusted: a width of 140% is a layout bug in
        // every container this is ever dropped into.
        const fabricated = { ...deriveSessionTasks([todo('a', 'pending')]), completedCount: 9 };
        expect(sessionTaskProgress(fabricated)!.fraction).toBe(1);
        const negative = { ...deriveSessionTasks([todo('a', 'pending')]), completedCount: -3 };
        expect(sessionTaskProgress(negative)!.fraction).toBe(0);
    });

    it('agrees with the headline the wrist reads, so the two surfaces cannot differ', () => {
        const tasks = deriveSessionTasks([todo('a', 'completed'), todo('b', 'pending')]);
        expect(tasks.headline).toBe('1 of 2 done');
        expect(sessionTaskProgress(tasks)!.label).toBe('1 of 2');
    });
});
