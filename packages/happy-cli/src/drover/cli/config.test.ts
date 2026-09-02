/**
 * `drover config` in node, against the same fixtures cattle-drover's
 * tests/config.bats drives the shell verb with (DROVE-315).
 *
 * NOTHING HERE MAY TOUCH A REAL TMUX CONFIG OR A RUNNING TMUX, and the bats
 * file's three guards are kept: HOME is a per-test throwaway so every
 * discovered candidate is under it, DROVER_CONFIG_RELOAD=0 and TMUX unset so
 * nothing is sourced into a server, and DROVER_TMUX_PROBE_OUT stands in for
 * the probe so no tmux is asked anything. The third guard is asserted rather
 * than merely relied on: a probe answer naming /Users/clayrisser/... is
 * discarded because it is not under THIS home.
 *
 * The marker constants are pinned here the way config.bats pins the shell's,
 * because they are a wire format: a shell install has already written
 * `# >>> drover >>>` into real configs, and an implementation that spells them
 * differently cannot find, rewrite or remove any of them.
 */

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import {
    droverBlockBegin,
    droverBlockEnd,
    droverConfigBackupStamp,
    droverConfigBackupSuffix,
    type ConfigCtx,
} from './configBlock';
import { run, tmuxFallbackSearchOrder, tmuxTarget } from './config';
import { droverVerbs } from './index';

let home: string;
let stateDir: string;
let droverDir: string;
let XDG: string;
let DOT: string;
let env: Record<string, string | undefined>;
let ctx: ConfigCtx;
const lines: string[] = [];
const io = {
    out: (s: string) => void lines.push(s),
    err: (s: string) => void lines.push(s),
};
const output = () => lines.join('');

beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), 'drover-config-'));
    home = join(root, 'home');
    // UNDER the test HOME on purpose. The backup dir follows the home the
    // config belongs to, so a state dir parked outside this HOME is the thing
    // being asserted as ignored.
    stateDir = join(home, 'state');
    droverDir = join(root, 'checkout');
    XDG = join(home, '.config', 'tmux', 'tmux.conf');
    DOT = join(home, '.tmux.conf');
    mkdirSync(home, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(join(droverDir, 'tmux'), { recursive: true });
    env = {
        HOME: home,
        STATE_DIR: stateDir,
        DROVER_DIR: droverDir,
        DROVER_CONFIG_RELOAD: '0',
        // The probe, answered with nothing usable, so no tmux is ever asked.
        DROVER_TMUX_PROBE_OUT: ' ',
    };
    ctx = { env, home };
    lines.length = 0;
});

/**
 * A config with hand-written content ABOVE and BELOW, which is the shape the
 * byte-identity assertions need: a block removed from the middle proves more
 * than a block removed from the end.
 */
function handwritten(path: string): void {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, `# my own tmux config
set -g mouse on
set -g history-limit 50000

# my own bindings
bind-key r source-file ~/.config/tmux/tmux.conf
`);
}

const countLines = (path: string, exact: string) =>
    readFileSync(path, 'utf8').split('\n').filter((l) => l === exact).length;

describe('the contract as data', () => {
    it('spells the markers and the backup name exactly as the shell does', () => {
        // A test that matched `>>> drover` would pass on a marker somebody had
        // "improved" into `## >>> drover >>> ##`, and then every older install
        // on disk would be invisible to the new uninstall.
        expect(droverBlockBegin).toBe('# >>> drover >>>');
        expect(droverBlockEnd).toBe('# <<< drover <<<');
        expect(droverConfigBackupSuffix).toBe('.bak');
        expect(droverConfigBackupStamp).toBe('+%Y%m%dT%H%M%SZ');
    });

    it('keeps the fallback search order as a table, in tmux\'s own load order', () => {
        // tmux loads these in sequence, so the last is the one whose settings
        // win — which is why selection takes the last entry, not the first.
        expect([...tmuxFallbackSearchOrder]).toEqual(['HOME/.tmux.conf', 'XDG/tmux/tmux.conf']);
    });
});

describe('install, converge, uninstall', () => {
    it('appends to a config the user wrote, then removes exactly the block', async () => {
        handwritten(XDG);
        const before = readFileSync(XDG);

        expect(await run(['install'], io, ctx)).toBe(0);
        expect(output()).toContain('appended the drover block');
        expect(countLines(XDG, droverBlockBegin)).toBe(1);
        expect(countLines(XDG, droverBlockEnd)).toBe(1);
        expect(readFileSync(XDG, 'utf8')).toContain(`source-file -q ${droverDir}/tmux/drover.conf`);
        // The user's own lines are untouched.
        expect(countLines(XDG, 'set -g history-limit 50000')).toBe(1);

        // A second run is a no-op, byte for byte.
        const first = readFileSync(XDG);
        lines.length = 0;
        expect(await run(['install'], io, ctx)).toBe(0);
        expect(output()).toContain('already current');
        expect(readFileSync(XDG)).toEqual(first);

        // And the uninstall is real: byte-identical, not merely similar.
        lines.length = 0;
        expect(await run(['uninstall'], io, ctx)).toBe(0);
        expect(output()).toContain('removed the drover block');
        expect(readFileSync(XDG)).toEqual(before);
    });

    it('rewrites the block in place when the checkout moves, never appends a second', async () => {
        handwritten(XDG);
        expect(await run(['install'], io, ctx)).toBe(0);
        const moved = mkdtempSync(join(tmpdir(), 'drover-moved-'));
        lines.length = 0;
        expect(await run(['install'], io, { env: { ...env, DROVER_DIR: moved }, home })).toBe(0);
        expect(output()).toContain('rewrote the drover block');
        expect(countLines(XDG, droverBlockBegin)).toBe(1);
        const body = readFileSync(XDG, 'utf8');
        expect(body.split('\n').filter((l) => l.startsWith('source-file -q ')).length).toBe(1);
        expect(body).toContain(`source-file -q ${moved}/tmux/drover.conf`);
    });

    it('CREATES the one file every tmux reads when there is no config at all', async () => {
        // Deliberate, and the one place discovery does NOT prefer the last row:
        // ~/.tmux.conf is read by every tmux ever built, and guessing XDG at a
        // tmux we could not even ask is how you write a file nothing loads.
        expect(await run(['install'], io, { env: { ...env, XDG_CONFIG_HOME: join(home, 'xdg') }, home })).toBe(0);
        expect(output()).toContain(`CREATED ${DOT}`);
        expect(output()).toContain('there was no tmux config here');
        expect(output()).not.toContain('appended');
        expect(countLines(DOT, droverBlockBegin)).toBe(1);

        // `deleted` is the exact inverse of `created`: a file whose whole
        // content was drover's block is a file drover made.
        lines.length = 0;
        expect(await run(['uninstall'], io, ctx)).toBe(0);
        expect(output()).toContain('it held nothing but drover\'s block');
        expect(readdirSync(home)).not.toContain('.tmux.conf');
    });

    it('sweeps EVERY candidate on uninstall, not just the one install would pick', async () => {
        handwritten(DOT);
        handwritten(XDG);
        expect(await run(['install'], io, { env: { ...env, DROVER_TMUX_CONF: DOT }, home })).toBe(0);
        expect(await run(['install'], io, { env: { ...env, DROVER_TMUX_CONF: XDG }, home })).toBe(0);
        expect(countLines(DOT, droverBlockBegin)).toBe(1);
        expect(countLines(XDG, droverBlockBegin)).toBe(1);

        expect(await run(['uninstall'], io, ctx)).toBe(0);
        expect(countLines(DOT, droverBlockBegin)).toBe(0);
        expect(countLines(XDG, droverBlockBegin)).toBe(0);
    });

    it('refuses an unbalanced block, loudly, with the file untouched', async () => {
        mkdirSync(join(XDG, '..'), { recursive: true });
        writeFileSync(XDG, `set -g mouse on\n${droverBlockBegin}\nsource-file -q /gone\n`);
        const before = readFileSync(XDG);

        expect(await run(['install'], io, ctx)).toBe(1);
        expect(output()).toContain('unbalanced drover block');
        expect(readFileSync(XDG)).toEqual(before);

        lines.length = 0;
        expect(await run(['uninstall'], io, ctx)).toBe(1);
        expect(output()).toContain('unbalanced drover block');
        expect(readFileSync(XDG)).toEqual(before);
    });

    it('migrates the pre-DROVE-306 unmarked source-file line into the block, and back out', async () => {
        handwritten(XDG);
        const preDrover = readFileSync(XDG);
        // Byte for byte what the old Makefile's printf emitted.
        writeFileSync(XDG, readFileSync(XDG, 'utf8')
            + '\n# Cattle Drover (BASED-98): prefix+F flip, prefix+M-f pick, prefix+A accounts\n'
            + 'source-file -q /Users/clayrisser/Projects/bitspur/cattle-drover/tmux/drover.conf\n');

        expect(await run(['status'], io, ctx)).toBe(0);
        expect(output()).toContain('unmarked pre-DROVE-306 source-file line');

        lines.length = 0;
        expect(await run(['install'], io, ctx)).toBe(0);
        expect(output()).toContain('removed the old unmarked source-file line');
        expect(readFileSync(XDG, 'utf8').split('\n').filter((l) => l.startsWith('source-file -q ')).length).toBe(1);

        // The whole complaint: the old line had no way out, so uninstalling
        // drover left it pointing at a checkout that may no longer exist.
        expect(await run(['uninstall'], io, ctx)).toBe(0);
        expect(readFileSync(XDG)).toEqual(preDrover);
    });

    it('writes THROUGH a symlinked dotfile rather than replacing the link', async () => {
        // ~/.tmux.conf -> ~/dotfiles/tmux.conf is the normal shape of a managed
        // dotfile. Renaming onto the link would swap it for a regular file and
        // silently detach the person from their own repo.
        const real = join(home, 'dotfiles', 'tmux.conf');
        handwritten(real);
        symlinkSync(real, DOT);

        expect(await run(['install'], io, ctx)).toBe(0);
        expect(countLines(real, droverBlockBegin)).toBe(1);
        expect(readdirSync(home)).toContain('.tmux.conf');

        expect(await run(['uninstall'], io, ctx)).toBe(0);
        expect(countLines(real, droverBlockBegin)).toBe(0);
        expect(readdirSync(home)).toContain('.tmux.conf');
    });
});

describe('the backup half of the contract', () => {
    it('files one stamped copy of the original, and never a copy of drover\'s own output', async () => {
        handwritten(XDG);
        const before = readFileSync(XDG);
        expect(await run(['install'], io, ctx)).toBe(0);
        expect(output()).toContain('backed the original up to');

        const backups = readdirSync(join(stateDir, 'backups'));
        expect(backups.length).toBe(1);
        expect(readFileSync(join(stateDir, 'backups', backups[0]))).toEqual(before);
        // Stamped, and named for the file it came from, so two configs called
        // tmux.conf in different directories cannot land on one name.
        expect(backups[0]).toMatch(/-\.config-tmux-tmux\.conf\.[0-9]{8}T[0-9]{6}Z\.bak$/);

        expect(await run(['install'], io, ctx)).toBe(0);
        expect(readdirSync(join(stateDir, 'backups')).length).toBe(1);
    });

    it('never files the backup in a STATE_DIR inherited from outside this HOME', async () => {
        // STATE_DIR is EXPORTED by drover into every shell it starts, so a run
        // from inside a session inherits the REAL one. Before this rule, a
        // suite filed copies of its own fixtures into the live state dir.
        const outside = mkdtempSync(join(tmpdir(), 'not-my-home-'));
        handwritten(XDG);
        expect(await run(['install'], io, { env: { ...env, STATE_DIR: outside }, home })).toBe(0);
        expect(output()).toContain('backed the original up to');
        expect(readdirSync(outside)).toEqual([]);
        // It went to this HOME's own default instead.
        expect(readdirSync(join(home, '.local', 'state', 'cattle-drover', 'backups')).length).toBe(1);
    });
});

describe('discovery, not a hardcoded path', () => {
    it('honours what tmux says its search order is', async () => {
        mkdirSync(join(home, 'somewhere'), { recursive: true });
        writeFileSync(join(home, 'somewhere', 'tmux.conf'), '');
        const t = tmuxTarget({
            env: { ...env, DROVER_TMUX_PROBE_OUT: `/etc/tmux.conf,${home}/somewhere/tmux.conf` },
            home,
        });
        expect(t.path).toBe(join(home, 'somewhere', 'tmux.conf'));
    });

    it('can never choose the live config, whatever a running server answers', async () => {
        // The one that keeps this file off a real machine. A real server's
        // answer names paths under a real home; HOME here is a throwaway; every
        // candidate is filtered on the CURRENT $HOME.
        const t = tmuxTarget({
            env: {
                ...env,
                DROVER_TMUX_PROBE_OUT:
                    '/opt/homebrew/etc/tmux.conf,/Users/clayrisser/.tmux.conf,/Users/clayrisser/.config/tmux/tmux.conf',
            },
            home,
        });
        expect(t.path.startsWith(`${home}/`)).toBe(true);
    });

    it('picks the file tmux loads LAST when both exist, and names the other out loud', async () => {
        handwritten(DOT);
        handwritten(XDG);
        expect(await run(['install'], io, ctx)).toBe(0);
        expect(countLines(XDG, droverBlockBegin)).toBe(1);
        expect(countLines(DOT, droverBlockBegin)).toBe(0);
        expect(output()).toContain(`tmux also reads: ${DOT}`);
    });

    it('keeps the block where it already is, even when that is not the preferred file', async () => {
        // Convergence beats preference: an upgrade rewrites the block where it
        // is rather than starting a second one somewhere tidier.
        handwritten(DOT);
        expect(await run(['install'], io, { env: { ...env, DROVER_TMUX_CONF: DOT }, home })).toBe(0);
        handwritten(XDG);
        expect(tmuxTarget(ctx).path).toBe(DOT);
        expect(await run(['install'], io, ctx)).toBe(0);
        expect(countLines(XDG, droverBlockBegin)).toBe(0);
    });
});

describe('the verb itself', () => {
    it('answers an unknown target and an unknown verb with 2', async () => {
        expect(await run(['install', 'zsh'], io, ctx)).toBe(2);
        expect(output()).toContain('the only one today is tmux');
        lines.length = 0;
        expect(await run(['frobnicate'], io, ctx)).toBe(2);
        expect(output()).toContain("unknown verb 'frobnicate'");
    });

    it('is in the verb table, so `drover config` reaches node', () => {
        expect(droverVerbs.map((v) => v.name)).toContain('config');
    });
});
