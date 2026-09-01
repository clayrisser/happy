/**
 * The drover stack's environment, as etc/drover.env computes it (DROVE-315).
 *
 * Every shell verb under cattle-drover/libexec starts with
 * `. "$root/etc/drover.env"`: the checkout, the fork, the state dir, the bus
 * port and URL, each `${VAR:-default}`, then a per-machine `local.env` sourced
 * over the top. A verb ported to node needs the same answers, and it needs them
 * WITHOUT spawning a shell to ask — the whole point of the port is one runtime.
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
    /** Where the stack keeps logs, ledgers and per-machine overrides. */
    stateDir: string;
    /** The loopback bus port. */
    droverPort: string;
    /** The bus, as a URL. */
    droverUrl: string;
    /** The local Happy self-host relay port and URL (DROVER_SERVER_MODE=relay). */
    relayPort: string;
    relayUrl: string;
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
        const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
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
        if (/\$[({]|`/.test(value)) continue;
        out[m[1]] = value;
    }
    return out;
}

export function droverEnv(env: Env = process.env, home: string = homedir()): DroverEnv {
    const droverDir = env.DROVER_DIR || join(home, 'Projects', 'bitspur', 'cattle-drover');
    const forkDir = env.FORK_DIR || join(home, 'Projects', 'bitspur', 'happy');
    const stateDir = env.STATE_DIR || join(env.XDG_STATE_HOME || join(home, '.local', 'state'), 'cattle-drover');

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
    return {
        droverDir: pick('DROVER_DIR', droverDir),
        forkDir: pick('FORK_DIR', forkDir),
        stateDir,
        droverPort,
        droverUrl: pick('DROVER_URL', `http://127.0.0.1:${droverPort}`),
        relayPort,
        relayUrl: pick('DROVER_RELAY_URL', `http://127.0.0.1:${relayPort}`),
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
