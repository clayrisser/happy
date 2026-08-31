/**
 * Where a drover-run Cursor session keeps its Cursor config (DROVE-57).
 *
 * MEASURED on cursor-agent 2026.08.25, and it is the whole reason this file
 * exists: `cursor-agent --model X` is NOT scoped to the run. It writes X into
 * `cli-config.json` as the new global default, which the Cursor IDE reads too.
 * A model picked on the phone would therefore silently change the model of
 * every Cursor window on the Mac. Proven both ways: a run with
 * `--model composer-2.5` turned `model.modelId` from `grok-4.6` into
 * `composer-2.5` in the config dir it was pointed at.
 *
 * So each session gets its OWN `CURSOR_CONFIG_DIR`, seeded from the real one
 * so the login, the permission allowlist and the per-model parameters all
 * carry over. A model pick then takes effect for that session and reaches
 * nothing else.
 *
 * Seeded FRESH at every session start rather than kept, so a rotated login in
 * the real config is picked up instead of going stale in a copy.
 */

import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

/** The user's real Cursor config dir, using cursor-agent's own resolution order. */
export function realCursorConfigDir(env: NodeJS.ProcessEnv = process.env): string {
    const explicit = env.CURSOR_CONFIG_DIR;
    if (explicit && explicit.trim()) return explicit;
    const xdg = env.XDG_CONFIG_HOME;
    if (xdg && xdg.trim()) return join(xdg, 'cursor');
    return join(os.homedir(), '.cursor');
}

/**
 * Create this session's config dir and seed it.
 *
 * Only the top-level FILES are copied — `cli-config.json` (the login, the
 * default model, the model parameters), `mcp.json`, `hooks.json` (which is how
 * a turn still reaches the drover bus, so `drover sessions` sees it), and
 * whatever else the user keeps beside them. Directories are left behind on purpose: `chats/`,
 * `projects/` and `worktrees/` are state, not configuration, and copying a
 * chat store per session would be both slow and wrong.
 */
export function prepareSessionCursorConfigDir(sessionDir: string, from: string = realCursorConfigDir()): string {
    rmSync(sessionDir, { recursive: true, force: true });
    mkdirSync(sessionDir, { recursive: true });
    let entries: string[];
    try {
        entries = readdirSync(from);
    } catch {
        // No Cursor config at all. The dir still exists, and cursor-agent will
        // say "not logged in" itself, which is a better error than ours.
        return sessionDir;
    }
    for (const name of entries) {
        const src = join(from, name);
        try {
            if (!statSync(src).isFile()) continue;
            copyFileSync(src, join(sessionDir, name));
        } catch {
            // A socket, a permission error, a file that vanished mid-copy. One
            // unreadable entry is not a reason to fail the session.
        }
    }
    return sessionDir;
}
