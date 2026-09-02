/**
 * `drover account-edit` answers to its OWN NAME in node (DROVE-315 wave 4).
 *
 * The logic has been here since wave 2a, and `accounts.test.ts` already checks
 * `add` / `rm` / `rename` against the shell through `drover account`. What was
 * missing is the thing cattle-drover's owner table needed before it could flip
 * the row: a row in `droverVerbs` so `runDroverVerb('account-edit', ...)`
 * resolves. Without one the word fell PAST the table, and the fork's entry
 * hands a subcommand it does not recognise to Claude AS A PROMPT — which is
 * why the arm flip had to leave this verb on shell and say so out loud.
 *
 * So this file asserts the reachability and the two argv shapes that decide
 * nothing: `--help` (and the bare call, which the shell also answers with the
 * usage) and an unknown verb. Both are compared to libexec/drover-account-edit
 * byte for byte, and neither reads the registry.
 *
 * DROVE-336 fence: HAPPY_HOME_DIR is a mkdtemp pinned above the first import,
 * HOME is a mkdtemp, and the registry the fixture names does not exist — so a
 * path that decided to read one would fail rather than reach Clay's.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

import { droverEnv } from './env';
import { droverVerbs, knowsDroverVerb, runDroverVerb } from './index';

const { happyHome, realHappyHome } = await vi.hoisted(async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const realHappyHome = path.join(os.homedir(), '.happy');
    const happyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'account-edit-happy-'));
    process.env.HAPPY_HOME_DIR = happyHome;
    process.env.HAPPY_SERVER_URL = 'http://127.0.0.1:1';
    return { happyHome, realHappyHome };
});

vi.mock('../../configuration', () => {
    throw new Error('account-edit.test: configuration (the ~/.happy reader) was imported; this verb must not reach the session machinery');
});
vi.mock('../../api/api', () => {
    throw new Error('account-edit.test: api/api (session registration) was imported; this verb must not reach the session machinery');
});

const droverDir = droverEnv({ ...process.env, DROVER_DIR: process.env.DROVER_DIR }).droverDir;
const shellVerb = join(droverDir, 'libexec', 'drover-account-edit');

const root = mkdtempSync(join(tmpdir(), 'drover-account-edit-'));
const fixture: Record<string, string | undefined> = {
    HOME: root,
    DROVER_DIR: droverDir,
    // A registry that is not there: nothing on these paths may read one.
    DROVER_ACCOUNTS: join(root, 'no-such-accounts.json'),
    HAPPY_HOME_DIR: happyHome,
    HAPPY_SERVER_URL: 'http://127.0.0.1:1',
    DROVER_URL: 'http://127.0.0.1:1',
    PATH: process.env.PATH,
};

function refuseRealHappyHome(where: string): void {
    const raw = fixture.HAPPY_HOME_DIR;
    const at = raw ? resolve(raw.replace(/^~/, homedir())) : resolve(realHappyHome);
    if (at === resolve(realHappyHome)) {
        throw new Error(`${where}: HAPPY_HOME_DIR resolves to the real ${realHappyHome}. Refusing.`);
    }
}

interface Ran { stdout: string; stderr: string; code: number }

function shell(args: string[]): Ran {
    refuseRealHappyHome('account-edit.test shell');
    const r = spawnSync(shellVerb, args, { env: fixture as NodeJS.ProcessEnv, encoding: 'utf8' });
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status ?? 0 };
}

/** The verb through the TABLE, which is the thing under test. */
async function node(args: string[]): Promise<Ran> {
    refuseRealHappyHome('account-edit.test node');
    const saved = process.env;
    let stdout = '';
    let stderr = '';
    const outWrite = process.stdout.write.bind(process.stdout);
    const errWrite = process.stderr.write.bind(process.stderr);
    process.env = fixture as NodeJS.ProcessEnv;
    (process.stdout as unknown as { write: (c: string) => boolean }).write = (c: string) => {
        stdout += c;
        return true;
    };
    (process.stderr as unknown as { write: (c: string) => boolean }).write = (c: string) => {
        stderr += c;
        return true;
    };
    try {
        const code = await runDroverVerb('account-edit', args);
        return { stdout, stderr, code: code ?? -1 };
    } finally {
        process.env = saved;
        (process.stdout as unknown as { write: typeof outWrite }).write = outWrite;
        (process.stderr as unknown as { write: typeof errWrite }).write = errWrite;
    }
}

afterAll(() => {
    const left = existsSync(happyHome) ? readdirSync(happyHome) : [];
    expect(left).toEqual([]);
    rmSync(happyHome, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
});

describe('drover account-edit — the bare name is a verb', () => {
    it('is in the table exactly once, and the table answers it', () => {
        expect(knowsDroverVerb('account-edit')).toBe(true);
        expect(droverVerbs.filter((v) => v.name === 'account-edit')).toHaveLength(1);
        // The row every other row also has to have: a summary, and a lazy load.
        const row = droverVerbs.find((v) => v.name === 'account-edit');
        expect(row?.summary).toContain('add / rm / rename');
        expect(typeof row?.load).toBe('function');
    });

    it('answers --help and the bare call with the shell\'s usage, byte for byte', async () => {
        for (const args of [['--help'], ['-h'], []]) {
            const sh = shell(args);
            const nd = await node(args);
            expect(nd.stdout, args.join(' ')).toBe(sh.stdout);
            expect(nd.stderr, args.join(' ')).toBe(sh.stderr);
            expect(nd.code, args.join(' ')).toBe(sh.code);
            expect(sh.code, args.join(' ')).toBe(0);
            // Not two empty answers: the rule that makes this verb safe is in
            // the text it prints.
            expect(nd.stdout, args.join(' ')).toContain('drover account add|rm|rename');
        }
    });

    it('refuses an unknown verb the same way, and never reads the registry', async () => {
        const sh = shell(['nope']);
        const nd = await node(['nope']);
        expect(nd.stderr).toBe(sh.stderr);
        expect(nd.code).toBe(sh.code);
        expect(nd.code).toBe(2);
        expect(nd.stderr).toContain("unknown verb 'nope' (add, rm, rename)");
        expect(existsSync(fixture.DROVER_ACCOUNTS as string)).toBe(false);
    });
});
