/**
 * Which header control routes where (DROVE-205). The regression this pins is
 * the one Clay reported: the title pill went to the session settings screen
 * and the worktrees were only reachable from the branch text inside it.
 */
import { describe, expect, it } from 'vitest';
import { sessionHeaderSheet, sessionSettingsRows } from './sessionHeaderRouting';

describe('sessionHeaderSheet', () => {
    it('gives the title pill the worktrees and the avatar the settings', () => {
        expect(sessionHeaderSheet('title')).toBe('worktrees');
        expect(sessionHeaderSheet('avatar')).toBe('settings');
    });

    it('never sends the title pill to settings again', () => {
        expect(sessionHeaderSheet('title')).not.toBe('settings');
    });
});

describe('sessionSettingsRows', () => {
    it('offers session settings, app settings and the accounts screen, in that order', () => {
        const rows = sessionSettingsRows('abc123');
        expect(rows.map((row) => row.key)).toEqual(['session', 'app', 'accounts']);
        expect(rows.map((row) => row.route)).toEqual([
            '/session/abc123/info',
            '/settings',
            '/settings/accounts',
        ]);
    });

    it('links DROVE-165s Accounts screen rather than carrying accounts of its own', () => {
        const accounts = sessionSettingsRows('abc123').find((row) => row.key === 'accounts');
        expect(accounts?.route).toBe('/settings/accounts');
        expect(accounts?.title).toBe('Accounts');
    });
});
