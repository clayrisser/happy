/**
 * `drover client` — the standalone prompt subscriber, one per tmux server
 * (DROVE-11, DROVE-239), in node (DROVE-315).
 *
 * The node twin of cattle-drover/libexec/drover-client. What is ported is the
 * CONTROL half: the pidfile claim, the "is this holder still the client"
 * check, --status / --stop / --restart, and the start path's race. The surface
 * itself stays clients/tmux-gum.sh — it draws tmux popups and there is nothing
 * to gain by rewriting a popup driver — so the start path still execs that
 * file, exactly as the wrapper did.
 *
 * NOT A LAUNCHD AGENT, and that is structural rather than a preference.
 * clients/tmux-gum.sh exits 2 when $TMUX is unset, because a popup needs a
 * tmux server to draw in. A launchd job has no $TMUX, so a plist would exit 2
 * on every start and be throttled for it. The surface lives in tmux, so tmux
 * is what starts it: tmux/drover.conf runs this verb on client-attached.
 *
 * ONE SUBSCRIBER PER TMUX SERVER. That hook fires on every attach, and two
 * terminals on one server share one screen's worth of popups. The pidfile is
 * the guard, keyed on the tmux SERVER pid because a popup is drawn per server.
 *
 * A pidfile is only ever a claim, so this never trusts it on its own: the pid
 * has to still be alive AND still be running clients/tmux-gum.sh. A recycled
 * pid belonging to something else would otherwise leave the machine with no
 * subscriber at all, silently, which is the bug this verb exists to fix.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { droverEnv } from './env';

const HELP = `drover client — the standalone prompt subscriber for this tmux server.

USAGE
  drover client            Start it, unless one is already running here.
                           tmux/drover.conf runs this on client-attached, so
                           you rarely type it.
  drover client --status   Which tmux servers have a subscriber, which pid, and
                           whether it is running code older than the file
  drover client --stop     Stop this tmux server's subscriber
  drover client --restart  Stop it and start a fresh one — how it picks up new
                           code, because nothing else does
  drover client --log      Start it with output appended to
                           $STATE_DIR/logs/client.log — what the tmux hook
                           passes, because run-shell throws output away

It draws prompts raised where there is no screen: a cron run, a script calling
\`drover ask\`, a session in a tmux server nobody is attached to. A prompt whose
origin pane is on THIS server is skipped — whatever raised it is already
drawing its own popup here.

NOTHING RESTARTS IT WHEN THE CODE CHANGES. It is not a launchd job, its parent
is a tmux run-shell, and re-attaching is a deliberate no-op while a subscriber
is alive — so a client started this morning still runs this morning's
clients/tmux-gum.sh however many times you merge. --status says so and
--restart is the fix.

ENV
  DROVER_URL             bus endpoint (default http://127.0.0.1:7970)
  DROVER_POPUP_HELPER    popup body (default clients/drover-popup.sh)
  DROVER_CLIENT_PRINT    headless: print each event, draw nothing
`;

const restartHint = 'run: drover client --restart';

export interface ClientIo {
    out: (s: string) => void;
    err: (s: string) => void;
}

const processIo: ClientIo = {
    out: (s) => void process.stdout.write(s),
    err: (s) => void process.stderr.write(s),
};

type Env = Record<string, string | undefined>;

export interface ClientCtx {
    env: Env;
    /** clients/tmux-gum.sh — the surface this verb claims a slot for. */
    client: string;
    /** libexec/, so --restart can re-run the verb the way the hook does. */
    libexec: string;
    /** $STATE_DIR/client — the claims live with the rest of drover's state. */
    claims: string;
    /** The `ps -o command= -p <pid>` line for a pid, or null when it is gone. */
    psCommand: (pid: string) => string | null;
    /** Does this pid exist at all (`kill -0`)? */
    alive: (pid: string) => boolean;
}

export function clientCtx(env: Env = process.env, home: string = env.HOME || homedir()): ClientCtx {
    const denv = droverEnv(env, home);
    return {
        env,
        client: join(denv.droverDir, 'clients', 'tmux-gum.sh'),
        libexec: join(denv.droverDir, 'libexec'),
        // The claim travels with the rest of the drover's state, so a stale
        // pidfile is somewhere you would think to look and never in /tmp,
        // where a reboot's cleanup makes "was one running" unanswerable.
        claims: join(denv.stateDir, 'client'),
        psCommand: (pid) => {
            const r = spawnSync('ps', ['-o', 'command=', '-p', pid], { encoding: 'utf8' });
            if (r.error || r.status !== 0) return null;
            const line = (r.stdout || '').trim();
            return line || null;
        },
        alive: (pid) => {
            try {
                process.kill(Number(pid), 0);
                return true;
            } catch (e) {
                // EPERM means it exists and belongs to somebody else.
                return (e as NodeJS.ErrnoException).code === 'EPERM';
            }
        },
    };
}

/**
 * $TMUX is "socket,serverpid,session". The server pid is unique on this
 * machine and is exactly the scope one subscriber covers, so it is the whole
 * key. With no tmux at all — DROVER_CLIENT_PRINT, or a hand-run headless
 * client — there is one screen-less subscriber and one key for it.
 */
export function clientKey(env: Env): string {
    const tmux = env.TMUX || '';
    const rest = tmux.includes(',') ? tmux.slice(tmux.indexOf(',') + 1) : '';
    const pid = rest.includes(',') ? rest.slice(0, rest.indexOf(',')) : rest;
    return pid && pid.match(/^[0-9]+$/) ? `tmux-${pid}` : 'notmux';
}

/**
 * Alive AND still the client. `kill -0` alone says only that SOME process
 * holds the pid, and pids are recycled: believing a stranger leaves this tmux
 * server with no subscriber and nothing to say why.
 */
export function holderAlive(ctx: ClientCtx, pid: string | null): boolean {
    if (!pid) return false;
    if (!ctx.alive(pid)) return false;
    const cmd = ctx.psCommand(pid);
    return !!cmd && cmd.includes('tmux-gum.sh');
}

/**
 * IS IT RUNNING THE FILE THAT IS ON DISK? (DROVE-239) A script is read once,
 * at exec, so a subscriber started this morning keeps running this morning's
 * code however many times the file changes under it. Nothing here reloads and
 * nothing supervises it, so the only honest thing to do is SAY it.
 *
 * The pidfile's mtime is the start time: the verb writes it and then execs the
 * client, and the rename carries the temp file's mtime over. So "the client is
 * newer than the claim" is exactly "the code changed after this one started".
 *
 * Only clients/tmux-gum.sh is asked about: clients/drover-popup.sh is exec'd
 * fresh inside every popup, so it is always current and a stale warning about
 * it would be wrong.
 */
export function codeIsNewer(ctx: ClientCtx, claim: string): boolean {
    try {
        return statSync(ctx.client).mtimeMs > statSync(claim).mtimeMs;
    } catch {
        return false;
    }
}

function readPid(file: string): string | null {
    try {
        const s = readFileSync(file, 'utf8').trim();
        return s || null;
    } catch {
        return null;
    }
}

function fmtSince(claim: string): string {
    try {
        const d = statSync(claim).mtime;
        const p = (n: number) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    } catch {
        return 'unknown';
    }
}

function cmdStatus(ctx: ClientCtx, io: ClientIo): number {
    mkdirSync(ctx.claims, { recursive: true });
    let files: string[] = [];
    try {
        files = readdirSync(ctx.claims).filter((f) => f.endsWith('.pid')).sort();
    } catch {
        files = [];
    }
    let found = 0;
    for (const f of files) {
        const path = join(ctx.claims, f);
        const name = f.slice(0, -'.pid'.length);
        const pid = readPid(path);
        if (holderAlive(ctx, pid)) {
            const since = fmtSince(path);
            if (codeIsNewer(ctx, path)) {
                io.out(`${name}\trunning\tpid ${pid}\tsince ${since}\tOLD CODE — clients/tmux-gum.sh has changed since, ${restartHint}\n`);
            } else {
                io.out(`${name}\trunning\tpid ${pid}\tsince ${since}\tcurrent\n`);
            }
            found++;
        } else {
            io.out(`${name}\tstale\tpid ${pid ?? 'none'}\n`);
        }
    }
    if (found === 0) io.out('no subscriber is running — attach a tmux client, or run: drover client\n');
    return 0;
}

function cmdStop(ctx: ClientCtx, io: ClientIo, key: string, pidfile: string): number {
    const pid = readPid(pidfile);
    if (holderAlive(ctx, pid)) {
        try {
            process.kill(Number(pid));
        } catch {
            // Already gone between the check and the signal is the same
            // outcome, and the shell swallowed it too.
        }
        io.out(`stopped the subscriber for ${key} (pid ${pid})\n`);
    } else {
        io.out(`no subscriber running for ${key}\n`);
    }
    rmSync(pidfile, { force: true });
    return 0;
}

function sleepSync(ms: number): void {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * THE WHOLE ANSWER TO "how does it pick up new code" (DROVE-239). Stop the
 * holder, wait for it to actually go, then start one the way tmux does.
 *
 * Waiting matters: the client closes its popups on TERM, and taking the claim
 * from under one that is still doing that leaves an orphan popup on the
 * screen, which is the failure clients/tmux-gum.sh exists to prevent.
 */
function cmdRestart(ctx: ClientCtx, io: ClientIo, key: string, pidfile: string): number {
    const pid = readPid(pidfile);
    if (holderAlive(ctx, pid)) {
        try {
            process.kill(Number(pid));
        } catch {
            // As above.
        }
        for (let n = 0; n < 40 && holderAlive(ctx, pid); n++) sleepSync(250);
        io.out(`stopped the subscriber for ${key} (pid ${pid})\n`);
    } else {
        io.out(`no subscriber was running for ${key}\n`);
    }
    rmSync(pidfile, { force: true });

    // `run-shell -b`, not exec, and that is the point: it reproduces exactly
    // the start path tmux/drover.conf uses on client-attached, so a restarted
    // subscriber is parented and logged identically to one nobody restarted.
    // exec here would tie the client to the pane it was typed in, and closing
    // that pane would take the surface with it.
    if (ctx.env.TMUX && hasTmux()) {
        spawnSync('tmux', ['run-shell', '-b', `"${join(ctx.libexec, 'drover-client')}" --log`], { encoding: 'utf8' });
        const logs = join(droverEnv(ctx.env, ctx.env.HOME || homedir()).stateDir, 'logs', 'client.log');
        io.out(`started a fresh one the way the attach hook does — ${logs}\n`);
        return 0;
    }
    io.err('not inside tmux, so there is nothing to draw on: attach a terminal and the hook starts one\n');
    return 2;
}

function hasTmux(): boolean {
    const r = spawnSync('tmux', ['-V'], { encoding: 'utf8' });
    return !r.error && r.status === 0;
}

/**
 * Take the claim and exec the surface. Returns the argv the caller should
 * exec, or null when a live subscriber already holds this tmux server — the
 * ordinary case on a re-attach, and it has to be QUIET, because the hook fires
 * on every attach and a line here would put a message on the status bar every
 * time a second terminal opens.
 *
 * WITH ONE EXCEPTION, AND IT IS THE POINT OF DROVE-239: if the running one is
 * older than the file, say so — once, on the status line, at the one moment a
 * human is demonstrably arriving. It does NOT restart anything; the holder may
 * have a popup open somebody is mid-answer on, and killing that is worse than
 * one more attach on old code.
 */
export function claim(ctx: ClientCtx, io: ClientIo, key: string, pidfile: string): boolean {
    mkdirSync(ctx.claims, { recursive: true });
    const held = readPid(pidfile);
    if (holderAlive(ctx, held)) {
        if (ctx.env.TMUX && hasTmux() && codeIsNewer(ctx, pidfile)) {
            spawnSync('tmux', [
                'display-message',
                `drover client: this subscriber predates clients/tmux-gum.sh — ${restartHint}`,
            ], { encoding: 'utf8' });
        }
        return false;
    }

    // Two attaches land in the same second often enough to matter — a terminal
    // that restores its windows opens all of them at once. The rename is
    // atomic, so exactly one pid survives in the file, and whoever's pid is
    // not the one in there a moment later stands down. Last writer wins rather
    // than first, which is fine: both were about to do the identical thing.
    const tmp = `${pidfile}.${process.pid}`;
    writeFileSync(tmp, `${process.pid}\n`);
    renameSync(tmp, pidfile);
    sleepSync(1000);
    return readPid(pidfile) === String(process.pid);
}

export async function run(args: string[], io: ClientIo = processIo, ctx: ClientCtx = clientCtx()): Promise<number> {
    const key = clientKey(ctx.env);
    const pidfile = join(ctx.claims, `${key}.pid`);
    let useLog = false;

    switch (args[0] ?? '') {
        case 'help':
        case '--help':
        case '-h':
            io.out(HELP);
            return 0;
        case '--status':
            return cmdStatus(ctx, io);
        case '--stop':
            return cmdStop(ctx, io, key, pidfile);
        case '--restart':
            return cmdRestart(ctx, io, key, pidfile);
        case '--log':
            useLog = true;
            break;
        case '':
            break;
        default:
            io.err(`drover client: unknown argument ${args[0]}\n`);
            io.err(HELP);
            return 2;
    }

    if (!claim(ctx, io, key, pidfile)) return 0;

    const stateDir = droverEnv(ctx.env, ctx.env.HOME || homedir()).stateDir;
    if (useLog) {
        // run-shell hands the job a pipe nobody drains and then throws what it
        // collects away. A client that talked would eventually block on a full
        // pipe, and until then nothing it said would be readable anywhere. The
        // other services already log here, so this one does too.
        mkdirSync(join(stateDir, 'logs'), { recursive: true });
    }

    // Spawned rather than exec'd — node has no execve — but `stdio: inherit`
    // plus forwarding the child's code keeps the pid file honest enough for
    // `--status`, which asks `ps` about the pid it finds either way.
    const log = useLog ? join(stateDir, 'logs', 'client.log') : null;
    if (log) {
        const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
        appendLine(log, `--- drover client starting ${now} key=${key} pid=${process.pid}\n`);
    }
    const r = spawnSync(ctx.client, [], {
        stdio: log ? ['ignore', 'ignore', 'ignore'] : 'inherit',
        env: { ...ctx.env, DROVER_URL: droverEnv(ctx.env, ctx.env.HOME || homedir()).droverUrl } as NodeJS.ProcessEnv,
    });
    return r.status ?? 1;
}

function appendLine(file: string, line: string): void {
    try {
        const prev = existsSync(file) ? readFileSync(file, 'utf8') : '';
        writeFileSync(file, prev + line);
    } catch {
        // A log that cannot be written is not a reason to refuse the surface.
    }
}
