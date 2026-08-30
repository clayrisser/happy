/**
 * Environment variables that identify one particular Happy or provider
 * session. A daemon can live much longer than the session that created it, so
 * these must never flow from an ambient daemon environment into a new child.
 */
export const SESSION_SCOPED_ENV_KEYS = [
    'HAPPY_RECONNECT_SESSION_ID',
    'HAPPY_RECONNECT_ENCRYPTION_KEY',
    'HAPPY_RECONNECT_ENCRYPTION_VARIANT',
    'HAPPY_RECONNECT_SEQ',
    'HAPPY_RECONNECT_METADATA_VERSION',
    'HAPPY_RECONNECT_AGENT_STATE_VERSION',
    'HAPPY_FORKED_FROM_SESSION_ID',
    'HAPPY_FORKED_FROM_MESSAGE_ID',
    'HAPPY_FORK_CLAUDE_SESSION_ID',
    'HAPPY_FORK_CODEX_THREAD_ID',
    'HAPPY_SIDE_CHAT',
    'CODEX_THREAD_ID',
] as const;

/**
 * Environment variables that describe how THIS process is being run, and are
 * therefore wrong for any process it spawns (DROVE-42).
 *
 * HAPPY_DAEMON_SUPERVISED says "a service manager will restart me if I exit",
 * which is true of the daemon launchd starts and false of everything that
 * daemon goes on to spawn. Inherited, a session-started daemon would believe
 * it had a supervisor, exit on the next rebuild, and leave the machine with no
 * daemon at all — the exact opposite of the orphan it was added to prevent.
 */
export const PROCESS_SCOPED_ENV_KEYS = [
    'HAPPY_DAEMON_SUPERVISED',
] as const;

/**
 * Environment variables that name the tmux pane a process is running IN
 * (BASED-140).
 *
 * These are not session lineage, so they are kept apart from
 * SESSION_SCOPED_ENV_KEYS and stripped only where stripping is right.
 *
 * A daemon started from a terminal inherited that terminal's TMUX_PANE and
 * handed it to every child. `adapters/claude-session.sh` then posts
 * `--arg pane "$TMUX_PANE"` on the honest assumption that a hook runs as a
 * child of its own session, so the phone-started session registered the
 * TERMINAL's pane. Two live sessions claimed `%43`, and a message sent from
 * the phone to one of them could land in the other's input box
 * (`engine/sender.js` channel 1).
 *
 * Stripped for a DIRECT spawn, where nothing else would ever give the child a
 * pane and any value it inherits is somebody else's. NOT stripped for the tmux
 * spawn path: tmux gives that child a real pane of its own, and it wins.
 * Measured on tmux 3.7c — `new-window -e TMUX_PANE=%999 -P -F '#{pane_id}'`
 * reports `%1` and the child reads `%1`, because spawn_pane() sets TMUX_PANE
 * after copying the `-e` environment. (TMUX and TMUX_TMPDIR are NOT overridden
 * that way, but on that path they name the very server the window was created
 * on, so they are correct by construction.)
 */
export const PANE_SCOPED_ENV_KEYS = [
    'TMUX',
    'TMUX_PANE',
    'TMUX_TMPDIR',
] as const;

/**
 * Remove session-scoped state inherited from a parent process without
 * modifying the source environment.
 */
export function sanitizeSessionEnvironment<T extends Record<string, string>>(env: T): T;
export function sanitizeSessionEnvironment(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function sanitizeSessionEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const sanitized = { ...env };
    for (const key of SESSION_SCOPED_ENV_KEYS) {
        delete sanitized[key];
    }
    for (const key of PROCESS_SCOPED_ENV_KEYS) {
        delete sanitized[key];
    }
    return sanitized;
}

/**
 * Build a child environment from clean ambient values plus explicit values for
 * the session being launched. Explicit values deliberately win so fork and
 * resume requests continue to work.
 */
export function buildSessionChildEnvironment(
    ambientEnv: NodeJS.ProcessEnv = process.env,
    explicitEnv: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
    return {
        ...sanitizeSessionEnvironment(ambientEnv),
        ...explicitEnv,
    };
}

/**
 * The child environment for a spawn that gets NO pane of its own — the
 * daemon's direct `spawnHappyCLI` paths. Same rules as
 * `buildSessionChildEnvironment` plus the pane keys, so the session registers
 * `pane: null` and the input router falls to the socket instead of typing into
 * a terminal that belongs to somebody else.
 */
export function buildDirectSpawnChildEnvironment(
    ambientEnv: NodeJS.ProcessEnv = process.env,
    explicitEnv: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
    const child = buildSessionChildEnvironment(ambientEnv, explicitEnv);
    for (const key of PANE_SCOPED_ENV_KEYS) {
        if (explicitEnv[key] !== undefined) continue;
        delete child[key];
    }
    return child;
}

/**
 * tmux windows inherit their server environment, including keys omitted from
 * `new-window -e`. These are the keys the shell must explicitly unset before
 * starting a child, unless this launch intentionally supplies a replacement.
 */
export function sessionEnvironmentKeysToUnset(explicitEnv: NodeJS.ProcessEnv = {}): string[] {
    // DROVE-42: process-scoped keys go too. The tmux path is the other way a
    // daemon's environment reaches a child, and HAPPY_DAEMON_SUPERVISED must
    // not survive either hop.
    return [...SESSION_SCOPED_ENV_KEYS, ...PROCESS_SCOPED_ENV_KEYS]
        .filter((key) => explicitEnv[key] === undefined);
}

export function wrapTmuxCommandWithSessionEnvironmentSanitizer(
    command: string,
    explicitEnv: NodeJS.ProcessEnv = {},
): string {
    const keysToUnset = sessionEnvironmentKeysToUnset(explicitEnv);
    if (keysToUnset.length === 0) {
        return command;
    }
    return `unset ${keysToUnset.join(' ')}; ${command}`;
}
