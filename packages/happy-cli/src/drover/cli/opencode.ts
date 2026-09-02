/**
 * `drover opencode` — an OpenCode session, driven like a Claude one (DROVE-56),
 * in node (DROVE-315 wave 3a). The port of cattle-drover/libexec/drover-opencode.
 *
 * ONE MODE holds here with no exception. `opencode --port N` starts the REAL
 * OpenCode TUI in this pane and serves its whole HTTP API from the same
 * process, so there is one process, one pane, and one endpoint. There is no
 * headless OpenCode session and no second kind of session; the app is a window
 * onto this pane exactly as it is for Claude Code.
 *
 * What differs from Claude and from cursor, and why:
 *
 *   * No account picking and no flip. Accounts do not cross harnesses (Clay's
 *     ruling, docs/flip-policy.md): there is no meaning to carrying a Claude
 *     transcript onto an OpenCode login. This verb never touches accounts.json,
 *     CLAUDE_CONFIG_DIR or the cooldown ledger.
 *   * No hooks to install. Claude Code and Cursor publish through hook files a
 *     launcher has to merge into; OpenCode publishes through its own event
 *     stream, which adapters/opencode-bridge.mjs holds open for the life of the
 *     pane. Nothing under the user's config is written.
 *   * The permission gate is NOT opt-in. For Cursor it is, because registering
 *     a blocking hook in ~/.cursor/hooks.json changes every Cursor window on
 *     the machine. Here the brokering is scoped to this one server process and
 *     ends with it, so there is nothing to opt out of.
 *   * No build step. The bridge and the bus are cattle-drover's own node;
 *     nothing in the fork's dist is involved.
 *
 * WHY THIS ONE STILL SPAWNS. Every other harness ends by handing argv to a
 * runner that lives in THIS process. OpenCode's does not exist here: the pane
 * must BE the OpenCode TUI, and the bridge must be its SIBLING rather than its
 * child, so that ctrl-c, resize and the pane's own lifetime behave exactly as
 * an unwrapped opencode would. So this verb execs the real binary and detaches
 * the bridge beside it, which is what the shell did and what the shape
 * requires — not a node wrapper around a shell wrapper.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

import { droverEnv } from './env';
import { droverTmuxHavePane, type Env } from './harness/tmuxEntry';
import { defaultIo, reenterLine, runEnter, type EnterIo } from './harness/tmuxEnter';

export const usage = `drover opencode — an OpenCode session drover can see and the phone can drive.

USAGE
  drover opencode [--seed <file>] [opencode args...]

  --seed <file>  the file's contents become this session's first prompt. What
                 \`drover clone <session> --to opencode\` uses to retell a
                 conversation into a fresh OpenCode session.

  Every opencode flag works: \`drover opencode -m anthropic/claude-...\`,
  \`drover opencode --agent build\`, and so on. --port is the one exception:
  drover chooses it, because the port IS the channel the phone reaches this
  pane through.

WHAT YOU GET
  a real OpenCode TUI in this pane, listed by \`drover sessions\` with
  harness=opencode, its conversation streaming to the app as cards, its
  permission and question prompts on the bus (gum, phone, watch), and a
  message sent from the app landing in this pane's input box and submitting.

WHAT YOU DO NOT GET
  accounts and the flip. Those move Claude logins and do not cross harnesses
  (docs/flip-policy.md).

ENV
  DROVER_OPENCODE_BIN   default: opencode
  DROVER_OPENCODE_PORT  pin the port instead of letting drover pick one
  DROVER_URL            bus endpoint (default http://127.0.0.1:7970)
`;

export interface OpencodeIo {
    env: Env;
    cwd: string;
    home: string;
    out: (line: string) => void;
    err: (line: string) => void;
    hasBinary: (bin: string) => boolean;
    /** `[ -r "$seed" ]`. */
    readable: (path: string) => boolean;
    /** A port nothing is listening on right now, or null. */
    freePort: () => Promise<number | null>;
    /** Start the bridge as a SIBLING, detached, logging to a file. */
    startBridge: (script: string, argv: string[], logFile: string, env: Env) => void;
    /** Become the TUI. Answers with its exit code. */
    execTui: (bin: string, argv: string[], env: Env) => number;
    enter: (argv: string[]) => Promise<number>;
}

function onPath(bin: string, env: Env): boolean {
    if (bin.includes('/')) return existsSync(bin);
    for (const dir of (env.PATH ?? '').split(delimiter)) {
        if (dir && existsSync(join(dir, bin))) return true;
    }
    return false;
}

export function defaultOpencodeIo(): OpencodeIo {
    const io: EnterIo = defaultIo();
    return {
        env: process.env,
        cwd: process.cwd(),
        home: homedir(),
        out: (line) => process.stdout.write(`${line}\n`),
        err: (line) => process.stderr.write(`${line}\n`),
        hasBinary: (bin) => onPath(bin, process.env),
        readable: (path) => existsSync(path),
        // A free port from the kernel. There is a window between closing this
        // listener and opencode binding it; the bridge's health check is what
        // turns losing that race into a loud failure rather than a session
        // nobody can reach.
        freePort: () => new Promise((resolve) => {
            const s = createServer();
            s.on('error', () => resolve(null));
            s.listen(0, '127.0.0.1', () => {
                const addr = s.address();
                const port = typeof addr === 'object' && addr ? addr.port : null;
                s.close(() => resolve(port));
            });
        }),
        startBridge: (script, argv, logFile, env) => {
            const fd = openSync(logFile, 'a');
            const child = spawn(process.execPath, [script, ...argv], {
                detached: true,
                stdio: ['ignore', fd, fd],
                env: env as NodeJS.ProcessEnv,
            });
            child.unref();
        },
        execTui: (bin, argv, env) => {
            const r = spawnSync(bin, argv, { stdio: 'inherit', env: env as NodeJS.ProcessEnv });
            return r.status ?? 1;
        },
        enter: async (argv) => {
            const { droverDir } = droverEnv(process.env, homedir());
            return runEnter(argv, io, join(droverDir, 'libexec'));
        },
    };
}

export async function run(args: string[], io: OpencodeIo = defaultOpencodeIo()): Promise<number> {
    const env = io.env;
    const { droverDir, stateDir, droverUrl } = droverEnv(env, io.home);
    const libexec = join(droverDir, 'libexec');

    // The ORIGINAL argv, kept because the pane check below sits AFTER this
    // loop: a missing opencode has to be reported in the terminal you typed
    // in, not in a window that opens, prints it and closes half a second
    // later. Re-entering with what is LEFT would run a different command from
    // the one that was typed.
    const original = [...args];

    let seed: string | null = null;
    const rest = [...args];
    while (rest.length > 0) {
        const a = rest[0];
        if (a === '--help' || a === '-h') {
            io.out(usage.trimEnd());
            return 0;
        }
        // `drover clone <session> --to opencode` (DROVE-58). A FILE, because a
        // clone seed is tens of kilobytes of retold conversation and one stray
        // quote on a tmux command line turns the launch into a syntax error.
        // The bridge submits it as the first prompt once it owns the session;
        // nothing is typed into the pane.
        if (a === '--seed') {
            seed = rest[1] ?? '';
            if (!seed) {
                io.err('drover opencode: --seed needs a file');
                return 2;
            }
            if (!io.readable(seed)) {
                io.err(`drover opencode: cannot read the seed file '${seed}'`);
                return 2;
            }
            rest.splice(0, 2);
            continue;
        }
        break;
    }

    const bin = env.DROVER_OPENCODE_BIN || 'opencode';

    // --port is drover's, not yours. Your own would start the API somewhere the
    // bridge is not looking, and the session would run perfectly in the pane
    // while being invisible to the phone — the exact silent half-failure this
    // ticket is about. Refused rather than overridden.
    for (const a of rest) {
        if (a === '--port' || a.startsWith('--port=')) {
            io.err('drover opencode: --port is drover\'s to choose — it is how the phone reaches');
            io.err('  this pane. Pin it with DROVER_OPENCODE_PORT=<n> if you need a fixed one.');
            return 2;
        }
    }

    if (!io.hasBinary(bin)) {
        io.err(`drover opencode: '${bin}' is not on PATH.`);
        io.err('  install it (brew install sst/tap/opencode) or set DROVER_OPENCODE_BIN.');
        return 127;
    }

    // Same gate as a Claude session, same reason: a managed session lives in a
    // pane so the app is a window onto it rather than a second kind of session.
    // Unlike Cursor the pane is not the input channel here (the API is), so a
    // headless run is genuinely drivable — which is why DROVER_ALLOW_NO_TMUX is
    // a real escape hatch here and not a way to create a session nothing can
    // reach. And it OPENS one rather than refusing (DROVE-308).
    if ((env.DROVER_ALLOW_NO_TMUX ?? '0') !== '1' && !droverTmuxHavePane(env)) {
        if (env.DROVER_DRY_RUN) {
            io.out(reenterLine(libexec, 'drover-opencode', original, io.cwd));
            return 0;
        }
        return io.enter(['--cwd', io.cwd, '--', process.execPath, process.argv[1], 'opencode', ...original]);
    }

    let port = env.DROVER_OPENCODE_PORT || '';
    if (!port) {
        const picked = await io.freePort();
        if (picked === null) {
            io.err('drover opencode: could not find a free port to run the OpenCode API on.');
            return 1;
        }
        port = String(picked);
    }
    if (!port.match(/^[0-9]+$/)) {
        io.err(`drover opencode: '${port}' is not a port number.`);
        return 2;
    }
    const endpoint = `http://127.0.0.1:${port}`;

    if (env.DROVER_DRY_RUN) {
        io.out(`${bin} --port ${port} ${rest.join(' ')}`);
        return 0;
    }

    const logDir = join(stateDir, 'opencode');
    try {
        mkdirSync(logDir, { recursive: true });
    } catch {
        // Best effort, as `mkdir -p ... || true` was.
    }

    // The bridge starts FIRST and waits for the API, so the session is
    // registered the moment the TUI answers rather than after the first turn.
    // It is a SIBLING of the pane process and not a child of it: the TUI takes
    // this pane over below, so the pane is the TUI and nothing else.
    const bridgeArgv = ['--endpoint', endpoint, '--cwd', io.cwd, '--pane', env.TMUX_PANE ?? '', '--bus', droverUrl];
    if (seed) bridgeArgv.push('--seed', seed);
    io.startBridge(
        join(droverDir, 'adapters', 'opencode-bridge.mjs'),
        bridgeArgv,
        join(logDir, `bridge-${port}.log`),
        { ...env, DROVER_URL: droverUrl, DROVER_ORIGIN: env.DROVER_ORIGIN || 'terminal' },
    );

    return io.execTui(bin, ['--port', port, ...rest], env);
}
