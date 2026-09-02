/**
 * The integration harness cleans up after a run that could not (DROVE-389).
 *
 * On 2026-09-02 three `dist/index.mjs daemon start-sync` processes, each with
 * its happy-server and its expo, sat for an hour with PPID 1 after the vitest
 * run that seeded them was killed by a Claude Code restart. Two holes, both
 * closed here and both measured here:
 *
 *   1. The run never reached afterAll, and nothing else knew the environments
 *      were anybody's. Now every harness environment carries the pid of the
 *      vitest that made it, and the next run sweeps the ones whose pid is gone.
 *   2. Even a teardown that ran had no handle on the daemon: seedEnvironment
 *      went through `daemon start`, a launcher that exits, and the daemon's own
 *      state file was gone. Now the daemon's pid is filed beside the server's,
 *      and stopEnvironment also finds a daemon by the HAPPY_HOME_DIR it
 *      carries, which is the one thing a leaked daemon cannot lose.
 *
 * Everything here runs under a HAPPY_ENVIRONMENTS_DIR of its own, so no real
 * environment under environments/data/envs is created, stopped or removed,
 * and every process started is a `sleep` or an idle node in its own group.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

type Environments = {
    daemonPidsFor: (cliHome: string) => number[];
    readHarnessOwner: (name: string) => number | null;
    stopEnvironment: (name: string) => void;
    sweepDeadHarnessEnvironments: () => Array<{ name: string; owner: number }>;
    writeHarnessOwner: (name: string, pid: number) => void;
};

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
const ENVIRONMENTS_MODULE_URL = pathToFileURL(join(REPO_ROOT, 'environments', 'environments.ts')).href;

let envsDir: string;
let environments: Environments;
const started: ChildProcess[] = [];

function alive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function waitGone(pid: number, ms = 5000): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (!alive(pid)) return true;
        await new Promise((r) => setTimeout(r, 50));
    }
    return !alive(pid);
}

/** A process in a group of its own, the way spawnService starts one. */
function detached(command: string, args: string[], env: Record<string, string> = {}): number {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', env: { ...process.env, ...env } });
    child.unref();
    started.push(child);
    if (!child.pid) throw new Error(`could not start ${command}`);
    return child.pid;
}

/** A pid that is certainly dead: a sleep that was started and then shot. */
async function deadPid(): Promise<number> {
    const child = spawn('sleep', ['30'], { stdio: 'ignore' });
    const pid = child.pid!;
    child.kill('SIGKILL');
    await new Promise<void>((r) => child.once('exit', () => r()));
    return pid;
}

/** One environment directory, the shape createEnvironment leaves. */
function makeEnv(name: string, opts: { owner?: number; server?: number; daemon?: number } = {}): string {
    const dir = join(envsDir, name);
    mkdirSync(join(dir, 'cli', 'home'), { recursive: true });
    mkdirSync(join(dir, 'pids'), { recursive: true });
    writeFileSync(join(dir, 'environment.json'), JSON.stringify({
        name, serverPort: 1, expoPort: 2, createdAt: new Date().toISOString(), template: 'empty',
        projectTemplate: 'lab-rat-todo-project', projectPath: join(dir, 'project'),
    }));
    if (opts.owner !== undefined) environments.writeHarnessOwner(name, opts.owner);
    if (opts.server !== undefined) writeFileSync(join(dir, 'pids', 'server.pid'), String(opts.server));
    if (opts.daemon !== undefined) writeFileSync(join(dir, 'pids', 'daemon.pid'), String(opts.daemon));
    return dir;
}

beforeAll(async () => {
    envsDir = mkdtempSync(join(tmpdir(), 'harness-envs-'));
    process.env.HAPPY_ENVIRONMENTS_DIR = envsDir;
    // Imported only now, after the override: the module reads it at load.
    environments = await import(ENVIRONMENTS_MODULE_URL) as Environments;
});

afterAll(() => {
    for (const child of started) {
        if (child.pid && alive(child.pid)) {
            try {
                process.kill(-child.pid, 'SIGKILL');
            } catch {
                try {
                    child.kill('SIGKILL');
                } catch {}
            }
        }
    }
    delete process.env.HAPPY_ENVIRONMENTS_DIR;
    rmSync(envsDir, { recursive: true, force: true });
});

describe('the harness owner', () => {
    it('is written as a pid and read back, and an environment made by hand has none', () => {
        // This process, so the sweep below does not take the fixture as a
        // dead run: an owner that is a made-up number IS a dead run.
        makeEnv('owned', { owner: process.pid });
        makeEnv('by-hand');
        expect(environments.readHarnessOwner('owned')).toBe(process.pid);
        expect(environments.readHarnessOwner('by-hand')).toBeNull();
    });
});

describe('sweepDeadHarnessEnvironments', () => {
    it('stops and removes an environment whose vitest is gone, and only that one', { timeout: 20_000 }, async () => {
        const gone = await deadPid();
        const deadServer = detached('sleep', ['300']);
        const deadDaemon = detached('sleep', ['300']);
        makeEnv('dead-run', { owner: gone, server: deadServer, daemon: deadDaemon });

        const liveServer = detached('sleep', ['300']);
        makeEnv('live-run', { owner: process.pid, server: liveServer });

        const handServer = detached('sleep', ['300']);
        makeEnv('by-hand', { server: handServer });

        const swept = environments.sweepDeadHarnessEnvironments();

        expect(swept).toEqual([{ name: 'dead-run', owner: gone }]);
        expect(await waitGone(deadServer)).toBe(true);
        expect(await waitGone(deadDaemon)).toBe(true);
        expect(existsSync(join(envsDir, 'dead-run'))).toBe(false);

        // A run that is still going, and an environment somebody made by
        // hand, are not this sweep's business.
        expect(alive(liveServer)).toBe(true);
        expect(existsSync(join(envsDir, 'live-run'))).toBe(true);
        expect(alive(handServer)).toBe(true);
        expect(existsSync(join(envsDir, 'by-hand'))).toBe(true);
    });
});

describe('stopEnvironment and the daemon', () => {
    it('stops the daemon the pid file names, and does not wait on its own zombie', async () => {
        const daemon = detached('sleep', ['300']);
        makeEnv('with-daemon-pid', { daemon });
        // The stop is synchronous and the loop is blocked while it waits, so
        // the sleep it just TERMed cannot be reaped until it returns: a stop
        // that reads kill -0 alone waits the full three seconds on a corpse.
        const started = Date.now();
        environments.stopEnvironment('with-daemon-pid');
        expect(Date.now() - started).toBeLessThan(2500);
        expect(await waitGone(daemon)).toBe(true);
        expect(existsSync(join(envsDir, 'with-daemon-pid', 'pids', 'daemon.pid'))).toBe(false);
    });

    it('finds a daemon by the HAPPY_HOME_DIR it carries when no file names it', async () => {
        // The 2026-09-02 shape exactly: a `dist/index.mjs daemon start-sync`
        // in its own group, this env's home in its environment, no pid file,
        // no daemon.state.json.
        const dir = makeEnv('orphan-daemon');
        const home = join(dir, 'cli', 'home');
        const idle = 'setInterval(() => {}, 1000)';
        const daemon = detached(process.execPath, ['-e', idle, '--', 'dist/index.mjs', 'daemon', 'start-sync'], { HAPPY_HOME_DIR: home });
        // And a bystander with the same argv and a DIFFERENT home, which must
        // not be touched.
        const other = makeEnv('other-env');
        const bystander = detached(process.execPath, ['-e', idle, '--', 'dist/index.mjs', 'daemon', 'start-sync'], { HAPPY_HOME_DIR: join(other, 'cli', 'home') });

        // ps sees a process once it has exec'd; give both a moment to appear.
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline && !environments.daemonPidsFor(home).includes(daemon)) {
            await new Promise((r) => setTimeout(r, 50));
        }
        expect(environments.daemonPidsFor(home)).toEqual([daemon]);

        environments.stopEnvironment('orphan-daemon');

        expect(await waitGone(daemon)).toBe(true);
        expect(alive(bystander)).toBe(true);
    });

    it('never names the process asking, even though it carries the same variable', () => {
        // applyEnvironmentToProcess puts the env's HAPPY_HOME_DIR on the vitest
        // worker itself. The worker is not a daemon and must not be killed by
        // its own teardown.
        const home = join(envsDir, 'self', 'cli', 'home');
        const before = process.env.HAPPY_HOME_DIR;
        process.env.HAPPY_HOME_DIR = home;
        try {
            expect(environments.daemonPidsFor(home)).not.toContain(process.pid);
        } finally {
            process.env.HAPPY_HOME_DIR = before;
        }
    });
});

describe('the daemon shape', () => {
    it('is what ps prints for a real daemon: node, the entry, then daemon start-sync', () => {
        // Pinned so the pattern in environments.ts and the one in
        // cattle-drover's reaper keep matching the same command line.
        const out = spawnSync('ps', ['-o', 'command=', '-p', String(process.pid)], { encoding: 'utf8' }).stdout;
        expect(typeof out).toBe('string');
        expect(/dist\/index\.mjs daemon start-sync/.test('node --no-warnings --no-deprecation /x/packages/happy-cli/dist/index.mjs daemon start-sync')).toBe(true);
    });
});
