/**
 * The worktree sheet's rows (DROVE-90): the daemon's list joined with what
 * the app knows. Pinned: the current mark lands on this session's cwd and
 * nowhere else, live counts match by cwd and ignore dead sessions, the home
 * collapses to `~`, and a detached or bare entry still gets a readable branch.
 */
import { describe, expect, it } from 'vitest';
import { buildWorktreeRows, collapseHome, describeBranch, type WorktreeSource } from './worktreeRows';

const home = '/Users/clay';
const worktrees: WorktreeSource[] = [
    { path: '/Users/clay/Projects/bitspur/happy', branch: 'lane/BASED-113-inline-prompts-and-settings', head: 'af03569d00', dirty: false, isMain: true, bare: false, detached: false },
    { path: '/Users/clay/.cache/drover-worktrees/DROVE-90', branch: 'lane/DROVE-90-branch-worktrees', head: '1111111111', dirty: true, isMain: false, bare: false, detached: false },
    { path: '/Users/clay/.cache/drover-worktrees/build10', branch: null, head: 'e9fd620400', dirty: false, isMain: false, bare: false, detached: true },
];

describe('buildWorktreeRows', () => {
    it('marks only the worktree this session is in, and keeps git order with main first', () => {
        const rows = buildWorktreeRows({
            worktrees,
            currentPath: '/Users/clay/.cache/drover-worktrees/DROVE-90/',
            homeDir: home,
            sessions: [],
        });
        expect(rows.map((row) => [row.label, row.current, row.isMain])).toEqual([
            ['~/Projects/bitspur/happy', false, true],
            ['~/.cache/drover-worktrees/DROVE-90', true, false],
            ['~/.cache/drover-worktrees/build10', false, false],
        ]);
    });

    it('counts live sessions by cwd, newest first, and ignores dead ones and other paths', () => {
        const rows = buildWorktreeRows({
            worktrees,
            currentPath: '/Users/clay/Projects/bitspur/happy',
            homeDir: home,
            sessions: [
                { id: 'old', path: '/Users/clay/.cache/drover-worktrees/DROVE-90', live: true, updatedAt: 1 },
                { id: 'new', path: '/Users/clay/.cache/drover-worktrees/DROVE-90/', live: true, updatedAt: 2 },
                { id: 'dead', path: '/Users/clay/.cache/drover-worktrees/DROVE-90', live: false, updatedAt: 3 },
                { id: 'elsewhere', path: '/Users/clay/Projects/other', live: true, updatedAt: 4 },
                { id: 'main', path: '/Users/clay/Projects/bitspur/happy', live: true, updatedAt: 5 },
            ],
        });
        expect(rows.map((row) => row.liveSessionIds)).toEqual([['main'], ['new', 'old'], []]);
    });

    it('carries the dirty mark and names a detached or bare worktree by what it is', () => {
        const rows = buildWorktreeRows({ worktrees, currentPath: null, homeDir: null, sessions: [] });
        expect(rows.map((row) => [row.branch, row.dirty])).toEqual([
            ['lane/BASED-113-inline-prompts-and-settings', false],
            ['lane/DROVE-90-branch-worktrees', true],
            ['detached e9fd620', false],
        ]);
        expect(rows.every((row) => !row.current)).toBe(true);
        expect(rows[0].label).toBe('/Users/clay/Projects/bitspur/happy');
        expect(describeBranch({ branch: null, head: '', bare: true, detached: false })).toBe('bare');
    });
});

describe('collapseHome', () => {
    it('folds the home directory and nothing that merely shares its prefix', () => {
        expect(collapseHome('/Users/clay/Projects/x', '/Users/clay')).toBe('~/Projects/x');
        expect(collapseHome('/Users/clay', '/Users/clay/')).toBe('~');
        expect(collapseHome('/Users/clayton/x', '/Users/clay')).toBe('/Users/clayton/x');
        expect(collapseHome('/srv/x', null)).toBe('/srv/x');
    });
});
