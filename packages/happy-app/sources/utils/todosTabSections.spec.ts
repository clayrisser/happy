/**
 * The Todos tab's three states per section (DROVE-380).
 *
 * Clay photographed the tab: two captions, two grey fragments, and two thirds
 * of a screen of black. So the states are pinned here by fixture — empty,
 * populated, and one task being worked — because the empty one is the one that
 * regressed and it is the cheapest of the three to leave undrawn.
 */
import { describe, expect, it, vi } from 'vitest';

// droverGates reaches for the store for one default argument, and the store
// pulls in React Native. The same mock droverGates.spec.ts uses; nothing here
// reads a session.
vi.mock('@/sync/storage', () => ({
    storage: { getState: () => ({ sessions: {} }) },
}));

import type { DroverGateEntry } from '@/sync/droverGates';
import { deriveSessionTasks, noTasksHeadline } from './sessionTasks';
import {
    needsCaption,
    needsContext,
    nothingWaitingFragment,
    todosTabSections,
} from './todosTabSections';
import type { TodoItem } from '@/sync/storageTypes';

const now = Date.parse('2026-09-02T04:00:00.000Z');
const todo = (content: string, status: TodoItem['status']): TodoItem => ({ content, status });

/** A mirrored `drover needs` to-do, as the bridge writes one. */
function needs(over: {
    requestId?: string;
    title?: string;
    reason?: string;
    command?: string;
    createdAt?: number;
} = {}): DroverGateEntry {
    const title = over.title ?? 'Push the release';
    const reason = over.reason ?? 'The tag is cut';
    const command = over.command ?? '';
    return {
        gate: {
            id: `bridge:${over.requestId ?? 'ev-1'}`,
            title,
            reason,
            preview: reason,
            kind: 'todo',
            createdAt: '2026-09-02T03:59:00.000Z',
            options: [{ id: 'done', label: 'Done' }, { id: 'drop', label: 'Drop it' }],
        },
        sessionId: 'bridge',
        requestId: over.requestId ?? 'ev-1',
        tool: 'DroverTodo',
        args: { title, reason, command, options: [{ id: 'done', label: 'Done' }, { id: 'drop', label: 'Drop it' }] },
        todo: true,
        event: {
            kind: 'todo',
            title,
            reason,
            command,
            createdAt: over.createdAt ?? Date.parse('2026-09-02T03:59:00.000Z'),
        },
    };
}

describe('NEEDS YOU', () => {
    it('is empty with a glyph and ONE fragment, never a blank section', () => {
        const sections = todosTabSections({ todos: [], tasks: deriveSessionTasks([]), now });
        expect(sections.needs.empty).toBe(true);
        expect(sections.needs.glyph).toBe('needs');
        expect(sections.needs.fragment).toBe(nothingWaitingFragment);
        expect(sections.needs.cards).toEqual([]);
        // The bar DROVE-346 set, checked here too so a longer fragment cannot
        // reach the screen through this file.
        expect(sections.needs.fragment.length).toBeLessThanOrEqual(40);
        expect(sections.needs.fragment).not.toMatch(/[.!?]/);
    });

    it('draws a card per to-do: title, one fragment of context, and the age', () => {
        const sections = todosTabSections({
            todos: [needs({ requestId: 'a', title: 'Sign the lease', reason: 'The agent is waiting' })],
            tasks: deriveSessionTasks([]),
            now,
        });
        expect(sections.needs.empty).toBe(false);
        expect(sections.needs.caption).toBe('NEEDS YOU · 1');
        const [card] = sections.needs.cards;
        expect(card.card.title).toBe('Sign the lease');
        expect(card.context).toBe('The agent is waiting');
        expect(card.age).toBe('60s');
        expect(card.sessionId).toBe('bridge');
        expect(card.requestId).toBe('a');
    });

    it('carries the options the bus expects, so the card can only be closed by naming one', () => {
        const sections = todosTabSections({ todos: [needs()], tasks: deriveSessionTasks([]), now });
        expect(sections.needs.cards[0].card.options.map((o) => o.id)).toEqual(['done', 'drop']);
    });

    it('falls back to the command when the agent gave no why, and to nothing when it gave neither', () => {
        expect(needsContext({ title: 't', reason: '', command: 'make release', options: [] })).toBe('make release');
        expect(needsContext({ title: 't', reason: 'why', command: 'make release', options: [] })).toBe('why');
        expect(needsContext({ title: 't', reason: '', command: '', options: [] })).toBe('');
    });

    it('keeps the order it was handed, so a row does not move under a thumb', () => {
        const sections = todosTabSections({
            todos: [needs({ requestId: 'old' }), needs({ requestId: 'new' })],
            tasks: deriveSessionTasks([]),
            now,
        });
        expect(sections.needs.cards.map((card) => card.requestId)).toEqual(['old', 'new']);
    });

    it('rebuilds a card from the gate when the mirrored args never carried the shape', () => {
        const entry = needs({ requestId: 'thin', title: 'Approve the invoice' });
        const sections = todosTabSections({
            todos: [{ ...entry, args: { command: 'not a to-do' } }],
            tasks: deriveSessionTasks([]),
            now,
        });
        // Dropping it would be the worst outcome: a to-do that vanishes
        // because a field moved.
        expect(sections.needs.cards).toHaveLength(1);
        expect(sections.needs.cards[0].card.title).toBe('Approve the invoice');
        expect(sections.needs.cards[0].card.options.map((o) => o.id)).toEqual(['done', 'drop']);
    });

    it('counts on the caption and nowhere else', () => {
        expect(needsCaption(0)).toBe('NEEDS YOU');
        expect(needsCaption(1)).toBe('NEEDS YOU · 1');
        expect(needsCaption(4)).toBe('NEEDS YOU · 4');
    });
});

describe('TASK LIST', () => {
    it('is empty with the checklist glyph and the one fragment every surface uses', () => {
        const sections = todosTabSections({ todos: [], tasks: deriveSessionTasks([]), now });
        expect(sections.tasks.empty).toBe(true);
        expect(sections.tasks.glyph).toBe('tasks');
        expect(sections.tasks.fragment).toBe(noTasksHeadline);
        expect(sections.tasks.progress).toBeNull();
        expect(sections.tasks.rows).toEqual([]);
    });

    it('marks each row circle, half or check, and dims only what is done', () => {
        const sections = todosTabSections({
            todos: [],
            tasks: deriveSessionTasks([
                todo('Read the reducer', 'completed'),
                todo('Write the sheet', 'in_progress'),
                todo('Wire the wrist', 'pending'),
            ]),
            now,
        });
        // In hand first, then waiting, then done — deriveSessionTasks' order,
        // which is the order the CLI emitted them in.
        expect(sections.tasks.rows.map((row) => row.mark)).toEqual(['working', 'pending', 'check']);
        expect(sections.tasks.rows.map((row) => row.dimmed)).toEqual([false, false, true]);
        expect(sections.tasks.rows.map((row) => row.text)).toEqual([
            'Write the sheet',
            'Wire the wrist',
            'Read the reducer',
        ]);
    });

    it('pulses exactly one row, the one being worked', () => {
        const sections = todosTabSections({
            todos: [],
            tasks: deriveSessionTasks([
                todo('a', 'pending'),
                todo('b', 'in_progress'),
                todo('c', 'completed'),
            ]),
            now,
        });
        expect(sections.tasks.rows.filter((row) => row.pulsing)).toHaveLength(1);
        expect(sections.tasks.rows.find((row) => row.pulsing)?.text).toBe('b');
    });

    it('pulses nothing when the session named no task in hand', () => {
        const sections = todosTabSections({
            todos: [],
            tasks: deriveSessionTasks([todo('a', 'pending'), todo('b', 'completed')]),
            now,
        });
        expect(sections.tasks.rows.some((row) => row.pulsing)).toBe(false);
    });

    it('puts the progress over the rows', () => {
        const sections = todosTabSections({
            todos: [],
            tasks: deriveSessionTasks([
                todo('a', 'completed'),
                todo('b', 'completed'),
                todo('c', 'completed'),
                todo('d', 'in_progress'),
                todo('e', 'pending'),
                todo('f', 'pending'),
                todo('g', 'pending'),
            ]),
            now,
        });
        expect(sections.tasks.progress).toEqual({ done: 3, total: 7, label: '3 of 7', fraction: 3 / 7 });
    });
});

describe('what sizes the tab', () => {
    it('counts the empty sections, which is what the layout splits the tab between', () => {
        const empty = todosTabSections({ todos: [], tasks: deriveSessionTasks([]), now });
        expect(empty.emptySections).toBe(2);

        const half = todosTabSections({ todos: [needs()], tasks: deriveSessionTasks([]), now });
        expect(half.emptySections).toBe(1);

        const full = todosTabSections({
            todos: [needs()],
            tasks: deriveSessionTasks([todo('a', 'pending')]),
            now,
        });
        expect(full.emptySections).toBe(0);
    });
});
