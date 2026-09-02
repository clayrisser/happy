/**
 * `make install` and `make uninstall` on macOS (DROVE-321), in node (DROVE-315).
 *
 * The node twin of cattle-drover/scripts/drover-install.sh, which is THE one
 * implementation behind `make link`, `make unlink`, `make render-plists`,
 * `make launchd`, `make launchd-one`, `make install` and `make uninstall`. The
 * rule DROVE-306 set for tmux, applied here: the Makefile does not get to know
 * a second time where a symlink goes or how a plist is rendered, because two
 * implementations is how they drift. This port is a third reader of the same
 * rules, so it is a transcription: the rendered plist is byte-identical to the
 * shell's (`plutil -lint` plus `cmp` is the proof), and the DRY_RUN lines are
 * the exact strings a real install would run.
 *
 * WHAT IT WILL NOT DO, and these are rules rather than defaults:
 *
 *   It never overwrites a file it did not create. A real file where a symlink
 *   belongs, or a symlink pointing somewhere that is not another checkout's
 *   bin/, stops the install and reports.
 *
 *   It never removes something it did not create. `unlinks` deletes a symlink
 *   only when it points into THIS checkout's bin/; `unplists` deletes a plist
 *   only when it carries drover's own label.
 *
 *   It never uninstalls a package, and it never authenticates anything.
 *
 * NOTHING HERE MAY TOUCH A REAL INSTALL FROM A TEST. DROVER_LAUNCHCTL names
 * the launchctl to call, and the suite points it at a recording stub — the
 * ONLY reason the file half of this can be exercised without moving a live
 * agent. Every launchctl call in this file goes through that name.
 */

import { spawnSync } from 'node:child_process';
import {
    lstatSync,
    mkdirSync,
    readFileSync,
    readlinkSync,
    rmSync,
    statSync,
    symlinkSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { droverEnv } from './env';

export const labelPrefix = 'com.bitspur.cattle-drover';

export interface InstallIo {
    out: (s: string) => void;
    err: (s: string) => void;
}

export const processIo: InstallIo = {
    out: (s) => void process.stdout.write(s),
    err: (s) => void process.stderr.write(s),
};

export interface InstallCfg {
    droverDir: string;
    binDir: string;
    agentsDir: string;
    stateDir: string;
    home: string;
    links: string[];
    legacyLinks: string[];
    services: string[];
    started: string[];
    dryRun: boolean;
    launchctl: string;
    forceLinks: boolean;
    uid: string;
}

type Env = Record<string, string | undefined>;

const words = (s: string): string[] => s.split(/\s+/).filter(Boolean);

export function installCfg(env: Env = process.env, root?: string): InstallCfg {
    const home = env.HOME || homedir();
    const denv = droverEnv(env, home);
    return {
        droverDir: env.DROVER_DIR || root || denv.droverDir,
        binDir: env.BIN_DIR || join(home, '.local', 'bin'),
        agentsDir: env.AGENTS_DIR || join(home, 'Library', 'LaunchAgents'),
        // Through droverEnv, which is the one module that knows where drover's
        // state lives (DROVE-309). The shell script still spells its own XDG
        // default; that is the line the migration retires, and a second copy
        // of it here is exactly what the ticket forbids.
        stateDir: env.STATE_DIR || denv.stateDir,
        home,
        links: words(env.LINKS || 'drover'),
        legacyLinks: words(env.LEGACY_LINKS || 'claude-acct drover-flip'),
        services: words(env.SERVICES || 'bus relay bridge daemon'),
        started: words(env.STARTED || 'bus bridge daemon'),
        dryRun: (env.DRY_RUN || '0') === '1',
        launchctl: env.DROVER_LAUNCHCTL || 'launchctl',
        forceLinks: (env.DROVER_FORCE_LINKS || '0') === '1',
        uid: String(process.getuid?.() ?? 0),
    };
}

class Die extends Error {}

function domain(cfg: InstallCfg): string {
    return `gui/${cfg.uid}`;
}

/**
 * Print a command the way a person would type it, then run it — or, under
 * DRY_RUN, only print. Quoting is deliberately naive: every argument here is a
 * path or a launchd label, and the output is read by a human, not re-executed.
 */
function runCmd(cfg: InstallCfg, io: InstallIo, argv: string[]): { ok: boolean } {
    if (cfg.dryRun) {
        io.out(`  would run: ${argv.join(' ')}\n`);
        return { ok: true };
    }
    const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8' });
    if (r.stdout) io.out(r.stdout);
    if (r.stderr) io.err(r.stderr);
    return { ok: !r.error && r.status === 0 };
}

/**
 * READ-ONLY, so it runs under DRY_RUN too. Knowing whether a unit is already
 * loaded is the whole difference between an install that converges and one
 * that restarts the bus every time it is run — and restarting the bus drops
 * the surface a live session's prompts ride on.
 */
function isLoaded(cfg: InstallCfg, service: string): boolean {
    const r = spawnSync(cfg.launchctl, ['print', `${domain(cfg)}/${labelPrefix}.${service}`], { encoding: 'utf8' });
    return !r.error && r.status === 0;
}

// --- symlinks ----------------------------------------------------------------

function lstat(p: string) {
    try {
        return lstatSync(p);
    } catch {
        return null;
    }
}

/**
 * A drover-shaped target is `<something>/bin/<name>`: another checkout of this
 * repo. Repointing one of those is the documented multi-checkout case.
 * Anything else on that name belongs to somebody else.
 */
function droverShaped(name: string, target: string): boolean {
    return target.endsWith(`/bin/${name}`);
}

function cmdLinks(cfg: InstallCfg, io: InstallIo): number {
    // A linked git worktree has a .git FILE where the main checkout has a
    // directory. Linking from one would repoint the LIVE cli — $BIN_DIR/drover
    // is a symlink straight into the tree — at a lane that gets deleted, and
    // the next `drover` in any terminal would be a dangling link.
    let dotGitIsFile = false;
    try {
        dotGitIsFile = statSync(join(cfg.droverDir, '.git')).isFile();
    } catch {
        dotGitIsFile = false;
    }
    if (dotGitIsFile) {
        io.err(`links: ${cfg.droverDir} is a linked git worktree, and ${cfg.binDir}/drover is the live CLI.\n`);
        io.err('       Run this from the main checkout, or name one:\n');
        io.err('         DROVER_DIR=/path/to/main/checkout make install\n');
        return 1;
    }
    if (cfg.dryRun) io.out(`  would run: mkdir -p ${cfg.binDir}\n`);
    else mkdirSync(cfg.binDir, { recursive: true });

    for (const c of cfg.links) {
        const src = join(cfg.droverDir, 'bin', c);
        const dst = join(cfg.binDir, c);
        if (!lstat(src)) throw new Die(`links: ${src} does not exist`);
        const st = lstat(dst);
        if (st?.isSymbolicLink()) {
            const cur = readlinkSync(dst);
            if (cur === src) {
                io.out(`  link   ${dst} -> ${src} (unchanged)\n`);
                continue;
            }
            if (!cfg.forceLinks && !droverShaped(c, cur)) {
                io.err(`links: ${dst} already points at ${cur}, which is not another drover checkout.\n`);
                io.err('       Refusing to replace something this install did not create.\n');
                io.err('       DROVER_FORCE_LINKS=1 lifts this.\n');
                return 1;
            }
            lnsfn(cfg, io, src, dst);
            io.out(`  link   ${dst} -> ${src} (repointed, was ${cur})\n`);
        } else if (st) {
            io.err(`links: ${dst} exists and is a real file, not a symlink.\n`);
            io.err('       Refusing to overwrite something this install did not create.\n');
            return 1;
        } else {
            lnsfn(cfg, io, src, dst);
            io.out(`  link   ${dst} -> ${src} (created)\n`);
        }
    }
    for (const c of cfg.legacyLinks) {
        if (!lstat(join(cfg.binDir, c))?.isSymbolicLink()) continue;
        io.out(`  note   ${join(cfg.binDir, c)} is a deprecation shim — \`make uninstall\` removes it\n`);
    }
    return 0;
}

function lnsfn(cfg: InstallCfg, io: InstallIo, src: string, dst: string): void {
    if (cfg.dryRun) {
        io.out(`  would run: ln -sfn ${src} ${dst}\n`);
        return;
    }
    try {
        unlinkSync(dst);
    } catch {
        // Nothing there is the ordinary case; `ln -sfn` does not mind either.
    }
    symlinkSync(src, dst);
}

function cmdUnlinks(cfg: InstallCfg, io: InstallIo): number {
    for (const c of [...cfg.links, ...cfg.legacyLinks]) {
        const dst = join(cfg.binDir, c);
        const st = lstat(dst);
        if (st?.isSymbolicLink()) {
            const cur = readlinkSync(dst);
            if (cur.startsWith(`${cfg.droverDir}/bin/`)) {
                if (cfg.dryRun) io.out(`  would run: rm -f ${dst}\n`);
                else rmSync(dst, { force: true });
                io.out(`  unlink ${dst} (removed)\n`);
            } else {
                io.out(`  keep   ${dst} -> ${cur} (not this checkout — left alone)\n`);
            }
        } else if (st) {
            io.out(`  keep   ${dst} is a real file — left alone\n`);
        }
    }
    return 0;
}

// --- plists ------------------------------------------------------------------

/**
 * A service may override the shared template with its own
 * launchd/<label>.<service>.plist.in. Only the daemon does, and that file
 * explains itself; the shared template stays the rule.
 */
export function templateFor(cfg: InstallCfg, service: string): string {
    const own = join(cfg.droverDir, 'launchd', `${labelPrefix}.${service}.plist.in`);
    try {
        if (statSync(own).isFile()) return own;
    } catch {
        // Fall through to the shared template.
    }
    return join(cfg.droverDir, 'launchd', `${labelPrefix}.plist.in`);
}

/**
 * The render, and it has to be BYTE-IDENTICAL to the shell's four `sed -e`
 * substitutions — same placeholders, same order, every occurrence. That
 * identity is what makes this port provable: `plutil -lint` on the result plus
 * `cmp` against the shell's render of the same template.
 */
export function renderPlist(cfg: InstallCfg, service: string): string {
    return readFileSync(templateFor(cfg, service), 'utf8')
        .split('__NAME__').join(service)
        .split('__DROVER_DIR__').join(cfg.droverDir)
        .split('__STATE_DIR__').join(cfg.stateDir)
        .split('__HOME__').join(cfg.home);
}

/**
 * Services whose rendered plist differs from what is already on disk. Returned
 * rather than kept in a global, but the reason it exists is the shell's: "did
 * this change?" is a comparison against the bytes that were there BEFORE the
 * render, so once the file is written the answer is gone. That is why render
 * and converge are one call and not two make targets.
 */
function plistsRender(cfg: InstallCfg, io: InstallIo): string[] {
    const changed: string[] = [];
    if (!cfg.dryRun) {
        mkdirSync(cfg.agentsDir, { recursive: true });
        mkdirSync(join(cfg.stateDir, 'logs'), { recursive: true });
    } else {
        io.out(`  would run: mkdir -p ${cfg.agentsDir} ${join(cfg.stateDir, 'logs')}\n`);
    }
    const tmp = join(process.env.TMPDIR || tmpdir(), `drover-install.${process.pid}.plist`);
    try {
        for (const s of cfg.services) {
            const dst = join(cfg.agentsDir, `${labelPrefix}.${s}.plist`);
            const body = renderPlist(cfg, s);
            writeFileSync(tmp, body);
            // plutil refuses a malformed plist here rather than letting launchd
            // refuse it later with a less useful message. Absent on Linux,
            // where nothing calls this anyway.
            const lint = spawnSync('plutil', ['-lint', tmp], { encoding: 'utf8' });
            if (!lint.error && lint.status !== 0) {
                throw new Die(`plists: rendering ${s} from ${templateFor(cfg, s)} produced an invalid plist`);
            }
            let existing: string | null = null;
            try {
                existing = readFileSync(dst, 'utf8');
            } catch {
                existing = null;
            }
            if (existing !== null && existing === body) {
                io.out(`  plist  ${dst} (unchanged)\n`);
                continue;
            }
            const verb = existing !== null ? 'updated' : 'written';
            changed.push(s);
            if (cfg.dryRun) {
                io.out(`  plist  ${dst} (${verb} — DRY_RUN, not written)\n`);
            } else {
                writeFileSync(dst, body);
                io.out(`  plist  ${dst} (${verb})\n`);
            }
        }
    } finally {
        rmSync(tmp, { force: true });
    }
    return changed;
}

function cmdUnplists(cfg: InstallCfg, io: InstallIo): number {
    for (const s of cfg.services) {
        const dst = join(cfg.agentsDir, `${labelPrefix}.${s}.plist`);
        let body: string;
        try {
            body = readFileSync(dst, 'utf8');
        } catch {
            io.out(`  plist  ${dst} (not present)\n`);
            continue;
        }
        // Ownership by LABEL, not by filename. A file that happens to sit at
        // that path but declares some other job is not ours to delete.
        if (body.includes(`<string>${labelPrefix}.${s}</string>`)) {
            if (cfg.dryRun) io.out(`  would run: rm -f ${dst}\n`);
            else rmSync(dst, { force: true });
            io.out(`  plist  ${dst} (removed)\n`);
        } else {
            io.out(`  keep   ${dst} does not declare ${labelPrefix}.${s} — left alone\n`);
        }
    }
    return 0;
}

// --- launchd -----------------------------------------------------------------

/**
 * launchd's bootout is asynchronous: the job can still be present for a beat
 * after the call returns, and bootstrapping into a domain that still holds the
 * label fails. Wait for it to actually go, then bootstrap.
 */
function bootoutWait(cfg: InstallCfg, io: InstallIo, service: string): void {
    runCmd(cfg, io, [cfg.launchctl, 'bootout', `${domain(cfg)}/${labelPrefix}.${service}`]);
    if (cfg.dryRun) return;
    for (let n = 0; n <= 30 && isLoaded(cfg, service); n++) {
        sleepSync(1000);
    }
}

function sleepSync(ms: number): void {
    // A real sleep without an async hop, so the converge stays one straight
    // line the way the shell's `sleep 1` did.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function bootstrap(cfg: InstallCfg, io: InstallIo, service: string): void {
    const plist = join(cfg.agentsDir, `${labelPrefix}.${service}.plist`);
    const r = runCmd(cfg, io, [cfg.launchctl, 'bootstrap', domain(cfg), plist]);
    if (!r.ok) {
        sleepSync(2000);
        runCmd(cfg, io, [cfg.launchctl, 'bootstrap', domain(cfg), plist]);
    }
}

/**
 * THE CONVERGING LOAD, and the reason `make install` is safe to rerun. A unit
 * already loaded on the plist it is already running is left ALONE. The old
 * `make launchd` booted every unit out and back in unconditionally, which on a
 * rerun drops the bus and the bridge — the surfaces a live session's prompts
 * ride on — for no change at all.
 */
function cmdLaunchd(cfg: InstallCfg, io: InstallIo): number {
    const changed = plistsRender(cfg, io);
    for (const s of cfg.started) {
        if (isLoaded(cfg, s)) {
            if (changed.includes(s)) {
                io.out(`  unit   ${labelPrefix}.${s} (plist changed — reloading)\n`);
                bootoutWait(cfg, io, s);
                bootstrap(cfg, io, s);
            } else {
                io.out(`  unit   ${labelPrefix}.${s} (already loaded, unchanged)\n`);
            }
        } else {
            io.out(`  unit   ${labelPrefix}.${s} (loading)\n`);
            bootstrap(cfg, io, s);
        }
    }
    return 0;
}

/**
 * The old `make launchd`: bootout and bootstrap every started unit whether or
 * not anything changed. Kept as its own verb because forcing a restart is a
 * real thing to want; it is no longer what `make install` does.
 */
function cmdLaunchdRestart(cfg: InstallCfg, io: InstallIo): number {
    plistsRender(cfg, io);
    for (const s of cfg.started) {
        io.out(`  unit   ${labelPrefix}.${s} (restarting)\n`);
        bootoutWait(cfg, io, s);
        bootstrap(cfg, io, s);
    }
    if (cfg.dryRun) {
        io.out(`  would run: ${cfg.launchctl} list | grep cattle-drover\n`);
    } else {
        const r = spawnSync(cfg.launchctl, ['list'], { encoding: 'utf8' });
        for (const line of (r.stdout || '').split('\n')) {
            if (line.includes('cattle-drover')) io.out(`${line}\n`);
        }
    }
    return 0;
}

function cmdLaunchdOne(cfg: InstallCfg, io: InstallIo, service: string | undefined): number {
    if (!service) throw new Die('launchd-one: usage: make launchd-one SERVICE=daemon');
    plistsRender(cfg, io);
    io.out(`  unit   ${labelPrefix}.${service} (restarting)\n`);
    bootoutWait(cfg, io, service);
    bootstrap(cfg, io, service);
    return 0;
}

/**
 * Start or stop ONE already-rendered unit without touching its plist. This is
 * what `make relay-on` / `make relay-off` are: the relay's agent stays
 * installed in either server mode, and turning it on is a bootstrap rather
 * than a render.
 */
function cmdStart(cfg: InstallCfg, io: InstallIo, service: string | undefined): number {
    if (!service) throw new Die('start: usage: sh scripts/drover-install.sh start relay');
    if (isLoaded(cfg, service)) {
        io.out(`  unit   ${labelPrefix}.${service} (already loaded)\n`);
        return 0;
    }
    bootstrap(cfg, io, service);
    io.out(`  unit   ${labelPrefix}.${service} (loaded)\n`);
    return 0;
}

function cmdStop(cfg: InstallCfg, io: InstallIo, service: string | undefined): number {
    if (!service) throw new Die('stop: usage: sh scripts/drover-install.sh stop relay');
    if (isLoaded(cfg, service)) {
        runCmd(cfg, io, [cfg.launchctl, 'bootout', `${domain(cfg)}/${labelPrefix}.${service}`]);
        io.out(`  unit   ${labelPrefix}.${service} (booted out)\n`);
    } else {
        io.out(`  unit   ${labelPrefix}.${service} (not loaded)\n`);
    }
    return 0;
}

function cmdUnload(cfg: InstallCfg, io: InstallIo): number {
    for (const s of cfg.services) {
        if (isLoaded(cfg, s)) {
            runCmd(cfg, io, [cfg.launchctl, 'bootout', `${domain(cfg)}/${labelPrefix}.${s}`]);
            io.out(`  unit   ${labelPrefix}.${s} (booted out)\n`);
        } else {
            io.out(`  unit   ${labelPrefix}.${s} (not loaded)\n`);
        }
    }
    return 0;
}

function cmdReport(cfg: InstallCfg, io: InstallIo): number {
    io.out(`checkout   ${cfg.droverDir}\n`);
    for (const c of cfg.links) {
        const dst = join(cfg.binDir, c);
        if (lstat(dst)?.isSymbolicLink()) io.out(`on PATH    ${dst} -> ${readlinkSync(dst)}\n`);
        else io.out(`on PATH    ${dst} is NOT linked\n`);
    }
    for (const s of cfg.services) {
        const dst = join(cfg.agentsDir, `${labelPrefix}.${s}.plist`);
        let rendered = false;
        try {
            rendered = statSync(dst).isFile();
        } catch {
            rendered = false;
        }
        io.out(`unit       ${s}: ${rendered ? 'rendered' : 'not rendered'}, ${isLoaded(cfg, s) ? 'loaded' : 'not loaded'}\n`);
    }
    return 0;
}

const USAGE = 'usage: sh scripts/drover-install.sh '
    + '<links|unlinks|plists|unplists|launchd|launchd-restart|launchd-one|start|stop|unload|report>';

export async function run(args: string[], io: InstallIo = processIo, cfg: InstallCfg = installCfg()): Promise<number> {
    const cmd = args[0] ?? '';
    const rest = args.slice(1);
    try {
        switch (cmd) {
            case 'links': return cmdLinks(cfg, io);
            case 'unlinks': return cmdUnlinks(cfg, io);
            case 'plists': plistsRender(cfg, io); return 0;
            case 'unplists': return cmdUnplists(cfg, io);
            case 'launchd': return cmdLaunchd(cfg, io);
            case 'launchd-restart': return cmdLaunchdRestart(cfg, io);
            case 'launchd-one': return cmdLaunchdOne(cfg, io, rest[0]);
            case 'start': return cmdStart(cfg, io, rest[0]);
            case 'stop': return cmdStop(cfg, io, rest[0]);
            case 'unload': return cmdUnload(cfg, io);
            case 'report': return cmdReport(cfg, io);
            default:
                io.err(`${USAGE}\n`);
                return 2;
        }
    } catch (e) {
        if (e instanceof Die) {
            io.err(`drover-install: ${e.message}\n`);
            return 1;
        }
        throw e;
    }
}
