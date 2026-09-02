/**
 * The vitest spec for `drover daemon` (DROVE-315), the port of
 * cattle-drover/libexec/drover-daemon.
 *
 * cattle-drover/tests/daemon.bats does NOT test this wrapper: every one of its
 * nine tests runs `libexec/drover-status` and reads its daemon block, so that
 * file is the STATUS verb's spec and belongs to the status lane. What it does
 * pin about this wrapper is one measured fact, and it is asserted below: the
 * wrapper ADOPTS an incumbent rather than racing it, which is why launchd's pid
 * can be a wrapper standing by while the daemon actually serving the phone is
 * someone else's. The wrapper's own bats coverage is tests/dist.bats, whose
 * five "daemon wrapper:" cases drive it through dist_ensure with a fixture
 * dist; dist_ensure stays in lib/drover-dist.sh here, shelled out through the
 * probe, so those cases still measure the one implementation.
 *
 * THIS VERB STARTS A REAL DAEMON. Nothing here may. Every door out of the
 * process — `ps`, `dist_ensure`, the handoff itself, and the two sleeps —
 * is on one DaemonProbe whose double THROWS by default, so a test that reached
 * the machine fails instead of registering this worktree with Clay's phone.
 * The handoff is never run: its argv, cwd and environment are asserted instead.
 * HAPPY_HOME_DIR is pinned to a throwaway above every import, and DROVER_URL
 * and every home in every test point at temp directories and a dead port.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { daemonPid, droverHappyHome, run, type DaemonProbe, type LaunchPlan } from './daemon';
import { droverVerbs, runDroverVerb } from './index';

const { happyHome, realHappyHome } = await vi.hoisted(async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const realHappyHome = path.join(os.homedir(), '.happy');
    const happyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-happy-'));
    process.env.HAPPY_HOME_DIR = happyHome;
    return { happyHome, realHappyHome };
});

vi.mock('../../configuration', () => {
    throw new Error('daemon.test: configuration (the ~/.happy reader) was imported; the verb must not reach the session machinery');
});
vi.mock('../../persistence', () => {
    throw new Error('daemon.test: persistence (access.key, settings) was imported; the verb must not reach the session machinery');
});
vi.mock('../../api/api', () => {
    throw new Error('daemon.test: api/api (session registration) was imported; the verb must not reach the session machinery');
});
vi.mock('../../claude/runClaude', () => {
    throw new Error('daemon.test: claude/runClaude was imported; the verb must not reach the session machinery');
});

type Env = Record<string, string | undefined>;

function happyHomeOf(env: Env): string {
    const raw = env.HAPPY_HOME_DIR;
    return raw ? resolve(raw.replace(/^~/, homedir())) : resolve(realHappyHome);
}

function refuseRealHappyHome(env: Env, where: string): void {
    if (happyHomeOf(env) === resolve(realHappyHome)) {
        throw new Error(
            `${where}: HAPPY_HOME_DIR resolves to the real ${realHappyHome} (it is ${env.HAPPY_HOME_DIR ?? 'unset'}). Refusing.`,
        );
    }
}

beforeAll(() => {
    refuseRealHappyHome(process.env, 'daemon.test');
});

afterAll(() => {
    refuseRealHappyHome(process.env, 'daemon.test (afterAll)');
    expect(existsSync(happyHome) ? readdirSync(happyHome) : []).toEqual([]);
    rmSync(happyHome, { recursive: true, force: true });
});

/** A probe that proves nothing on this machine is asked and no daemon is started. */
const noProbe: DaemonProbe = {
    psCommand: () => {
        throw new Error('ps was asked');
    },
    distEnsure: () => {
        throw new Error('dist_ensure was run');
    },
    launch: () => {
        throw new Error('a daemon was launched');
    },
    sleep: () => {
        throw new Error('the wrapper slept');
    },
};

interface Captured {
    code: number;
    out: string;
    err: string;
}

async function capture(args: string[], env: Env, probe: DaemonProbe, home: string): Promise<Captured> {
    refuseRealHappyHome(process.env, 'capture');
    refuseRealHappyHome(env, 'the verb env');
    const out: string[] = [];
    const err: string[] = [];
    const so = vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => (out.push(String(c)), true));
    const se = vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => (err.push(String(c)), true));
    try {
        const code = await run(args, { env, probe, home });
        return { code, out: out.join(''), err: err.join('') };
    } finally {
        so.mockRestore();
        se.mockRestore();
    }
}

let work: string;
let fork: string;
let state: string;
let home: string;
let hhome: string;

beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'daemon-'));
    home = join(work, 'home');
    fork = join(work, 'fork');
    state = join(work, 'state');
    hhome = join(work, 'happy-home');
    mkdirSync(join(fork, 'packages', 'happy-cli'), { recursive: true });
    mkdirSync(home, { recursive: true });
});

afterEach(() => {
    rmSync(work, { recursive: true, force: true });
});

/** The env a launchd-started wrapper would compute, with every path a throwaway and the bus on a dead port. */
function env(over: Env = {}): Env {
    return {
        HOME: home,
        HAPPY_HOME_DIR: happyHome,
        FORK_DIR: fork,
        DROVER_DIR: join(work, 'checkout'),
        STATE_DIR: state,
        DROVER_HAPPY_HOME: hhome,
        DROVER_URL: 'http://127.0.0.1:1',
        ...over,
    };
}

function signedIn(): void {
    mkdirSync(hhome, { recursive: true });
    writeFileSync(join(hhome, 'access.key'), 'k\n');
}

/** A probe that answers, records the handoff, and still refuses to start anything. */
function stubProbe(over: Partial<DaemonProbe> = {}): DaemonProbe & { launched: LaunchPlan[]; slept: number[] } {
    const launched: LaunchPlan[] = [];
    const slept: number[] = [];
    return {
        launched,
        slept,
        psCommand: () => '',
        distEnsure: () => 0,
        launch: (plan) => (launched.push(plan), 0),
        sleep: async (s) => {
            slept.push(s);
        },
        ...over,
    };
}

describe('drover daemon — daemon_pid, the identity match', () => {
    const stateFile = (): string => join(work, 'daemon.state.json');

    it('is nothing when there is no state file at all', () => {
        expect(daemonPid(stateFile(), noProbe)).toBeNull();
    });

    it('is nothing when the file is not JSON, or carries no pid', () => {
        writeFileSync(stateFile(), 'not json\n');
        expect(daemonPid(stateFile(), noProbe)).toBeNull();
        writeFileSync(stateFile(), '{"httpPort":58526}\n');
        expect(daemonPid(stateFile(), noProbe)).toBeNull();
        writeFileSync(stateFile(), '{"pid":null}\n');
        expect(daemonPid(stateFile(), noProbe)).toBeNull();
    });

    it('is the pid when ps says that process really is the daemon', () => {
        writeFileSync(stateFile(), '{"pid":20879,"httpPort":58526,"startedWithCliVersion":"1.2.2"}\n');
        const probe = stubProbe({
            psCommand: (pid) => (pid === '20879' ? 'node --no-warnings /fork/packages/happy-cli/dist/index.mjs daemon start-sync\n' : ''),
        });
        expect(daemonPid(stateFile(), probe)).toBe('20879');
    });

    it('is nothing when the pid was recycled onto something else', () => {
        // The state file outlives the process that wrote it. A stale pid
        // pointing at a fresh unrelated process would make the wrapper defer
        // forever to a daemon that does not exist.
        writeFileSync(stateFile(), '{"pid":18544}\n');
        expect(daemonPid(stateFile(), stubProbe({ psCommand: () => '/usr/sbin/cupsd -l\n' }))).toBeNull();
    });

    it('is nothing for a process that merely MENTIONS daemon start-sync', () => {
        // The looser `daemon start-sync` this first used matches any command
        // line containing the phrase -- a shell one-liner grepping for it does,
        // which is how a test harness talked this function into adopting itself.
        writeFileSync(stateFile(), '{"pid":31337}\n');
        const probe = stubProbe({ psCommand: () => "sh -c while ps -ax | grep 'daemon start-sync'; do sleep 1; done\n" });
        expect(daemonPid(stateFile(), probe)).toBeNull();
    });

    it('asks ps exactly once per call, and never kill -0', () => {
        // One `ps` covers existence AND identity. A `kill -0` guard as well is
        // redundant, and fails with EPERM on another user's live process.
        writeFileSync(stateFile(), '{"pid":20879}\n');
        const asked: string[] = [];
        const probe = stubProbe({
            psCommand: (pid) => (asked.push(pid), 'node /fork/packages/happy-cli/dist/index.mjs daemon start-sync\n'),
        });
        expect(daemonPid(stateFile(), probe)).toBe('20879');
        expect(asked).toEqual(['20879']);
    });
});

describe('drover daemon — the wrapper', () => {
    it('refuses when the fork is missing, by name, without touching anything', async () => {
        const missing = join(work, 'nowhere');
        const r = await capture([], env({ FORK_DIR: missing }), noProbe, home);
        expect(r.code).toBe(1);
        expect(r.err).toBe(`drover daemon: fork not found at ${missing}\n`);
        expect(r.out).toBe('');
    });

    it('makes the happy home and the logs dir, then hands off to dist/index.mjs daemon start-sync', async () => {
        signedIn();
        const probe = stubProbe();
        const r = await capture([], env(), probe, home);
        expect(r.code).toBe(0);
        expect(existsSync(hhome)).toBe(true);
        expect(existsSync(join(state, 'logs'))).toBe(true);
        expect(probe.launched).toHaveLength(1);
        const plan = probe.launched[0];
        expect(plan.command).toBe('node');
        expect(plan.argv).toEqual(['dist/index.mjs', 'daemon', 'start-sync']);
        expect(plan.cwd).toBe(join(fork, 'packages', 'happy-cli'));
        // The four the shell exported, and the supervisor flag that stops the
        // daemon replacing itself on a rebuild (DROVE-42).
        expect(plan.env.HAPPY_HOME_DIR).toBe(hhome);
        expect(plan.env.DROVER_URL).toBe('http://127.0.0.1:1');
        expect(plan.env.STATE_DIR).toBe(state);
        expect(plan.env.HAPPY_DAEMON_SUPERVISED).toBe('1');
        // Official mode leaves HAPPY_SERVER_URL alone; the CLI's own default wins.
        expect(plan.env.HAPPY_SERVER_URL).toBeUndefined();
    });

    it('runs dist_ensure before the handoff, and starts nothing when it fails', async () => {
        signedIn();
        const order: string[] = [];
        const probe = stubProbe({
            distEnsure: () => (order.push('dist_ensure'), 1),
            launch: (plan) => (order.push('launch'), 0),
        });
        const r = await capture([], env(), probe, home);
        expect(r.code).toBe(1);
        expect(order).toEqual(['dist_ensure']);
    });

    it('points at the relay under DROVER_SERVER_MODE=relay', async () => {
        // Those credentials belong to a different server and must not overwrite
        // the real ones, which is why relay mode keeps its own home too.
        signedIn();
        const probe = stubProbe();
        await capture([], env({ DROVER_SERVER_MODE: 'relay', DROVER_RELAY_URL: 'http://127.0.0.1:7971' }), probe, home);
        expect(probe.launched[0].env.HAPPY_SERVER_URL).toBe('http://127.0.0.1:7971');
    });

    it('waits quietly for access.key, and says why exactly once', async () => {
        // With no credentials there is nothing to register, and crash-looping
        // under KeepAlive would print the same auth failure every ten seconds.
        mkdirSync(hhome, { recursive: true });
        let ticks = 0;
        const probe = stubProbe({
            sleep: async (s) => {
                probe.slept.push(s);
                if (++ticks === 3) writeFileSync(join(hhome, 'access.key'), 'k\n');
            },
        });
        const r = await capture([], env(), probe, home);
        expect(r.code).toBe(0);
        expect(probe.slept).toEqual([5, 5, 5]);
        expect(r.out).toBe(
            `drover daemon: not signed in (${hhome}) — run 'drover pair' and scan the QR with Cattle Drover. Waiting.\n`
            + 'drover daemon: login found, starting.\n',
        );
        expect(probe.launched).toHaveLength(1);
    });

    it('an empty access.key is not a login', async () => {
        mkdirSync(hhome, { recursive: true });
        writeFileSync(join(hhome, 'access.key'), '');
        const probe = stubProbe({
            sleep: async (s) => {
                probe.slept.push(s);
                writeFileSync(join(hhome, 'access.key'), 'k\n');
            },
        });
        const r = await capture([], env(), probe, home);
        expect(r.code).toBe(0);
        expect(probe.slept).toEqual([5]);
    });

    it('ADOPTS an incumbent rather than racing it, and takes over when it goes', async () => {
        // startDaemon() logs "Daemon already running with matching version" and
        // exits ZERO. KeepAlive restarts on any exit, success included, so
        // racing is a crash loop wearing a success exit code.
        signedIn();
        const stateFile = join(hhome, 'daemon.state.json');
        writeFileSync(stateFile, '{"pid":20879}\n');
        let alive = 3;
        const probe = stubProbe({
            psCommand: () => (alive > 0 ? 'node /fork/packages/happy-cli/dist/index.mjs daemon start-sync\n' : ''),
            sleep: async (s) => {
                probe.slept.push(s);
                alive--;
            },
        });
        const r = await capture([], env(), probe, home);
        expect(r.code).toBe(0);
        expect(r.out).toBe(
            `drover daemon: pid 20879 already holds ${stateFile} — standing by.\n`
            + 'drover daemon: incumbent exited, taking over.\n',
        );
        expect(probe.slept).toEqual([5, 5, 5]);
        expect(probe.launched).toHaveLength(1);
    });

    it('a recycled pid does not make it stand by forever', async () => {
        // The whole reason daemon_pid confirms the command line: a state file
        // naming a pid the OS handed to cupsd must not park this wrapper.
        signedIn();
        writeFileSync(join(hhome, 'daemon.state.json'), '{"pid":18544}\n');
        const probe = stubProbe({ psCommand: () => '/usr/sbin/cupsd -l\n' });
        const r = await capture([], env(), probe, home);
        expect(r.code).toBe(0);
        expect(r.out).toBe('');
        expect(probe.slept).toEqual([]);
        expect(probe.launched).toHaveLength(1);
    });

    it('passes the daemon\'s exit code back to launchd', async () => {
        signedIn();
        const probe = stubProbe({ launch: () => 7 });
        expect((await capture([], env(), probe, home)).code).toBe(7);
    });

    it('refuses an argument rather than ignoring it', async () => {
        const r = await capture(['start'], env(), noProbe, home);
        expect(r.code).toBe(2);
        expect(r.err).toBe("drover daemon: unknown argument 'start' (try --help)\n");
    });

    it('--help answers before any file is read or any process is asked', async () => {
        const r = await capture(['--help'], env({ FORK_DIR: join(work, 'nowhere') }), noProbe, home);
        expect(r.code).toBe(0);
        expect(r.out.startsWith('drover daemon — run the fork\'s happy-cli daemon under a supervisor.\n')).toBe(true);
        expect(r.err).toBe('');
    });
});

describe('drover daemon — DROVER_HAPPY_HOME, as etc/drover.env computes it', () => {
    it('relay mode keeps its own home under STATE_DIR', () => {
        expect(droverHappyHome({ HOME: home, STATE_DIR: state, DROVER_SERVER_MODE: 'relay' }, home)).toBe(join(state, 'happy-home'));
    });

    it('official mode is ~/.happy until `drover home migrate` has run, and ~/.drover/happy after', () => {
        // DROVE-309's drover_home_path: the new path when it is there, else the
        // legacy path when THAT is there, else the new path. A machine is never
        // sent to an empty directory while its state sits in the other one.
        const e = { HOME: home, STATE_DIR: state };
        expect(droverHappyHome(e, home)).toBe(join(home, '.drover', 'happy'));
        mkdirSync(join(home, '.happy'), { recursive: true });
        expect(droverHappyHome(e, home)).toBe(join(home, '.happy'));
        mkdirSync(join(home, '.drover', 'happy'), { recursive: true });
        expect(droverHappyHome(e, home)).toBe(join(home, '.drover', 'happy'));
    });

    it('an explicit DROVER_HAPPY_HOME wins in either mode', () => {
        expect(droverHappyHome({ HOME: home, STATE_DIR: state, DROVER_HAPPY_HOME: hhome }, home)).toBe(hhome);
        expect(droverHappyHome({ HOME: home, STATE_DIR: state, DROVER_SERVER_MODE: 'relay', DROVER_HAPPY_HOME: hhome }, home)).toBe(hhome);
    });
});

describe('drover daemon — the row in the table', () => {
    it('is one row named daemon, loading its own chunk', () => {
        const row = droverVerbs.find((v) => v.name === 'daemon');
        expect(row, droverVerbs.map((v) => v.name).join(', ')).toBeDefined();
        expect(row?.summary).toBeTruthy();
    });

    it('is reachable through runDroverVerb, which refuses a missing fork rather than starting anything', async () => {
        // Reached with the real default probe on purpose, down the one path
        // that cannot spawn: FORK_DIR points at nothing, so the verb returns 1
        // before dist_ensure or the handoff is considered.
        const saved = process.env.FORK_DIR;
        process.env.FORK_DIR = join(work, 'nowhere');
        const err: string[] = [];
        const se = vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => (err.push(String(c)), true));
        try {
            expect(await runDroverVerb('daemon', [])).toBe(1);
        } finally {
            se.mockRestore();
            if (saved === undefined) delete process.env.FORK_DIR;
            else process.env.FORK_DIR = saved;
        }
        expect(err.join('')).toBe(`drover daemon: fork not found at ${join(work, 'nowhere')}\n`);
    });
});
