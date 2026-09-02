/**
 * Finding the Claude Code CLI (DROVE-400).
 *
 * The same bug codexBin.ts, cursorBin.ts, piBin.ts and geminiBin.ts were each
 * written for, and claude was the harness still on the bare probe. Claude Code's
 * native installer (`curl -fsSL https://claude.ai/install.sh | sh`) puts
 * `claude` in ~/.local/bin as a symlink into ~/.local/share/claude/versions/;
 * `claude migrate-installer` puts it in ~/.claude/local; `npm install -g
 * @anthropic-ai/claude-code` puts the wrapper beside whichever node ran npm.
 * None of those are on a launchd daemon's PATH.
 *
 * Measured on studio.234 (2026-09-02): a login shell answers `command -v
 * claude` with ~/.local/bin/claude -> ~/.local/share/claude/versions/2.1.257,
 * and `launchctl print gui/501/com.bitspur.cattle-drover.daemon` shows the
 * daemon's PATH as ~/.asdf/shims:/opt/homebrew/bin:/usr/local/bin:/usr/bin:
 * /bin:/usr/sbin:/sbin. Nothing in that list holds claude, so
 * detectCLIAvailability()'s `command -v claude` failed, the daemon reported
 * claude: false, and the phone's new-session sheet drew the Claude Code row
 * disabled for the machine this very code runs on.
 *
 * PATH is walked here rather than shelled out to, for the reasons codexBin.ts
 * gives. A node_modules/.bin entry is skipped on purpose: the happy checkout's
 * own node_modules/.bin/claude is a shebang-less stub that says "claude native
 * binary not installed" (drover/flip/refresh.ts measured the ENOEXEC), and
 * pnpm puts that directory first on PATH for every test and script.
 */

import { existsSync, statSync } from 'node:fs';
import os from 'node:os';
import { delimiter, dirname, join, sep } from 'node:path';

export const CLAUDE_BIN = 'claude';

/**
 * The system-wide install locations, injectable ONLY so the tests can be true
 * (see geminiBin.ts for why a test that depends on this machine pins nothing).
 */
export const SYSTEM_INSTALL_DIRS: readonly string[] = [
    // A Homebrew node's npm prefix, Apple silicon then Intel.
    join('/opt', 'homebrew', 'bin'),
    join('/usr', 'local', 'bin'),
];

/** Windows needs the extension; POSIX takes the bare name. */
function candidateNames(): string[] {
    if (process.platform !== 'win32') return [CLAUDE_BIN];
    return [`${CLAUDE_BIN}.cmd`, `${CLAUDE_BIN}.exe`, `${CLAUDE_BIN}.ps1`, CLAUDE_BIN];
}

/**
 * A path that exists and is a file (not a stale directory of the same name).
 * statSync follows symlinks, which is what the native install is.
 */
function isExecutableFile(candidate: string): boolean {
    try {
        return existsSync(candidate) && statSync(candidate).isFile();
    } catch {
        return false;
    }
}

/** See the header: the checkout's own shim is not an installation. */
function isBuildArtifact(dir: string): boolean {
    return dir.includes(`node_modules${sep}.bin`) || dir.endsWith('node_modules/.bin');
}

/** The first hit for `claude` on the given PATH, or undefined. */
function searchPath(pathValue: string | undefined): string | undefined {
    if (!pathValue) return undefined;
    for (const dir of pathValue.split(delimiter)) {
        if (!dir) continue;
        if (isBuildArtifact(dir)) continue;
        for (const name of candidateNames()) {
            const candidate = join(dir, name);
            if (isExecutableFile(candidate)) return candidate;
        }
    }
    return undefined;
}

/**
 * The install locations worth checking once PATH has said no: the native
 * installer's two homes first, since that is how Claude Code arrives today,
 * then npm -g beside the running node, then the system prefixes.
 */
function fallbackPaths(
    env: NodeJS.ProcessEnv,
    execPath: string,
    systemDirs: readonly string[],
): string[] {
    const home = env.HOME || os.homedir();
    const dirs = [
        // The native installer (install.sh): ~/.local/bin/claude -> versions/<v>.
        join(home, '.local', 'bin'),
        // `claude migrate-installer`: a local npm tree under ~/.claude/local.
        join(home, '.claude', 'local'),
        // npm -g: the wrapper lands beside the node that installed it.
        dirname(execPath),
        ...systemDirs,
    ];
    const out: string[] = [];
    for (const dir of dirs) {
        for (const name of candidateNames()) out.push(join(dir, name));
    }
    return out;
}

/**
 * `HAPPY_CLAUDE_PATH`, then `DROVER_CLAUDE` (the override drover/flip/refresh.ts
 * already honours for the same binary, so the two resolvers cannot disagree),
 * then PATH, then the known install locations. Undefined means genuinely not
 * installed.
 */
export function findClaudeBin(
    env: NodeJS.ProcessEnv = process.env,
    execPath: string = process.execPath,
    systemDirs: readonly string[] = SYSTEM_INSTALL_DIRS,
): string | undefined {
    for (const override of [env.HAPPY_CLAUDE_PATH, env.DROVER_CLAUDE]) {
        if (override && isExecutableFile(override)) return override;
    }

    const onPath = searchPath(env.PATH);
    if (onPath) return onPath;

    for (const candidate of fallbackPaths(env, execPath, systemDirs)) {
        if (isExecutableFile(candidate)) return candidate;
    }
    return undefined;
}

/** A spawnable command. Falls back to the bare name so the error names it. */
export function resolveClaudeBin(
    env: NodeJS.ProcessEnv = process.env,
    execPath: string = process.execPath,
    systemDirs: readonly string[] = SYSTEM_INSTALL_DIRS,
): string {
    return findClaudeBin(env, execPath, systemDirs) ?? CLAUDE_BIN;
}
