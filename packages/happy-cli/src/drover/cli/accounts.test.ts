/**
 * The accounts family, checked against the shell it was ported from
 * (DROVE-315 wave 2a).
 *
 * ONE FIXTURE, TWO IMPLEMENTATIONS, BYTE FOR BYTE. Each verb here runs the
 * cattle-drover shell file and the node port over the SAME fixture home,
 * registry, ledger and cursor store, and compares stdout, stderr and the exit
 * code exactly. That is the whole point of the port's contract: `--json` is
 * what the phone, the bridge and drover-flip-policy read, and a character of
 * drift there is a surface disagreeing with the terminal.
 *
 * NOTHING HERE TOUCHES ANYTHING REAL. HAPPY_HOME_DIR is pinned to a throwaway
 * directory before the first import and refused at every run and spawn; HOME
 * is a temp dir, so ~/.claude, ~/.claude-accounts and the cursor token store
 * are the fixture's and never Clay's; DROVER_URL points at a port nothing
 * listens on, so `rm` asking about live sessions cannot reach the real bus;
 * and no test starts a session, a login or a tmux server. The only credential
 * shaped thing in the fixture is an `oauthAccount` address, which is identity,
 * not a secret.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { droverEnv } from './env';

/**
 * A throwaway HAPPY_HOME_DIR, pinned above every import (DROVE-336).
 *
 * A bench that did not set it once registered seventy-eight real sessions on
 * Clay's phone, because the entry takes an unknown word to Claude and Claude
 * registers. Nothing in this file goes near the entry, and this is what makes
 * that a fact rather than an intention.
 */
const { happyHome, realHappyHome } = await vi.hoisted(async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const realHappyHome = path.join(os.homedir(), '.happy');
    const happyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'accounts-happy-'));
    process.env.HAPPY_HOME_DIR = happyHome;
    process.env.HAPPY_SERVER_URL = 'http://127.0.0.1:1';
    return { happyHome, realHappyHome };
});

// The modules a session registration goes through. These verbs import none of
// them; a factory that throws turns a future import into a failure of this
// whole file at load, instead of a test that quietly reads ~/.happy.
vi.mock('../../configuration', () => {
    throw new Error('accounts.test: configuration (the ~/.happy reader) was imported; these verbs must not reach the session machinery');
});
vi.mock('../../persistence', () => {
    throw new Error('accounts.test: persistence (access.key, settings) was imported; these verbs must not reach the session machinery');
});
vi.mock('../../api/api', () => {
    throw new Error('accounts.test: api/api (session registration) was imported; these verbs must not reach the session machinery');
});
vi.mock('../../claude/runClaude', () => {
    throw new Error('accounts.test: claude/runClaude was imported; these verbs must not reach the session machinery');
});

type Env = Record<string, string | undefined>;

function refuseRealHappyHome(env: Env, where: string): void {
    const raw = env.HAPPY_HOME_DIR;
    const at = raw ? resolve(raw.replace(/^~/, homedir())) : resolve(realHappyHome);
    if (at === resolve(realHappyHome)) {
        throw new Error(`${where}: HAPPY_HOME_DIR resolves to the real ${realHappyHome}. Refusing.`);
    }
}

const droverDir = droverEnv({ ...process.env, DROVER_DIR: process.env.DROVER_DIR }).droverDir;
const shellVerb = (name: string): string => join(droverDir, 'libexec', name);

let root = '';
let fixture: Record<string, string> = {};

/**
 * The fixture, and every value in it is chosen to be time-independent.
 *
 * The resets are in 2099 so both implementations read the account as cooling
 * whatever second they run in, and the cursor store is EMPTY so the token
 * state is `missing` rather than a JWT clock comparison that could tick over
 * between the two runs.
 *
 * The registry deliberately holds the DROVE-338 shape: a Claude row and a
 * Cursor row with one address, cursor FIRST, so a reader that takes the first
 * row by name gets the wrong one.
 */
function makeFixture(): Record<string, string> {
    root = mkdtempSync(join(tmpdir(), 'drover-accounts-'));
    const home = join(root, 'home');
    const state = join(root, 'state');
    mkdirSync(join(home, '.claude'), { recursive: true });
    mkdirSync(join(home, '.claude-accounts', 'a6'), { recursive: true });
    mkdirSync(join(home, '.claude-accounts', 'lost'), { recursive: true });
    mkdirSync(state, { recursive: true });

    writeFileSync(join(home, '.claude.json'), `${JSON.stringify({
        oauthAccount: { emailAddress: 'main@example.com' },
        hasCompletedOnboarding: true,
        cachedUsageUtilization: {
            utilization: {
                limits: [
                    {
                        percent: 42.5,
                        kind: 'session',
                        resets_at: '2099-01-01T00:00:00.000000+00:00',
                        scope: { model: { display_name: 'Opus 4.8' } },
                    },
                    { percent: 100, kind: 'weekly_all', resets_at: '2099-01-02T03:04:05.123456+00:00', scope: {} },
                ],
            },
        },
    })}\n`);
    // Logged in but NEVER RUN: no hasCompletedOnboarding, which is the row that
    // must read `ready · never run` and not `ready` (DROVE-246).
    writeFileSync(join(home, '.claude-accounts', 'a6', '.claude.json'),
        `${JSON.stringify({ oauthAccount: { emailAddress: 'clay@example.com' } })}\n`);
    // An orphan: a real login under ~/.claude-accounts that no row points at.
    writeFileSync(join(home, '.claude-accounts', 'lost', '.claude.json'),
        `${JSON.stringify({ oauthAccount: { emailAddress: 'main@example.com' } })}\n`);

    const registry = join(root, 'accounts.json');
    writeFileSync(registry, `${JSON.stringify([
        { name: 'main', configDir: 'default' },
        { name: 'clay@example.com', harness: 'cursor', authId: 'auth0|c' },
        { name: 'clay@example.com', configDir: '~/.claude-accounts/a6' },
        { name: 'nologin', configDir: '~/.claude-accounts/never' },
    ], null, 2)}\n`);
    writeFileSync(join(state, 'cooldowns.json'), `${JSON.stringify({
        'clay@example.com': { until: 4102444800000, at: 1, reason: "You've reached your Fable limit" },
    })}\n`);
    writeFileSync(join(state, 'cursor-auth.json'), '{}\n');

    return {
        HOME: home,
        STATE_DIR: state,
        DROVER_ACCOUNTS: registry,
        DROVER_DIR: droverDir,
        DROVER_URL: 'http://127.0.0.1:1',
        DROVER_CURSOR_AUTH: join(state, 'cursor-auth.json'),
        DROVER_SHARED_STORE: join(root, 'no-shared-store'),
        DROVER_ACCOUNTS_WIDTH: '100',
        DROVER_CREDENTIAL_WAIT_S: '0',
        HAPPY_HOME_DIR: happyHome,
        HAPPY_SERVER_URL: 'http://127.0.0.1:1',
        PATH: process.env.PATH ?? '',
        // HOME is the fixture's, and the asdf shims that provide jq resolve
        // their data dir from $HOME unless told otherwise — so the shell verb
        // would exec a shim that cannot find its own runtime and exit 126
        // before printing a line. These two are read-only pointers at the
        // toolchain, not at anything of Clay's the fixture is standing in for.
        ASDF_DIR: process.env.ASDF_DIR ?? `${homedir()}/.asdf`,
        ASDF_DATA_DIR: process.env.ASDF_DATA_DIR ?? `${homedir()}/.asdf`,
    };
}

interface Ran {
    stdout: string;
    stderr: string;
    code: number;
}

/**
 * The two implementations edit two COPIES of the registry, so each names its
 * own path in the sentence it prints. That path is the one legitimate
 * difference; everything else has to match, so it is folded and nothing else
 * is.
 */
function fold(text: string): string {
    return text.replaceAll(/twin-(?:sh|nd)-/g, 'twin-');
}

/** The shell verb, on the fixture, with nothing of the real environment left. */
function shell(name: string, args: string[], extra: Env = {}): Ran {
    const env = { ...fixture, ...extra } as Record<string, string>;
    refuseRealHappyHome(env, `accounts.test: spawn ${name}`);
    const res = spawnSync(shellVerb(name), args, { env, encoding: 'utf8' });
    if (res.error || res.status === 126 || res.status === 127) {
        throw new Error(`accounts.test: could not run ${shellVerb(name)} (status ${res.status}, ${String(res.error)}) stderr=${res.stderr}`);
    }
    return { stdout: res.stdout ?? '', stderr: res.stderr ?? '', code: res.status ?? 0 };
}

/** The node verb, in this process, with process.env swapped for the fixture. */
async function node(
    load: () => Promise<{ run: (args: string[]) => Promise<number> }>,
    args: string[],
    extra: Env = {},
): Promise<Ran> {
    const env = { ...fixture, ...extra } as Record<string, string>;
    refuseRealHappyHome(env, 'accounts.test: in-process run');
    const saved = process.env;
    let stdout = '';
    let stderr = '';
    const outWrite = process.stdout.write.bind(process.stdout);
    const errWrite = process.stderr.write.bind(process.stderr);
    process.env = env as NodeJS.ProcessEnv;
    (process.stdout as unknown as { write: (c: string) => boolean }).write = (c: string) => {
        stdout += c;
        return true;
    };
    (process.stderr as unknown as { write: (c: string) => boolean }).write = (c: string) => {
        stderr += c;
        return true;
    };
    try {
        const { run } = await load();
        const code = await run(args);
        return { stdout, stderr, code };
    } finally {
        process.env = saved;
        (process.stdout as unknown as { write: typeof outWrite }).write = outWrite;
        (process.stderr as unknown as { write: typeof errWrite }).write = errWrite;
    }
}

beforeAll(() => {
    refuseRealHappyHome(process.env, 'accounts.test');
    fixture = makeFixture();
});

afterAll(() => {
    // The pinned happy home is exactly as empty as mkdtemp made it: nothing
    // here registered a session or opened the entry.
    const left = existsSync(happyHome) ? readdirSync(happyHome) : [];
    expect(left).toEqual([]);
    rmSync(happyHome, { recursive: true, force: true });
    if (root !== '') rmSync(root, { recursive: true, force: true });
});

describe('accounts', () => {
    it('--json is byte-identical to the shell on the same fixture', async () => {
        const sh = shell('drover-accounts', ['--json']);
        const nd = await node(() => import('./accounts'), ['--json']);
        expect(sh.code).toBe(0);
        expect(nd.stdout).toBe(sh.stdout);
        expect(nd.code).toBe(sh.code);
        // And it really is the DROVE-338 / DROVE-246 shape, not two empty arrays.
        const rows = JSON.parse(nd.stdout) as Record<string, unknown>[];
        expect(rows.map((r) => r.harness)).toEqual(['claude', 'cursor', 'claude', 'claude']);
        expect(rows.map((r) => r.sameLoginAs)).toEqual([null, null, null, null]);
        expect(rows[0].state).toBe('cooling');
        expect(rows[1].state).toBe('no login');
        expect(rows[2].onboarded).toBe(false);
        expect(rows[3].loggedIn).toBe(false);
    });

    it('the table is byte-identical to the shell, orphan report and all', async () => {
        const sh = shell('drover-accounts', []);
        const nd = await node(() => import('./accounts'), []);
        expect(sh.code).toBe(0);
        expect(nd.stdout).toBe(sh.stdout);
        // Not two empty tables: the model-scoped cooling label, the never-run
        // continuation under it, the ledger footer and the orphan report are
        // all really there.
        expect(nd.stdout).toContain('Fable cooling · back ');
        expect(nd.stdout).toContain('logged in, but never run — a session here opens the first-run');
        expect(nd.stdout).toContain('a model in STATE means only THAT model is out');
        expect(nd.stdout).toContain('~/.claude-accounts/lost');
        expect(nd.stdout).toContain('duplicate: main is registered at default');
    });

    it('--orphans --json is byte-identical, and an unknown argument exits 2 the same way', async () => {
        const sh = shell('drover-accounts', ['--orphans', '--json']);
        const nd = await node(() => import('./accounts'), ['--orphans', '--json']);
        expect(nd.stdout).toBe(sh.stdout);
        const bad = shell('drover-accounts', ['--nope']);
        const badNode = await node(() => import('./accounts'), ['--nope']);
        expect(badNode.code).toBe(2);
        expect(badNode.code).toBe(bad.code);
        expect(badNode.stderr).toBe(bad.stderr);
    });
});

describe('account-of', () => {
    it('resolves the same name as the shell in every branch', async () => {
        const cases: Env[] = [
            // The ambient account: unset means ambient, and ~/.claude is the
            // same spelling, so both name `main`.
            { CLAUDE_CONFIG_DIR: undefined, DROVER_ACCOUNT: undefined },
            // A config dir the registry holds, with a trailing slash.
            { CLAUDE_CONFIG_DIR: `${fixture.HOME}/.claude-accounts/a6/`, DROVER_ACCOUNT: 'stale' },
            // A config dir it does NOT hold, named by its login instead.
            { CLAUDE_CONFIG_DIR: `${fixture.HOME}/.claude-accounts/lost`, DROVER_ACCOUNT: undefined },
            // Nothing measurable falls back to the stamp, not to silence.
            { CLAUDE_CONFIG_DIR: `${fixture.HOME}/nowhere`, DROVER_ACCOUNT: 'stamped' },
            // And with no stamp either, nothing at all — still exit 0.
            { CLAUDE_CONFIG_DIR: `${fixture.HOME}/nowhere`, DROVER_ACCOUNT: undefined },
        ];
        for (const env of cases) {
            const sh = shell('drover-account-of', [], env);
            const nd = await node(() => import('./account-of'), [], env);
            expect(nd.stdout, JSON.stringify(env)).toBe(sh.stdout);
            expect(nd.code).toBe(0);
            expect(sh.code).toBe(0);
        }
        // Not a tautology of two empty answers.
        const ambient = await node(() => import('./account-of'), [], cases[0]);
        expect(ambient.stdout).toBe('main\n');
        const byLogin = await node(() => import('./account-of'), [], cases[2]);
        expect(byLogin.stdout).toBe('main\n');
    });
});

describe('account', () => {
    it('refuses a cursor-only name for `use`, word for word, and answers --help itself', async () => {
        // A name a Claude row also answers to is NOT refused (DROVE-338), so
        // the refusal is measured on a name only the cursor row holds.
        const registry = JSON.parse(readFileSync(fixture.DROVER_ACCOUNTS, 'utf8')) as Record<string, unknown>[];
        const cursorOnly = join(root, 'cursor-only.json');
        writeFileSync(cursorOnly, `${JSON.stringify(registry.filter((r) => r.configDir !== '~/.claude-accounts/a6'))}\n`);
        const env = { DROVER_ACCOUNTS: cursorOnly };
        const sh = shell('drover-account', ['use', 'clay@example.com'], env);
        const nd = await node(() => import('./account'), ['use', 'clay@example.com'], env);
        expect(nd.stderr).toBe(sh.stderr);
        expect(nd.code).toBe(sh.code);
        expect(nd.code).toBe(2);
        expect(nd.stderr).toContain('drover cursor --account clay@example.com');

        const shHelp = shell('drover-account', ['--help']);
        const ndHelp = await node(() => import('./account'), ['--help']);
        expect(ndHelp.stdout).toBe(shHelp.stdout);
        expect(ndHelp.code).toBe(0);
    });
});

describe('account-edit', () => {
    /** Two identical copies of the registry and ledger, one per implementation. */
    function twin(tag: string): Env {
        const dir = join(root, `twin-${tag}`);
        mkdirSync(dir, { recursive: true });
        const registry = join(dir, 'accounts.json');
        const state = join(dir, 'state');
        mkdirSync(state, { recursive: true });
        writeFileSync(registry, readFileSync(fixture.DROVER_ACCOUNTS, 'utf8'));
        writeFileSync(join(state, 'cooldowns.json'), readFileSync(join(fixture.STATE_DIR, 'cooldowns.json'), 'utf8'));
        writeFileSync(join(state, 'cursor-auth.json'), '{"clay@example.com":{"token":"x","email":"clay@example.com"}}\n');
        return {
            DROVER_ACCOUNTS: registry,
            STATE_DIR: state,
            DROVER_CURSOR_AUTH: join(state, 'cursor-auth.json'),
        };
    }

    it('rm of a shared name is refused identically, and --harness cursor removes one row and keeps the ledger', async () => {
        const a = twin('sh-rm');
        const b = twin('nd-rm');
        // Ambiguous: two rows, one per harness, so it is refused rather than
        // guessed at — and both implementations list the same two rows.
        const shBad = shell('drover-account-edit', ['rm', 'clay@example.com'], a);
        const ndBad = await node(() => import('./account-edit'), ['rm', 'clay@example.com'], b);
        expect(fold(ndBad.stderr)).toBe(fold(shBad.stderr));
        expect(ndBad.code).toBe(shBad.code);
        expect(ndBad.code).not.toBe(0);
        expect(ndBad.stderr).toContain('cursor  (a token, no config dir)');

        const sh = shell('drover-account-edit', ['rm', 'clay@example.com', '--harness', 'cursor'], a);
        const nd = await node(() => import('./account-edit'), ['rm', 'clay@example.com', '--harness', 'cursor'], b);
        expect(fold(nd.stdout)).toBe(fold(sh.stdout));
        expect(nd.code).toBe(sh.code);
        expect(nd.code).toBe(0);
        // Same registry and same ledger afterwards: only the cursor row went,
        // and the Claude account's cooldown history stayed.
        const after = (env: Env): unknown => JSON.parse(readFileSync(env.DROVER_ACCOUNTS as string, 'utf8'));
        expect(after(b)).toEqual(after(a));
        expect((after(b) as Record<string, unknown>[]).map((r) => r.harness)).toEqual([undefined, undefined, undefined]);
        const ledger = (env: Env): unknown => JSON.parse(readFileSync(join(env.STATE_DIR as string, 'cooldowns.json'), 'utf8'));
        expect(ledger(b)).toEqual(ledger(a));
        expect(Object.keys(ledger(b) as object)).toEqual(['clay@example.com']);
        // And the token went with the row, in both.
        const tokens = (env: Env): unknown => JSON.parse(readFileSync(env.DROVER_CURSOR_AUTH as string, 'utf8'));
        expect(tokens(b)).toEqual({});
        expect(tokens(a)).toEqual({});
    });

    it('rename --harness claude relabels one row and carries the ledger, identically', async () => {
        const a = twin('sh-mv');
        const b = twin('nd-mv');
        const sh = shell('drover-account-edit', ['rename', 'clay@example.com', 'clay', '--harness', 'claude'], a);
        const nd = await node(() => import('./account-edit'), ['rename', 'clay@example.com', 'clay', '--harness', 'claude'], b);
        expect(fold(nd.stdout)).toBe(fold(sh.stdout));
        expect(nd.code).toBe(sh.code);
        expect(nd.stdout).toContain('carried its cooldown entry');
        const after = (env: Env): Record<string, unknown>[] =>
            JSON.parse(readFileSync(env.DROVER_ACCOUNTS as string, 'utf8')) as Record<string, unknown>[];
        expect(after(b)).toEqual(after(a));
        // The cursor row keeps the old name; only the Claude row moved.
        expect(after(b).map((r) => [r.name, r.harness ?? 'claude']))
            .toEqual([['main', 'claude'], ['clay@example.com', 'cursor'], ['clay', 'claude'], ['nologin', 'claude']]);
        const ledger = (env: Env): object => JSON.parse(readFileSync(join(env.STATE_DIR as string, 'cooldowns.json'), 'utf8')) as object;
        expect(ledger(b)).toEqual(ledger(a));
        expect(Object.keys(ledger(b))).toEqual(['clay']);
    });
});
