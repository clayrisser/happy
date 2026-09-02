/**
 * The node twin of etc/drover.env has to agree with the shell that sources that
 * file (DROVE-315): same names, same defaults, and the same precedence —
 * local.env over an exported var over the built-in default, because sourcing a
 * file assigns unconditionally and it is sourced last. These pin that, and pin
 * the one rule that is easy to get wrong: local.env can override a value but
 * cannot move STATE_DIR, because STATE_DIR is how local.env was found.
 *
 * ONE HOME, NO XDG (DROVE-309). etc/drover.env stopped reading XDG_STATE_HOME
 * when Clay ruled that everything drover owns lives under ~/.drover, on both
 * platforms, and `XDG_*` is not consulted even when it is set. This file used
 * to assert the opposite; the assertion is inverted here rather than deleted,
 * because a node side that still honoured XDG would send half the stack to a
 * directory the shell half has never heard of.
 */

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { droverEnv, droverVar, parseLocalEnv } from './env';

describe('parseLocalEnv — only the plain assignments a shell would set', () => {
    it('takes a bare assignment and an exported one alike', () => {
        expect(parseLocalEnv('DROVER_PORT=8000\nexport DROVER_URL=http://x:9')).toEqual({
            DROVER_PORT: '8000',
            DROVER_URL: 'http://x:9',
        });
    });

    it('strips one layer of single or double quotes', () => {
        expect(parseLocalEnv('A="one"\nB=\'two\'')).toEqual({ A: 'one', B: 'two' });
    });

    it('skips blanks and comments', () => {
        expect(parseLocalEnv('\n# a note\n  \nDROVER_PORT=7000\n')).toEqual({ DROVER_PORT: '7000' });
    });

    it('ends an unquoted value at an inline comment, as sh does', () => {
        expect(parseLocalEnv('DROVER_PORT=8000 # the bus')).toEqual({ DROVER_PORT: '8000' });
    });

    it('leaves a value that still needs a shell to the shell, rather than guessing', () => {
        // A `$(...)` or a backtick is not a value this reader has.
        expect(parseLocalEnv('FOO=$(hostname)\nBAR=`date`\nOK=plain')).toEqual({ OK: 'plain' });
    });
});

describe('droverEnv — defaults, then precedence', () => {
    it('computes every default off HOME when nothing is set', () => {
        const e = droverEnv({}, '/home/me');
        expect(e).toEqual({
            droverDir: '/home/me/Projects/bitspur/cattle-drover',
            forkDir: '/home/me/Projects/bitspur/happy',
            droverHome: '/home/me/.drover',
            // Neither ~/.drover/state nor ~/.local/state/cattle-drover exists
            // under this synthetic home, so drover_home_path lands on the new
            // one: a fresh machine writes straight under ~/.drover.
            stateDir: '/home/me/.drover/state',
            droverPort: '7970',
            droverUrl: 'http://127.0.0.1:7970',
            relayPort: '7971',
            relayUrl: 'http://127.0.0.1:7971',
            serverMode: 'official',
            happyHome: '/home/me/.drover/happy',
            accounts: '/home/me/Projects/bitspur/cattle-drover/accounts.json',
            skipPermissions: '1',
            skipBuild: '0',
            distSettleS: '15',
            localAsk: '1',
            localAskTimeout: '120',
        });
    });

    it('lets an exported var win over the default', () => {
        const e = droverEnv({ DROVER_URL: 'http://host:1234', DROVER_PORT: '9000' }, '/home/me');
        expect(e.droverUrl).toBe('http://host:1234');
        expect(e.droverPort).toBe('9000');
    });

    it('does not consult XDG_STATE_HOME, on either platform (DROVE-309)', () => {
        // The ruling, unprompted, on the ticket: "yeah yeah but it should all
        // be in .drover". etc/drover.env reads DROVER_HOME and nothing else.
        const e = droverEnv({ XDG_STATE_HOME: '/xdg' }, '/home/me');
        expect(e.stateDir).toBe('/home/me/.drover/state');
    });

    it('DROVER_HOME moves the whole tree, which is how a test points at a temp home', () => {
        const e = droverEnv({ DROVER_HOME: '/tmp/dh' }, '/home/me');
        expect(e.droverHome).toBe('/tmp/dh');
        expect(e.stateDir).toBe('/tmp/dh/state');
        expect(e.happyHome).toBe('/tmp/dh/happy');
    });

    it('resolves a mover to the legacy path while that is where the bytes are', () => {
        // Before `drover home migrate` has run, ~/.drover/state does not exist
        // and ~/.local/state/cattle-drover is the only truth. Sending the
        // machine to the empty new path would lose every ledger it has.
        const home = mkdtempSync(join(tmpdir(), 'drover-home-'));
        mkdirSync(join(home, '.local', 'state', 'cattle-drover'), { recursive: true });
        mkdirSync(join(home, '.happy'), { recursive: true });

        const before = droverEnv({}, home);
        expect(before.stateDir).toBe(join(home, '.local', 'state', 'cattle-drover'));
        expect(before.happyHome).toBe(join(home, '.happy'));

        // After the move both exist (the migration leaves a symlink behind),
        // and the canonical spelling is the new one.
        mkdirSync(join(home, '.drover', 'state'), { recursive: true });
        mkdirSync(join(home, '.drover', 'happy'), { recursive: true });
        const after = droverEnv({}, home);
        expect(after.stateDir).toBe(join(home, '.drover', 'state'));
        expect(after.happyHome).toBe(join(home, '.drover', 'happy'));
    });

    it('relay mode keeps its own happy home, so it cannot overwrite the real credentials', () => {
        const e = droverEnv({ DROVER_SERVER_MODE: 'relay', DROVER_HOME: '/tmp/dh' }, '/home/me');
        expect(e.happyHome).toBe('/tmp/dh/state/happy-home');
    });

    it('lets local.env override an exported var, and cannot move STATE_DIR', () => {
        const dh = mkdtempSync(join(tmpdir(), 'drover-env-'));
        mkdirSync(join(dh, 'state'));
        // local.env names a new URL and even tries to move STATE_DIR.
        writeFileSync(
            join(dh, 'state', 'local.env'),
            'DROVER_URL=http://local:1\nSTATE_DIR=/somewhere/else\n',
        );

        const e = droverEnv({ DROVER_HOME: dh, DROVER_URL: 'http://env:2' }, '/home/me');

        expect(e.droverUrl).toBe('http://local:1'); // local.env beats the exported var
        expect(e.stateDir).toBe(join(dh, 'state')); // ...but not STATE_DIR itself
    });
});

describe('droverVar — a name drover.env does not define, read with its precedence', () => {
    it('takes the default, then the exported var, then local.env over both', () => {
        const dh = mkdtempSync(join(tmpdir(), 'drover-env-'));
        mkdirSync(join(dh, 'state'));

        expect(droverVar('DROVER_SHARED_STORE', '/dflt', { DROVER_HOME: dh }, '/home/me')).toBe('/dflt');
        expect(
            droverVar('DROVER_SHARED_STORE', '/dflt', { DROVER_HOME: dh, DROVER_SHARED_STORE: '/exported' }, '/home/me'),
        ).toBe('/exported');

        writeFileSync(join(dh, 'state', 'local.env'), 'DROVER_SHARED_STORE=/local\n');
        expect(
            droverVar('DROVER_SHARED_STORE', '/dflt', { DROVER_HOME: dh, DROVER_SHARED_STORE: '/exported' }, '/home/me'),
        ).toBe('/local');
    });
});
