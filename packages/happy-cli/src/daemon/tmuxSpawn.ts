/**
 * Where a session started from the phone actually lands (DROVE-2).
 *
 * Clay's requirement: a session started from the app is the same kind of thing
 * as one started in a terminal — a real Claude Code TUI in a tmux pane on the
 * Mac, open in front of him at any moment while the phone drives it. No modes,
 * no takeover, no second kind of session.
 *
 * The daemon already had a tmux spawn path, but nothing the app can reach ever
 * selected it: the condition was the presence of `TMUX_SESSION_NAME` in the
 * spawn request's `environmentVariables`, and the app's spawn request has no
 * such field (`happy-app/sources/sync/ops.ts` `machineSpawnNewSession`). Every
 * phone spawn therefore fell through to a headless SDK loop. Reachability is
 * the condition now; `TMUX_SESSION_NAME` survives only as an override for
 * WHICH session, and unset means the user's own server.
 *
 * The pane command is the drover WRAPPER rather than the fork's
 * `dist/index.mjs`, because the wrapper is where the terminal's policy lives:
 * `libexec/drover-sync-commands` so `/flip` exists, `libexec/drover-trust` so
 * Claude Code's trust dialog cannot kill the first run in a new directory, and
 * the `DROVER_URL` / `DROVER_DIR` / `STATE_DIR` exports the bus hooks read.
 * Re-implementing those inside the daemon is how the two halves drift.
 *
 * One thing the wrapper does NOT contribute here: the bypass. `bin/drover`
 * prepends `--dangerously-skip-permissions` only when its first argument is
 * absent or a flag, and this launch names the agent first, so the flag comes
 * from `appendDaemonSpawnModeArgs` instead. That reads `DROVER_SKIP_PERMISSIONS`
 * and the default written in `etc/drover.env` (BASED-140 / DROVE-29), so both
 * halves still answer to one switch — and the phone's own `permissionMode`
 * still wins when it asks for something specific.
 */

import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';

import { droverDir } from '@/drover/hooks';

/** Agents the daemon knows how to launch. `rig` is handled by another RPC. */
// `pi` joined in DROVE-316, once `drover pi` gained a happy-cli runner. Being
// in this list IS the promise the phone's picker makes, so the order is
// always runner first: a name here with no runner behind it opens a tmux
// window and then calls a session that never appears a success.
export const daemonAgents = ['claude', 'codex', 'cursor', 'gemini', 'openclaw', 'agy', 'pi'] as const;

export type DaemonAgent = (typeof daemonAgents)[number];

/**
 * An unknown agent is an ERROR, not a silent fallback to Claude. The old tmux
 * path mapped anything it did not recognise onto `claude` through a ternary
 * chain, which was harmless while the path was unreachable and is a
 * wrong-agent bug now that every phone spawn takes it.
 */
export function resolveDaemonAgent(agent: string | undefined): DaemonAgent | null {
    if (agent === undefined) return 'claude';
    return (daemonAgents as readonly string[]).includes(agent) ? (agent as DaemonAgent) : null;
}

/**
 * The drover wrapper the pane runs.
 *
 * `DROVER_BIN` names it outright; otherwise it is `bin/drover` under the
 * checkout `droverDir()` already resolves for the bus hooks, so a daemon that
 * finds the adapters finds the wrapper next to them.
 */
export function droverBinPath(
    env: NodeJS.ProcessEnv = process.env,
    root: string = droverDir(),
): string {
    return env.DROVER_BIN || join(root, 'bin', 'drover');
}

export function droverBinExists(path: string): boolean {
    return existsSync(path);
}

/**
 * The window name, taken from the directory so `tmux list-windows` reads like
 * the work rather than like `happy-1756570000000-claude`.
 */
export function tmuxWindowNameForDirectory(directory: string): string {
    const trimmed = directory.replace(/[/\\]+$/, '');
    const cleaned = basename(trimmed)
        .replace(/[^A-Za-z0-9._-]+/g, '-')
        .replace(/^[-.]+|-+$/g, '')
        .slice(0, 40);
    return cleaned || 'drover';
}

/** Shell-escape a string for safe interpolation into a tmux command string. */
export function shellescape(s: string): string {
    return "'" + s.replace(/'/g, "'\\''") + "'";
}

export interface DroverPaneLaunch {
    droverBin: string;
    agent: DaemonAgent;
    /** Permission / model / effort flags from `appendDaemonSpawnModeArgs`. */
    modeArgs?: string[];
    /** Provider conversation to attach to, for a fork or a duplicate. */
    resumeId?: string;
}

/**
 * The argv the tmux window runs.
 *
 * LOCAL mode, deliberately. The old path passed `--happy-starting-mode remote`
 * even when it created a pane, which is the mode that exists for a session
 * with no keyboard. A session that owns a window has one, so remote is simply
 * wrong for it — and `runClaude` treats a `local` daemon start as valid
 * exactly when the process has a `TMUX_PANE`.
 */
export function buildDroverPaneArgv(launch: DroverPaneLaunch): string[] {
    const argv = [
        launch.droverBin,
        launch.agent,
        '--happy-starting-mode', 'local',
        '--started-by', 'daemon',
        ...(launch.modeArgs ?? []),
    ];
    if (launch.resumeId) {
        argv.push('--resume', launch.resumeId);
    }
    return argv;
}

export function formatDroverPaneCommand(launch: DroverPaneLaunch): string {
    return buildDroverPaneArgv(launch).map(shellescape).join(' ');
}

/**
 * What the phone is told when tmux cannot be reached.
 *
 * Clay's ruling on this ticket: NO headless session is ever created. A spawn
 * that cannot get a pane FAILS, loudly, rather than quietly producing a second
 * kind of session that the terminal can never see.
 */
export function tmuxUnreachableMessage(): string {
    return 'Cannot start a session: tmux is not available on this machine. '
        + 'Every drover session runs in a tmux window so the terminal and the app are the same session. '
        + 'Install tmux (or start the session from a terminal) and try again.';
}

export function droverMissingMessage(droverBin: string): string {
    return `Cannot start a session: the drover wrapper was not found at ${droverBin}. `
        + 'Point the daemon at your cattle-drover checkout with DROVER_BIN (or DROVER_DIR) and restart it.';
}

/**
 * Everything that has to be true before a window can be opened, in one place
 * so the no-headless ruling is one testable answer rather than a shape spread
 * across the spawn function. `null` means go; a string is what the phone shows
 * and there is no third outcome — in particular, no quiet fall-through to a
 * headless session.
 */
export function spawnPreconditionError(check: {
    tmuxAvailable: boolean;
    droverBin: string;
    droverExists: boolean;
}): string | null {
    if (!check.tmuxAvailable) return tmuxUnreachableMessage();
    if (!check.droverExists) return droverMissingMessage(check.droverBin);
    return null;
}
