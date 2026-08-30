import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { droverSkipPermissions, readDroverEnvDefault } from './permissionPolicy';

function droverCheckout(line: string): string {
    const root = mkdtempSync(join(tmpdir(), 'drover-policy-'));
    mkdirSync(join(root, 'etc'));
    writeFileSync(join(root, 'etc', 'drover.env'), `DROVER_DIR="/x"\n${line}\nDROVER_SKIP_BUILD="0"\n`);
    return root;
}

describe('drover permission policy', () => {
    it('reads the default out of etc/drover.env rather than keeping a second copy', () => {
        const root = droverCheckout('DROVER_SKIP_PERMISSIONS="${DROVER_SKIP_PERMISSIONS:-1}"');

        expect(readDroverEnvDefault(join(root, 'etc', 'drover.env'))).toBe('1');
        expect(droverSkipPermissions({}, root)).toBe(true);
    });

    it('follows that file when the default is turned off there', () => {
        const root = droverCheckout('DROVER_SKIP_PERMISSIONS="${DROVER_SKIP_PERMISSIONS:-0}"');

        expect(droverSkipPermissions({}, root)).toBe(false);
    });

    it('accepts a plain assignment as well as the shell default form', () => {
        const root = droverCheckout('export DROVER_SKIP_PERMISSIONS=0');

        expect(droverSkipPermissions({}, root)).toBe(false);
    });

    it('lets the environment override the file, in both directions', () => {
        const off = droverCheckout('DROVER_SKIP_PERMISSIONS="${DROVER_SKIP_PERMISSIONS:-0}"');
        const on = droverCheckout('DROVER_SKIP_PERMISSIONS="${DROVER_SKIP_PERMISSIONS:-1}"');

        expect(droverSkipPermissions({ DROVER_SKIP_PERMISSIONS: '1' }, off)).toBe(true);
        expect(droverSkipPermissions({ DROVER_SKIP_PERMISSIONS: '0' }, on)).toBe(false);
    });

    it('bypasses by default when the drover checkout is not where we expect it', () => {
        expect(readDroverEnvDefault('/nowhere/etc/drover.env')).toBeUndefined();
        expect(droverSkipPermissions({}, '/nowhere')).toBe(true);
    });
});
