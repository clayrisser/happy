/**
 * `drover daemon` — the fork's happy-cli daemon, under launchd (DROVE-42,
 * BASED-98), in node (DROVE-315). A port of cattle-drover/libexec/drover-daemon.
 *
 * What the daemon actually is, because nothing else in this stack does its job:
 * it registers THIS MACHINE with the Happy server and holds the WebSocket that
 * carries `spawn-happy-session` and `stop-session` RPCs from the phone. The
 * bridge forwards prompts out of a session that already exists; the daemon is
 * what lets the app start one, list one, or stop one at all. Lose it and the
 * machine simply stops appearing in the app — with the bus up, the bridge
 * connected, and every other light in `drover status` green.
 *
 * Upstream does not supervise it, and says so in two places:
 *
 *   src/daemon/mac/install.ts writes a /Library/LaunchDaemons plist and is dead
 *   code, disabled with "requires sudo permissions, which users might not be
 *   comfortable with" plus the assumption that "users will run happy
 *   frequently (every time they open their laptop)".
 *
 *   src/daemon/run.ts carries upstream's own TODO on the self-restart path:
 *   "We should probably migrate this daemon to native system service
 *   management (launchd/systemd ...) so startup/start-at-login and upgrades are
 *   owned by the OS instead of by the daemon trying to replace itself
 *   in-process."
 *
 * Both objections are about a SYSTEM LaunchDaemon. A gui-domain LaunchAgent
 * needs no sudo, and this repo already runs the bus and the bridge that way.
 * So the daemon joins them, and stops depending on Clay having opened a
 * terminal since the last reboot.
 *
 * THE NAME IS SHADOWED THROUGH THE ENTRY, and that is not new. bin/drover has
 * no `daemon)` case, so `drover daemon` falls to the `*)` arm and hands the
 * whole argv to the fork's CLI, whose own `daemon` command answers first —
 * before the DROVE-315 verb table is ever consulted. That is exactly why the
 * daemon has its OWN launchd template: it names libexec/drover-daemon by path
 * rather than running `drover daemon`, because the fork's arm calls
 * startDaemon(), which logs "Daemon already running with matching version" and
 * exits ZERO into KeepAlive. The plist's own comment says how to fold it back:
 * add a `daemon)` case to bin/drover that runs the wrapper when called bare and
 * forwards stop/status/logs to the fork CLI. Until somebody does, this module
 * is reached as a table row (`runDroverVerb('daemon', ...)`), not by typing the
 * word — and it is written so that flip is a one-line change over there rather
 * than a rewrite here.
 *
 * WHAT SHELLS OUT, AND WHY IT IS ONE SEAM. Everything that could start or
 * inspect a process goes through DaemonProbe: `ps` for the incumbent's identity,
 * `dist_ensure` for the build guard, and the handoff itself. The test double
 * throws on all three, so a test that reached the machine fails instead of
 * quietly starting a real daemon against Clay's real ~/.happy.
 *
 * NODE HAS NO execve ON 22.x. The shell ended in `exec node dist/index.mjs
 * daemon start-sync`, which is what makes the pid launchd supervises the
 * daemon's own — no babysitter shell in between. `process.execve` is Node 24
 * and experimental, so the default handoff spawns with the parent's stdio and
 * returns the child's status: launchd still gets one long-lived process to
 * supervise, but it is this wrapper with the daemon underneath it, and `drover
 * status` already knows that shape — it is what UNSUPERVISED in the daemon line
 * exists to name. When this verb takes the launchd unit over, the plist should
 * point at it directly for the same reason the shell wrapper is named there
 * now.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { droverEnv, droverVar } from './env';

const HELP = `drover daemon — run the fork's happy-cli daemon under a supervisor.

USAGE
  drover daemon        Start it, or stand by for the one already running

The daemon registers this machine with the Happy server and holds the socket
that carries spawn-happy-session and stop-session from the phone. Lose it and
the machine stops appearing in the app with every other light green.

It ADOPTS a daemon that is already up rather than racing it: startDaemon() exits
ZERO when it loses the lock, and KeepAlive restarts on any exit, so racing is a
crash loop wearing a success exit code. Waiting gives launchd one long-lived
process either way.

With no credentials it waits quietly and says why once. DROVER_SERVER_MODE=relay
points it at DROVER_RELAY_URL instead of the official server.
`;

type Env = Record<string, string | undefined>;

/** The argv, cwd and environment the handoff runs with — what `exec` was handed. */
export interface LaunchPlan {
    command: string;
    argv: string[];
    cwd: string;
    env: Env;
}

/**
 * What the wrapper asked the machine. The default asks for real; a test hands
 * in one that answers from fixtures, or one that throws, which is how "no
 * daemon was started" is proven rather than promised.
 */
export interface DaemonProbe {
    /** `ps -o command= -p <pid>` — the process's command line, or '' when ps knows nothing. */
    psCommand(pid: string): string;
    /** `. lib/drover-dist.sh; dist_ensure <cli> <prefix>` — 0 when a loadable dist is in place. */
    distEnsure(droverDir: string, cli: string, prefix: string, env: Env): number;
    /** The handoff. In the shell this was `exec` and never returned. */
    launch(plan: LaunchPlan): number;
    /** `sleep <seconds>`, the wrapper's two waiting loops. */
    sleep(seconds: number): Promise<void>;
}

export const systemDaemonProbe: DaemonProbe = {
    psCommand: (pid) => {
        const r = spawnSync('ps', ['-o', 'command=', '-p', pid], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        if (r.error || r.status !== 0) return '';
        return r.stdout ?? '';
    },
    // The one sequence both service wrappers run before exec'ing dist/index.mjs
    // (DROVE-65): wait out a build in progress, rebuild once only over a tree
    // that might build, through the fork's own beside-and-swap build that
    // cannot delete a working dist, and fall back to the last-known-good rather
    // than exit. It stays in lib/drover-dist.sh, sourced, rather than being
    // reimplemented here: the bridge wrapper runs the same function, and two
    // copies of a guard that decides whether to DELETE a dist is how DROVE-65
    // happened in the first place.
    distEnsure: (droverDir, cli, prefix, env) => {
        const script = '. "$1"/etc/drover.env; . "$1"/lib/drover-dist.sh; dist_ensure "$2" "$3"';
        const r = spawnSync('sh', ['-c', script, 'sh', droverDir, cli, prefix], {
            env: env as NodeJS.ProcessEnv,
            stdio: ['ignore', 'inherit', 'inherit'],
        });
        if (r.error) return 1;
        return r.status ?? 1;
    },
    launch: (plan) => {
        const r = spawnSync(plan.command, plan.argv, {
            cwd: plan.cwd,
            env: plan.env as NodeJS.ProcessEnv,
            stdio: 'inherit',
        });
        if (r.error) return 1;
        return r.status ?? 1;
    },
    sleep: (seconds) => new Promise((res) => setTimeout(res, seconds * 1000)),
};

/**
 * `drover_home_path <new> <legacy>` — where a tree drover owns lives TODAY.
 * `drover home migrate` moves it under DROVER_HOME and leaves a symlink, so
 * both spellings resolve afterwards; before that run the legacy path is the
 * only truth. A machine is never sent to an empty directory while its state
 * sits in the other one.
 */
function droverHomePath(next: string, legacy: string): string {
    if (existsSync(next)) return next;
    if (existsSync(legacy)) return legacy;
    return next;
}

/**
 * DROVER_HAPPY_HOME, as etc/drover.env computes it. Official mode shares Clay's
 * own ~/.happy so `happy` in a terminal and the bridge are the SAME account on
 * the SAME server — otherwise the phone pairs with one of them and is blind to
 * the other. Relay mode keeps its own home under STATE_DIR, because those
 * credentials belong to a different server and must not overwrite the real ones.
 */
export function droverHappyHome(env: Env = process.env, home: string = homedir()): string {
    const stateDir = droverEnv(env, home).stateDir;
    const mode = droverVar('DROVER_SERVER_MODE', 'official', env, home);
    if (mode === 'relay') return droverVar('DROVER_HAPPY_HOME', join(stateDir, 'happy-home'), env, home);
    const droverHome = droverVar('DROVER_HOME', join(home, '.drover'), env, home);
    return droverVar('DROVER_HAPPY_HOME', droverHomePath(join(droverHome, 'happy'), join(home, '.happy')), env, home);
}

/**
 * Is a daemon OTHER than us alive right now? Its pid if so, null otherwise.
 *
 * `kill -0` alone trusts a pid the OS may have recycled onto something
 * unrelated — the state file outlives the process that wrote it, so a stale pid
 * pointing at a fresh unrelated process would make this wrapper defer forever to
 * a daemon that does not exist. Confirm the command line too.
 *
 * Match `dist/index.mjs daemon start-sync`, not the bare `daemon start-sync`
 * this first used. That looser pattern matches any process whose command line
 * merely CONTAINS the phrase — a shell one-liner that greps for it does, which
 * is how a test harness talked this function into adopting itself.
 *
 * One `ps` covers existence AND identity. A `kill -0` guard as well is
 * redundant, and fails with EPERM on a live process owned by someone else.
 */
export function daemonPid(stateFile: string, probe: DaemonProbe): string | null {
    let pid: string;
    try {
        // `jq -r '.pid // empty'`: absent, null and false are all empty.
        const parsed: unknown = JSON.parse(readFileSync(stateFile, 'utf8'));
        const raw = (parsed as { pid?: unknown } | null)?.pid;
        if (raw === undefined || raw === null || raw === false || raw === '') return null;
        pid = String(raw);
    } catch {
        // Unreadable, or not JSON: the same answer `[ -r ]` and a failing jq gave.
        return null;
    }
    if (!pid) return null;
    if (!probe.psCommand(pid).includes('dist/index.mjs daemon start-sync')) return null;
    return pid;
}

export interface DaemonOptions {
    env?: Env;
    home?: string;
    probe?: DaemonProbe;
}

function isDir(path: string): boolean {
    try {
        return statSync(path).isDirectory();
    } catch {
        return false;
    }
}

/** `[ -s "$f" ]` — the file exists and is not empty. */
function isNonEmptyFile(path: string): boolean {
    try {
        const s = statSync(path);
        return s.isFile() && s.size > 0;
    } catch {
        return false;
    }
}

/**
 * The wrapper.
 *
 *   1  the fork is not there, or dist_ensure could not put a loadable dist in
 *      place — there is nothing to run
 *   anything else  whatever the daemon exited with
 *
 * The shell took no arguments at all: launchd passes the program path and
 * nothing else. An argument is refused rather than ignored, because a wrapper
 * that shrugs at a typo is a wrapper that starts a second daemon.
 */
export async function run(args: string[], opts: DaemonOptions = {}): Promise<number> {
    const first = args[0];
    if (first === '-h' || first === '--help') {
        process.stdout.write(HELP);
        return 0;
    }
    if (first !== undefined && first !== '') {
        process.stderr.write(`drover daemon: unknown argument '${first}' (try --help)\n`);
        return 2;
    }

    const env: Env = { ...(opts.env ?? process.env) };
    const home = opts.home ?? homedir();
    const probe = opts.probe ?? systemDaemonProbe;
    const denv = droverEnv(env, home);
    const happyHome = droverHappyHome(env, home);

    const cli = join(denv.forkDir, 'packages', 'happy-cli');
    if (!isDir(cli)) {
        process.stderr.write(`drover daemon: fork not found at ${denv.forkDir}\n`);
        return 1;
    }
    mkdirSync(happyHome, { recursive: true });
    mkdirSync(join(denv.stateDir, 'logs'), { recursive: true });

    const stateFile = join(happyHome, 'daemon.state.json');

    if (droverVar('DROVER_SERVER_MODE', 'official', env, home) === 'relay') {
        env.HAPPY_SERVER_URL = denv.relayUrl;
    }

    // Same reasoning as the bridge: with no credentials there is nothing to
    // register, and crash-looping under KeepAlive would just print the same
    // auth failure every ten seconds. Wait quietly, and say why once.
    const accessKey = join(happyHome, 'access.key');
    if (!isNonEmptyFile(accessKey)) {
        process.stdout.write(
            `drover daemon: not signed in (${happyHome}) — run 'drover pair' and scan the QR with Cattle Drover. Waiting.\n`,
        );
        while (!isNonEmptyFile(accessKey)) await probe.sleep(5);
        process.stdout.write('drover daemon: login found, starting.\n');
    }

    env.HAPPY_HOME_DIR = happyHome;
    env.DROVER_URL = denv.droverUrl;
    // The CLI writes the phone-message ledger `drover status` reads (DROVE-48),
    // and a session the daemon spawns inherits its environment. Unexported, a
    // machine with a STATE_DIR override in local.env would have those sessions
    // write to the default path while status read the override — the
    // undelivered count would be zero because it was looking somewhere else.
    env.STATE_DIR = denv.stateDir;
    // Tell the daemon it has a supervisor (DROVE-42).
    //
    // Without this it replaces ITSELF on a rebuild: the heartbeat notices
    // dist/index.mjs was rewritten, spawns a DETACHED `daemon start`, and exits.
    // The child reparents to pid 1, where launchd cannot see it, while launchd
    // separately restarts the copy it does supervise — so one `pnpm build` in
    // the fork turns one daemon into two, and the extra one is an orphan
    // nothing will ever stop. Five were found alive at once, the oldest two
    // days old. Set, the daemon just exits on a rebuild and KeepAlive brings it
    // back through this wrapper.
    env.HAPPY_DAEMON_SUPERVISED = '1';

    // The dist crash-loop guard, for the same reason the bridge has one: this
    // runs dist/index.mjs too, so an interrupted `pnpm build` leaves it
    // importing a content-hashed chunk that no longer exists, and KeepAlive
    // turns that into ERR_MODULE_NOT_FOUND every ten seconds while launchd
    // reports the job running. The "rebuild once" that used to live inline here
    // was the AMPLIFIER (DROVE-65): the fork's build deleted dist first, so over
    // a tree that did not compile this wrapper DESTROYED the dist instead of
    // repairing it, roughly every 25 seconds.
    if (probe.distEnsure(denv.droverDir, cli, 'drover daemon', env) !== 0) return 1;

    // ADOPT a daemon that is already running rather than race it.
    //
    // launchd is not the only thing that starts one. Every `drover` session
    // calls ensureDaemonRunning(), which spawns a detached `daemon start-sync`
    // of its own. So this wrapper routinely arrives to find a perfectly good
    // daemon holding the lock.
    //
    // What startDaemon() does about that is the trap: it logs "Daemon already
    // running with matching version" and calls process.exit(0). Exit ZERO.
    // KeepAlive restarts on any exit, success included, so simply handing off
    // here would boot node, lose the lock race, exit clean, and be restarted
    // every ThrottleInterval — forever, writing one identical line each time.
    // That is a crash loop wearing a success exit code, which is worse than the
    // noisy kind because nothing reports it as a failure.
    //
    // Waiting instead gives launchd exactly one long-lived process either way,
    // and hands the daemon over the moment the incumbent really does go.
    const incumbent = daemonPid(stateFile, probe);
    if (incumbent) {
        process.stdout.write(`drover daemon: pid ${incumbent} already holds ${stateFile} — standing by.\n`);
        while (daemonPid(stateFile, probe)) await probe.sleep(5);
        process.stdout.write('drover daemon: incumbent exited, taking over.\n');
    }

    return probe.launch({ command: 'node', argv: ['dist/index.mjs', 'daemon', 'start-sync'], cwd: cli, env });
}
