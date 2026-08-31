/**
 * The list-worktrees RPC against fake git output (DROVE-90).
 *
 * git is stubbed: the porcelain shapes here are what `git worktree list
 * --porcelain` prints for a normal checkout, a detached worktree and a bare
 * main, and `git status --porcelain` answers per path. What is pinned is the
 * parse, the dirty mark, that a bare main is never asked for status, and
 * that a missing repoRoot or a git failure comes back as an error rather
 * than a throw.
 */

import { describe, expect, it, vi } from 'vitest';

import { listWorktrees, parseWorktreeList, registerListWorktreesHandler, type GitRunner, type ListWorktreesRequest, type ListWorktreesResponse } from './listWorktrees';

const porcelain = [
    'worktree /Users/clay/Projects/bitspur/happy',
    'HEAD af03569d0000000000000000000000000000af03',
    'branch refs/heads/lane/BASED-113-inline-prompts-and-settings',
    '',
    'worktree /Users/clay/.cache/drover-worktrees/DROVE-90',
    'HEAD 1111111111111111111111111111111111111111',
    'branch refs/heads/lane/DROVE-90-branch-worktrees',
    '',
    'worktree /Users/clay/.cache/drover-worktrees/build10',
    'HEAD e9fd620400000000000000000000000000000000',
    'detached',
    '',
].join('\n');

const bareFirst = [
    'worktree /srv/git/happy.git',
    'bare',
    '',
    'worktree /srv/checkouts/main',
    'HEAD 2222222222222222222222222222222222222222',
    'branch refs/heads/main',
    '',
].join('\n');

function fakeGit(status: Record<string, string>, list = porcelain): { git: GitRunner; calls: Array<[string[], string]> } {
    const calls: Array<[string[], string]> = [];
    const git: GitRunner = async (args, cwd) => {
        calls.push([args, cwd]);
        if (args[0] === 'worktree') return list;
        if (args[0] === 'status') return status[cwd] ?? '';
        throw new Error(`unexpected git ${args.join(' ')}`);
    };
    return { git, calls };
}

describe('parseWorktreeList', () => {
    it('reads path, head and short branch per block, and marks detached and bare', () => {
        expect(parseWorktreeList(porcelain).map((w) => [w.path, w.branch, w.detached, w.bare])).toEqual([
            ['/Users/clay/Projects/bitspur/happy', 'lane/BASED-113-inline-prompts-and-settings', false, false],
            ['/Users/clay/.cache/drover-worktrees/DROVE-90', 'lane/DROVE-90-branch-worktrees', false, false],
            ['/Users/clay/.cache/drover-worktrees/build10', null, true, false],
        ]);
        expect(parseWorktreeList(bareFirst)[0]).toEqual({
            path: '/srv/git/happy.git', head: '', branch: null, bare: true, detached: false,
        });
    });

    it('returns nothing for empty output', () => {
        expect(parseWorktreeList('')).toEqual([]);
    });
});

describe('listWorktrees', () => {
    it('lists from the repo root, marks the first entry main, and asks each worktree whether it is dirty', async () => {
        const { git, calls } = fakeGit({
            '/Users/clay/.cache/drover-worktrees/DROVE-90': ' M packages/happy-cli/src/daemon/listWorktrees.ts\n?? new.ts\n',
        });

        const result = await listWorktrees({ repoRoot: '/Users/clay/.cache/drover-worktrees/DROVE-90' }, git);

        expect(result).toEqual({
            ok: true,
            worktrees: [
                {
                    path: '/Users/clay/Projects/bitspur/happy',
                    branch: 'lane/BASED-113-inline-prompts-and-settings',
                    head: 'af03569d0000000000000000000000000000af03',
                    dirty: false, isMain: true, bare: false, detached: false,
                },
                {
                    path: '/Users/clay/.cache/drover-worktrees/DROVE-90',
                    branch: 'lane/DROVE-90-branch-worktrees',
                    head: '1111111111111111111111111111111111111111',
                    dirty: true, isMain: false, bare: false, detached: false,
                },
                {
                    path: '/Users/clay/.cache/drover-worktrees/build10',
                    branch: null,
                    head: 'e9fd620400000000000000000000000000000000',
                    dirty: false, isMain: false, bare: false, detached: true,
                },
            ],
        });
        expect(calls[0]).toEqual([['worktree', 'list', '--porcelain'], '/Users/clay/.cache/drover-worktrees/DROVE-90']);
        expect(calls.slice(1).map(([args, cwd]) => [args.join(' '), cwd])).toEqual([
            ['status --porcelain', '/Users/clay/Projects/bitspur/happy'],
            ['status --porcelain', '/Users/clay/.cache/drover-worktrees/DROVE-90'],
            ['status --porcelain', '/Users/clay/.cache/drover-worktrees/build10'],
        ]);
    });

    it('never runs status in a bare main and reports it clean', async () => {
        const { git, calls } = fakeGit({ '/srv/checkouts/main': '' }, bareFirst);

        const result = await listWorktrees({ repoRoot: '/srv/checkouts/main' }, git);

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.worktrees.map((w) => [w.path, w.bare, w.isMain, w.dirty, w.branch])).toEqual([
            ['/srv/git/happy.git', true, true, false, null],
            ['/srv/checkouts/main', false, false, false, 'main'],
        ]);
        expect(calls.filter(([args]) => args[0] === 'status').map(([, cwd]) => cwd)).toEqual(['/srv/checkouts/main']);
    });

    it('keeps the list when one worktree cannot answer status', async () => {
        const git: GitRunner = async (args, cwd) => {
            if (args[0] === 'worktree') return porcelain;
            if (cwd.endsWith('build10')) throw Object.assign(new Error('git failed'), { stderr: 'fatal: not a git repository' });
            return '';
        };

        const result = await listWorktrees({ repoRoot: '/Users/clay/Projects/bitspur/happy' }, git);

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.worktrees).toHaveLength(3);
        expect(result.worktrees[2].dirty).toBe(false);
    });

    it('answers with an error, not a throw, for a missing root or a repo git rejects', async () => {
        expect(await listWorktrees({}, fakeGit({}).git)).toEqual({ ok: false, error: 'repoRoot is required' });

        const failing: GitRunner = async () => {
            throw Object.assign(new Error('Command failed'), { stderr: 'fatal: not a git repository (or any of the parent directories): .git\n' });
        };
        expect(await listWorktrees({ repoRoot: '/tmp/nowhere' }, failing)).toEqual({
            ok: false,
            error: 'fatal: not a git repository (or any of the parent directories): .git',
        });
    });
});

describe('registerListWorktreesHandler', () => {
    it('registers the list-worktrees method and serves it with the injected git', async () => {
        const handlers = new Map<string, (req: ListWorktreesRequest) => Promise<ListWorktreesResponse>>();
        const manager = { registerHandler: vi.fn((m: string, h: any) => handlers.set(m, h)) } as never;

        registerListWorktreesHandler(manager, fakeGit({}).git);

        expect(handlers.has('list-worktrees')).toBe(true);
        const result = await handlers.get('list-worktrees')!({ repoRoot: '/Users/clay/Projects/bitspur/happy' });
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.worktrees.map((w) => w.isMain)).toEqual([true, false, false]);
    });
});
