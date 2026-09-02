/**
 * The worktree sheet's tabs and scopes (DROVE-330). Pinned: the four tabs in
 * the order Clay said them, which glyphs a row offers, how a scope turns into
 * a pane request, and the Files tab's path arithmetic.
 */
import { describe, expect, it } from 'vitest';
import {
    breadcrumb,
    fileNotes,
    fileSizeLabel,
    isWorktreeSheetTab,
    joinRel,
    ownScope,
    paneTargetFor,
    paneTrouble,
    parentRel,
    scopeForRow,
    worktreeActions,
    worktreeSheetDefaultTab,
    worktreeSheetTabs,
} from './worktreeSheetTabs';

describe('the tabs', () => {
    it('are the four Clay named, in that order, and open on the worktrees', () => {
        expect(worktreeSheetTabs.map((tab) => tab.key)).toEqual(['worktrees', 'todos', 'terminal', 'files']);
        expect(worktreeSheetDefaultTab).toBe('worktrees');
    });

    it('keep their labels short enough to share one segmented control', () => {
        // Four segments on a 393pt phone. A label that wraps or truncates
        // inside a segment reads as broken.
        for (const tab of worktreeSheetTabs) expect(tab.label.length).toBeLessThanOrEqual(9);
    });

    it('recognise their own keys and nothing else', () => {
        expect(isWorktreeSheetTab('files')).toBe(true);
        expect(isWorktreeSheetTab('settings')).toBe(false);
        expect(isWorktreeSheetTab(undefined)).toBe(false);
    });
});

describe('what a row offers', () => {
    it('offers the terminal only where a session is live, and the folder wherever there is a tree', () => {
        expect(worktreeActions({ bare: false, liveSessionIds: ['s1'] })).toEqual({ terminal: true, files: true });
        expect(worktreeActions({ bare: false, liveSessionIds: [] })).toEqual({ terminal: false, files: true });
    });

    it('offers nothing on a bare checkout', () => {
        expect(worktreeActions({ bare: true, liveSessionIds: ['s1'] })).toEqual({ terminal: false, files: false });
    });

    it('hands the tabs the row\'s path, label and newest live session', () => {
        expect(scopeForRow({ path: '/Users/clay/wt/x', label: '~/wt/x', liveSessionIds: ['new', 'old'] }))
            .toEqual({ path: '/Users/clay/wt/x', label: '~/wt/x', sessionId: 'new' });
        expect(scopeForRow({ path: '/Users/clay/wt/x', label: '~/wt/x', liveSessionIds: [] }).sessionId).toBeNull();
    });
});

describe('the sheet\'s own scope', () => {
    it('is this session in its cwd, home collapsed', () => {
        expect(ownScope({ sessionId: 'me', path: '/Users/clay/Projects/happy', homeDir: '/Users/clay' }))
            .toEqual({ path: '/Users/clay/Projects/happy', label: '~/Projects/happy', sessionId: 'me' });
    });

    it('is nothing when the session has no path yet', () => {
        expect(ownScope({ sessionId: 'me', path: null, homeDir: '/Users/clay' })).toBeNull();
    });
});

describe('asking for a pane', () => {
    it('asks by the harness\'s session id when the app holds one', () => {
        const target = paneTargetFor(
            { path: '/x', label: '~/x', sessionId: 'happy-1' },
            (id) => (id === 'happy-1' ? 'claude-uuid' : null),
        );
        expect(target).toEqual({ sessionId: 'claude-uuid' });
    });

    it('falls back to the path for a session without one, and for no session at all', () => {
        expect(paneTargetFor({ path: '/x', label: '~/x', sessionId: 'cursor-1' }, () => undefined)).toEqual({ cwd: '/x' });
        expect(paneTargetFor({ path: '/x', label: '~/x', sessionId: null }, () => 'never asked')).toEqual({ cwd: '/x' });
    });

    it('turns the bus\'s short refusals into sentences and leaves the rest alone', () => {
        expect(paneTrouble('no pane')).toContain('started by the daemon');
        expect(paneTrouble('no live session in that worktree')).toContain('Worktrees tab');
        expect(paneTrouble('The drover bus is not running on this machine (drover bus).')).toBe('The drover bus is not running on this machine (drover bus).');
    });
});

describe('the Files tab\'s paths', () => {
    it('joins and climbs relative to the root, which is the empty string', () => {
        expect(joinRel('', 'src')).toBe('src');
        expect(joinRel('src', 'app.ts')).toBe('src/app.ts');
        expect(parentRel('src/app.ts')).toBe('src');
        expect(parentRel('src')).toBe('');
        expect(parentRel('')).toBe('');
    });

    it('draws the crumb as the scope then the path inside it', () => {
        expect(breadcrumb('~/wt/x', '')).toBe('~/wt/x');
        expect(breadcrumb('~/wt/x', 'src/app')).toBe('~/wt/x/src/app');
    });

    it('sizes a file the way a person reads it, and a directory not at all', () => {
        expect(fileSizeLabel(null)).toBe('');
        expect(fileSizeLabel(340)).toBe('340 B');
        expect(fileSizeLabel(1234)).toBe('1.2 KB');
        expect(fileSizeLabel(200 * 1024)).toBe('200 KB');
        expect(fileSizeLabel(3.1 * 1024 * 1024)).toBe('3.1 MB');
    });

    it('says what the drover did to a file, and nothing when it did nothing', () => {
        expect(fileNotes({ truncated: false, binary: false, redacted: 0, size: 10 })).toEqual([]);
        expect(fileNotes({ truncated: true, binary: false, redacted: 2, size: 300 * 1024 })).toEqual(['first 256 KB of 300 KB', '2 secrets masked']);
        expect(fileNotes({ truncated: false, binary: true, redacted: 0, size: 10 })).toEqual(['binary, not shown']);
        expect(fileNotes({ truncated: false, binary: false, redacted: 1, size: 10 })).toEqual(['1 secret masked']);
    });
});
