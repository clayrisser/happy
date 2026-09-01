/**
 * The node twin of etc/drover.env has to agree with the shell that sources that
 * file (DROVE-315): same names, same defaults, and the same precedence —
 * local.env over an exported var over the built-in default, because sourcing a
 * file assigns unconditionally and it is sourced last. These pin that, and pin
 * the one rule that is easy to get wrong: local.env can override a value but
 * cannot move STATE_DIR, because STATE_DIR is how local.env was found.
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
            stateDir: '/home/me/.local/state/cattle-drover',
            droverPort: '7970',
            droverUrl: 'http://127.0.0.1:7970',
            relayPort: '7971',
            relayUrl: 'http://127.0.0.1:7971',
        });
    });

    it('lets an exported var win over the default', () => {
        const e = droverEnv({ DROVER_URL: 'http://host:1234', DROVER_PORT: '9000' }, '/home/me');
        expect(e.droverUrl).toBe('http://host:1234');
        expect(e.droverPort).toBe('9000');
    });

    it('honours XDG_STATE_HOME for the state dir', () => {
        const e = droverEnv({ XDG_STATE_HOME: '/xdg' }, '/home/me');
        expect(e.stateDir).toBe('/xdg/cattle-drover');
    });

    it('lets local.env override an exported var, and cannot move STATE_DIR', () => {
        const xdg = mkdtempSync(join(tmpdir(), 'drover-env-'));
        mkdirSync(join(xdg, 'cattle-drover'));
        // local.env names a new URL and even tries to move STATE_DIR.
        writeFileSync(
            join(xdg, 'cattle-drover', 'local.env'),
            'DROVER_URL=http://local:1\nSTATE_DIR=/somewhere/else\n',
        );

        const e = droverEnv({ XDG_STATE_HOME: xdg, DROVER_URL: 'http://env:2' }, '/home/me');

        expect(e.droverUrl).toBe('http://local:1'); // local.env beats the exported var
        expect(e.stateDir).toBe(join(xdg, 'cattle-drover')); // ...but not STATE_DIR itself
    });
});

describe('droverVar — a name drover.env does not define, read with its precedence', () => {
    it('takes the default, then the exported var, then local.env over both', () => {
        const xdg = mkdtempSync(join(tmpdir(), 'drover-env-'));
        mkdirSync(join(xdg, 'cattle-drover'));

        expect(droverVar('DROVER_SHARED_STORE', '/dflt', { XDG_STATE_HOME: xdg }, '/home/me')).toBe('/dflt');
        expect(
            droverVar('DROVER_SHARED_STORE', '/dflt', { XDG_STATE_HOME: xdg, DROVER_SHARED_STORE: '/exported' }, '/home/me'),
        ).toBe('/exported');

        writeFileSync(join(xdg, 'cattle-drover', 'local.env'), 'DROVER_SHARED_STORE=/local\n');
        expect(
            droverVar('DROVER_SHARED_STORE', '/dflt', { XDG_STATE_HOME: xdg, DROVER_SHARED_STORE: '/exported' }, '/home/me'),
        ).toBe('/local');
    });
});
