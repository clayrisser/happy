/**
 * Finding the Codex CLI (DROVE-273).
 *
 * Same bug cursorBin.ts was written for, one harness over. Codex installs two
 * ways — `npm install -g @openai/codex` and `brew install --cask codex` — and
 * NEITHER lands on a launchd daemon's PATH. A session started from the phone is
 * spawned by that daemon, so a bare `codex` ENOENTs on a machine where the
 * terminal beside it runs Codex fine.
 *
 * It costs more than a failed spawn. detectCLIAvailability() probes the same
 * bare name, so the daemon reports codex: false, and harnessCatalog's
 * isHarnessAvailable() then hides Codex from the app's picker entirely. The
 * harness looks uninstalled on a machine that has it.
 *
 * The npm case is why `dirname(process.execPath)` is in the list and is tried
 * before the fixed paths: a global npm install puts the wrapper beside the node
 * that installed it, so under asdf, nvm or volta the binary sits next to the
 * very interpreter running this code. No version guessing, no shim directory to
 * enumerate.
 *
 * PATH is walked here rather than shelled out to. cursorBin.ts and
 * agy/constants.ts both `execSync('command -v ...')`, which spawns a shell per
 * probe and is one interpolation away from being an injection site. Reading
 * env.PATH costs no process, works the same under launchd, and returns an
 * ABSOLUTE path — which is what a daemon spawn wants anyway.
 */

import { existsSync, statSync } from 'node:fs';
import os from 'node:os';
import { delimiter, dirname, join } from 'node:path';

export const CODEX_BIN = 'codex';

/** Windows needs the extension; POSIX takes the bare name. */
function candidateNames(): string[] {
    if (process.platform !== 'win32') return [CODEX_BIN];
    return [`${CODEX_BIN}.cmd`, `${CODEX_BIN}.exe`, `${CODEX_BIN}.ps1`, CODEX_BIN];
}

/** A path that exists and is a file (not a stale directory of the same name). */
function isExecutableFile(candidate: string): boolean {
    try {
        return existsSync(candidate) && statSync(candidate).isFile();
    } catch {
        return false;
    }
}

/** The first hit for `codex` on the given PATH, or undefined. */
function searchPath(pathValue: string | undefined): string | undefined {
    if (!pathValue) return undefined;
    for (const dir of pathValue.split(delimiter)) {
        if (!dir) continue;
        for (const name of candidateNames()) {
            const candidate = join(dir, name);
            if (isExecutableFile(candidate)) return candidate;
        }
    }
    return undefined;
}

/**
 * The install locations worth checking once PATH has said no, in the order a
 * machine is likely to have them.
 */
function fallbackPaths(env: NodeJS.ProcessEnv, execPath: string): string[] {
    const home = env.HOME || os.homedir();
    const dirs = [
        // npm -g: the wrapper lands beside the node that installed it.
        dirname(execPath),
        join(home, '.local', 'bin'),
        // Homebrew, Apple silicon then Intel.
        join('/opt', 'homebrew', 'bin'),
        join('/usr', 'local', 'bin'),
    ];
    const out: string[] = [];
    for (const dir of dirs) {
        for (const name of candidateNames()) out.push(join(dir, name));
    }
    return out;
}

/**
 * `HAPPY_CODEX_PATH`, then PATH, then the known install locations.
 * Undefined means genuinely not installed.
 */
export function findCodexBin(
    env: NodeJS.ProcessEnv = process.env,
    execPath: string = process.execPath,
): string | undefined {
    const override = env.HAPPY_CODEX_PATH;
    if (override && isExecutableFile(override)) return override;

    const onPath = searchPath(env.PATH);
    if (onPath) return onPath;

    for (const candidate of fallbackPaths(env, execPath)) {
        if (isExecutableFile(candidate)) return candidate;
    }
    return undefined;
}

/** A spawnable command. Falls back to the bare name so the error names it. */
export function resolveCodexBin(
    env: NodeJS.ProcessEnv = process.env,
    execPath: string = process.execPath,
): string {
    return findCodexBin(env, execPath) ?? CODEX_BIN;
}
