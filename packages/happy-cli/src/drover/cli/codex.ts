/**
 * `drover codex` — start an OpenAI Codex session as a drover-managed session
 * (DROVE-273), in node (DROVE-315 wave 3a). The port of
 * cattle-drover/libexec/drover-codex.
 *
 * Same rules as a Claude Code session, because ONE MODE is a rule about
 * sessions and not about Claude: the agent is a real TUI in a tmux pane, the
 * app is a window onto that pane, and a session started outside tmux gets a
 * pane opened for it rather than being quietly created headless.
 *
 * WHY THIS IS SHAPED LIKE opencode AND NOT LIKE cursor. It was the other way
 * round until DROVE-377, and the pane is what changed the answer.
 *
 *   cursor    runs through this CLI, which creates the Happy session and
 *             drives the agent a turn at a time. The pane shows the CLI, not
 *             an agent.
 *   opencode  the pane runs the REAL TUI and a sibling bridge process does the
 *             registering. One process, one pane, one conversation.
 *
 * The old shape here was the cursor one, and it produced exactly the session
 * Clay complained about: this CLI's codex runner speaks `codex app-server
 * --listen stdio://`, which is HEADLESS, so the pane showed one line — "Codex
 * Agent Running - Ctrl-C to exit" — and the phone was the only way in. His
 * words: "Codex is working, but it's doing the modes like it used to do with
 * Claude - I don't want it that way. I want to be able to use it directly from
 * the terminal."
 *
 * So the pane now runs `codex` itself, with the user's own config, and
 * cattle-drover's adapters/codex-bridge.mjs is its sibling:
 *
 *   the session   the bridge registers it on drover's bus, the same call
 *                 opencode-bridge.mjs makes.
 *   transcript    codex's own rollout JSONL under $CODEX_HOME/sessions, which
 *                 cattle-drover's engine/harness.js already coerces.
 *   input         `codex queue --thread <id> --message <text>`, MEASURED to
 *                 deliver into a running TUI and submit the turn. Codex drains
 *                 the queue when idle, so drover needs no gate of its own.
 *   teardown      the bridge is told the TUI's pid. A codex reparented to pid
 *                 1, or whose pane is gone, is reaped and its row ended within
 *                 seconds — the twin that outlived the pane (DROVE-377).
 *
 * The headless runner is still there and still good — it is simply not what a
 * PANE should hold. `--headless` reaches it, in this process as before.
 *
 * WHAT ACCOUNTS MEAN HERE. Codex authenticates with a ChatGPT subscription and
 * keeps the credential at $CODEX_HOME/auth.json (default ~/.codex/auth.json).
 * CODEX_HOME relocates the whole home, so two logins CAN coexist the same way
 * two Claude logins do behind CLAUDE_CONFIG_DIR — but drover's accounts.json is
 * not wired to it yet, and the flip moves CLAUDE logins only. Set CODEX_HOME
 * yourself to pick a login; do not expect `drover flip` to do it. Nothing here
 * reads that file.
 */

import { existsSync, mkdirSync, openSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

import { droverEnv } from './env';
import { guardHarness } from './harness/failure';
import { runPaneTui, type TuiStarted } from './harness/paneTui';
import { droverTmuxHavePane, type Env } from './harness/tmuxEntry';
import { defaultIo, reenterLine, runEnter, type EnterIo } from './harness/tmuxEnter';

export const usage = `drover codex — an OpenAI Codex session, managed like a Claude Code one.

USAGE
  drover codex [codex args...]      Start it. Needs a tmux pane.
  drover codex --resume <thread>    Continue a Codex thread by id.
  drover codex --headless           The old app-server runner, no TUI.

WHAT YOU GET
  a REAL Codex TUI in this pane, with your own ~/.codex config — the same
  thing \`codex\` on its own would give you. Drover registers it, mirrors its
  rollout to the app, and delivers the phone's messages into THIS instance.

WHAT IS AND IS NOT WIRED
  a row in the app   yes. adapters/codex-bridge.mjs registers the pane on
                     drover's bus, so the phone lists it like any other.
  transcript         yes, live, from codex's own rollout JSONL under
                     $CODEX_HOME/sessions — the file the TUI is writing.
  tool calls         yes, as tool calls — CodexBash, CodexPatch, CodexDiff
                     have their own renderers in the app.
  permission gates   through codex's OWN hook surface, which is the Claude
                     Code one: $CODEX_HOME/hooks.json takes PreToolUse
                     matchers running a command, so the ask-*.sh gates already
                     on this machine publish to the bus and reach gum, the
                     phone and the watch exactly as they do for Claude. That
                     is a better answer than the app-server path had — one
                     gate surface for two harnesses instead of a codex-shaped
                     approval bridge — and it is why --headless keeps its own.
                     A published gate nobody answers is a DENY.
  resume             yes. --resume <thread-id>, or from the app.
  model / effort     yes. --model and --effort, or codex's own /model.
  accounts / flip    no. Flip moves Claude logins. Codex has its own, under
                     CODEX_HOME; see the note at the top of this file.

  --headless         the old app-server runner: no TUI, the phone is the only
                     input, approvals ride JSON-RPC (DROVER_CODEX_GATE=1 puts
                     them on the bus). Kept because it is a complete Codex
                     client and something may still want it. It is not what a
                     pane should hold, so it is not the default any more.

ENV
  DROVER_CODEX_BIN         the codex binary to require (default: codex)
  DROVER_CODEX_HEADLESS=1  same as --headless
  DROVER_CODEX_GATE=1      --headless only: put approvals on the bus too
  CODEX_HOME               which Codex login to use (default: ~/.codex)
  DROVER_ALLOW_NO_TMUX=1   start without a pane, deliberately
`;

/**
 * The seams a test replaces. Everything that touches a binary, a directory or
 * another process is here, so a test drives every branch without a codex, a
 * tmux, a fork checkout or a Happy session.
 */
export interface CodexIo {
    env: Env;
    cwd: string;
    home: string;
    out: (line: string) => void;
    err: (line: string) => void;
    /** `command -v <bin>`: is it on PATH? */
    hasBinary: (bin: string) => boolean;
    /** Does this path exist? For the fork checkout's one probe (--headless). */
    exists: (path: string) => boolean;
    /** Open the pane and re-enter, when there is none. */
    enter: (argv: string[]) => Promise<number>;
    /** Start the bridge as a SIBLING, detached, logging to a file. */
    startBridge: (script: string, argv: string[], logFile: string, env: Env) => void;
    /** Become the TUI. `started(pid)` fires once it exists. Answers with its exit code. */
    execTui: (bin: string, argv: string[], env: Env, started?: TuiStarted) => Promise<number>;
    /** The --headless runner, in this process. */
    launch: (argv: string[]) => Promise<number>;
}

function onPath(bin: string, env: Env): boolean {
    if (bin.includes('/')) return existsSync(bin);
    for (const dir of (env.PATH ?? '').split(delimiter)) {
        if (dir && existsSync(join(dir, bin))) return true;
    }
    return false;
}

export function defaultCodexIo(): CodexIo {
    const io: EnterIo = defaultIo();
    return {
        env: process.env,
        cwd: process.cwd(),
        home: homedir(),
        out: (line) => process.stdout.write(`${line}\n`),
        err: (line) => process.stderr.write(`${line}\n`),
        hasBinary: (bin) => onPath(bin, process.env),
        exists: (path) => existsSync(path),
        enter: async (argv) => {
            const { droverDir } = droverEnv(process.env, homedir());
            return runEnter(argv, io, join(droverDir, 'libexec'));
        },
        startBridge: (script, argv, logFile, env) => {
            try {
                mkdirSync(dirname(logFile), { recursive: true });
            } catch {
                // Best effort, as `mkdir -p ... || true` was.
            }
            const fd = openSync(logFile, 'a');
            const child = spawn(process.execPath, [script, ...argv], {
                detached: true,
                stdio: ['ignore', fd, fd],
                env: env as NodeJS.ProcessEnv,
            });
            child.unref();
        },
        execTui: (bin, argv, env, started) => runPaneTui(bin, argv, env, started),
        // WITH THE CATCH THE ARM IT REPLACED HAD (DROVE-374). src/index.ts
        // wrapped handleCodexCommand in a try/catch that printed one line and
        // exited 1. The port dropped it, so anything thrown out of the runner
        // reached the terminal as an unhandled rejection and a raw node stack.
        launch: async (argv) => guardHarness('codex', (line) => process.stderr.write(`${line}\n`), async () => {
            const { handleCodexCommand } = await import('../../commands/codexCommand');
            await handleCodexCommand(argv);
            return 0;
        }),
    };
}

/**
 * --help is answered BEFORE anything else runs — before the environment is
 * resolved and before a single path is looked at. It reaches nothing at all.
 *
 * cattle-drover's tests/libexec-loadtime.bats probes every launcher with --help
 * under a hard timeout, on a PATH of shims, and asserts it ran nothing: four
 * uncommented header lines in libexec/drover-account once made `drover account`
 * run a real login on load and hang the whole CLI. Keep every side effect below
 * this block.
 */
export async function run(args: string[], io: CodexIo = defaultCodexIo()): Promise<number> {
    if (args[0] === '--help' || args[0] === '-h') {
        io.out(usage.trimEnd());
        return 0;
    }

    const env = io.env;
    const { droverDir, forkDir, stateDir, droverUrl } = droverEnv(env, io.home);
    const libexec = join(droverDir, 'libexec');

    // The ORIGINAL argv, because the pane check below re-enters with what was
    // typed, --headless included — the shell quotes "$@" before its own loop
    // eats the flag, for the same reason.
    const original = [...args];

    // --headless is DROVER's flag, not codex's, so it is eaten here and never
    // reaches the binary. It decides WHICH preflight applies: the headless
    // path needs the fork tree, the TUI path does not.
    let headless = env.DROVER_CODEX_HEADLESS === '1';
    const rest = [...args];
    while (rest[0] === '--headless') {
        headless = true;
        rest.shift();
    }

    const bin = env.DROVER_CODEX_BIN || 'codex';

    // Say which binary is missing rather than failing obscurely three layers
    // down.
    if (!io.hasBinary(bin)) {
        io.err(`drover codex: '${bin}' is not on PATH.`);
        io.err('  install it:  npm install -g @openai/codex');
        io.err('           or:  brew install --cask codex');
        io.err('  then log in: codex login        (a ChatGPT subscription)');
        io.err('');
        io.err('  installed somewhere unusual?  DROVER_CODEX_BIN=/path/to/codex');
        return 127;
    }

    // ONE MODE. Same requirement, same reason, same escape hatch as every other
    // harness: a managed session lives in a pane so the app is a window onto it
    // rather than a second kind of session. And it OPENS one rather than
    // refusing (DROVE-308), through the one entry every harness shares.
    if ((env.DROVER_ALLOW_NO_TMUX ?? '0') !== '1' && !droverTmuxHavePane(env)) {
        if (env.DROVER_DRY_RUN) {
            io.out(reenterLine(libexec, 'drover-codex', original, io.cwd));
            return 0;
        }
        return io.enter(['--cwd', io.cwd, '--', process.execPath, process.argv[1], 'codex', ...original]);
    }

    // The four the shell exported before handing over. Set in the environment
    // rather than passed, because the headless runner reads them there and the
    // bridge inherits them: one spelling of a thing etc/drover.env answers.
    env.DROVER_URL = droverUrl;
    env.DROVER_DIR = droverDir;
    env.STATE_DIR = stateDir;
    env.DROVER_ORIGIN = env.DROVER_ORIGIN || 'terminal';

    // --headless: the old runner, unchanged, in this process. It needs the
    // fork tree; the TUI path below does not, which is why the check lives in
    // here rather than above.
    if (headless) {
        const cli = join(forkDir, 'packages', 'happy-cli');
        if (!io.exists(cli)) {
            io.err(`drover codex: fork not found at ${forkDir}`);
            return 1;
        }
        if (env.DROVER_DRY_RUN) {
            io.out(`node ${join(cli, 'bin', 'drover.mjs')} codex ${rest.join(' ')}`);
            return 0;
        }
        return io.launch(rest);
    }

    if (env.DROVER_DRY_RUN) {
        io.out(`${bin} ${rest.join(' ')}`);
        return 0;
    }

    const logDir = join(stateDir, 'codex');

    // The pane is the REAL codex and nothing else. The bridge starts the moment
    // the TUI's pid exists — before codex has drawn its composer, let alone
    // opened a thread — so the pane is registered at once rather than after
    // the first turn. It is a SIBLING (detached) and not a child: ctrl-c,
    // resize and the pane's own lifetime then behave exactly as an unwrapped
    // codex would. The pid is what lets it reap a codex that outlives its pane.
    return io.execTui(bin, rest, env, (pid) => {
        io.startBridge(
            join(droverDir, 'adapters', 'codex-bridge.mjs'),
            ['--cwd', io.cwd, '--pane', env.TMUX_PANE ?? '', '--bus', droverUrl, '--codex-bin', bin, '--tui-pid', String(pid)],
            join(logDir, `bridge-${pid}.log`),
            { ...env, DROVER_URL: droverUrl, DROVER_ORIGIN: env.DROVER_ORIGIN || 'terminal' },
        );
    });
}
