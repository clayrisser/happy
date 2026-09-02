/**
 * DROVE-400. The bug being pinned: a Claude Code install that a login shell
 * finds and a launchd daemon does not. Every case is a real install layout, and
 * the PATH is passed in rather than mutated so nothing depends on this machine,
 * except the one differential at the bottom, which is ABOUT this machine and
 * says so.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join, sep } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import { findClaudeBin, resolveClaudeBin, CLAUDE_BIN } from './claudeBin';

/**
 * NO SYSTEM DIRS. /opt/homebrew/bin/claude is real on any machine that ran
 * `npm i -g` under a brew node, so leaving the default in would make every
 * "not installed" case find that install and pass while asserting the opposite.
 */
const NO_SYSTEM: readonly string[] = [];

const find = (env: NodeJS.ProcessEnv, execPath?: string) => findClaudeBin(env, execPath, NO_SYSTEM);
const resolve = (env: NodeJS.ProcessEnv, execPath?: string) => resolveClaudeBin(env, execPath, NO_SYSTEM);

let root: string;

/** A real file at <dir>/claude, since the finder stats rather than trusts. */
function installAt(dir: string): string {
    mkdirSync(dir, { recursive: true });
    const bin = join(dir, CLAUDE_BIN);
    writeFileSync(bin, '#!/bin/sh\necho 2.1.257\n', { mode: 0o755 });
    return bin;
}

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'claudebin-'));
});

describe('findClaudeBin', () => {
    it('is undefined when claude is genuinely not installed', () => {
        expect(find({ PATH: join(root, 'empty'), HOME: root }, join(root, 'node'))).toBeUndefined();
    });

    // Tier: PATH.
    it('finds claude on PATH and returns an absolute path', () => {
        const bin = installAt(join(root, 'bin'));
        expect(find({ PATH: join(root, 'bin'), HOME: root }, join(root, 'node'))).toBe(bin);
    });

    it('takes the first PATH hit, so PATH ordering still decides', () => {
        const first = installAt(join(root, 'a'));
        installAt(join(root, 'b'));
        const path = [join(root, 'a'), join(root, 'b')].join(delimiter);
        expect(find({ PATH: path, HOME: root }, join(root, 'node'))).toBe(first);
    });

    // Tier: the native installer. The whole point of the file, and the exact
    // shape on studio.234: ~/.local/bin/claude is a SYMLINK into
    // ~/.local/share/claude/versions/<v>, and the daemon's PATH names neither.
    it('finds the native install, a symlink in ~/.local/bin, when PATH misses it', () => {
        const versions = join(root, '.local', 'share', 'claude', 'versions');
        const real = installAt(versions);
        const target = join(versions, '2.1.257');
        writeFileSync(target, '#!/bin/sh\necho 2.1.257\n', { mode: 0o755 });
        mkdirSync(join(root, '.local', 'bin'), { recursive: true });
        const link = join(root, '.local', 'bin', CLAUDE_BIN);
        symlinkSync(target, link);
        expect(real).toBeTruthy();
        const daemonPath = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].join(delimiter);
        expect(find({ PATH: daemonPath, HOME: root }, join(root, 'node'))).toBe(link);
    });

    // Tier: `claude migrate-installer`.
    it('finds a ~/.claude/local install when PATH misses it', () => {
        const bin = installAt(join(root, '.claude', 'local'));
        expect(find({ PATH: join(root, 'empty'), HOME: root }, join(root, 'node'))).toBe(bin);
    });

    // Tier: npm -g beside the running node.
    it('finds an npm -g install beside the running node when PATH misses it', () => {
        const bin = installAt(join(root, 'nodebin'));
        const execPath = join(root, 'nodebin', 'node');
        expect(find({ PATH: join(root, 'empty'), HOME: root }, execPath)).toBe(bin);
    });

    // Tier: the system prefixes, injected so the case is true anywhere.
    it('finds a system-prefix install last', () => {
        const bin = installAt(join(root, 'opt', 'homebrew', 'bin'));
        expect(findClaudeBin({ PATH: join(root, 'empty'), HOME: root }, join(root, 'node'), [join(root, 'opt', 'homebrew', 'bin')])).toBe(bin);
    });

    it('prefers the native install over npm -g and the system prefix', () => {
        const native = installAt(join(root, '.local', 'bin'));
        installAt(join(root, 'nodebin'));
        const system = join(root, 'opt', 'homebrew', 'bin');
        installAt(system);
        expect(findClaudeBin({ PATH: join(root, 'empty'), HOME: root }, join(root, 'nodebin', 'node'), [system])).toBe(native);
    });

    it('prefers PATH over the fallback locations', () => {
        const onPath = installAt(join(root, 'bin'));
        installAt(join(root, '.local', 'bin'));
        expect(find({ PATH: join(root, 'bin'), HOME: root }, join(root, 'node'))).toBe(onPath);
    });

    // Tier: the overrides.
    it('honours HAPPY_CLAUDE_PATH above everything else', () => {
        installAt(join(root, 'bin'));
        const override = installAt(join(root, 'elsewhere'));
        const env = { PATH: join(root, 'bin'), HOME: root, HAPPY_CLAUDE_PATH: override };
        expect(find(env, join(root, 'node'))).toBe(override);
    });

    it('honours DROVER_CLAUDE, the override the usage refresh already takes, below HAPPY_CLAUDE_PATH', () => {
        installAt(join(root, 'bin'));
        const drover = installAt(join(root, 'drover'));
        expect(find({ PATH: join(root, 'bin'), HOME: root, DROVER_CLAUDE: drover }, join(root, 'node'))).toBe(drover);
        const happy = installAt(join(root, 'happy'));
        expect(find({ PATH: join(root, 'bin'), HOME: root, DROVER_CLAUDE: drover, HAPPY_CLAUDE_PATH: happy }, join(root, 'node'))).toBe(happy);
    });

    it('ignores an override that points at nothing, rather than spawning it', () => {
        const onPath = installAt(join(root, 'bin'));
        const env = { PATH: join(root, 'bin'), HOME: root, HAPPY_CLAUDE_PATH: join(root, 'gone'), DROVER_CLAUDE: join(root, 'gone2') };
        expect(find(env, join(root, 'node'))).toBe(onPath);
    });

    it('does not mistake a directory named claude for an installation', () => {
        mkdirSync(join(root, 'bin', CLAUDE_BIN), { recursive: true });
        expect(find({ PATH: join(root, 'bin'), HOME: root }, join(root, 'node'))).toBeUndefined();
    });

    // The checkout's own node_modules/.bin/claude is a shebang-less stub, and
    // pnpm puts that directory first on PATH. It is not an installation.
    it('ignores a node_modules/.bin shim, which is a build artifact not an install', () => {
        const shim = join(root, 'node_modules', '.bin');
        installAt(shim);
        expect(find({ PATH: shim, HOME: root }, join(root, 'node'))).toBeUndefined();
    });

    it('takes a real install over a node_modules/.bin shim earlier on PATH', () => {
        const shim = join(root, 'node_modules', '.bin');
        installAt(shim);
        const real = installAt(join(root, 'bin'));
        const path = [shim, join(root, 'bin')].join(delimiter);
        expect(find({ PATH: path, HOME: root }, join(root, 'node'))).toBe(real);
    });

    it('tolerates an unset PATH instead of throwing', () => {
        expect(find({ HOME: root }, join(root, 'node'))).toBeUndefined();
    });
});

describe('resolveClaudeBin', () => {
    it('falls back to the bare name so the spawn error still names claude', () => {
        expect(resolve({ PATH: join(root, 'empty'), HOME: root }, join(root, 'node'))).toBe(CLAUDE_BIN);
    });

    it('returns the resolved path when there is one', () => {
        const bin = installAt(join(root, 'bin'));
        expect(resolve({ PATH: join(root, 'bin'), HOME: root }, join(root, 'node'))).toBe(bin);
    });
});

/**
 * The differential. Whatever `command -v claude` answers in the shell that runs
 * this suite, the resolver has to answer the SAME file when handed launchd's
 * default PATH, the one a job gets when its plist names none. On studio.234
 * that pair is the bug itself: the shell says ~/.local/bin/claude and no
 * launchd PATH holds that directory. Skipped where the shell finds nothing,
 * because then there is no install to agree about.
 *
 * node_modules/.bin is stripped before the shell probe: pnpm puts it first and
 * its claude is the stub described in claudeBin.ts, which is not what the login
 * shell means by `claude`.
 */
const LAUNCHD_DEFAULT_PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(delimiter);

function shellClaude(): string | undefined {
    if (process.platform === 'win32') return undefined;
    const path = (process.env.PATH ?? '')
        .split(delimiter)
        .filter((dir) => dir && !dir.includes(`node_modules${sep}.bin`))
        .join(delimiter);
    try {
        const out = execFileSync('/bin/sh', ['-c', 'command -v claude'], {
            env: { ...process.env, PATH: path },
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        return out || undefined;
    } catch {
        return undefined;
    }
}

const shellHit = shellClaude();

describe.skipIf(!shellHit)('differential against the shell', () => {
    it('resolves the same claude under launchd\'s default PATH that the shell resolves under its own', () => {
        const env: NodeJS.ProcessEnv = { ...process.env, PATH: LAUNCHD_DEFAULT_PATH, HOME: homedir() };
        delete env.HAPPY_CLAUDE_PATH;
        delete env.DROVER_CLAUDE;
        const found = findClaudeBin(env);
        expect(found).toBeDefined();
        expect(realpathSync(found!)).toBe(realpathSync(shellHit!));
    });
});
