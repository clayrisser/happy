import { describe, it, expect } from 'vitest';

import {
    cursorPermissionArgs,
    cursorPermissionCatalog,
    cursorModeSkipsPermissions,
} from './cursorPermission';

describe('cursorPermissionArgs', () => {
    it('maps each published mode onto real cursor-agent argv', () => {
        expect(cursorPermissionArgs('plan')).toEqual(['--mode', 'plan']);
        expect(cursorPermissionArgs('read-only')).toEqual(['--mode', 'ask']);
        expect(cursorPermissionArgs('default')).toEqual(['--auto-review']);
        expect(cursorPermissionArgs('bypassPermissions')).toEqual(['--force']);
    });

    it('falls back to --force, because a mode this build does not know must '
        + 'not silently turn the session read-only', () => {
        expect(cursorPermissionArgs('acceptEdits')).toEqual(['--force']);
        expect(cursorPermissionArgs(null)).toEqual(['--force']);
        expect(cursorPermissionArgs(undefined)).toEqual(['--force']);
    });
});

describe('cursorPermissionCatalog', () => {
    it('offers auto-review only when a gate can answer it', () => {
        const plain = cursorPermissionCatalog().map((m) => m.code);
        expect(plain).toEqual(['bypassPermissions', 'plan', 'read-only']);
        const gated = cursorPermissionCatalog({ gated: true }).map((m) => m.code);
        expect(gated).toContain('default');
    });

    it('publishes more than one mode, or the app hides the picker entirely', () => {
        expect(cursorPermissionCatalog().length).toBeGreaterThan(1);
    });

    it('every published code maps to argv that is not the fallback by accident', () => {
        for (const mode of cursorPermissionCatalog({ gated: true })) {
            const args = cursorPermissionArgs(mode.code);
            expect(args.length).toBeGreaterThan(0);
        }
    });
});

describe('cursorModeSkipsPermissions', () => {
    it('is true only where nothing will actually be asked', () => {
        expect(cursorModeSkipsPermissions('bypassPermissions')).toBe(true);
        expect(cursorModeSkipsPermissions(null)).toBe(true);
        expect(cursorModeSkipsPermissions('plan')).toBe(false);
        expect(cursorModeSkipsPermissions('read-only')).toBe(false);
        expect(cursorModeSkipsPermissions('default')).toBe(false);
    });
});
