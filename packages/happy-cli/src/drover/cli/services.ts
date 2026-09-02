/**
 * The four launchd-supervised service wrappers, in node (DROVE-315).
 *
 * cattle-drover/libexec/drover-bus, -relay, -bridge and -daemon are wrappers,
 * not services: the bus IS server.js and the bridge and the daemon ARE the
 * fork's own dist/index.mjs, all three already node. What each shell file adds
 * is a decision — which environment to hand the process, what to wait for, and
 * when NOT to start at all — and that decision is what is ported here.
 *
 * PLANS, NOT LAUNCHES. Every wrapper answers with a ServicePlan: the argv, the
 * environment, the directories to make, and the reason it would refuse. A
 * caller runs the plan; a test reads it. That split is the whole reason this
 * file can be exercised at all — nothing in the suite may start, stop or
 * kickstart a real bus, bridge or daemon, and a function that returns a plan
 * cannot accidentally do so.
 *
 * THE THREE DECISIONS WORTH KEEPING, each with its own scar:
 *
 *   NOT SIGNED IN IS NOT A CRASH. With no access.key there is nothing to
 *   bridge and nothing to register, and crash-looping under KeepAlive would
 *   fill the log with the same stack every ten seconds. The wrappers wait
 *   quietly and say why once.
 *
 *   ADOPT, DO NOT RACE (DROVE-42). Every `drover` session spawns a detached
 *   `daemon start-sync` of its own, so the wrapper routinely arrives to find a
 *   perfectly good daemon holding the lock — and startDaemon() answers that
 *   with process.exit(0). Exit ZERO, under KeepAlive, is a crash loop wearing
 *   a success exit code. daemonPid() is how the wrapper tells a live daemon
 *   from a recycled pid, and it matches the COMMAND LINE, not just liveness.
 *
 *   LOOPBACK IS NOT A DEFAULT for the bus, it is the only bind server.js will
 *   accept — it refuses a routable bind and exits, because the bus has no auth
 *   and its routes inject into live sessions (DROVE-6).
 */

import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { droverEnv, type DroverEnv } from './env';

type Env = Record<string, string | undefined>;

export interface ServicePlan {
    /** The service's name, as launchd and `drover status` spell it. */
    name: 'bus' | 'relay' | 'bridge' | 'daemon';
    /** Directories the wrapper makes before anything runs. */
    mkdirs: string[];
    /** Variables the wrapper exports on top of the inherited environment. */
    env: Record<string, string>;
    /** The command, argv-style. Empty when `refuse` is set. */
    argv: string[];
    /** Where the command runs, when it matters. */
    cwd?: string;
    /** Commands that must succeed first (the relay's idempotent migrate). */
    before?: string[][];
    /** URLs the wrapper polls before starting, in order. */
    waitFor?: { url: string; name: string }[];
    /** Set when the wrapper would exit 1 instead of starting, with the reason. */
    refuse?: string;
    /** Set when the wrapper would wait quietly rather than crash-loop. */
    waitForLogin?: { home: string; message: string };
}

function logs(e: DroverEnv): string {
    return join(e.stateDir, 'logs');
}

/** The bus: server.js, on loopback, supervised by launchd. */
export function busPlan(env: Env = process.env, home: string = env.HOME || homedir()): ServicePlan {
    const e = droverEnv(env, home);
    return {
        name: 'bus',
        mkdirs: [logs(e)],
        env: {
            DROVER_PORT: e.droverPort,
            // Named, not chosen: server.js refuses a routable bind and exits.
            DROVER_BIND: env.DROVER_BIND || '127.0.0.1',
        },
        argv: ['node', join(e.droverDir, 'server.js')],
    };
}

/**
 * The relay: the local Happy self-host server (embedded PGlite, no external
 * DB), run from the fork checkout. Migrations are idempotent and must run
 * before first serve, or /v1/auth 500s on a fresh PGlite dir.
 */
export function relayPlan(env: Env = process.env, home: string = env.HOME || homedir()): ServicePlan {
    const e = droverEnv(env, home);
    const pkg = join(e.forkDir, 'packages', 'happy-server');
    if (!isDir(pkg)) {
        return { name: 'relay', mkdirs: [], env: {}, argv: [], refuse: `drover relay: fork not found at ${e.forkDir}` };
    }
    const data = join(e.stateDir, 'relay');
    return {
        name: 'relay',
        mkdirs: [join(data, 'pglite'), logs(e)],
        env: {
            PORT: e.relayPort,
            NODE_ENV: 'production',
            DATA_DIR: data,
            PGLITE_DIR: join(data, 'pglite'),
            DATABASE_URL: '',
            METRICS_ENABLED: 'false',
            // HANDY_MASTER_SECRET is minted once on this machine into
            // $STATE_DIR/relay/master-secret and read at start. Never a value
            // this module returns: a secret in a plan is a secret in a log.
        },
        cwd: pkg,
        before: [['pnpm', 'standalone', 'migrate']],
        argv: ['pnpm', 'standalone', 'serve'],
    };
}

/**
 * The bridge: waits for the bus, waits for a Happy login, then runs the fork's
 * `drover-bridge`. Which server it bridges to is DROVER_SERVER_MODE — official
 * exports nothing, so happy-cli uses its own built-in default and the bridge
 * shares the same account as a plain `drover` in a terminal.
 */
export function bridgePlan(env: Env = process.env, home: string = env.HOME || homedir()): ServicePlan {
    const e = droverEnv(env, home);
    const pkg = join(e.forkDir, 'packages', 'happy-cli');
    if (!isDir(pkg)) {
        return { name: 'bridge', mkdirs: [], env: {}, argv: [], refuse: `drover bridge: fork not found at ${e.forkDir}` };
    }
    const waitFor = [{ url: `${e.droverUrl}/v1/status`, name: 'bus' }];
    const vars: Record<string, string> = { HAPPY_HOME_DIR: e.happyHome, DROVER_URL: e.droverUrl };
    if (e.serverMode === 'relay') {
        waitFor.push({ url: `${e.relayUrl}/`, name: 'relay' });
        vars.HAPPY_SERVER_URL = e.relayUrl;
    }
    const plan: ServicePlan = {
        name: 'bridge',
        mkdirs: [e.happyHome, logs(e)],
        env: vars,
        cwd: pkg,
        waitFor,
        // The BUILT CLI with plain node, never `npx tsx`: `npx` is not neutral
        // on this machine — a shim dir ahead of it on an interactive PATH
        // re-execs the whole process tree under Socket Firewall, which then
        // answers 405 for the official Happy server. A long-running service
        // has no business inside an install-time guard.
        argv: ['node', 'dist/index.mjs', 'drover-bridge'],
    };
    // Official mode has no seeding path: the account is minted by scanning the
    // QR once. Until that happens there is nothing to bridge.
    if (e.serverMode !== 'relay' && !hasCredential(e.happyHome)) {
        plan.waitForLogin = {
            home: e.happyHome,
            message: `drover bridge: not signed in (${e.happyHome}) — run 'drover pair' and scan the QR with Cattle Drover. Waiting.`,
        };
    }
    return plan;
}

/**
 * The daemon: the fork's happy-cli daemon, under launchd. It registers THIS
 * MACHINE with the Happy server and holds the WebSocket that carries
 * spawn-happy-session and stop-session from the phone. Lose it and the machine
 * simply stops appearing in the app, with every other light green.
 */
export function daemonPlan(env: Env = process.env, home: string = env.HOME || homedir()): ServicePlan {
    const e = droverEnv(env, home);
    const pkg = join(e.forkDir, 'packages', 'happy-cli');
    if (!isDir(pkg)) {
        return { name: 'daemon', mkdirs: [], env: {}, argv: [], refuse: `drover daemon: fork not found at ${e.forkDir}` };
    }
    const vars: Record<string, string> = {
        HAPPY_HOME_DIR: e.happyHome,
        DROVER_URL: e.droverUrl,
        // The CLI writes the phone-message ledger `drover status` reads
        // (DROVE-48), and a session the daemon spawns inherits its
        // environment. Unexported, a machine with a STATE_DIR override in
        // local.env would have those sessions write to the default path while
        // status read the override.
        STATE_DIR: e.stateDir,
        // Tell the daemon it has a supervisor (DROVE-42). Without this it
        // replaces ITSELF on a rebuild: the heartbeat spawns a DETACHED
        // successor that reparents to pid 1 where launchd cannot see it, while
        // launchd separately restarts the copy it does supervise. Five were
        // found alive at once, the oldest two days old.
        HAPPY_DAEMON_SUPERVISED: '1',
    };
    if (e.serverMode === 'relay') vars.HAPPY_SERVER_URL = e.relayUrl;
    const plan: ServicePlan = {
        name: 'daemon',
        mkdirs: [e.happyHome, logs(e)],
        env: vars,
        cwd: pkg,
        argv: ['node', 'dist/index.mjs', 'daemon', 'start-sync'],
    };
    if (!hasCredential(e.happyHome)) {
        plan.waitForLogin = {
            home: e.happyHome,
            message: `drover daemon: not signed in (${e.happyHome}) — run 'drover pair' and scan the QR with Cattle Drover. Waiting.`,
        };
    }
    return plan;
}

/** Where the daemon records the pid that wrote last. */
export function daemonStateFile(env: Env = process.env, home: string = env.HOME || homedir()): string {
    return join(droverEnv(env, home).happyHome, 'daemon.state.json');
}

/**
 * Is a daemon OTHER than us alive right now? Returns its pid if so.
 *
 * `kill -0` alone trusts a pid the OS may have recycled onto something
 * unrelated — the state file outlives the process that wrote it, so a stale
 * pid pointing at a fresh unrelated process would make the wrapper defer
 * forever to a daemon that does not exist. Confirm the command line too.
 *
 * Match `dist/index.mjs daemon start-sync`, not the bare `daemon start-sync`
 * this first used. That looser pattern matches any process whose command line
 * merely CONTAINS the phrase — a shell one-liner that greps for it does, which
 * is how a test harness talked this function into adopting itself.
 */
export const daemonCommandMatch = /dist\/index\.mjs daemon start-sync/;

export function daemonPid(
    stateFile: string,
    psCommand: (pid: string) => string | null = defaultPsCommand,
    readJson: (p: string) => unknown = defaultReadJson,
): string | null {
    let doc: unknown;
    try {
        doc = readJson(stateFile);
    } catch {
        return null;
    }
    const pid = (doc as { pid?: unknown } | null)?.pid;
    if (pid === undefined || pid === null || pid === '') return null;
    const s = String(pid);
    // One `ps` covers existence AND identity. A `kill -0` guard as well is
    // redundant, and fails with EPERM on a live process owned by someone else.
    const cmd = psCommand(s);
    if (!cmd || !cmd.match(daemonCommandMatch)) return null;
    return s;
}

function defaultPsCommand(pid: string): string | null {
    const r = spawnSync('ps', ['-o', 'command=', '-p', pid], { encoding: 'utf8' });
    if (r.error || r.status !== 0) return null;
    const line = (r.stdout || '').trim();
    return line || null;
}

function defaultReadJson(p: string): unknown {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    return JSON.parse(readFileSync(p, 'utf8'));
}

/** `[ -s "$home/access.key" ]` — present AND not empty. */
export function hasCredential(happyHome: string): boolean {
    try {
        return statSync(join(happyHome, 'access.key')).size > 0;
    } catch {
        return false;
    }
}

function isDir(p: string): boolean {
    try {
        return existsSync(p) && statSync(p).isDirectory();
    } catch {
        return false;
    }
}

/** Every plan, by name, so `drover status` and a test can ask for one. */
export const servicePlans = {
    bus: busPlan,
    relay: relayPlan,
    bridge: bridgePlan,
    daemon: daemonPlan,
} as const;
