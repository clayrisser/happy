import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, it, expect } from 'vitest';

import { CursorBackend } from './CursorBackend';
import { cursorTurnEnv } from './cursorEnv';
import {
    parseCursorModels,
    splitCursorModelId,
    buildCursorModelCatalog,
    resolveCursorModelId,
    listCursorModels,
    describeCursorListFailure,
    fallbackCursorModelCatalog,
    cursorDefaultDescription,
    cursorFallbackDescription,
} from './cursorModels';

/**
 * A verbatim slice of `cursor-agent --list-models` on 2026.08.25-3e8eec8. Kept
 * real rather than invented, because every rule below is a rule about what
 * Cursor actually prints.
 */
const listed = `Available models

auto - Auto (default)
gpt-5.2 - GPT-5.2
composer-2.5 - Composer 2.5
composer-2.5-fast - Composer 2.5 Fast
cursor-grok-4.6-low - Cursor Grok 4.6 Low
cursor-grok-4.6-high - Cursor Grok 4.6
cursor-grok-4.6-xhigh - Cursor Grok 4.6 Extra High
cursor-grok-4.6-xhigh-fast - Cursor Grok 4.6 Extra High Fast
claude-opus-5-thinking-low - Claude Opus 5 1M Low Thinking
claude-opus-5-thinking-high - Claude Opus 5 1M Thinking
claude-opus-5-thinking-max - Claude Opus 5 1M Max Thinking
`;

describe('splitCursorModelId', () => {
    it('pulls the effort tier out of the id', () => {
        expect(splitCursorModelId('cursor-grok-4.6-xhigh'))
            .toEqual({ base: 'cursor-grok-4.6', effort: 'xhigh', fast: false });
        expect(splitCursorModelId('claude-opus-5-thinking-max'))
            .toEqual({ base: 'claude-opus-5-thinking', effort: 'max', fast: false });
    });

    it('keeps -fast on the base, because it is a serving tier and not an '
        + 'effort: a slider that moved between fast and slow would change what '
        + 'the turn costs without saying so', () => {
        expect(splitCursorModelId('cursor-grok-4.6-xhigh-fast'))
            .toEqual({ base: 'cursor-grok-4.6-fast', effort: 'xhigh', fast: true });
    });

    it('leaves an id with no tier alone', () => {
        expect(splitCursorModelId('gpt-5.2')).toEqual({ base: 'gpt-5.2', effort: null, fast: false });
        expect(splitCursorModelId('auto')).toEqual({ base: 'auto', effort: null, fast: false });
        expect(splitCursorModelId('composer-2.5'))
            .toEqual({ base: 'composer-2.5', effort: null, fast: false });
    });

    it('does not mistake a version fragment for a tier', () => {
        expect(splitCursorModelId('claude-opus-4-8').effort).toBeNull();
    });
});

describe('buildCursorModelCatalog', () => {
    const catalog = buildCursorModelCatalog(parseCursorModels(listed));

    it('collapses sixty near-duplicates into families', () => {
        expect(catalog.models.map((m) => m.code)).toEqual([
            'auto',
            'gpt-5.2',
            'composer-2.5',
            'composer-2.5-fast',
            'cursor-grok-4.6',
            'cursor-grok-4.6-fast',
            'claude-opus-5-thinking',
        ]);
    });

    it('offers only the tiers that some family really has, weakest first', () => {
        expect(catalog.efforts.map((e) => e.code)).toEqual(['low', 'high', 'xhigh', 'max']);
    });

    it('names a family the way a human does, with the tier words removed', () => {
        const grok = catalog.models.find((m) => m.code === 'cursor-grok-4.6');
        expect(grok?.value).toBe('Cursor Grok 4.6');
        const opus = catalog.models.find((m) => m.code === 'claude-opus-5-thinking');
        expect(opus?.value).toBe('Claude Opus 5 1M Thinking');
    });

    // `auto - Auto (default)`. The chip has 27pt for a name and no room for a
    // parenthesis; the fact goes under the row instead (DROVE-395).
    it('takes the (default) suffix off the name and puts it under the row', () => {
        const auto = catalog.models.find((m) => m.code === 'auto');
        expect(auto).toEqual({ code: 'auto', value: 'Auto', description: cursorDefaultDescription });
        expect(catalog.models.filter((m) => m.description).map((m) => m.code)).toEqual(['auto']);
    });
});

describe('resolveCursorModelId', () => {
    const catalog = buildCursorModelCatalog(parseCursorModels(listed));

    it('rejoins family and tier by LOOKUP, so it can only ever name an id '
        + 'cursor-agent already listed', () => {
        expect(resolveCursorModelId(catalog, 'cursor-grok-4.6', 'xhigh')).toBe('cursor-grok-4.6-xhigh');
        expect(resolveCursorModelId(catalog, 'cursor-grok-4.6-fast', 'xhigh'))
            .toBe('cursor-grok-4.6-xhigh-fast');
        expect(resolveCursorModelId(catalog, 'claude-opus-5-thinking', 'max'))
            .toBe('claude-opus-5-thinking-max');
    });

    it('a family with no tiers ignores the effort pick entirely', () => {
        expect(resolveCursorModelId(catalog, 'composer-2.5', 'max')).toBe('composer-2.5');
        expect(resolveCursorModelId(catalog, 'auto', 'low')).toBe('auto');
    });

    it('a tier the family does not have falls back to one it does, because a '
        + 'neighbouring tier beats exit 1 on an id that was never listed', () => {
        expect(resolveCursorModelId(catalog, 'cursor-grok-4.6', 'medium')).toBe('cursor-grok-4.6-high');
        expect(resolveCursorModelId(catalog, 'cursor-grok-4.6', null)).toBe('cursor-grok-4.6-high');
        // No `high` on this one, so the weakest tier it has.
        const partial = buildCursorModelCatalog([{ code: 'x-low', value: 'X Low' }]);
        expect(resolveCursorModelId(partial, 'x', null)).toBe('x-low');
    });

    it('an unknown family is passed through, and no family means no --model', () => {
        expect(resolveCursorModelId(catalog, 'something-new', 'high')).toBe('something-new');
        expect(resolveCursorModelId(catalog, null, 'high')).toBeNull();
    });

    it('never produces a bracket, which was measured to be REJECTED: '
        + "`--model 'composer-2.5[effort=high]'` exits 1 with "
        + '"Cannot use this model"', () => {
        for (const family of catalog.models) {
            for (const effort of [null, 'low', 'medium', 'high', 'xhigh', 'max']) {
                const id = resolveCursorModelId(catalog, family.code, effort);
                expect(id).not.toContain('[');
            }
        }
    });
});

const temps: string[] = [];
afterAll(() => {
    for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/** A cursor-agent that does what the script says. Never the real one. */
function fakeCursorAgent(script: string): { bin: string; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), 'cursor-list-'));
    temps.push(dir);
    const bin = join(dir, 'cursor-agent');
    writeFileSync(bin, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    return { bin, dir };
}

const twoModels = 'printf "Available models\\n\\nauto - Auto (default)\\ncomposer-2.5 - Composer 2.5\\n"';
const bareEnv = { PATH: '/usr/bin:/bin' };

describe('listCursorModels', () => {
    it('returns the rows cursor-agent prints, and no failure', async () => {
        const { bin, dir } = fakeCursorAgent(twoModels);
        expect(await listCursorModels({ bin, cwd: dir, env: bareEnv })).toEqual({
            models: [
                { code: 'auto', value: 'Auto (default)' },
                { code: 'composer-2.5', value: 'Composer 2.5' },
            ],
            failure: null,
        });
    });

    it('runs under the environment it is handed and no other', async () => {
        const { bin, dir } = fakeCursorAgent('/usr/bin/env > "$CURSOR_LIST_ENV_OUT"; ' + twoModels);
        const out = join(dir, 'env.out');
        await listCursorModels({
            bin,
            cwd: dir,
            env: { ...bareEnv, CURSOR_LIST_ENV_OUT: out, CURSOR_CONFIG_DIR: '/cfg/here' },
        });
        const seen = readFileSync(out, 'utf8').split('\n');
        expect(seen).toContain('CURSOR_CONFIG_DIR=/cfg/here');
        expect(seen.some((line) => line.startsWith('HAPPY_HOME_DIR='))).toBe(false);
    });

    // The exit a session started from the phone actually hits (DROVE-387
    // measured it): the login keychain is locked, cursor-agent says so on
    // stderr and exits 1 before a single row. This used to come back as `[]`.
    it('names the exit and the last line cursor-agent said, which is what a locked keychain looks like', async () => {
        const { bin, dir } = fakeCursorAgent('echo "keychain is locked or is denying access" >&2; exit 1');
        expect(await listCursorModels({ bin, cwd: dir, env: bareEnv })).toEqual({
            models: [],
            failure: 'exit 1: keychain is locked or is denying access',
        });
    });

    it('names a binary that is not there', async () => {
        const listing = await listCursorModels({ bin: '/nonexistent/cursor-agent', cwd: tmpdir(), env: bareEnv });
        expect(listing.models).toEqual([]);
        expect(listing.failure).toBe('/nonexistent/cursor-agent not found (ENOENT)');
    });

    it('an exit 0 with no rows is a failure too, not an empty picker', async () => {
        const { bin, dir } = fakeCursorAgent('echo "Please log in first"');
        expect(await listCursorModels({ bin, cwd: dir, env: bareEnv })).toEqual({
            models: [],
            failure: 'exit 0 with no model rows: Please log in first',
        });
    });

    it('names a list that hung', async () => {
        const { bin, dir } = fakeCursorAgent('sleep 5');
        const listing = await listCursorModels({ bin, cwd: dir, env: bareEnv, timeoutMs: 200 });
        expect(listing.models).toEqual([]);
        expect(listing.failure).toBe('killed by SIGTERM after 200ms');
    });

    it('strips colour off the reason and falls back to the message when nothing was said', () => {
        expect(describeCursorListFailure({ code: 2, stderr: '\u001b[31mno such account\u001b[0m\n' }, 'x', 1))
            .toBe('exit 2: no such account');
        expect(describeCursorListFailure({ code: 3, message: 'Command failed' }, 'x', 1)).toBe('exit 3: Command failed');
        expect(describeCursorListFailure({ signal: 'SIGKILL' }, 'x', 1)).toBe('signal SIGKILL');
        expect(describeCursorListFailure(null, 'x', 1)).toBe('failed');
    });
});

describe('CursorBackend.listModels', () => {
    // The acceptance criterion, verbatim: the list runs under the same
    // environment as a turn, so the picker lists only what the turn can run.
    // The turn's env is cursorTurnEnv (CursorBackend.env); the list is asked
    // through the backend so it cannot build its own.
    it('asks under exactly the environment a turn gets: the session config dir, '
        + 'the owned credential home, and no inherited key', async () => {
        const { bin, dir } = fakeCursorAgent('/usr/bin/env > "$CURSOR_LIST_ENV_OUT"; ' + twoModels);
        const out = join(dir, 'env.out');
        const owned = { credentialHome: join(dir, 'owned-home') };
        const prior = {
            HAPPY_CURSOR_PATH: process.env.HAPPY_CURSOR_PATH,
            CURSOR_API_KEY: process.env.CURSOR_API_KEY,
            CURSOR_LIST_ENV_OUT: process.env.CURSOR_LIST_ENV_OUT,
        };
        process.env.HAPPY_CURSOR_PATH = bin;
        process.env.CURSOR_API_KEY = 'inherited-and-must-not-survive';
        process.env.CURSOR_LIST_ENV_OUT = out;
        try {
            const backend = new CursorBackend({
                cwd: dir,
                configDir: join(dir, 'session-config'),
                credential: owned,
                log: () => {},
            });
            const listing = await backend.listModels();
            expect(listing.failure).toBeNull();
            expect(listing.models.map((m) => m.code)).toEqual(['auto', 'composer-2.5']);

            const seen = readFileSync(out, 'utf8').split('\n').filter(Boolean);
            const turn = cursorTurnEnv(join(dir, 'session-config'), owned);
            expect(seen).toContain(`CURSOR_CONFIG_DIR=${turn.CURSOR_CONFIG_DIR}`);
            expect(seen).toContain(`HOME=${owned.credentialHome}`);
            expect(seen).toContain('AGENT_CLI_CREDENTIAL_STORE=file');
            expect(turn.CURSOR_API_KEY).toBeUndefined();
            expect(seen.some((line) => line.startsWith('CURSOR_API_KEY='))).toBe(false);
        } finally {
            for (const [name, value] of Object.entries(prior)) {
                if (value === undefined) delete process.env[name];
                else process.env[name] = value;
            }
        }
    });
});

describe('fallbackCursorModelCatalog', () => {
    it('is auto plus the family the session started with, each marked, and no tiers', () => {
        const catalog = fallbackCursorModelCatalog('claude-opus-5-thinking-xhigh');
        expect(catalog.models).toEqual([
            { code: 'auto', value: 'Auto', description: cursorFallbackDescription },
            { code: 'claude-opus-5-thinking', value: 'claude-opus-5-thinking', description: cursorFallbackDescription },
        ]);
        expect(catalog.efforts).toEqual([]);
    });

    it('rejoins the started family to the exact id the session began on, by lookup', () => {
        const catalog = fallbackCursorModelCatalog('claude-opus-5-thinking-xhigh');
        expect(resolveCursorModelId(catalog, 'claude-opus-5-thinking', null)).toBe('claude-opus-5-thinking-xhigh');
        expect(resolveCursorModelId(catalog, 'claude-opus-5-thinking', 'xhigh')).toBe('claude-opus-5-thinking-xhigh');
        expect(resolveCursorModelId(catalog, 'auto', 'max')).toBe('auto');
    });

    it('a tier the started id does not have lands on the one it does, never on a made-up id', () => {
        const catalog = fallbackCursorModelCatalog('cursor-grok-4.6-xhigh-fast');
        expect(resolveCursorModelId(catalog, 'cursor-grok-4.6-fast', 'low')).toBe('cursor-grok-4.6-xhigh-fast');
    });

    it('is the one row auto when the session started on no --model, or on auto, or on whitespace', () => {
        for (const started of [null, undefined, '', '  ', 'auto']) {
            expect(fallbackCursorModelCatalog(started).models.map((m) => m.code)).toEqual(['auto']);
        }
    });
});
