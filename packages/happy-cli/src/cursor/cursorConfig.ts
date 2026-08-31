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
 *
 * `cli-config.json` carries the model, the model parameters, the approval mode
 * and the auth DISPLAY fields. It does not carry the credential: tokens live
 * in the macOS keychain under fixed service names that are not keyed to this
 * dir, so a session config dir moves settings and never moves identity. That
 * is what cursorEnv.ts is for.
 *
 * AND `chats/` IS LINKED BACK OUT, which is not a nicety (DROVE-253). Read out
 * of the bundle: the chats directory resolves from `CURSOR_CONFIG_DIR`, not
 * from `CURSOR_DATA_DIR` — `chats = join(configDir(), "chats")` where
 * `configDir()` is `CURSOR_CONFIG_DIR || XDG_CONFIG_HOME/cursor || ~/.cursor`,
 * while only `projects/` follows `CURSOR_DATA_DIR`. Confirmed by running a
 * turn under a scratch config dir and finding the chat written there instead
 * of in `~/.cursor/chats`.
 *
 * So without the link every chat a drover session creates is born inside a
 * per-session directory that the NEXT session start deletes. `--resume` across
 * sessions could not work, a chat started from the phone would be invisible to
 * the IDE and to `drover pick-cursor-chat`, and the abandoned copies would
 * pile up under `~/.happy/cursor-sessions/` forever. Config is per session;
 * the conversation is not.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, symlinkSync } from 'node:fs';
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
 * Files that must NOT be seeded into a session config dir (DROVE-253).
 *
 * `hooks.json` used to be copied here, with a comment saying it was how a turn
 * reached the drover bus. That was wrong, and the survey measured it three
 * ways: a probe hook in `CURSOR_CONFIG_DIR/hooks.json` never fired, the same
 * hook in `CURSOR_DATA_DIR/hooks.json` never fired, and only
 * `<cwd>/.cursor/hooks.json` did. cursor-agent resolves hooks from
 * `~/.cursor/hooks.json` and `<cwd>/.cursor/hooks.json` and from nowhere else;
 * no environment variable moves them.
 *
 * So the copy was dead weight, and worse than dead weight: it read as though
 * this dir scoped the gate to one session. It does not. Anything drover
 * registers is MACHINE-WIDE and reaches the Cursor IDE too, which is exactly
 * why `drover cursor` keeps `--gate` opt-in.
 */
const notSeeded = new Set(['hooks.json']);

/**
 * Create this session's config dir and seed it.
 *
 * Only the top-level FILES are copied — `cli-config.json` (the login display
 * fields, the default model, the model parameters), `mcp.json`, and whatever
 * else the user keeps beside them, minus `notSeeded`. Directories are left
 * behind on purpose: `chats/`, `projects/` and `worktrees/` are state, not
 * configuration, and copying a chat store per session would be both slow and
 * wrong.
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
        if (notSeeded.has(name)) continue;
        const src = join(from, name);
        try {
            if (!statSync(src).isFile()) continue;
            copyFileSync(src, join(sessionDir, name));
        } catch {
            // A socket, a permission error, a file that vanished mid-copy. One
            // unreadable entry is not a reason to fail the session.
        }
    }
    linkSharedChats(sessionDir, from);
    return sessionDir;
}

/**
 * Point this session's `chats/` at the real one, so a conversation outlives
 * the config dir it was started in. Best effort: a session that cannot link
 * still runs, it just keeps its chats to itself, which is what it did before.
 */
function linkSharedChats(sessionDir: string, from: string): void {
    try {
        const shared = join(from, 'chats');
        if (!existsSync(shared)) mkdirSync(shared, { recursive: true });
        symlinkSync(shared, join(sessionDir, 'chats'), 'dir');
    } catch {
        // Already there, no permission, a filesystem with no symlinks.
    }
}
