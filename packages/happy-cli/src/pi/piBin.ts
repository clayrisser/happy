/**
 * Finding the pi CLI (DROVE-295).
 *
 * The same bug codexBin.ts and cursorBin.ts were written for, one harness over,
 * and pi has it worse than either. pi installs as
 * `npm install -g @earendil-works/pi-coding-agent`, which on this machine lands
 * a symlink at /opt/homebrew/bin/pi — squarely outside a launchd daemon's PATH.
 * A session started from the phone is spawned by that daemon, so a bare `pi`
 * ENOENTs on a machine where the terminal beside it runs pi every day.
 *
 * It costs more than a failed spawn. detectCLIAvailability() probes the same
 * bare name, so the daemon reports pi: false, and harnessCatalog's
 * isHarnessAvailable() then hides the harness from the app's picker entirely.
 * The harness looks uninstalled on a machine that has it. That is exactly how
 * Codex went missing from the phone for weeks.
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
import { delimiter, dirname, join, sep } from 'node:path';

export const PI_BIN = 'pi';

/**
 * The system-wide install locations, injectable ONLY so the tests can be true.
 *
 * codexBin.ts hardcodes these inside its fallback list, and that is a latent
 * bug its own tests do not catch: every "not installed" case there passes
 * because /opt/homebrew/bin/codex happens not to exist on this machine. For pi
 * it DOES exist — that is the entire reason this file was written — so the same
 * shape made five tests assert the opposite of what they claimed. A test whose
 * result depends on the machine it runs on is not pinning anything.
 */
export const SYSTEM_INSTALL_DIRS: readonly string[] = [
    // Homebrew, Apple silicon then Intel. This is where pi actually is on
    // Clay's machine, and it is the one a launchd daemon cannot see.
    join('/opt', 'homebrew', 'bin'),
    join('/usr', 'local', 'bin'),
];

/** Windows needs the extension; POSIX takes the bare name. */
function candidateNames(): string[] {
    if (process.platform !== 'win32') return [PI_BIN];
    return [`${PI_BIN}.cmd`, `${PI_BIN}.exe`, `${PI_BIN}.ps1`, PI_BIN];
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
 * be standing in, not an installation of pi. Test runners put that directory on
 * PATH, and preferring it over a real system install would be wrong even where
 * it happened to work.
 */
function isBuildArtifact(dir: string): boolean {
    return dir.includes(`node_modules${sep}.bin`) || dir.endsWith('node_modules/.bin');
}

/** The first hit for `pi` on the given PATH, or undefined. */
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
 * `HAPPY_PI_PATH`, then PATH, then the known install locations.
 * Undefined means genuinely not installed.
 */
export function findPiBin(
    env: NodeJS.ProcessEnv = process.env,
    execPath: string = process.execPath,
    systemDirs: readonly string[] = SYSTEM_INSTALL_DIRS,
): string | undefined {
    const override = env.HAPPY_PI_PATH;
    if (override && isExecutableFile(override)) return override;

    const onPath = searchPath(env.PATH);
    if (onPath) return onPath;

    for (const candidate of fallbackPaths(env, execPath, systemDirs)) {
        if (isExecutableFile(candidate)) return candidate;
    }
    return undefined;
}

/** A spawnable command. Falls back to the bare name so the error names it. */
export function resolvePiBin(
    env: NodeJS.ProcessEnv = process.env,
    execPath: string = process.execPath,
    systemDirs: readonly string[] = SYSTEM_INSTALL_DIRS,
): string {
    return findPiBin(env, execPath, systemDirs) ?? PI_BIN;
}
