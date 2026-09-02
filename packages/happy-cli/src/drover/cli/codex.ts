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
 * WHY THIS IS SHAPED LIKE cursor AND NOT LIKE opencode. There are two working
 * shapes and picking the wrong one produces a session the phone cannot see:
 *
 *   opencode  runs an HTTP API, so a sibling bridge process polls it and does
 *             the registering. Codex has no such server.
 *   cursor    runs through this CLI, which creates the Happy session and
 *             drives the agent a turn at a time. That is the shape here.
 *
 * The deciding fact, measured: the app's session list comes from the Happy
 * server, and only a happy-cli session registers there. This CLI ALREADY owns
 * a complete Codex runner — it speaks `codex app-server --listen stdio://` over
 * bidirectional JSON-RPC, maps thread items onto the app's cards, and handles
 * approvals, resume and fork. Re-implementing any of that here would be a
 * second, worse Codex client. So this verb does the things the runner cannot do
 * for itself — open the pane, say plainly when the binary is missing — and then
 * gets out of the way.
 *
 * AND IT NO LONGER SPAWNS A SECOND NODE. The shell ended with
 * `exec node $FORK_DIR/packages/happy-cli/bin/drover.mjs codex "$@"`, which is
 * this process. The port therefore hands the rewritten argv straight to the
 * runner in-process: one implementation per harness, not a wrapper around one.
 *
 * WHAT ACCOUNTS MEAN HERE. Codex authenticates with a ChatGPT subscription and
 * keeps the credential at $CODEX_HOME/auth.json (default ~/.codex/auth.json).
 * CODEX_HOME relocates the whole home, so two logins CAN coexist the same way
 * two Claude logins do behind CLAUDE_CONFIG_DIR — but drover's accounts.json is
 * not wired to it yet, and the flip moves CLAUDE logins only. Set CODEX_HOME
 * yourself to pick a login; do not expect `drover flip` to do it. Nothing here
 * reads that file.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

import { droverEnv } from './env';
import { droverTmuxHavePane, type Env } from './harness/tmuxEntry';
import { defaultIo, reenterLine, runEnter, type EnterIo } from './harness/tmuxEnter';

export const usage = `drover codex — an OpenAI Codex session, managed like a Claude Code one.

USAGE
  drover codex [codex args...]      Start it. Needs a tmux pane.
  drover codex --resume <thread>    Continue a Codex thread by id.

WHAT IS AND IS NOT WIRED
  a row in the app   yes. The fork CLI's codex runner creates the Happy
                     session, so the phone lists it like any other.
  transcript         yes, live. The runner speaks \`codex app-server\` over
                     JSON-RPC and maps thread items onto the app's cards.
  tool calls         yes, as tool calls — CodexBash, CodexPatch, CodexDiff
                     have their own renderers in the app.
  permission gates   the phone, always. Codex raises approvals as JSON-RPC
                     REQUESTS, so an unanswered one blocks the turn and never
                     runs the command — it fails closed by construction.
                     gum and the WATCH with DROVER_CODEX_GATE=1: the approval
                     is also published to the bus, both surfaces race, and the
                     winner withdraws the other. A published gate nobody
                     answers is a DENY. Off by default only because it is new
                     and unproven against a real codex on this machine.
  resume             yes. --resume <thread-id>, or from the app.
  model / effort     yes. --model and --effort, or the app's pickers.
  accounts / flip    no. Flip moves Claude logins. Codex has its own, under
                     CODEX_HOME; see the note at the top of this file.

ENV
  DROVER_CODEX_BIN         the codex binary to require (default: codex)
  DROVER_CODEX_GATE=1      also put approvals on the bus, for gum and the watch
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
    /** Does this path exist? For the fork checkout's one probe. */
    exists: (path: string) => boolean;
    /** Open the pane and re-enter, when there is none. */
    enter: (argv: string[]) => Promise<number>;
    /** The runner. The shell spawned a second node for this; we do not. */
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
        launch: async (argv) => {
            const { handleCodexCommand } = await import('../../commands/codexCommand');
            await handleCodexCommand(argv);
            return 0;
        },
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
    const { droverDir, forkDir } = droverEnv(env, io.home);
    const libexec = join(droverDir, 'libexec');
    const bin = env.DROVER_CODEX_BIN || 'codex';

    // Say which binary is missing rather than failing obscurely three layers
    // down. The version floor is the CLI's, not ours: `codex app-server` — the
    // protocol the runner speaks — landed in codex-cli 0.100.
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
            io.out(reenterLine(libexec, 'drover-codex', args, io.cwd));
            return 0;
        }
        return io.enter(['--cwd', io.cwd, '--', process.execPath, process.argv[1], 'codex', ...args]);
    }

    // The fork checkout is still the thing the shell checked for, because
    // engine/ and adapters/ live beside it and the dry-run line names it.
    const cli = join(forkDir, 'packages', 'happy-cli');
    if (!io.exists(cli)) {
        io.err(`drover codex: fork not found at ${forkDir}`);
        return 1;
    }

    if (env.DROVER_DRY_RUN) {
        io.out(`node ${join(cli, 'bin', 'drover.mjs')} codex ${args.join(' ')}`);
        return 0;
    }

    // The four the shell exported before handing over. The runner reads them
    // out of the environment, so they are set here rather than passed: it is
    // the same process now, and an argument would be a second spelling of a
    // thing etc/drover.env already answers.
    const { stateDir, droverUrl } = droverEnv(env, io.home);
    env.DROVER_URL = droverUrl;
    env.DROVER_DIR = droverDir;
    env.STATE_DIR = stateDir;
    env.DROVER_ORIGIN = env.DROVER_ORIGIN || 'terminal';

    return io.launch(args);
}
