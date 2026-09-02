/**
 * Finding the gemini CLI (DROVE-381).
 *
 * The same bug codexBin.ts, cursorBin.ts and piBin.ts were written for, one
 * harness over. `npm install -g @google/gemini-cli` puts the `gemini` wrapper in
 * whatever the npm global prefix happens to be — under asdf, nvm or volta that
 * is a per-version directory nobody's PATH names in full, and under a Homebrew
 * node it is /opt/homebrew/bin. None of those are on a launchd daemon's PATH,
 * and a session started from the phone is spawned by that daemon, so a bare
 * `gemini` ENOENTs on a machine where the terminal beside it runs gemini every
 * day.
 *
 * It costs more than a failed spawn. detectCLIAvailability() probed the same
 * bare name until this file existed, so the daemon reported gemini: false, and
 * harnessCatalog's isHarnessAvailable() then hid the harness from the app's
 * picker entirely. The harness looks uninstalled on a machine that has it. That
 * is exactly how Codex went missing from the phone for weeks, and un-retiring
 * gemini without fixing it would have shipped the row and none of the taps.
 *
 * The npm case is why `dirname(process.execPath)` is in the list and is tried
 * before the fixed paths, and gemini is the purest instance of it in the tree:
 * it has no installer of its own and no cask, so npm -g is the ONLY way it
 * arrives, and a global npm install puts the wrapper beside the node that
 * installed it. No version guessing, no shim directory to enumerate.
 *
 * PATH is walked here rather than shelled out to. cursorBin.ts and
 * agy/constants.ts both shell out to `command -v`, which spawns a shell per
 * probe and is one interpolation away from being an injection site. Reading
 * env.PATH costs no process, works the same under launchd, and returns an
 * ABSOLUTE path — which is what a daemon spawn wants anyway.
 */

import { existsSync, statSync } from 'node:fs';
import os from 'node:os';
import { delimiter, dirname, join, sep } from 'node:path';

export const GEMINI_BIN = 'gemini';

/**
 * The system-wide install locations, injectable ONLY so the tests can be true.
 *
 * codexBin.ts hardcodes these inside its fallback list, and that is a latent bug
 * its own tests do not catch: every "not installed" case there passes because
 * /opt/homebrew/bin/codex happens not to exist on this machine. A test whose
 * result depends on the machine it runs on is not pinning anything, so the
 * suite below passes an empty list and never has to care what this one holds.
 */
export const SYSTEM_INSTALL_DIRS: readonly string[] = [
    // A Homebrew node's npm prefix, Apple silicon then Intel. This is where
    // `npm install -g @google/gemini-cli` lands when node came from brew, and
    // it is the one a launchd daemon cannot see.
    join('/opt', 'homebrew', 'bin'),
    join('/usr', 'local', 'bin'),
];

/** Windows needs the extension; POSIX takes the bare name. */
function candidateNames(): string[] {
    if (process.platform !== 'win32') return [GEMINI_BIN];
    return [`${GEMINI_BIN}.cmd`, `${GEMINI_BIN}.exe`, `${GEMINI_BIN}.ps1`, GEMINI_BIN];
}

/** A path that exists and is a file (not a stale directory of the same name). */
function isExecutableFile(candidate: string): boolean {
    try {
        return existsSync(candidate) && statSync(candidate).isFile();
    } catch {
        return false;
    }
}

/**
 * A node_modules/.bin entry is a build artifact of whichever tree you happen to
 * be standing in, not an installation of gemini. Test runners put that directory
 * on PATH, and preferring it over a real system install would be wrong even
 * where it happened to work.
 */
function isBuildArtifact(dir: string): boolean {
    return dir.includes(`node_modules${sep}.bin`) || dir.endsWith('node_modules/.bin');
}

/** The first hit for `gemini` on the given PATH, or undefined. */
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
 * The install locations worth checking once PATH has said no, in the order a
 * machine is likely to have them.
 */
function fallbackPaths(
    env: NodeJS.ProcessEnv,
    execPath: string,
    systemDirs: readonly string[],
): string[] {
    const home = env.HOME || os.homedir();
    const dirs = [
        // npm -g: the wrapper lands beside the node that installed it.
        dirname(execPath),
        join(home, '.local', 'bin'),
        ...systemDirs,
    ];
    const out: string[] = [];
    for (const dir of dirs) {
        for (const name of candidateNames()) out.push(join(dir, name));
    }
    return out;
}

/**
 * `HAPPY_GEMINI_PATH`, then PATH, then the known install locations.
 * Undefined means genuinely not installed.
 */
export function findGeminiBin(
    env: NodeJS.ProcessEnv = process.env,
    execPath: string = process.execPath,
    systemDirs: readonly string[] = SYSTEM_INSTALL_DIRS,
): string | undefined {
    const override = env.HAPPY_GEMINI_PATH;
    if (override && isExecutableFile(override)) return override;

    const onPath = searchPath(env.PATH);
    if (onPath) return onPath;

    for (const candidate of fallbackPaths(env, execPath, systemDirs)) {
        if (isExecutableFile(candidate)) return candidate;
    }
    return undefined;
}

/** A spawnable command. Falls back to the bare name so the error names it. */
export function resolveGeminiBin(
    env: NodeJS.ProcessEnv = process.env,
    execPath: string = process.execPath,
    systemDirs: readonly string[] = SYSTEM_INSTALL_DIRS,
): string {
    return findGeminiBin(env, execPath, systemDirs) ?? GEMINI_BIN;
}
