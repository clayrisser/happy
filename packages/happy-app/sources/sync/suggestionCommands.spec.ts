import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from './storageTypes';

const mockSessions: Record<string, Partial<Session>> = {};

vi.mock('./storage', () => ({
    storage: {
        getState: () => ({ sessions: mockSessions }),
    },
}));

const sessionInventory = vi.fn();
vi.mock('./ops', () => ({
    sessionInventory: (sessionId: string) => sessionInventory(sessionId),
}));

import { getAllCommands, primeCommands, resetCommandCache, searchCommands } from './suggestionCommands';

/** Let the in-flight refresh settle before reading the cache again. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
    resetCommandCache();
    sessionInventory.mockReset();
    for (const key of Object.keys(mockSessions)) delete mockSessions[key];
});

describe('suggestionCommands', () => {
    it('answers from the snapshot immediately rather than blocking on the RPC', async () => {
        sessionInventory.mockReturnValue(new Promise(() => { /* never settles */ }));

        const commands = getAllCommands('cold-session');

        expect(commands.map((c) => c.command)).toEqual(['compact', 'clear', 'goal', 'mcp', 'skills']);
        expect(commands.every((c) => c.kind === 'command')).toBe(true);
    });

    it('falls back to today’s five when the harness cannot enumerate', async () => {
        sessionInventory.mockResolvedValue({ success: false, error: 'no such method' });

        primeCommands('old-cli-session');
        await settle();

        expect(getAllCommands('old-cli-session').map((c) => c.command))
            .toEqual(['compact', 'clear', 'goal', 'mcp', 'skills']);
    });

    it('serves the machine’s real inventory once the RPC answers, with kinds', async () => {
        sessionInventory.mockResolvedValue({
            success: true,
            inventory: {
                commands: [{ name: 'flip', description: 'Move this session', origin: 'user' }],
                skills: [
                    { name: 'huly-ticket', description: 'File a ticket', origin: 'user' },
                    { name: 'align-conventions', origin: 'user' },
                ],
            },
        });

        primeCommands('live-session');
        await settle();

        const commands = getAllCommands('live-session');
        expect(commands.find((c) => c.command === 'flip')?.kind).toBe('command');
        expect(commands.find((c) => c.command === 'huly-ticket')?.kind).toBe('skill');
        expect(commands.find((c) => c.command === 'huly-ticket')?.description).toBe('File a ticket');
        // The five stay reachable even when the machine's own scan did not name them.
        expect(commands.map((c) => c.command)).toEqual(expect.arrayContaining(['compact', 'clear']));
    });

    it('uses the snapshot’s own lists when there is no RPC answer', async () => {
        mockSessions['codex-session'] = {
            metadata: {
                path: '/tmp/project',
                host: 'localhost',
                slashCommands: ['plan-to-beads', 'superpowers:brainstorming'],
                skills: ['plan-to-beads', 'superpowers:brainstorming'],
            },
        } as Partial<Session>;
        sessionInventory.mockResolvedValue({ success: true, inventory: { commands: [], skills: [] } });

        primeCommands('codex-session');
        await settle();

        const commands = getAllCommands('codex-session');
        expect(commands.find((c) => c.command === 'plan-to-beads')?.kind).toBe('skill');
        expect(commands.find((c) => c.command === 'superpowers:brainstorming')?.kind).toBe('skill');
    });

    it('asks each session for its own inventory, because it depends on the machine', async () => {
        sessionInventory.mockImplementation(async (sessionId: string) => ({
            success: true,
            inventory: { commands: [], skills: [{ name: `only-on-${sessionId}` }] },
        }));

        primeCommands('mac');
        primeCommands('linux-box');
        await settle();

        expect(getAllCommands('mac').map((c) => c.command)).toContain('only-on-mac');
        expect(getAllCommands('mac').map((c) => c.command)).not.toContain('only-on-linux-box');
        expect(getAllCommands('linux-box').map((c) => c.command)).toContain('only-on-linux-box');
    });

    it('narrows as you type', async () => {
        sessionInventory.mockResolvedValue({
            success: true,
            inventory: {
                commands: [],
                skills: [{ name: 'superpowers--brainstorming' }, { name: 'huly-ticket' }],
            },
        });

        primeCommands('typing-session');
        await settle();

        expect((await searchCommands('typing-session', 'brain')).map((c) => c.command))
            .toEqual(['superpowers--brainstorming']);
        expect((await searchCommands('typing-session', 'huly')).map((c) => c.command))
            .toEqual(['huly-ticket']);
    });
});
