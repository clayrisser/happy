/**
 * `drover config` — every edit drover makes to a file it does not own, and the
 * command that takes those edits back out (DROVE-306), in node (DROVE-315).
 *
 * A transcription of cattle-drover/libexec/drover-config. The sentences are
 * the contract's surface — "CREATED …, there was no tmux config here" versus
 * "appended the drover block" is how a person tells whether drover made a file
 * they did not have — so they are copied byte for byte, not paraphrased. The
 * marker contract itself lives in configBlock.ts.
 *
 * DISCOVERY ASKS TMUX. tmux 3.2+ exposes its own search order as
 * `#{config_files}`, in load order, whether or not the files exist; a
 * hardcoded list cannot be right about a build with XDG compiled out or a
 * distro that moved the system file. Two guards on the answer, and both
 * matter: only paths under $HOME are kept, and $HOME is OUR $HOME — the probe
 * talks to whatever tmux server is reachable, so filtering on the current home
 * is what stops a test with a throwaway HOME from ever being handed the path
 * to a real config.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
    ConfigRefusal,
    type ConfigCtx,
    configCtx,
    droverBlockInstall,
    droverBlockRemove,
    droverBlockState,
    droverConfigBackup,
    droverConfigBackupDir,
    droverConfigReplace,
    droverConfigResolve,
} from './configBlock';
import { droverEnv } from './env';

const HELP = `drover config — the files drover writes that it did not create.

USAGE
  drover config [status]        every such file: where it is, whether drover's
                                block is in it, and where the backup went
  drover config install [tmux]  write or converge the marked block
  drover config uninstall [tmux]
                                remove exactly the marked block, leaving the
                                rest of the file byte for byte as it was
  drover config target [tmux]   the file that would be written, and the other
                                candidates tmux would also read
  drover config check [FILE]    validate a drover.yaml (the plugin selection
                                and per-plugin config) against the schema;
                                --path prints which file would be read

WHAT A MARKED BLOCK IS
  Everything drover writes into somebody else's config sits between

    # >>> drover >>>
    # <<< drover <<<

  Rewriting replaces what is between them. Uninstalling removes exactly that
  span. The first write copies the original to
  $STATE_DIR/backups/<flattened-path>.<utc-stamp>.bak, once.

ENV
  DROVER_CONFIG             the drover.yaml \`check\` reads, instead of the
                            search order under ~/.drover
  DROVER_TMUX_CONF          write THIS file instead of discovering one
  DROVER_CONFIG_BACKUP_DIR  where the pre-drover copies go
  DROVER_CONFIG_RELOAD=0    do not \`tmux source-file\` after a write
`;

const STRUCTURED = `structured configs  (converged on STRUCTURE, not on markers — JSON has no
                     comment syntax to hang a marker on, so the block half of
                     the contract does not apply; the rest does)
  ~/.claude.json, ~/.claude/settings.json      libexec/drover-trust
      backed up once into the directory above, before the first write
  ~/.claude.json (the ambient account only)    libexec/drover-account-login
                                               libexec/drover-account-edit
      the SECOND writer of that file: json_account_settle_first_run settles
      Claude Code's onboarding keys. Same once-per-file backup. drover's own
      accounts.json and ledgers are skipped, being files drover made.
  <account>/settings.json, <account>/.claude.json
                                               libexec/drover-sync-commands
      backed up per run into <account>/drover-backups/
  ~/.config/opencode/opencode.jsonc            engine/opencode-mirror.js
      converges the "mcp" member only, keeps everything else byte for byte,
      and keeps the block it last wrote beside the sync stamp. NOT backed up.
  ~/.cursor/hooks.json                         libexec/drover-cursor
      merged, not replaced, and machine-wide: the Cursor IDE reads the same
      file. Backed up once into the directory above, before the first write.
  All of them refuse to rewrite a file that does not parse, and replace it
  atomically through a temp file beside the target.

not a config anybody wrote  (drover's own, listed so this is a full inventory)
  ~/.local/bin/drover                          make link / make unlink
  ~/Library/LaunchAgents/com.bitspur.cattle-drover.*.plist
                                               make launchd / make unlaunchd
`;

export interface ConfigIo {
    out: (s: string) => void;
    err: (s: string) => void;
}

export const processIo: ConfigIo = {
    out: (s) => void process.stdout.write(s),
    err: (s) => void process.stderr.write(s),
};

/**
 * The fallback when tmux cannot be asked — no tmux installed yet, no server
 * running, or a tmux older than 3.2.
 *
 * A TABLE, not a code path, because it had to survive this rewrite exactly and
 * an ordered list transcribes where an `if` ladder gets reinterpreted. One
 * path per row, in TMUX'S OWN LOAD ORDER, first loaded first — which is also
 * last-wins order read backwards, and the reason selection takes the LAST
 * entry rather than the first. The two roots are PLACEHOLDERS expanded below,
 * never evaluated: a table is data, and running data as shell is how a home
 * directory with a quote in it becomes a command.
 */
export const tmuxFallbackSearchOrder = ['HOME/.tmux.conf', 'XDG/tmux/tmux.conf'] as const;

function isFile(p: string): boolean {
    try {
        return statSync(p).isFile();
    } catch {
        return false;
    }
}

/** Only paths under OUR $HOME survive; /opt/homebrew/etc/tmux.conf is not ours to write. */
function underHome(p: string, home: string): boolean {
    return p.startsWith(`${home}/`);
}

/** What tmux itself says its search order is, filtered to this home. */
export function tmuxSearchOrder(ctx: ConfigCtx): string[] {
    let cf = '';
    if (ctx.env.DROVER_TMUX_PROBE_OUT) {
        cf = ctx.env.DROVER_TMUX_PROBE_OUT;
    } else {
        const r = spawnSync('tmux', ['display-message', '-p', '#{config_files}'], { encoding: 'utf8' });
        if (!r.error && r.status === 0) cf = (r.stdout || '').trim();
    }
    // A tmux too old for the format leaves it unexpanded rather than empty.
    if (cf.includes('#{config_files}')) cf = '';
    return cf
        .split(',')
        .map((s) => s.replace(/\n/g, ''))
        .filter((p) => underHome(p, ctx.home));
}

export function tmuxStaticOrder(ctx: ConfigCtx): string[] {
    const xdg = ctx.env.XDG_CONFIG_HOME || join(ctx.home, '.config');
    return tmuxFallbackSearchOrder.map((row) => (row.startsWith('HOME/')
        ? join(ctx.home, row.slice('HOME/'.length))
        : join(xdg, row.slice('XDG/'.length))));
}

function dedupe(list: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const p of list) {
        if (!p.trim()) continue;
        if (seen.has(p)) continue;
        seen.add(p);
        out.push(p);
    }
    return out;
}

/** Every candidate under $HOME, in load order, deduplicated. */
export function tmuxCandidates(ctx: ConfigCtx): string[] {
    const probed = tmuxSearchOrder(ctx);
    return dedupe(probed.length ? probed : tmuxStaticOrder(ctx));
}

export type TargetHow = 'explicit' | 'block' | 'existing' | 'create-probed' | 'create-default';

export interface Target {
    how: TargetHow;
    path: string;
}

/**
 * The ONE file to write, and it is not a coin toss.
 *
 *   explicit        DROVER_TMUX_CONF said so; an instruction outranks discovery
 *   block           a candidate already carries a drover block — convergence
 *                   beats preference, so an upgrade rewrites it where it is
 *   existing        the LAST existing candidate, because tmux loads them in
 *                   order and the last to load is the one that wins a conflict
 *   create-probed   nothing exists; the last path tmux ITSELF named
 *   create-default  nothing exists and tmux could not be asked, so
 *                   ~/.tmux.conf: every tmux ever built reads it, and guessing
 *                   XDG at a tmux we could not question is how you write a
 *                   file nothing loads
 */
export function tmuxTarget(ctx: ConfigCtx): Target {
    if (ctx.env.DROVER_TMUX_CONF) return { how: 'explicit', path: ctx.env.DROVER_TMUX_CONF };

    const probe = tmuxSearchOrder(ctx);
    const probed = probe.length > 0;
    const cands = dedupe(probed ? probe : tmuxStaticOrder(ctx));

    let block = '';
    let exist = '';
    let last = '';
    for (const c of cands) {
        last = c;
        if (!isFile(c)) continue;
        exist = c;
        if (droverBlockState(c) !== 'absent') block = c;
    }

    if (block) return { how: 'block', path: block };
    if (exist) return { how: 'existing', path: exist };
    if (probed) return { how: 'create-probed', path: last };
    return { how: 'create-default', path: join(ctx.home, '.tmux.conf') };
}

/**
 * The BODY the markers wrap. It carries the checkout path, which is the whole
 * of what an upgrade can change: rerunning install from a different DROVER_DIR
 * rewrites this block in place and never appends a second one.
 */
export function tmuxBody(droverDir: string): string[] {
    return [
        '# Cattle Drover (BASED-98): prefix+F flip, prefix+M-f pick, prefix+A accounts,',
        '# and the prompt subscriber on attach. The keys themselves live in the file',
        '# below, so changing one is an edit there plus `prefix + r` — never another',
        '# run of this.',
        '#',
        '# MANAGED BLOCK. `drover config install tmux` rewrites everything between the',
        '# markers; `drover config uninstall tmux` removes exactly it. Edit around it',
        '# freely; edits inside it are lost on the next run.',
        `source-file -q ${droverDir}/tmux/drover.conf`,
    ];
}

// --- the line the old Makefile wrote ----------------------------------------
//
// Every machine that ran `make tmux` before DROVE-306 has an UNMARKED
// source-file line, put there by a printf that also wrote one comment line
// above it and a blank line above that. It is drover's writing, so it is
// drover's to take back. Deliberately narrow: only `source-file -q` with the
// drover.conf path this project ships, and the comment and blank line are
// stripped only when they are the exact two the old Makefile emitted.
const legacyComment = '# Cattle Drover (BASED-98): prefix+F flip, prefix+M-f pick, prefix+A accounts';
const legacyLine = /^source-file -q .*\/tmux\/drover\.conf$/;

function readLines(path: string): string[] {
    const lines = readFileSync(path, 'utf8').split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines;
}

export function legacyPresent(path: string): boolean {
    if (!isFile(path)) return false;
    let inside = false;
    for (const line of readLines(path)) {
        if (line === '# >>> drover >>>') {
            inside = true;
            continue;
        }
        if (line === '# <<< drover <<<') {
            inside = false;
            continue;
        }
        if (inside) continue;
        if (line.match(legacyLine)) return true;
    }
    return false;
}

/** Two lines of lookbehind, held and flushed, so the comment and the blank above go with it. */
export function legacyStrip(path: string): void {
    const out: string[] = [];
    let hold: string[] = [];
    const flush = () => {
        out.push(...hold);
        hold = [];
    };
    let inside = false;
    for (const line of readLines(path)) {
        if (line === '# >>> drover >>>') {
            flush();
            inside = true;
            out.push(line);
            continue;
        }
        if (line === '# <<< drover <<<') {
            inside = false;
            out.push(line);
            continue;
        }
        if (inside) {
            out.push(line);
            continue;
        }
        if (line.match(legacyLine)) {
            if (hold.length >= 1 && hold[hold.length - 1] === legacyComment) hold.pop();
            if (hold.length >= 1 && hold[hold.length - 1] === '') hold.pop();
            flush();
            continue;
        }
        if (hold.length === 2) {
            out.push(hold[0]);
            hold = [hold[1]];
        }
        hold.push(line);
    }
    flush();
    droverConfigReplace(droverConfigResolve(path), out.length ? out.join('\n') + '\n' : '');
}

/**
 * A write that does not reach the running server is a write somebody has to
 * finish by hand, so this reloads — and it reloads ONLY the file the running
 * server actually reads. That test is not politeness: a test writes into a
 * throwaway HOME, that path is not in the live server's `#{config_files}`, so
 * nothing is sourced. Without it, a suite run from inside tmux would source a
 * fixture into the session somebody is working in.
 */
function maybeReload(path: string, ctx: ConfigCtx, io: ConfigIo): void {
    if ((ctx.env.DROVER_CONFIG_RELOAD ?? '1') !== '1') return;
    const probe = spawnSync('tmux', ['display-message', '-p', '#{config_files}'], { encoding: 'utf8' });
    if (probe.error || probe.status !== 0) return;
    const files = (probe.stdout || '').trim();
    if (!`,${files},`.includes(`,${path},`)) return;
    const r = spawnSync('tmux', ['source-file', path], { encoding: 'utf8' });
    if (!r.error && r.status === 0) io.out('  reloaded the running tmux\n');
}

/** Every candidate except the chosen one. Whole-line, fixed-string: a path is not a regex. */
function otherCandidates(ctx: ConfigCtx, chosen: string): string[] {
    return tmuxCandidates(ctx).filter((c) => c !== chosen);
}

function sayTarget(ctx: ConfigCtx, io: ConfigIo): number {
    const t = tmuxTarget(ctx);
    io.out(`${t.path}\n`);
    const why: Record<TargetHow, string> = {
        block: '  chosen because it already carries drover\'s block',
        existing: '  chosen because it exists and tmux loads it last',
        'create-probed': '  does not exist yet; tmux named it in #{config_files}',
        'create-default': '  does not exist yet, and tmux could not be asked',
        explicit: '  named by DROVER_TMUX_CONF',
    };
    io.err(`${why[t.how]}\n`);
    if (t.how !== 'explicit') {
        // A machine with two of these files has a real ambiguity, and silently
        // picking one is how the bindings end up in the file that loses.
        const others = otherCandidates(ctx, t.path);
        if (others.length) {
            io.err('  tmux also reads (load order, last wins):\n');
            for (const o of others) io.err(`    ${o}\n`);
        }
    }
    return 0;
}

function doInstall(ctx: ConfigCtx, io: ConfigIo): number {
    const path = tmuxTarget(ctx).path;
    // Only files that are actually THERE. Naming a path tmux would read if it
    // existed is noise on the one run where the reader most needs to see what
    // happened.
    const others = otherCandidates(ctx, path).filter(isFile);

    // The backup belongs to whichever write happens FIRST, and the legacy
    // strip is a write. droverBlockInstall takes it otherwise, and takes it
    // once: a second install must not file a copy of drover's own output as if
    // it were the user's original.
    let backup: string | null = null;
    if (legacyPresent(path)) {
        backup = droverConfigBackup(droverConfigResolve(path), ctx);
        legacyStrip(path);
        io.out(`removed the old unmarked source-file line from ${path}\n`);
    }

    const droverDir = ctx.env.DROVER_DIR || droverEnv(ctx.env, ctx.home).droverDir;
    const res = droverBlockInstall(path, tmuxBody(droverDir), ctx);
    if (!backup) backup = res.backup;

    switch (res.did) {
        case 'created':
            io.out(`CREATED ${path} — there was no tmux config here, so drover made one\n`);
            break;
        case 'appended':
            io.out(`appended the drover block to ${path} (your own lines are untouched)\n`);
            break;
        case 'rewrote':
            io.out(`rewrote the drover block in ${path}\n`);
            break;
        case 'unchanged':
            io.out(`the drover block in ${path} is already current\n`);
            break;
    }
    if (backup) io.out(`  backed the original up to ${backup}\n`);
    if (others.length) io.out(`  tmux also reads: ${others.join(' ')}\n`);
    io.out('  remove it with: drover config uninstall tmux\n');
    maybeReload(path, ctx, io);
    return 0;
}

/**
 * Uninstall sweeps EVERY candidate, not just the one install would choose. Two
 * configs can each have picked up a block — a machine that grew a second one,
 * a DROVER_TMUX_CONF run — and an uninstall that cleans one of them is the
 * same broken promise as no uninstall at all.
 */
function doUninstall(ctx: ConfigCtx, io: ConfigIo): number {
    const list = ctx.env.DROVER_TMUX_CONF ? [ctx.env.DROVER_TMUX_CONF] : tmuxCandidates(ctx);
    let any = false;
    for (const c of list) {
        if (!c || !isFile(c)) continue;
        if (legacyPresent(c)) {
            legacyStrip(c);
            io.out(`removed the old unmarked source-file line from ${c}\n`);
            any = true;
        }
        const did = droverBlockRemove(c);
        if (did === 'removed') {
            io.out(`removed the drover block from ${c}\n`);
            any = true;
        } else if (did === 'deleted') {
            io.out(`removed ${c} — it held nothing but drover's block\n`);
            any = true;
        }
    }
    if (!any) {
        io.out('nothing to remove — no drover block in any tmux config\n');
    } else {
        io.out('  the bindings are gone from the config; a running tmux keeps them\n');
        io.out('  until it is restarted or its config is re-sourced\n');
    }
    return 0;
}

function doStatus(ctx: ConfigCtx, io: ConfigIo): number {
    io.out('FILES DROVER WRITES THAT IT DID NOT CREATE\n');
    io.out('\n');
    io.out('tmux config  (marked block — drover config install|uninstall tmux)\n');
    const chosen = tmuxTarget(ctx).path;
    for (const c of tmuxCandidates(ctx)) {
        const mark = c === chosen ? '* ' : '  ';
        if (!isFile(c)) {
            io.out(`${mark}${c} (does not exist)\n`);
            continue;
        }
        let st: string = droverBlockState(c);
        if (legacyPresent(c)) st = `${st}, plus an unmarked pre-DROVE-306 source-file line`;
        io.out(`${mark}${c} (${st})\n`);
    }
    if (ctx.env.DROVER_TMUX_CONF) {
        io.out(`  DROVER_TMUX_CONF overrides discovery: ${ctx.env.DROVER_TMUX_CONF}\n`);
    }
    io.out('\n');
    const bd = droverConfigBackupDir(ctx);
    io.out(`backups      ${bd}\n`);
    if (existsSync(bd)) {
        let entries: string[] = [];
        try {
            entries = readdirSync(bd).sort();
        } catch {
            entries = [];
        }
        for (const e of entries) io.out(`  ${e}\n`);
    } else {
        io.out('  (none yet — nothing has been edited on this machine)\n');
    }
    io.out('\n');
    // Named rather than acted on, so this is an inventory a reader can trust
    // instead of a list of the parts that happened to be easy.
    io.out(STRUCTURED);
    return 0;
}

interface ConfigCheckEngine {
    main: (argv: string[], opts?: { out?: { write: (s: string) => void }; err?: { write: (s: string) => void } }) => number;
}

export async function run(args: string[], io: ConfigIo = processIo, ctx: ConfigCtx = configCtx()): Promise<number> {
    const verb = args[0] ?? 'status';

    // `drover config check` — the user's own drover.yaml, validated against the
    // schema (DROVE-326). Its argument is a FILE, not a target, so it
    // dispatches BEFORE the target guard below.
    if (verb === 'check') {
        const { loadEngine } = await import('./engine');
        const engine = await loadEngine<ConfigCheckEngine>(join('plugin', 'config-check.js'));
        return engine.main(args.slice(1));
    }

    const target = args[1];
    if (target !== undefined && target !== '' && target !== 'tmux' && target !== 'all') {
        io.err(`drover config: unknown target '${target}' — the only one today is tmux\n`);
        return 2;
    }

    try {
        switch (verb) {
            case '-h':
            case '--help':
            case 'help':
                io.out(HELP);
                return 0;
            case 'status':
                return doStatus(ctx, io);
            case 'target':
                return sayTarget(ctx, io);
            case 'install':
                return doInstall(ctx, io);
            case 'uninstall':
            case 'remove':
                return doUninstall(ctx, io);
            default:
                io.err(`drover config: unknown verb '${verb}'\n`);
                io.err(HELP);
                return 2;
        }
    } catch (e) {
        if (e instanceof ConfigRefusal) {
            for (const line of e.lines) io.err(`${line}\n`);
            return 1;
        }
        throw e;
    }
}
