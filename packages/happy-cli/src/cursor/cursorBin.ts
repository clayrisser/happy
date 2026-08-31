/**
 * Finding cursor-agent (DROVE-57).
 *
 * Cursor's installer drops the binary in `~/.local/bin`, which is on a login
 * shell's PATH and NOT on a launchd daemon's. A session started from the phone
 * is spawned by that daemon, so a bare `cursor-agent` ENOENTs on a machine
 * where the terminal beside it runs Cursor fine — and the availability probe
 * reports the harness as absent for the same reason, which hides it from the
 * app's picker entirely.
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

export const CURSOR_BIN = 'cursor-agent';

/**
 * `HAPPY_CURSOR_PATH`, then PATH, then the installer's own location.
 * Undefined means genuinely not installed.
 */
export function findCursorBin(env: NodeJS.ProcessEnv = process.env): string | undefined {
    const override = env.HAPPY_CURSOR_PATH;
    if (override && existsSync(override)) return override;

    try {
        const probe = process.platform === 'win32'
            ? `where ${CURSOR_BIN}`
            : `command -v ${CURSOR_BIN}`;
        execSync(probe, { stdio: 'ignore', windowsHide: true });
        return CURSOR_BIN;
    } catch {
        // Not on PATH. That is the daemon's normal state, not an answer.
    }

    const localBin = join(os.homedir(), '.local', 'bin', CURSOR_BIN);
    return existsSync(localBin) ? localBin : undefined;
}

/** A spawnable command. Falls back to the bare name so the error names it. */
export function resolveCursorBin(): string {
    return findCursorBin() ?? CURSOR_BIN;
}
