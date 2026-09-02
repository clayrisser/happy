/**
 * `drover pi` — a pi session drover can see and the phone can drive
 * (DROVE-295, DROVE-316), in node (DROVE-315).
 *
 * pi is the LOCAL-MODEL harness, and that is the whole reason it exists beside
 * the other four. claude is the default, cursor is the subscription, codex is
 * OpenAI, opencode is arbitrary third-party providers, and pi fronts what runs
 * on this machine: LM Studio's OpenAI-compatible server on :1234 and a local
 * GLM on :8420. ~/.pi/agent/auth.json is EMPTY on this machine by design, and
 * nothing below assumes otherwise.
 *
 * A straight port of cattle-drover/libexec/drover-pi: the same options, the
 * same refusals, the same exit codes, the same dry-run lines. What it does is
 * what the CLI cannot do for itself — refuse outside tmux, say plainly which
 * binary is missing, resolve a model against `pi --list-models` before anything
 * starts — and then get out of the way.
 *
 * ONE DIFFERENCE FROM THE SHELL, and it is the point of the port: the normal
 * path no longer spawns `node $cli/bin/drover.mjs pi ...`. There is one
 * implementation now. The rewritten argv is handed to the fork's own runner
 * (src/pi/runPi.ts) behind an injectable `launch`, so a `drover pi` costs one
 * process rather than two. Under DROVER_DRY_RUN the line the shell printed is
 * printed unchanged, because the bats pin it byte for byte.
 *
 * ONE MODE, which is why the routing is unconditional. A `drover pi` in the
 * terminal and one spawned from the phone are the same kind of session;
 * branching on --started-by would produce two, which is the thing this repo
 * keeps refusing.
 *
 * DROVER_PI_BRIDGE=1 still runs the DROVE-295 bus-only bridge instead. It is
 * the fallback for a machine with no fork checkout, and the harness that
 * tests/pi.bats exercises directly. It registers no Happy session, so a session
 * started that way is visible to drover and not to the phone's session list.
 *
 * TWO TRAPS worth the ink, both measured on pi 0.80.3:
 *   --no-extensions kills local models. The lmstudio and glm providers ARE
 *   extensions, so -ne makes pi answer `Unknown provider "lmstudio"`. Never
 *   pass it; the gate is loaded with --extension on top of normal discovery.
 *   SIGTERM loses the transcript. pi writes its jsonl on a clean exit and
 *   nothing at all when killed, so the bridge closes stdin to stop it.
 *
 * Help is answered BEFORE anything else — no env read, no binary lookup, no
 * tmux question — the way the shell answered it above the path resolution.
 */

import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

import { droverEnv } from './env';
import { guardHarness } from './harness/failure';
import { defaultIo, reenterLine, runEnter } from './harness/tmuxEnter';
import { droverTmuxHavePane } from './harness/tmuxEntry';

const HELP = `drover pi — a pi session drover can see and the phone can drive.

USAGE
  drover pi [--resume [id]] [--model <provider/id>] [--thinking <level>]
            [--seed <file>] [pi args...]

  --resume [id]     bare picks from this project's pi sessions; with an id,
                    resumes that one. pi resumes by id or by a partial uuid.
  --model <p/id>    a model pi actually reports. Picked by LOOKUP against
                    \`pi --list-models\`, never typed free-hand: a name pi does
                    not know is refused here rather than at the first turn.
  --thinking <l>    off | minimal | low | medium | high | xhigh
  --seed <file>     the file's contents become this session's first prompt.
  --no-gate         do not broker pi's tool calls on the bus. The pane is then
                    unsupervised; the default is to broker.

  Every other pi flag is passed through untouched. --mode is the one exception:
  drover chooses it, because \`--mode rpc\` IS the channel.

WHAT YOU GET
  a real Happy session, so the phone LISTS it and can start one from the
  new-session picker (DROVE-316) — not just watch a pane drover told it about.
  Its transcript streams as cards with tool calls rendered as tool calls, its
  permission gates reach the phone AND the bus (gum, the watch), and a message
  sent from the app lands in the running session.

  A gate nobody answers DENIES. That is pi's own protocol doing it: the dialog
  auto-resolves to undefined, and undefined is not allow.

WHAT YOU DO NOT GET
  accounts and the flip. Those move Claude logins and do not cross harnesses
  (docs/flip-policy.md). pi holds its own auth, and here it holds none.

LOCAL MODELS
  pi reaches whatever its packages register. On this machine that is LM Studio
  (http://localhost:1234/v1) and a local GLM (http://localhost:8420/v1). Start
  the runtime first — a model that is not being served is not a model pi can
  reach, and the failure lands on the first turn rather than at startup.

ENV
  DROVER_PI_BIN         default: pi
  DROVER_PI_GATE        on (default) | all | off
  DROVER_PI_ALLOW       comma list of tools that pass without asking
                        (default: read,ls,grep,find)
  DROVER_PI_GATE_MS     how long a surface has before the answer is no
  DROVER_URL            bus endpoint (default http://127.0.0.1:7970)
  DROVER_PI_BRIDGE=1    run the DROVE-295 bus-only bridge instead of the
                        happy-cli runner. No Happy session, so the phone can
                        see the pane but cannot start one.
`;

export type Env = Record<string, string | undefined>;

/** The levels pi's --thinking takes. Anything else is refused by name. */
const THINKING = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];

/**
 * Everything the launcher needs that is not argv. Injected so a test drives
 * every branch without a pi on PATH, a tmux server, a fork checkout, or a real
 * session — and so a test that forgot to inject fails loudly rather than
 * starting one.
 */
export interface PiIo {
    env: Env;
    home: string;
    cwd: string;
    out: (line: string) => void;
    err: (line: string) => void;
    /** `command -v <name>` — the resolved path, or null. */
    which: (name: string) => string | null;
    /** `[ -x <path> ]`. */
    isExecutable: (path: string) => boolean;
    /** `[ -r <file> ]`. */
    isReadable: (path: string) => boolean;
    /** `[ -d <dir> ]`. */
    isDirectory: (path: string) => boolean;
    /** `mkdir -p ... 2>/dev/null || true`. */
    mkdirp: (path: string) => void;
    /** `$self/drover-pick-pi-session` — the picked id, and its exit code. */
    pickSession: () => Promise<{ code: number; id: string }>;
    /** `$self/drover-pick-pi-model --resolve <want>` — the full provider/id. */
    resolveModel: (want: string) => Promise<{ code: number; ref: string }>;
    /** The pane opener, when there is no pane and this is not a dry run. */
    enter: (argv: readonly string[], cwd: string) => Promise<number>;
    /** The fork's own pi runner. ONE implementation — never a second process. */
    launch: (argv: string[], env: Env) => Promise<number>;
    /** adapters/pi-bridge.mjs, the DROVE-295 bus-only path. */
    launchBridge: (argv: string[], env: Env) => Promise<number>;
}

function whichOnPath(name: string, env: Env): string | null {
    for (const dir of (env.PATH ?? '').split(delimiter)) {
        if (!dir) continue;
        const candidate = join(dir, name);
        if (existsSync(candidate)) return candidate;
    }
    return null;
}

/**
 * The argv the runner takes, parsed the way src/index.ts's `pi` arm parses it.
 * The launcher's job ends at building this list; translating it is the
 * runner's, and this is the one place the two meet.
 */
export function parseRunnerArgs(argv: readonly string[]): {
    startedBy?: 'daemon' | 'terminal';
    model: string | null;
    thinking: string | null;
    resumeSessionId: string | null;
    gate: boolean;
    seedFile: string | null;
} {
    let startedBy: 'daemon' | 'terminal' | undefined;
    let model: string | null = null;
    let thinking: string | null = null;
    let resumeSessionId: string | null = null;
    let gate = true;
    let seedFile: string | null = null;
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--started-by') startedBy = argv[++i] as 'daemon' | 'terminal';
        else if (argv[i] === '--seed') seedFile = argv[++i] ?? null;
        else if (argv[i] === '--model') model = argv[++i] ?? null;
        else if (argv[i] === '--thinking' || argv[i] === '--effort') thinking = argv[++i] ?? null;
        else if (argv[i] === '--resume') resumeSessionId = argv[++i] ?? null;
        else if (argv[i] === '--no-gate') gate = false;
    }
    return { startedBy, model, thinking, resumeSessionId, gate, seedFile };
}

export function defaultPiIo(env: Env = process.env, libexec = ''): PiIo {
    const spawnCode = (bin: string, argv: string[], childEnv: Env): number => {
        const r = spawnSync(bin, argv, { stdio: 'inherit', env: childEnv as NodeJS.ProcessEnv });
        return r.status ?? 1;
    };
    return {
        env,
        home: homedir(),
        cwd: process.cwd(),
        out: (line) => process.stdout.write(`${line}\n`),
        err: (line) => process.stderr.write(`${line}\n`),
        which: (name) => whichOnPath(name, env),
        isExecutable: (path) => {
            try {
                accessSync(path, constants.X_OK);
                return true;
            } catch {
                return false;
            }
        },
        isReadable: (path) => {
            try {
                accessSync(path, constants.R_OK);
                return true;
            } catch {
                return false;
            }
        },
        isDirectory: (path) => {
            try {
                return statSync(path).isDirectory();
            } catch {
                return false;
            }
        },
        mkdirp: (path) => {
            try {
                mkdirSync(path, { recursive: true });
            } catch {
                // `|| true`
            }
        },
        pickSession: async () => {
            const picker = await import('./pick-pi-session');
            let id = '';
            const io = picker.defaultSessionIo();
            const code = await picker.run([], { io: { ...io, out: (line: string) => { id = line; } } });
            return { code, id };
        },
        resolveModel: async (want) => {
            const picker = await import('./pick-pi-model');
            let ref = '';
            const io = picker.defaultModelIo();
            const code = await picker.run(['--resolve', want], { io: { ...io, out: (line: string) => { ref = line; } } });
            return { code, ref };
        },
        enter: async (argv, cwd) => {
            const entry = process.argv[1] ?? '';
            return runEnter(['--cwd', cwd, '--', process.execPath, entry, 'pi', ...argv], defaultIo(), libexec);
        },
        // GUARDED, because the arm this replaced was (DROVE-374). src/index.ts
        // wrapped runPi in a try/catch that printed one line and exited 1; the
        // port dropped it, and a throw then arrived as a raw node stack.
        launch: async (argv, childEnv) => guardHarness('pi', (line) => process.stderr.write(`${line}\n`), async () => {
            // ONE implementation. The runner IS the pi client — it creates the
            // Happy session the app's list is built from, streams the
            // transcript, races the app's permission card against the drover
            // bus, and shuts pi down by closing stdin so the transcript
            // survives. Spawning a second node to reach it would be a second,
            // worse pi client.
            const { runPi } = await import('@/pi/runPi');
            const { authAndSetupMachineIfNeeded } = await import('@/ui/auth');
            const { ensureDaemonRunning } = await import('@/daemon/ensureDaemonRunning');
            for (const [k, v] of Object.entries(childEnv)) if (v !== undefined) process.env[k] = v;
            const { credentials } = await authAndSetupMachineIfNeeded();
            await ensureDaemonRunning();
            await runPi({ credentials, ...parseRunnerArgs(argv) });
            return 0;
        }),
        launchBridge: async (argv, childEnv) => {
            const root = droverEnv(env).droverDir;
            return spawnCode(process.execPath, [join(root, 'adapters', 'pi-bridge.mjs'), ...argv], {
                ...process.env,
                ...childEnv,
            });
        },
    };
}

export interface PiOptions {
    io?: PiIo;
    /** cattle-drover's libexec/, for the re-entry line. */
    libexec?: string;
}

export async function run(args: string[], opts: PiOptions = {}): Promise<number> {
    // BEFORE anything else, and it touches nothing: the shell answered --help
    // above the path resolution on purpose, and tests/libexec-loadtime.bats
    // probes for exactly that.
    if (args[0] === '--help' || args[0] === '-h') {
        process.stdout.write(HELP);
        return 0;
    }

    const denv = droverEnv(opts.io?.env ?? process.env, opts.io?.home ?? homedir());
    const libexec = opts.libexec ?? join(denv.droverDir, 'libexec');
    const io = opts.io ?? defaultPiIo(process.env, libexec);
    const root = droverEnv(io.env, io.home).droverDir;

    // The ORIGINAL argv, captured HERE, before the loop below starts shifting.
    // The pane check has to stay AFTER the preflight — a missing pi has to be
    // reported in the terminal you typed in, not in a window that opens, prints
    // it and closes half a second later — so by then the remaining argv is what
    // is LEFT, and re-entering with it would run a DIFFERENT command.
    const original = [...args];

    let seed = '';
    let model = '';
    let thinking = '';
    let gate = 1;
    let pickMode = '';
    let resumeId = '';
    let rest: string[] = [];

    let i = 0;
    for (; i < args.length; i++) {
        const a = args[i];
        if (a === '--help' || a === '-h') {
            io.out(HELP.replace(/\n$/, ''));
            return 0;
        } else if (a === '--seed') {
            seed = args[i + 1] ?? '';
            if (seed === '') {
                io.err('drover pi: --seed needs a file');
                return 2;
            }
            if (!io.isReadable(seed)) {
                io.err(`drover pi: cannot read the seed file '${seed}'`);
                return 2;
            }
            i++;
        } else if (a === '--model') {
            model = args[i + 1] ?? '';
            if (model === '') {
                io.err('drover pi: --model needs a model');
                return 2;
            }
            i++;
        } else if (a === '--thinking') {
            thinking = args[i + 1] ?? '';
            if (!THINKING.includes(thinking)) {
                io.err(`drover pi: '${thinking}' is not a thinking level.`);
                io.err('  one of: off minimal low medium high xhigh');
                return 2;
            }
            i++;
        } else if (a === '--no-gate') {
            gate = 0;
        } else if (a === '--resume' || a === '-r') {
            // A bare --resume picks; --resume <id> resumes that one. Same seam
            // as `drover cursor --resume` (DROVE-57): the id has to exist
            // BEFORE the session starts, or the phone gets an empty twin of a
            // conversation it already has.
            const next = args[i + 1] ?? '';
            if (next === '' || next.startsWith('-')) {
                pickMode = 'choose';
            } else {
                resumeId = next;
                i++;
            }
            if (pickMode === '') pickMode = 'given';
        } else if (a === '--mode') {
            io.err("drover pi: --mode is drover's to choose — 'rpc' IS the channel the phone");
            io.err('  reaches this session through. Everything else is passed straight to pi.');
            return 2;
        } else if (a === '--no-extensions' || a === '-ne') {
            io.err('drover pi: --no-extensions takes the LOCAL MODELS down with it.');
            io.err('  The lmstudio and glm providers are pi extensions (settings.json');
            io.err("  packages), so pi answers 'Unknown provider' and refuses to start.");
            return 2;
        } else {
            rest = args.slice(i);
            break;
        }
    }

    let bin = io.env.DROVER_PI_BIN || 'pi';

    // Say WHICH binary is missing rather than failing obscurely three layers
    // down. `command -v` first, then the places a global npm install actually
    // lands: pi ships as @earendil-works/pi-coding-agent, and on this machine
    // that is a homebrew-node symlink at /opt/homebrew/bin/pi — which is NOT on
    // a launchd daemon's PATH. Same bug src/codex/codexBin.ts was written for.
    if (!io.which(bin)) {
        // The fallback is for the DEFAULT name only. A DROVER_PI_BIN somebody
        // set by hand and got wrong must fail with THAT name in the message —
        // silently running a different pi than the one asked for is worse than
        // not starting.
        let found = '';
        if (bin === 'pi') {
            for (const c of [join(io.home, '.local', 'bin', 'pi'), '/opt/homebrew/bin/pi', '/usr/local/bin/pi']) {
                if (io.isExecutable(c)) {
                    found = c;
                    break;
                }
            }
        }
        if (found) {
            bin = found;
        } else {
            io.err(`drover pi: '${bin}' is not on PATH.`);
            io.err('  install it:  npm install -g @earendil-works/pi-coding-agent');
            io.err('');
            io.err('  installed somewhere unusual?  DROVER_PI_BIN=/path/to/pi');
            return 127;
        }
    }

    if (!io.which('node')) {
        io.err('drover pi: node is required — the bridge that drives pi\'s rpc protocol is');
        io.err('  node, the same as the bus itself.');
        return 127;
    }

    // ONE MODE. A managed session lives in a pane so the app is a window onto
    // it rather than a second kind of session — and drover OPENS one rather
    // than refusing (DROVE-308), through the one implementation shared with
    // every other harness.
    if (io.env.DROVER_ALLOW_NO_TMUX !== '1' && !droverTmuxHavePane(io.env)) {
        // The CAPTURED argv and not what is left: the loop above has already
        // eaten this script's own flags, and re-entering without them would run
        // a different command than the one that was typed.
        if (io.env.DROVER_DRY_RUN) {
            io.out(reenterLine(libexec, 'drover-pi', original, io.cwd));
            return 0;
        }
        return io.enter(original, io.cwd);
    }

    if (pickMode === 'choose') {
        const picked = await io.pickSession();
        if (picked.code !== 0) return picked.code;
        if (picked.id === '') return 1;
        resumeId = picked.id;
    }

    // LOOKUP, NEVER FREE TEXT (DROVE-253). A model string is only real if the
    // CLI itself lists it, so the pick is resolved against `pi --list-models`
    // and a miss is refused HERE, where the message can name the alternatives,
    // rather than at the first turn where it is an opaque provider error.
    if (model !== '') {
        const resolved = await io.resolveModel(model);
        if (resolved.code !== 0) return resolved.code;
        model = resolved.ref;
    }

    const childEnv: Env = {
        DROVER_URL: denv.droverUrl,
        DROVER_DIR: denv.droverDir,
        STATE_DIR: denv.stateDir,
        DROVER_ORIGIN: io.env.DROVER_ORIGIN || 'terminal',
    };

    io.mkdirp(join(denv.stateDir || join(root, '.state'), 'pi'));

    // THE DROVE-295 BRIDGE, kept behind a switch rather than deleted. It
    // registers no Happy session, so the phone can watch a pane started this
    // way but cannot start one — exactly the gap DROVE-316 closed. It stays
    // reachable because it needs no fork checkout, and because tests/pi.bats
    // exercises the rpc protocol through it directly.
    if (io.env.DROVER_PI_BRIDGE === '1') {
        if (!io.which('node')) {
            io.err('drover pi: node is required — the bridge that drives pi\'s rpc protocol is');
            io.err('  node, the same as the bus itself.');
            return 127;
        }
        // Built one flag at a time, in the shell's PREPEND order, rather than
        // one clever expansion: `${x:+--flag "$x"}` word-splits differently
        // across shells, and a model id or a seed path with a space in it would
        // split into two arguments and be refused by pi with a message about
        // neither of them.
        let piArgs = [...rest];
        if (thinking !== '') piArgs = ['--thinking', thinking, ...piArgs];
        if (model !== '') piArgs = ['--model', model, ...piArgs];
        // `--session`, because these go straight to pi, whose flag it is. The
        // runner below takes `--resume`, which is drover's own spelling.
        if (resumeId !== '') piArgs = ['--session', resumeId, ...piArgs];

        if (io.env.DROVER_DRY_RUN) {
            io.out(`node ${join(root, 'adapters', 'pi-bridge.mjs')} --pi-bin ${bin} -- ${piArgs.join(' ')}`);
            return 0;
        }

        // The gate is an EXTENSION pi loads, not a flag pi has. --extension
        // adds it on top of normal discovery; --no-extensions would replace
        // discovery and take the local providers down with it, which is why
        // that flag is refused above.
        piArgs = gate === 1 ? ['--gate', join(root, 'adapters', 'pi-gate.mjs'), '--', ...piArgs] : ['--', ...piArgs];
        if (seed !== '') piArgs = ['--seed', seed, ...piArgs];

        return io.launchBridge(
            ['--pi-bin', bin, '--cwd', io.cwd, '--pane', io.env.TMUX_PANE ?? '', '--bus', denv.droverUrl, ...piArgs],
            childEnv,
        );
    }

    // --- the happy-cli runner, which is the normal path (DROVE-316) ----------

    if (!io.which('node')) {
        io.err('drover pi: node is required — the pi runner is node, the same as the');
        io.err('  bus itself.');
        return 127;
    }

    const cli = join(denv.forkDir, 'packages', 'happy-cli');
    if (!io.isDirectory(cli)) {
        io.err(`drover pi: fork not found at ${denv.forkDir}`);
        io.err('');
        io.err('  the happy-cli pi runner is what registers the Happy session the phone');
        io.err('  lists. Point FORK_DIR at your happy checkout, or run the bus-only');
        io.err('  bridge instead:  DROVER_PI_BRIDGE=1 drover pi ...');
        return 1;
    }

    // HAPPY_PI_PATH, not DROVER_PI_BIN: the runner resolves pi through
    // src/pi/piBin.ts, which honours that variable and otherwise walks PATH and
    // the install locations a launchd daemon cannot see. Handing over the
    // binary this verb already resolved means both halves run the same pi.
    childEnv.HAPPY_PI_PATH = bin;

    let runnerArgs = [...rest];
    if (gate === 0) runnerArgs = ['--no-gate', ...runnerArgs];
    if (seed !== '') runnerArgs = ['--seed', seed, ...runnerArgs];
    if (thinking !== '') runnerArgs = ['--thinking', thinking, ...runnerArgs];
    if (model !== '') runnerArgs = ['--model', model, ...runnerArgs];
    if (resumeId !== '') runnerArgs = ['--resume', resumeId, ...runnerArgs];

    if (io.env.DROVER_DRY_RUN) {
        // The line the shell printed, unchanged — the bats pin it, and it still
        // names the entry a reader would reach for by hand.
        io.out(`node ${join(cli, 'bin', 'drover.mjs')} pi ${runnerArgs.join(' ')}`);
        return 0;
    }

    return io.launch(runnerArgs, childEnv);
}
