import { describe, expect, it } from 'vitest';

import { CLONE_TARGET_ORDER, cloneRefusal, cloneTargetOptions } from './cloneTargets';

describe('where a clone started from the phone can land', () => {
    it('offers exactly the harnesses that have both a clone lane and a runner', () => {
        expect([...CLONE_TARGET_ORDER]).toEqual(['claude', 'cursor', 'pi']);
    });

    // opencode has a clone lane (DROVE-56) and no daemon runner, so a phone
    // clone into it would open a window and wait forever for a session that
    // never registers. Offering it would be the mistake pi's own ticket
    // avoided by landing the runner first.
    it('leaves opencode off, because the daemon cannot spawn it', () => {
        expect(CLONE_TARGET_ORDER).not.toContain('opencode');
    });

    it('names each target the way the rest of the app names it', () => {
        const options = cloneTargetOptions({ claude: true, cursor: true, pi: true });

        expect(options.map((option) => option.name)).toEqual(['Claude Code', 'Cursor', 'Pi']);
    });

    // Cursor and pi are the two the daemon has to say it found. A machine
    // whose daemon predates that report says nothing for them, and nothing
    // means no: offering a harness with no binary produces a spawn that fails
    // only after the tmux window has already opened.
    it('refuses cursor on a machine that never reported it', () => {
        const options = cloneTargetOptions({ claude: true });

        expect(options.find((option) => option.key === 'cursor')?.available).toBe(false);
    });

    it('offers cursor once the machine reports it installed', () => {
        const options = cloneTargetOptions({ claude: true, cursor: true });

        expect(options.find((option) => option.key === 'cursor')?.available).toBe(true);
    });

    it('still lists an unavailable target, so the row can explain itself', () => {
        expect(cloneTargetOptions(null).map((option) => option.key)).toEqual(['claude', 'cursor', 'pi']);
    });
});

describe('whether a session can be cloned at all', () => {
    const online = {
        flavor: 'claude',
        claudeSessionId: 'db93e97b-9857-440f-ab9c-f265bd007e28',
        machineOnline: true,
    };

    it('allows a Claude session on a machine that is up', () => {
        expect(cloneRefusal(online)).toBeNull();
    });

    // `drover clone` exports a CLAUDE transcript and nothing else, so a Codex
    // or Cursor session has nothing this path can read.
    it('refuses a non-Claude session with a reason of its own', () => {
        expect(cloneRefusal({ ...online, flavor: 'codex' })).toBe('not-claude');
        expect(cloneRefusal({ ...online, flavor: 'cursor' })).toBe('not-claude');
    });

    it('refuses a session that has written no Claude conversation yet', () => {
        expect(cloneRefusal({ ...online, claudeSessionId: null })).toBe('no-conversation');
        expect(cloneRefusal({ ...online, claudeSessionId: '  ' })).toBe('no-conversation');
    });

    it('refuses while the machine that owns the session is offline', () => {
        expect(cloneRefusal({ ...online, machineOnline: false })).toBe('machine-offline');
    });

    // A session with no flavor at all is Claude Code's, the way it is
    // everywhere else in the app.
    it('treats an unstamped flavor as Claude', () => {
        expect(cloneRefusal({ ...online, flavor: undefined })).toBeNull();
    });
});
