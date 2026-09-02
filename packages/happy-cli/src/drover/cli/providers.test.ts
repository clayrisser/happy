/**
 * `drover providers`, checked against the shell it was ported from
 * (DROVE-315 wave 4).
 *
 * ONE FIXTURE, TWO IMPLEMENTATIONS. Every case here runs cattle-drover's
 * libexec/drover-providers and the node verb over the SAME throwaway OpenCode
 * config and compares stdout, stderr and the exit code. `--json` is the object
 * the bus's /v1/providers serves, so a character of drift there is the phone
 * disagreeing with the terminal about what drover wrote.
 *
 * NOTHING HERE TOUCHES ANYTHING REAL. HAPPY_HOME_DIR is pinned to a throwaway
 * directory before the first import (DROVE-336); HOME, OPENCODE_CONFIG_DIR and
 * DROVER_CONFIG_BACKUP_DIR all point inside a mkdtemp, so the config edited is
 * the fixture's and never Clay's ~/.config/opencode. No bus, no network, no
 * login, no tmux.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { droverEnv } from './env';

const { happyHome, realHappyHome } = await vi.hoisted(async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const realHappyHome = path.join(os.homedir(), '.happy');
    const happyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'providers-happy-'));
    process.env.HAPPY_HOME_DIR = happyHome;
    process.env.HAPPY_SERVER_URL = 'http://127.0.0.1:1';
    return { happyHome, realHappyHome };
});

// The session machinery this verb must never reach. A factory that throws
// turns a future import into a failure of this whole file at load, rather than
// a test that quietly registers a session.
vi.mock('../../configuration', () => {
    throw new Error('providers.test: configuration (the ~/.happy reader) was imported; this verb must not reach the session machinery');
});
vi.mock('../../api/api', () => {
    throw new Error('providers.test: api/api (session registration) was imported; this verb must not reach the session machinery');
});

type Env = Record<string, string | undefined>;

const droverDir = droverEnv({ ...process.env, DROVER_DIR: process.env.DROVER_DIR }).droverDir;
const shellVerb = join(droverDir, 'libexec', 'drover-providers');

let root = '';

/**
 * A fixture config holding ONE hand-written provider, which is the case that
 * matters: drover must read it, never rewrite it, and refuse to remove it.
 */
function makeFixture(): Env {
    root = mkdtempSync(join(tmpdir(), 'drover-providers-'));
    const home = join(root, 'home');
    const cfg = join(root, 'cfg');
    const state = join(root, 'state');
    for (const d of [home, cfg, state]) mkdirSync(d, { recursive: true });
    writeFileSync(join(cfg, 'opencode.json'), `${JSON.stringify({
        $schema: 'https://opencode.ai/config.json',
        provider: {
            handmade: { name: 'By Hand', models: { m1: { name: 'One' } } },
        },
    }, null, 2)}\n`);
    return {
        HOME: home,
        OPENCODE_CONFIG_DIR: cfg,
        DROVER_CONFIG_BACKUP_DIR: state,
        DROVER_DIR: droverDir,
        HAPPY_HOME_DIR: happyHome,
        HAPPY_SERVER_URL: 'http://127.0.0.1:1',
        PATH: process.env.PATH,
    };
}

function refuseRealHappyHome(env: Env, where: string): void {
    const raw = env.HAPPY_HOME_DIR;
    const at = raw ? resolve(raw.replace(/^~/, homedir())) : resolve(realHappyHome);
    if (at === resolve(realHappyHome)) {
        throw new Error(`${where}: HAPPY_HOME_DIR resolves to the real ${realHappyHome}. Refusing.`);
    }
}

interface Ran { stdout: string; stderr: string; code: number }

/** The shell verb, as `drover providers` runs it. */
function shell(args: string[], env: Env): Ran {
    refuseRealHappyHome(env, 'providers.test shell');
    const r = spawnSync(shellVerb, args, { env: env as NodeJS.ProcessEnv, encoding: 'utf8' });
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status ?? 0 };
}

/**
 * The node verb, in this process, with stdout and stderr captured.
 *
 * `process.exit` is trapped rather than allowed: the engine ends the process
 * itself on a refusal (`fail()` is a process.exit(1)), which under `exec node`
 * WAS the verb's exit code and in a test runner would take the runner with it.
 * Trapping it records the code the shell would have seen.
 */
async function node(args: string[], env: Env): Promise<Ran> {
    refuseRealHappyHome(env, 'providers.test node');
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
    class Exited extends Error {
        constructor(readonly code: number) {
            super(`exit ${code}`);
        }
    }
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
        throw new Exited(code ?? 0);
    }) as never);
    try {
        const { run } = await import('./providers');
        const code = await run(args);
        return { stdout, stderr, code };
    } catch (error) {
        if (error instanceof Exited) return { stdout, stderr, code: error.code };
        throw error;
    } finally {
        exitSpy.mockRestore();
        process.env = saved;
        (process.stdout as unknown as { write: typeof outWrite }).write = outWrite;
        (process.stderr as unknown as { write: typeof errWrite }).write = errWrite;
    }
}

let fixture: Env = {};

beforeAll(() => {
    refuseRealHappyHome(process.env, 'providers.test');
    fixture = makeFixture();
});

afterAll(() => {
    const left = existsSync(happyHome) ? readdirSync(happyHome) : [];
    expect(left).toEqual([]);
    rmSync(happyHome, { recursive: true, force: true });
    if (root !== '') rmSync(root, { recursive: true, force: true });
});

describe('drover providers — help is free, and the shell\'s words', () => {
    it('prints the shell\'s heredoc byte for byte, without loading the engine', async () => {
        for (const flag of ['--help', '-h', 'help']) {
            const sh = shell([flag], fixture);
            const fetchSpy = vi.spyOn(globalThis, 'fetch');
            const nd = await node([flag], fixture);
            expect(nd.stdout, flag).toBe(sh.stdout);
            expect(nd.code, flag).toBe(0);
            expect(sh.code, flag).toBe(0);
            // Not two empty strings: the DROVE-276 rule that made the write
            // shippable is really in the text.
            expect(nd.stdout, flag).toContain('the NAME of the environment variable holding the API');
            expect(nd.stdout, flag).toContain('key. NEVER the key.');
            expect(fetchSpy, flag).not.toHaveBeenCalled();
            fetchSpy.mockRestore();
        }
    });
});

describe('drover providers — the reads are byte-identical', () => {
    it('the bare list and --json say the same thing as the shell', async () => {
        for (const args of [[], ['--json']]) {
            const sh = shell(args, fixture);
            const nd = await node(args, fixture);
            expect(nd.stdout, args.join(' ')).toBe(sh.stdout);
            expect(nd.stderr, args.join(' ')).toBe(sh.stderr);
            expect(nd.code, args.join(' ')).toBe(sh.code);
            expect(sh.code, args.join(' ')).toBe(0);
        }
        // Not a tautology of two empty answers: the hand-written provider is in
        // the file and is NOT reported as drover's.
        const json = JSON.parse((await node(['--json'], fixture)).stdout) as Record<string, unknown>;
        expect(json.ok).toBe(true);
        expect(json.harness).toBe('opencode');
        expect(json.providers).toEqual([]);
        expect(readFileSync(join(root, 'cfg', 'opencode.json'), 'utf8')).toContain('"By Hand"');
    });
});

describe('drover providers — the refusals are the engine\'s, word for word', () => {
    it('refuses to remove a provider drover did not add, the same way in both', async () => {
        const sh = shell(['rm', 'handmade'], fixture);
        const nd = await node(['rm', 'handmade'], fixture);
        expect(nd.stderr).toBe(sh.stderr);
        expect(nd.code).toBe(sh.code);
        expect(nd.code).toBe(1);
        expect(nd.stderr).toContain('a provider you wrote by hand is yours');
        // And the hand-written block survived both attempts.
        expect(readFileSync(join(root, 'cfg', 'opencode.json'), 'utf8')).toContain('"By Hand"');
    });

    it('refuses a credential-shaped value in --key-env, the same way in both', async () => {
        const args = ['add', 'demo', '--key-env', 'sk-ant-api03-0123456789abcdefghijklmnopqrstuvwxyz'];
        const sh = shell(args, fixture);
        const nd = await node(args, fixture);
        expect(nd.stderr).toBe(sh.stderr);
        expect(nd.code).toBe(sh.code);
        expect(nd.code).toBe(1);
        // Neither run wrote the value anywhere.
        const raw = readFileSync(join(root, 'cfg', 'opencode.json'), 'utf8');
        expect(raw).not.toContain('sk-ant-api03');
    });

    it('an unknown verb exits the same way in both', async () => {
        const sh = shell(['nope'], fixture);
        const nd = await node(['nope'], fixture);
        expect(nd.stderr).toBe(sh.stderr);
        expect(nd.code).toBe(sh.code);
        expect(nd.code).toBe(1);
    });
});

describe('drover providers — a write lands identically', () => {
    it('add writes the same config and prints the same lines', async () => {
        const args = [
            'add', 'local', '--name', 'Local', '--npm', '@ai-sdk/openai-compatible',
            '--base-url', 'http://127.0.0.1:11434/v1', '--key-env', 'LOCAL_API_KEY',
            '--model', 'gpt-oss-120b',
        ];
        // The shell writes first, into its own copy of the fixture...
        const shellEnv = { ...fixture, OPENCODE_CONFIG_DIR: join(root, 'cfg-shell') };
        mkdirSync(shellEnv.OPENCODE_CONFIG_DIR as string, { recursive: true });
        writeFileSync(
            join(shellEnv.OPENCODE_CONFIG_DIR as string, 'opencode.json'),
            readFileSync(join(root, 'cfg', 'opencode.json'), 'utf8'),
        );
        const sh = shell(args, shellEnv);

        // ...and node into its own, so the two are compared on equal ground.
        const nodeEnv = { ...fixture, OPENCODE_CONFIG_DIR: join(root, 'cfg-node') };
        mkdirSync(nodeEnv.OPENCODE_CONFIG_DIR as string, { recursive: true });
        writeFileSync(
            join(nodeEnv.OPENCODE_CONFIG_DIR as string, 'opencode.json'),
            readFileSync(join(root, 'cfg', 'opencode.json'), 'utf8'),
        );
        const nd = await node(args, nodeEnv);

        expect(sh.code).toBe(0);
        expect(nd.code).toBe(0);
        // The only differences either side may have are the two paths it names:
        // the config it edited, and the backup it copied aside — whose name is
        // that path slugified plus the second it ran in. Both sides must SAY
        // they backed up; the bytes are compared below.
        const normalize = (text: string, dir: string): string => text
            .split(dir).join('<cfg>')
            .split('\n')
            .map((line) => (line.startsWith('backed up to ') ? 'backed up to <backup>' : line))
            .join('\n');
        expect(normalize(nd.stdout, nodeEnv.OPENCODE_CONFIG_DIR as string))
            .toBe(normalize(sh.stdout, shellEnv.OPENCODE_CONFIG_DIR as string));
        expect(nd.stdout).toContain('backed up to ');
        expect(sh.stdout).toContain('backed up to ');
        expect(nd.stderr).toBe(sh.stderr);

        const wroteShell = readFileSync(join(shellEnv.OPENCODE_CONFIG_DIR as string, 'opencode.json'), 'utf8');
        const wroteNode = readFileSync(join(nodeEnv.OPENCODE_CONFIG_DIR as string, 'opencode.json'), 'utf8');
        expect(wroteNode).toBe(wroteShell);
        // Really wrote something, inside the markers, and carried the env NAME
        // rather than a key.
        expect(wroteNode).toContain('>>> drover >>>');
        expect(wroteNode).toContain('{env:LOCAL_API_KEY}');
        expect(wroteNode).toContain('"By Hand"');
    });
});
