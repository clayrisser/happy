import { describe, expect, it } from 'vitest';
import {
    commandFallback,
    inventoryFromMetadata,
    inventoryFromPayload,
    matchScore,
    mergeInventory,
    searchInventory,
    type InventoryEntry,
} from './sessionInventory';

function entry(name: string, kind: InventoryEntry['kind'] = 'skill', description?: string): InventoryEntry {
    return { name, kind, description };
}

describe('inventoryFromPayload', () => {
    it('keeps commands and skills as different kinds', () => {
        const entries = inventoryFromPayload({
            commands: [{ name: 'flip', description: 'Move this session', origin: 'user' }],
            skills: [{ name: 'huly-ticket', description: 'File a ticket', origin: 'user' }],
        });

        expect(entries).toEqual([
            { name: 'flip', kind: 'command', description: 'Move this session', origin: 'user' },
            { name: 'huly-ticket', kind: 'skill', description: 'File a ticket', origin: 'user' },
        ]);
    });

    it('drops malformed rows instead of throwing', () => {
        const entries = inventoryFromPayload({
            commands: [{ name: '' }, { name: 42 }, { description: 'orphan' }, { name: 'ok' }],
            skills: undefined,
        });

        expect(entries.map((e) => e.name)).toEqual(['ok']);
    });

    it('is empty for a missing payload', () => {
        expect(inventoryFromPayload(null)).toEqual([]);
        expect(inventoryFromPayload({})).toEqual([]);
    });
});

describe('inventoryFromMetadata', () => {
    it('recovers the kinds from the flat lists a harness publishes', () => {
        // Measured on Claude Code 2.1.251: skills appear in slash_commands too,
        // so the difference of the two lists is what tells the kinds apart.
        const entries = inventoryFromMetadata({
            slashCommands: ['compact', 'context', 'huly-ticket', 'grug'],
            skills: ['huly-ticket', 'grug'],
        });

        expect(entries.filter((e) => e.kind === 'command').map((e) => e.name)).toEqual(['compact', 'context']);
        expect(entries.filter((e) => e.kind === 'skill').map((e) => e.name)).toEqual(['huly-ticket', 'grug']);
    });

    it('drops harness commands that only mean something at a terminal', () => {
        const entries = inventoryFromMetadata({
            slashCommands: ['vim', 'terminal-setup', 'login', 'compact'],
            skills: [],
        });

        expect(entries.map((e) => e.name)).toEqual(['compact']);
    });

    it('never filters a skill by that list, so somebody’s own /review survives', () => {
        const entries = inventoryFromMetadata({
            slashCommands: ['review', 'export'],
            skills: ['review', 'export'],
        });

        expect(entries.map((e) => e.name)).toEqual(['review', 'export']);
        expect(entries.every((e) => e.kind === 'skill')).toBe(true);
    });

    it('is empty when the snapshot carries no lists', () => {
        expect(inventoryFromMetadata(undefined)).toEqual([]);
        expect(inventoryFromMetadata({})).toEqual([]);
    });
});

describe('mergeInventory', () => {
    it('falls back to the five when nothing enumerates', () => {
        const merged = mergeInventory(inventoryFromPayload(null), inventoryFromMetadata(null), commandFallback);

        expect(merged.map((e) => e.name)).toEqual(['compact', 'clear', 'goal', 'mcp', 'skills']);
        expect(merged.every((e) => e.kind === 'command')).toBe(true);
    });

    it('lets the first source win a name, and keeps a command and a skill of the same name apart', () => {
        const merged = mergeInventory(
            [entry('review', 'skill', 'my own review')],
            [entry('review', 'skill', 'stale copy'), entry('review', 'command')],
        );

        expect(merged).toHaveLength(2);
        expect(merged.find((e) => e.kind === 'skill')?.description).toBe('my own review');
    });

    it('keeps the familiar commands at the top of an unfiltered list', () => {
        const merged = mergeInventory(
            [entry('align-conventions'), entry('zebra', 'command')],
            commandFallback,
        );

        expect(merged.slice(0, 5).map((e) => e.name)).toEqual(['compact', 'clear', 'goal', 'mcp', 'skills']);
        expect(merged.map((e) => e.name)).toContain('align-conventions');
    });
});

describe('searchInventory', () => {
    const entries = [
        entry('compact', 'command', 'Compact the conversation history'),
        entry('clear', 'command', 'Clear the conversation'),
        entry('align-conventions', 'skill', 'House style for Makefiles'),
        entry('superpowers--brainstorming', 'skill', 'Design and spec a feature'),
        entry('agent-os:plan-new-product', 'command'),
        entry('huly-ticket', 'skill', 'File and update a ticket'),
    ];

    it('returns everything in source order for an empty query', () => {
        expect(searchInventory(entries, '').map((e) => e.name)).toEqual(entries.map((e) => e.name));
    });

    it('puts a prefix match above a substring match', () => {
        expect(searchInventory(entries, 'c').map((e) => e.name).slice(0, 2)).toEqual(['clear', 'compact']);
    });

    it('matches a part of a namespaced or hyphenated name', () => {
        expect(searchInventory(entries, 'brain').map((e) => e.name)).toEqual(['superpowers--brainstorming']);
        expect(searchInventory(entries, 'plan').map((e) => e.name)).toEqual(['agent-os:plan-new-product']);
    });

    it('falls back to the description when no name matches', () => {
        expect(searchInventory(entries, 'makefiles').map((e) => e.name)).toEqual(['align-conventions']);
    });

    it('is empty rather than wrong when nothing matches', () => {
        expect(searchInventory(entries, 'zzzz')).toEqual([]);
    });

    it('honours the limit', () => {
        expect(searchInventory(entries, '', 2)).toHaveLength(2);
    });

    it('scores an exact name best', () => {
        expect(matchScore(entry('clear', 'command'), 'clear')).toBe(0);
        expect(matchScore(entry('clearly', 'command'), 'clear')).toBe(1);
    });

    /**
     * The acceptance criterion Clay asked to be checked rather than assumed:
     * typing has to narrow a few hundred entries without lag. This is the exact
     * work one keystroke does. Budget is deliberately loose — it runs on CI
     * boxes — but a regression that reintroduces a per-keystroke fuzzy index
     * blows past it by an order of magnitude.
     */
    it('filters 600 entries in well under a frame', () => {
        const many: InventoryEntry[] = [];
        for (let i = 0; i < 600; i++) {
            many.push(entry(
                `${['superpowers', 'expo', 'chrome-devtools-mcp', 'agent-os', 'team'][i % 5]}--skill-${i}`,
                i % 3 === 0 ? 'command' : 'skill',
                `does the ${i} thing for a session in a project on a machine`,
            ));
        }
        const queries = ['a', 'al', 'ali', 'sup', 'supe', 'super', 'expo', 'team', 'zzz', 'skill-5'];

        const started = performance.now();
        for (let round = 0; round < 20; round++) {
            for (const query of queries) searchInventory(many, query, 50);
        }
        const perKeystroke = (performance.now() - started) / (20 * queries.length);

        expect(perKeystroke).toBeLessThan(4);
    });
});
