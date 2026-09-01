/**
 * `drover stale-sessions` — which running sessions and services the last CLI
 * build left behind (DROVE-172, DROVE-220, DROVE-274), in node (DROVE-315).
 *
 * The ship loop is `make build-cli` then a daemon kickstart, and neither of
 * those reaches a session that is already up: a session is one long-lived
 * dist/index.mjs, the build rewrites that file, and the running process keeps
 * the bytes node read at spawn. On 2026-08-31 five CLI fixes shipped in one
 * night and none of them reached the session Clay was sitting in. This is the
 * line that says so, by name, so nobody can call a CLI fix live while the
 * session in front of them is still executing the bundle it was spawned with.
 *
 * A straight port of cattle-drover/libexec/drover-stale-sessions and the
 * lib/drover-stale.sh it sourced: the same arguments, the same exit codes, the
 * same lines. The sentences are load-bearing — "picks the new bundle up when
 * its current turn ends" versus "NOT supervised — drover --resume <id>" is
 * what Clay reads before calling a fix live — so they are copied, not
 * paraphrased. Where the shell shelled out (ps, tmux, launchctl, jq, date) this
 * asks node, through one injectable Probe, and the bats suite's two doors are
 * kept: DROVER_STALE_ROWS and DROVER_STALE_SERVICE_ROWS name files of pre-made
 * rows, and with either set no process on this machine is inspected.
 *
 * Help answers before anything else — no env read, no file, no process — the
 * way the shell answered it before `set -e` reached a single stat.
 */

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

import { droverEnv } from './env';

const HELP = `drover stale-sessions — sessions and services running code a change replaced.

USAGE
  drover stale-sessions        Name them, and say which fix themselves
  drover stale-sessions --raw  One TAB row per session: pid, start epoch,
                               supervised (1/0), claude session id, name
                               (sessions only — services are not in --raw)

WHY
  A session is one long-lived packages/happy-cli/dist/index.mjs. A rebuild
  rewrites that file; the running process keeps the bytes node read at spawn.
  A session started before the build behaves exactly as if the fix never
  shipped, which is how five fixes reached nobody on 2026-08-31.

  The launchd services are the same failure wearing a service label: the bus
  (server.js + engine/*), the bridge and the daemon (dist/index.mjs) are each
  one long-lived node process, and the ship loop kickstarts only the daemon.
  The bus that answered 404 for /v1/mcps had been up since before the route
  existed (DROVE-274). Each service's start time is compared against the
  newest mtime of the code it loads, and one behind gets its kickstart line.

WHAT HAPPENS NEXT
  A session started through bin/drover.mjs new enough to supervise itself
  relaunches onto the new bundle the moment its current turn ends — never
  mid-turn, never with subagents running. Anything else has to be restarted:
  \`drover --resume <claude session id>\` keeps the conversation. A stale
  service is one pasteable line: launchctl kickstart -k gui/<uid>/<label>.
`;

/** The prefix every report line carries; the shell's `${2:-drover}`. */
const PREFIX = 'drover';

type Env = Record<string, string | undefined>;

/**
 * What the shell asked the machine, one method per command. The default asks
 * for real; a test hands in one that answers from fixtures, or one that throws,
 * which is how "no process is inspected" is proven rather than promised.
 */
export interface Probe {
    /** `ps -p <pid> -o etime=` — elapsed time, or '' when ps knows nothing. */
    etime(pid: string): string;
    /** `ps -Eww -p <pid> -o command=` — argv and environment, space-joined. */
    envDump(pid: string): string;
    /** `ps -axo pid=,command=` — one line per process. */
    processes(): string[];
    /** `ps -axo ppid=,command=` — one line per process, keyed by parent. */
    children(): string[];
    /** `tmux display-message -p -t <pane> '#{session_name}'`. */
    tmuxSession(pane: string): string;
    /** `launchctl list <label>`. */
    launchctlList(label: string): string;
}

/** Run one command with an argv (no shell) and answer its stdout; '' on any failure, the shell's `|| :`. */
function ask(cmd: string, argv: string[]): string {
    const r = spawnSync(cmd, argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    if (r.error || r.status !== 0) return '';
    return r.stdout ?? '';
}

export const systemProbe: Probe = {
    etime: (pid) => ask('ps', ['-p', pid, '-o', 'etime=']),
    envDump: (pid) => ask('ps', ['-Eww', '-p', pid, '-o', 'command=']),
    processes: () => ask('ps', ['-axo', 'pid=,command=']).split('\n'),
    children: () => ask('ps', ['-axo', 'ppid=,command=']).split('\n'),
    tmuxSession: (pane) => ask('tmux', ['display-message', '-p', '-t', pane, '#{session_name}']),
    launchctlList: (label) => ask('launchctl', ['list', label]),
};

export interface StaleOptions {
    /** The environment; process.env unless a test says otherwise. */
    env?: Env;
    /** How the machine is asked. */
    probe?: Probe;
    /** The clock, in epoch seconds. */
    now?: () => number;
    /** This user's uid, for the kickstart line (`id -u`). */
    uid?: () => number | string;
}

/** One session launcher, as stale_scan printed it: five TAB fields. */
export interface SessionRow {
    pid: string;
    /** Start epoch, seconds. */
    at: string;
    /** '1' when the session relaunches itself, '0' otherwise. */
    sup: string;
    /** The claude session id, or '-' when there is none yet. */
    id: string;
    name: string;
    /** The row as written, for --raw. */
    line: string;
}

/** One launchd service, as stale_service_scan printed it: four TAB fields. */
export interface ServiceRow {
    name: string;
    /** Start epoch, seconds. */
    at: string;
    /** The newest mtime among the code it loads, epoch seconds. */
    mtime: string;
    label: string;
}

// --- the pure parts of lib/drover-stale.sh ----------------------------------

/** stale_dist_mtime: when the bundle on disk was written, epoch seconds; '' when there is none. */
export function staleDistMtime(cli: string): string {
    try {
        return String(Math.floor(statSync(join(cli, 'dist', 'index.mjs')).mtimeMs / 1000));
    } catch {
        return '';
    }
}

/**
 * The [[DD-]HH:]MM:SS that `ps -o etime=` prints, as seconds. Elapsed time,
 * not lstart, because it is one format on every BSD and GNU ps. Leading zeros
 * are the trap the shell had to strip — `08` is an invalid octal literal in
 * `$(( ))` — and Number() does not have it. Null when the string is not that
 * shape, which includes the empty answer ps gives for a pid it does not know.
 */
export function parseEtime(etime: string): number | null {
    let e = etime.replace(/\s+/g, '');
    if (!e) return null;
    let days = 0;
    const dash = e.indexOf('-');
    if (dash >= 0) {
        days = Number(e.slice(0, dash));
        e = e.slice(dash + 1);
    }
    const parts = e.split(':');
    if (parts.length > 3) return null;
    const s = Number(parts[parts.length - 1]);
    const m = parts.length >= 2 ? Number(parts[parts.length - 2]) : 0;
    const h = parts.length >= 3 ? Number(parts[parts.length - 3]) : 0;
    if (![days, h, m, s].every((n) => Number.isFinite(n))) return null;
    return days * 86400 + h * 3600 + m * 60 + s;
}

/**
 * stale_started_at: epoch seconds this process began, or null when ps prints
 * nothing for it — a process that exited between the scan and the question.
 * A row invented from an empty elapsed time would date the session to right
 * now and quietly call it fresh.
 */
export function staleStartedAt(pid: string, probe: Probe, now: () => number): number | null {
    const secs = parseEtime(probe.etime(pid));
    if (secs === null) return null;
    return now() - secs;
}

/** stale_env_of: one variable out of a `ps -E` dump split on spaces. */
export function staleEnvOf(dump: string[], name: string): string {
    const key = `${name}=`;
    const hit = dump.find((l) => l.startsWith(key));
    return hit ? hit.slice(key.length) : '';
}

/**
 * stale_transcript_of: the transcript id Claude Code itself has on record for
 * the session in that tmux pane. Claude writes one record per live process
 * under `<config dir>/sessions/<pid>.json`, and its `tmux` field ends in the
 * pane id — the same join paneInject.ts makes for the injection gate. Asked
 * BEFORE any argv, because argv only carries --resume after a resume: a
 * session started fresh this morning has the id that matters and no --resume
 * anywhere. The recorded pid is claude's INNER process, so the pane is the
 * join and the pid is not.
 *
 * '' for an empty pane, a config dir with no sessions/ (a Claude older than
 * the registry, or an account that has not started a session yet), or a pane
 * no record claims — never someone else's id.
 */
export function staleTranscriptOf(configDir: string, pane: string): string {
    if (!pane) return '';
    const dir = join(configDir || join(homedir(), '.claude'), 'sessions');
    let files: string[];
    try {
        files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
    } catch {
        return '';
    }
    for (const f of files) {
        let rec: { tmux?: unknown; sessionId?: unknown };
        try {
            rec = JSON.parse(readFileSync(join(dir, f), 'utf8'));
        } catch {
            continue;
        }
        if (!rec || typeof rec !== 'object') continue;
        const tmux = typeof rec.tmux === 'string' ? rec.tmux : '';
        if (!tmux.endsWith(pane)) continue;
        // jq's `.sessionId // empty`: a matching record without one is skipped.
        if (typeof rec.sessionId === 'string' && rec.sessionId) return rec.sessionId;
    }
    return '';
}

/**
 * stale_pane_tmux_session: the tmux session holding that pane. The WINDOW
 * name is not used — tmux renames a window after its foreground command, so
 * every session Clay has open is called `node`.
 */
export function stalePaneTmuxSession(pane: string, probe: Probe): string {
    if (!pane) return '';
    return probe.tmuxSession(pane).trim();
}

/**
 * awk's `$2 < m`: numeric when both sides look like numbers, a string compare
 * otherwise. Every row the scan writes is numeric; this is just awk's rule.
 */
function before(a: string, b: string): boolean {
    const x = Number(a);
    const y = Number(b);
    if (a.trim() !== '' && b.trim() !== '' && Number.isFinite(x) && Number.isFinite(y)) return x < y;
    return a < b;
}

/**
 * `date -r <epoch> '+%Y-%m-%d %H:%M:%S'`, local time, or '?' when the value is
 * not an epoch — the shell's `|| echo '?'`. Node does it on Linux too, where
 * GNU date reads -r as a file and the shell printed '?'.
 */
export function fmtLocal(epoch: string | number): string {
    const s = String(epoch).trim();
    const n = Number(s);
    if (s === '' || !Number.isFinite(n)) return '?';
    const d = new Date(n * 1000);
    const p = (v: number): string => String(v).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** The rows in an injected file: one per non-empty line. */
function readRows(file: string): string[] {
    try {
        return readFileSync(file, 'utf8').split('\n').filter((l) => l !== '');
    } catch {
        return [];
    }
}

export function parseSessionRow(line: string): SessionRow {
    const f = line.split('\t');
    // `read -r a b c d e` hands the last variable the rest of the line.
    return { pid: f[0] ?? '', at: f[1] ?? '', sup: f[2] ?? '', id: f[3] ?? '', name: f.slice(4).join('\t'), line };
}

function sessionRow(pid: string, at: string, sup: string, id: string, name: string): SessionRow {
    return { pid, at, sup, id, name, line: [pid, at, sup, id, name].join('\t') };
}

export function parseServiceRow(line: string): ServiceRow {
    const f = line.split('\t');
    return { name: f[0] ?? '', at: f[1] ?? '', mtime: f[2] ?? '', label: f.slice(3).join('\t') };
}

// --- the scans ------------------------------------------------------------------

/**
 * stale_scan: one row per RUNNING session launcher. The daemon and the bridge
 * run the same entrypoint, so they are dropped by their first argument; they
 * are services, they restart on their own, and they are nobody's conversation.
 *
 * DROVER_STALE_ROWS names a file of pre-made rows. That is how the suite tests
 * the reporting without a fork checkout or a live session, and it is the only
 * way in: nothing here ever invents a row.
 */
export function staleScan(cli: string, env: Env, probe: Probe, now: () => number): SessionRow[] {
    if (env.DROVER_STALE_ROWS) return readRows(env.DROVER_STALE_ROWS).map(parseSessionRow);
    const entry = join(cli, 'dist', 'index.mjs');
    // One snapshot, read many times: a `ps -ax` per session is a dozen full
    // process walks for one line of output.
    const all = probe.children();
    const rows: SessionRow[] = [];
    for (const raw of probe.processes()) {
        // `read` strips the leading whitespace ps pads a short pid with.
        const line = raw.trim();
        if (!line) continue;
        const sp = line.indexOf(' ');
        const pid = sp < 0 ? line : line.slice(0, sp);
        const at = line.indexOf(entry);
        if (at < 0) continue;
        const args = line.slice(at + entry.length);
        const first = args.startsWith(' ') ? args.slice(1) : args;
        if (/^(daemon|drover-|doctor)/.test(first)) continue;
        const started = staleStartedAt(pid, probe, now);
        if (started === null) continue;
        // Read ONCE per session and asked three questions: a session's
        // environment is a few kilobytes.
        const envs = probe.envDump(pid).split(' ');
        // Only the rebuilt bin/drover.mjs sets DROVER_RELAUNCH_FILE, so its
        // presence means that session can pick a new bundle up on its own.
        const sup = staleEnvOf(envs, 'DROVER_RELAUNCH_FILE') ? '1' : '0';
        const pane = staleEnvOf(envs, 'TMUX_PANE');
        // Claude's own registry first, then the claude child's argv, then the
        // launcher's. Each is a weaker answer than the one before it.
        let id = staleTranscriptOf(staleEnvOf(envs, 'CLAUDE_CONFIG_DIR'), pane);
        if (!id) {
            const re = new RegExp(`^ *${pid} .*claude_local_launcher\\.cjs .*--resume ([0-9a-f-]*)`);
            for (const c of all) {
                const m = re.exec(c);
                if (m) {
                    id = m[1];
                    break;
                }
            }
        }
        if (!id) {
            const m = /--resume ([0-9a-f][0-9a-f-]*)/.exec(args);
            if (m) id = m[1];
        }
        if (!id) id = '-';
        const pwd = staleEnvOf(envs, 'PWD');
        const where = pwd ? basename(pwd) : '';
        const tmux = stalePaneTmuxSession(pane, probe);
        const name = tmux && where ? `${tmux}:${where}` : where || `pid ${pid}`;
        rows.push(sessionRow(pid, String(started), sup, id, name));
    }
    return rows;
}

/**
 * stale_code_mtime: the newest mtime among the files a service loads. A
 * directory contributes its *.js files, because the bus imports every engine
 * module and a fix to any one of them is a fix the running bus does not have.
 */
export function staleCodeMtime(paths: string[]): string {
    let max: number | null = null;
    const consider = (file: string): void => {
        try {
            const m = Math.floor(statSync(file).mtimeMs / 1000);
            if (max === null || m > max) max = m;
        } catch {
            // `|| continue`
        }
    };
    for (const p of paths) {
        let st;
        try {
            st = statSync(p);
        } catch {
            continue;
        }
        if (st.isDirectory()) {
            let names: string[];
            try {
                names = readdirSync(p);
            } catch {
                continue;
            }
            for (const n of names) {
                if (!n.endsWith('.js')) continue;
                const f = join(p, n);
                try {
                    if (!statSync(f).isFile()) continue;
                } catch {
                    continue;
                }
                consider(f);
            }
        } else if (st.isFile()) {
            consider(p);
        }
    }
    return max === null ? '' : String(max);
}

/**
 * stale_service_pid: launchd's live pid for that label; '' when the job is
 * loaded but not running. A pid FILE can name a corpse while launchd runs
 * another process entirely.
 */
export function staleServicePid(label: string, probe: Probe): string {
    const m = /"PID" = ([0-9][0-9]*);/.exec(probe.launchctlList(label));
    return m ? m[1] : '';
}

/**
 * stale_service_scan: one row per RUNNING launchd service. DROVER_STALE_SERVICE_ROWS
 * is the same door as DROVER_STALE_ROWS. When session rows are injected and
 * service rows are not, the scan stays SILENT rather than falling back to
 * launchctl: a suite running against invented sessions must not inspect Clay's
 * real services either.
 */
export function staleServiceScan(droverDir: string, cli: string, env: Env, probe: Probe, now: () => number): ServiceRow[] {
    if (env.DROVER_STALE_SERVICE_ROWS) return readRows(env.DROVER_STALE_SERVICE_ROWS).map(parseServiceRow);
    if (env.DROVER_STALE_ROWS) return [];
    const rows: ServiceRow[] = [];
    for (const name of ['bus', 'bridge', 'daemon']) {
        const label = `com.bitspur.cattle-drover.${name}`;
        const pid = staleServicePid(label, probe);
        if (!pid) continue;
        const at = staleStartedAt(pid, probe, now);
        if (at === null) continue;
        // What each service actually loads: the bus is server.js plus every
        // engine module; the bridge and the daemon are both one long-lived
        // dist/index.mjs, the same file the sessions are compared against.
        const mtime = name === 'bus'
            ? staleCodeMtime([join(droverDir, 'server.js'), join(droverDir, 'engine')])
            : staleCodeMtime([join(cli, 'dist', 'index.mjs')]);
        if (!mtime) continue;
        rows.push({ name, at: String(at), mtime, label });
    }
    return rows;
}

// --- the reports, line for line ----------------------------------------------

/**
 * stale_report: which sessions the build just left behind. BOTH timestamps,
 * always. The whole diagnosis is one comparison — this process began at X, the
 * bundle under it was written at Y — and a report that prints only one of them
 * makes the reader go and find the other, which on 2026-08-31 nobody did for
 * eight hours (DROVE-220).
 */
export function renderSessionReport(rows: SessionRow[], mtime: string, prefix: string = PREFIX): string[] {
    const built = fmtLocal(mtime);
    const stale = rows.filter((r) => before(r.at, mtime));
    if (stale.length === 0) {
        return [`${prefix}: every running session is on the build that just finished (dist/index.mjs written ${built}).`];
    }
    const out = [
        `${prefix}: dist/index.mjs was written ${built}.`,
        `${prefix}: ${stale.length} running session(s) started BEFORE that — they are on the old CLI:`,
    ];
    for (const r of stale) {
        const when = fmtLocal(r.at);
        let note: string;
        if (r.sup === '1') note = 'picks the new bundle up when its current turn ends';
        else if (r.id === '-') note = 'NOT supervised — restart it by hand';
        else note = `NOT supervised — drover --resume ${r.id}`;
        // printf '  %-32s %-9s started %s · %s\n' name id8 when note
        out.push(`  ${r.name.padEnd(32)} ${r.id.slice(0, 8).padEnd(9)} started ${when} · ${note}`);
    }
    out.push(`${prefix}: a session on old code behaves exactly as if the fix never shipped. Say so before calling it live.`);
    return out;
}

/**
 * stale_service_report: the services running code that has since been
 * rewritten, and what to do in one pasteable line. Nothing at all when no
 * service is running — drover status owns not-running.
 */
export function renderServiceReport(rows: ServiceRow[], uid: string, prefix: string = PREFIX): string[] {
    if (rows.length === 0) return [];
    const stale = rows.filter((r) => before(r.at, r.mtime));
    if (stale.length === 0) {
        const up = rows.map((r) => r.name).join(' ');
        return [`${prefix}: every running service (${up}) started after the code it loads was written.`];
    }
    const out: string[] = [];
    for (const r of stale) {
        // BOTH timestamps on the line, always — the DROVE-220 rule.
        out.push(
            `${prefix}: the ${r.name} started ${fmtLocal(r.at)} and the code it loads was written ${fmtLocal(r.mtime)} — the ${r.name} is on old code. Kickstart it:`,
        );
        out.push(`  launchctl kickstart -k gui/${uid}/${r.label}`);
    }
    out.push(`${prefix}: a service on old code behaves exactly as if the fix never shipped. Kickstart before calling it live.`);
    return out;
}

function say(lines: string[]): void {
    if (lines.length) process.stdout.write(lines.join('\n') + '\n');
}

function complain(lines: string[]): void {
    process.stderr.write(lines.join('\n') + '\n');
}

/**
 * The verb. Always exits 0 on a report, stale or not, dist or no dist: this is
 * a REPORT bolted onto the ship loop, and a build must not fail because a
 * session could not be named. Only an argument it does not know is refused,
 * with 2, before anything is looked at.
 */
export async function run(args: string[], opts: StaleOptions = {}): Promise<number> {
    const first = args[0];
    if (first === '-h' || first === '--help') {
        process.stdout.write(HELP);
        return 0;
    }
    if (first !== undefined && first !== '' && first !== '--raw') {
        complain([`drover stale-sessions: unknown argument: ${first}`]);
        return 2;
    }

    const env = opts.env ?? process.env;
    const probe = opts.probe ?? systemProbe;
    const now = opts.now ?? ((): number => Math.floor(Date.now() / 1000));
    const denv = droverEnv(env);
    const cli = env.DROVER_FORK_CLI || join(denv.forkDir, 'packages', 'happy-cli');
    const mtime = env.DROVER_STALE_DIST_MTIME || staleDistMtime(cli);

    if (first === '--raw') {
        if (!mtime) return 0;
        const stale = staleScan(cli, env, probe, now).filter((r) => before(r.at, mtime));
        say(stale.map((r) => r.line));
        return 0;
    }

    if (!mtime) {
        complain([`${PREFIX}: no dist/index.mjs to compare running sessions against.`]);
    } else {
        say(renderSessionReport(staleScan(cli, env, probe, now), mtime));
    }
    // DROVER_DIR, not this checkout: the launchd bus loads $DROVER_DIR/server.js
    // (the path baked into its plist), and the checkout this CLI was built from
    // is not necessarily the one the service is on.
    const uid = String(opts.uid ? opts.uid() : (process.getuid?.() ?? ''));
    say(renderServiceReport(staleServiceScan(denv.droverDir, cli, env, probe, now), uid));
    return 0;
}
