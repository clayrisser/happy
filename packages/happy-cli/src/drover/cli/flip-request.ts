/**
 * The script behind the injected /flip slash command (BASED-98), ported from
 * libexec/drover-flip-request (DROVE-315 wave 2b).
 *
 * It runs INSIDE the claude child that is about to be stopped, so it must post
 * the request and return — the wrapper does the flip (stop this child, carry
 * the transcript, relaunch with --resume under the new CLAUDE_CONFIG_DIR),
 * never this process. The child dying mid-turn right after this prints is the
 * flip working, not a crash.
 *
 * Idempotency on resume is structural, not tracked: the bus stores flip frames
 * nowhere (server.js broadcasts them and forgets — only pending EVENTS replay
 * on /v1/stream connect), and `claude --resume` restores conversation text
 * without re-running commands. So the /flip exchange sitting in the resumed
 * transcript is inert history; nothing can replay it.
 *
 * EVERY PATH EXITS 0. This output is rendered INTO the slash command's prompt,
 * and a message the user can read beats a tool error the TUI half-swallows.
 */

import { existsSync, readFileSync } from 'node:fs';

import { busPost } from './bus';
import { droverEnv } from './env';
import { registryPath } from '../flip/accounts';

export async function run(argv: string[]): Promise<number> {
    const say = (text: string) => process.stdout.write(text + '\n');
    const env = droverEnv();
    const account = argv[0] ?? '';

    // Not under a drover wrapper: say exactly that, loudly, instead of posting a
    // request nothing is listening for. The stamp is set by the wrapper on every
    // child it spawns, so a plain `claude` started outside the drover never has
    // it. `drover account <name>` DOES have it — that verb goes through the
    // wrapper now.
    const wrapper = process.env.DROVER_WRAPPER_PID;
    if (!wrapper || !alive(wrapper)) {
        say(`Cattle Drover: this session is not drover-managed, so /flip cannot move it.
Only the wrapper can flip a session (it has to stop claude and resume it on
another account). Start it with \`drover\`, or \`drover account <name>\` to
pick the account — both are managed. A plain \`claude\` is not, and neither is
\`drover account <name> --\`, which is the deliberate escape hatch.`);
        return 0;
    }

    // One account is nowhere to flip to — a better answer than a request the
    // controller will refuse. Counted by PARSING the registry, never by counting
    // lines: `[{"name":"a"},{"name":"b"}]` is two accounts on one line, and the
    // sed this replaced said one, which is why a valid flip was once refused
    // with "only 1 account". An unparseable registry is left to the controller
    // rather than guessed at, because a wrong count here refuses a flip that
    // would have worked.
    const registry = registryPath();
    if (existsSync(registry)) {
        let count: number | null = null;
        try {
            const raw = JSON.parse(readFileSync(registry, 'utf8'));
            count = Array.isArray(raw) ? raw.length : 0;
        } catch { count = null; }
        if (count !== null && count < 2) {
            say(`Cattle Drover: only ${count} account in ${registry} — add another to flip:
  drover account add <name>`);
            return 0;
        }
    }

    // Address THIS session, most precise handle first. The wrapper's controller
    // matches claude session id, then tmux pane, then cwd; cwd is last because
    // it would flip every session in the directory.
    const body: Record<string, unknown> = process.env.CLAUDE_CODE_SESSION_ID
        ? { sessionId: process.env.CLAUDE_CODE_SESSION_ID }
        : process.env.TMUX_PANE
            ? { pane: process.env.TMUX_PANE }
            : { cwd: process.cwd() };
    if (account) body.account = account;
    body.by = 'terminal';
    body.reason = 'typed /flip in the session';

    let res;
    try {
        res = await busPost('/v1/flip', body, 3);
    } catch {
        say(`Cattle Drover: the bus is not reachable at ${env.droverUrl}, so the flip request
could not be posted. Start the stack with: make -C ${env.droverDir} launchd
(or one-off: drover bus).`);
        return 0;
    }
    if (res.body.includes('"error"')) {
        say(`Cattle Drover: the bus refused the flip request: ${res.body}`);
        return 0;
    }
    say(`Cattle Drover: flip requested (-> ${account || 'next account with headroom'}). The wrapper will stop this claude and resume the conversation on the other account in a moment.`);
    return 0;
}

/** `kill -0` — is that pid still there? Signal 0 tests, it does not signal. */
function alive(pid: string): boolean {
    const n = Number(pid);
    if (!Number.isInteger(n) || n <= 0) return false;
    try {
        process.kill(n, 0);
        return true;
    } catch {
        return false;
    }
}
