/**
 * The drover stack's environment, as etc/drover.env computes it (DROVE-315).
 *
 * Every shell verb under cattle-drover/libexec starts with
 * `. "$root/etc/drover.env"`: the checkout, the fork, the one home, the state
 * dir, the bus port and URL, each `${VAR:-default}`, then a per-machine
 * `local.env` sourced over the top. A verb ported to node needs the same
 * answers, and it needs them WITHOUT spawning a shell to ask — the whole point
 * of the port is one runtime.
 *
 * So this is the node twin of that file. Same names, same defaults, same
 * precedence: an exported variable wins over the default, and a plain
 * `NAME=value` line in `$STATE_DIR/local.env` wins over both, because sourcing
 * a file assigns unconditionally. Only plain assignments are honoured there —
 * `export NAME=value`, single or double quotes stripped, `#` comments skipped.
 * A line that needs a shell to evaluate (a `$(...)`, an `if`) is left to the
 * shell verbs that still read the file that way, and is not silently guessed
 * at here.
 *
 * ONE HOME, NO XDG (DROVE-309). Everything drover owns lives under
 * `$DROVER_HOME`, default `~/.drover`, on macOS and Linux alike, and `XDG_*`
 * is not consulted even when it is set — Clay ruled it on the ticket and
 * etc/drover.env stopped reading XDG_STATE_HOME in the same commit. This
 * module is the ONE place the node side resolves those paths, so the migration
 * that repoints the machine at ~/.drover is a change here and nowhere else.
 * Nothing downstream may spell `~/.local/state/cattle-drover` for itself.
 *
 * A tree that has not been migrated yet still has its bytes at the legacy
 * path, so every moved tree resolves through droverHomePath(): the new path
 * when it is there, else the legacy path when THAT is there, else the new one.
 * A machine is never sent to an empty directory while its state sits in the
 * other one. That is drover_home_path() in etc/drover.env, transcribed.
 *
 * When bin/drover hands off to the fork it already exports DROVER_URL,
 * DROVER_DIR and STATE_DIR, so under the wrapper this module mostly reads what
 * the shell computed. Invoked directly (`node dist/index.mjs mcps`), it
 * computes the same values itself.
 *
 * DROVER_DIR's default here matches src/drover/hooks.ts's droverDir(); this
 * module is the one that also knows the rest of the file, and the plan is for
 * the other readers to converge on it as the port proceeds.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface DroverEnv {
    /** The cattle-drover checkout: engine/, adapters/, plugins/, server.js. */
    droverDir: string;
    /** The happy fork checkout, whose packages/happy-cli this CLI is. */
    forkDir: string;
    /** One home for everything drover owns (DROVE-309). No XDG, either OS. */
    droverHome: string;
    /** Where the stack keeps logs, ledgers and per-machine overrides. */
    stateDir: string;
    /** The loopback bus port. */
    droverPort: string;
    /** The bus, as a URL. */
    droverUrl: string;
    /** The local Happy self-host relay port and URL (DROVER_SERVER_MODE=relay). */
    relayPort: string;
    relayUrl: string;
    /** Which Happy server the CLI and the bridge talk to: official | relay. */
    serverMode: string;
    /** The Happy home holding credentials, settings and logs. */
    happyHome: string;
    /** The account registry the flip reads. */
    accounts: string;
    /** `--dangerously-skip-permissions` by default; '0' gets the prompts back. */
    skipPermissions: string;
    /** '1' skips the fork rebuild a terminal `drover` would otherwise do. */
    skipBuild: string;
    /** Seconds a service wrapper gives an unloadable dist before rebuilding. */
    distSettleS: string;
    /** The local ask fallback in adapters/claude-pretooluse.sh. */
    localAsk: string;
    /** Seconds that popup may hold the turn before it closes itself. */
    localAskTimeout: string;
}

type Env = Record<string, string | undefined>;

/**
 * Parse the plain assignments out of a local.env. Anything else on a line is
 * skipped, deliberately: a partial evaluation of shell is worse than none.
 */
export function parseLocalEnv(text: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
        if (!m) continue;
        let value = m[2].trim();
        if (
            (value.startsWith('"') && value.endsWith('"') && value.length >= 2)
            || (value.startsWith('\'') && value.endsWith('\'') && value.length >= 2)
        ) {
            value = value.slice(1, -1);
        } else {
            // An unquoted value ends at the first comment marker, as in sh.
            const hash = value.indexOf(' #');
            if (hash >= 0) value = value.slice(0, hash).trim();
        }
        // A value that still needs a shell is not a value this reader has.
        if (value.match(/\$[({]|`/)) continue;
        out[m[1]] = value;
    }
    return out;
}

/**
 * drover_home_path, transcribed: where a tree drover owns lives TODAY.
 *
 * `drover home migrate` moves six trees under DROVER_HOME and leaves a symlink
 * at each old path, so both spellings resolve afterwards; the canonical one is
 * the new one. Before that run the new path does not exist and the legacy one
 * is the only truth; on a fresh machine neither exists and new state goes
 * straight under DROVER_HOME.
 */
export function droverHomePath(next: string, legacy: string): string {
    if (existsSync(next)) return next;
    if (existsSync(legacy)) return legacy;
    return next;
}

export function droverEnv(env: Env = process.env, home: string = homedir()): DroverEnv {
    const droverHome = env.DROVER_HOME || join(home, '.drover');
    const droverDir = env.DROVER_DIR || join(home, 'Projects', 'bitspur', 'cattle-drover');
    const forkDir = env.FORK_DIR || join(home, 'Projects', 'bitspur', 'happy');
    // NO XDG. etc/drover.env stopped consulting XDG_STATE_HOME in DROVE-309;
    // a node side that still did would send half the stack to a directory the
    // shell half has never heard of.
    const stateDir = env.STATE_DIR
        || droverHomePath(join(droverHome, 'state'), join(home, '.local', 'state', 'cattle-drover'));

    // The overlay. Read through the SAME state dir the defaults produced, the
    // way the shell does: local.env cannot move STATE_DIR, because STATE_DIR is
    // how local.env was found.
    const local: Record<string, string> = {};
    const localFile = join(stateDir, 'local.env');
    if (existsSync(localFile)) {
        try {
            Object.assign(local, parseLocalEnv(readFileSync(localFile, 'utf8')));
        } catch {
            // Unreadable is the same as absent, which is what `[ -r ]` says too.
        }
    }
    const pick = (name: string, fallback: string): string => local[name] ?? env[name] ?? fallback;

    const droverPort = pick('DROVER_PORT', '7970');
    const relayPort = pick('DROVER_RELAY_PORT', '7971');
    const serverMode = pick('DROVER_SERVER_MODE', 'official');
    // Relay mode keeps its own happy home, because those credentials belong to
    // a different server and must not overwrite the real ones.
    const happyDefault = serverMode === 'relay'
        ? join(stateDir, 'happy-home')
        : droverHomePath(join(droverHome, 'happy'), join(home, '.happy'));

    return {
        droverDir: pick('DROVER_DIR', droverDir),
        forkDir: pick('FORK_DIR', forkDir),
        droverHome: pick('DROVER_HOME', droverHome),
        stateDir,
        droverPort,
        droverUrl: pick('DROVER_URL', `http://127.0.0.1:${droverPort}`),
        relayPort,
        relayUrl: pick('DROVER_RELAY_URL', `http://127.0.0.1:${relayPort}`),
        serverMode,
        happyHome: pick('DROVER_HAPPY_HOME', happyDefault),
        accounts: pick('DROVER_ACCOUNTS', join(pick('DROVER_DIR', droverDir), 'accounts.json')),
        skipPermissions: pick('DROVER_SKIP_PERMISSIONS', '1'),
        skipBuild: pick('DROVER_SKIP_BUILD', '0'),
        distSettleS: pick('DROVER_DIST_SETTLE_S', '15'),
        localAsk: pick('DROVER_LOCAL_ASK', '1'),
        localAskTimeout: pick('DROVER_LOCAL_ASK_TIMEOUT', '120'),
    };
}

/**
 * One variable the way a shell verb reads it right after `. etc/drover.env`:
 * the local.env line, else the exported var, else the default. For a name the
 * env file does not define itself but that still rides on local.env because
 * the file sources it — DROVER_SHARED_STORE, which share-sessions reads as
 * `${DROVER_SHARED_STORE:-$HOME/.claude-shared}` on the line after the source.
 */
export function droverVar(name: string, fallback: string, env: Env = process.env, home: string = homedir()): string {
    const localFile = join(droverEnv(env, home).stateDir, 'local.env');
    let local: Record<string, string> = {};
    if (existsSync(localFile)) {
        try {
            local = parseLocalEnv(readFileSync(localFile, 'utf8'));
        } catch {
            // Unreadable is the same as absent, as above.
        }
    }
    return local[name] ?? env[name] ?? fallback;
}
