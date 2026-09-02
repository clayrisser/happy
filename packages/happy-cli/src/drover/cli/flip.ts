/**
 * `drover flip` — ask a running session to move onto another Claude account and
 * carry on. Ported from libexec/drover-flip (DROVE-315 wave 2b).
 *
 * Bound to a tmux key it is the fastest surface there is; the same POST is what
 * the watch and the phone reach through the bridge. The bus only broadcasts —
 * the flip controller inside each drover session decides whether the frame is
 * addressed to it, which account has headroom, and what to say on arrival.
 *
 * IT DOES NOT COME THROUGH flip-policy, and must not (DROVE-333). This is the
 * escape hatch: a straight POST that the fork's controller takes on its
 * `wanted` branch, skipping the ledger and the back-door rule alike. Routing it
 * through the policy would make `drover flip main` refusable by the very rule
 * that exists to keep it working.
 */

import { busGet, busPost, BusError } from './bus';
import { droverEnv } from './env';

const usage = `drover flip — move a live session onto another Claude subscription, carrying
the transcript. The session id the phone is watching does not change.

USAGE
  drover flip                     This tmux pane, next account with headroom
  drover flip <account>           This tmux pane, that account (overrides the
                                  cooldown ledger — an explicit flip wins, but
                                  it warns first if that account is out)
  drover flip --session <id> [account]
  drover flip --cwd [dir] [account]
  drover flip --all [account]
  drover flip --prompt "..."      What the resumed session is told on arrival

Prompt resolution: this --prompt > the account's flipPrompt in accounts.json >
DROVER_FLIP_PROMPT or flip-prompt.txt > the built-in default. Template vars:
{from} {to} {account} {reason} {cwd} {project} {session}.

A flip also happens on its own when Claude reports a usage limit: the account
is recorded as cooling and the next one with headroom is chosen. With every
account cooling the session PARKS until the soonest reset.

Headroom, not position. An account is skipped when the cooldown ledger says it
is cooling OR when Claude Code's own usage cache has it at 100% with the reset
still ahead — that second one is what stops a flip landing on an account
emptied outside any drover session. Registry order only breaks the tie.

Naming an account overrides all of that, and still does. What it no longer
does is move first and find out afterwards: if the account you name has no
headroom for the model the session is running, the flip is HELD and the
session says so on the tmux status bar and on the phone — which model is out,
when it comes back, and whether another model still runs there, since /model
is usually the quicker fix. Ask again within thirty seconds and it moves
anyway. Nothing is stopped while it waits, so a warning costs no relaunch.

Measured 2026-08-30 (DROVE-64): two flips onto an account at Fable weekly 100%
each bounced off the limit in about 3.5 seconds and auto-flipped straight
back — four relaunches to end up where the session started.

Claude Code only. Accounts do not cross harnesses, and drover holds no login
for OpenCode or Cursor, so a flip named at one of those sessions — or pressed
inside one of their panes — is REFUSED rather than broadcast to nobody.

See also: drover accounts (who is cooling, until when)`;

type TargetKey = 'sessionId' | 'cwd' | 'all' | 'pane';

export async function run(argv: string[]): Promise<number> {
    const say = (line: string) => process.stdout.write(line + '\n');
    const warn = (line: string) => process.stderr.write(line + '\n');

    let account = '';
    let prompt = '';
    let target: TargetKey | '' = '';
    let targetval = '';

    let i = 0;
    while (i < argv.length) {
        const arg = argv[i]!;
        if (arg === '--session') { target = 'sessionId'; targetval = argv[i + 1] ?? ''; i += 2; }
        else if (arg === '--cwd') {
            target = 'cwd';
            const next = argv[i + 1];
            // `drover flip --cwd` with nothing after it, and `--cwd --all`, both
            // mean THIS directory: a value that looks like a flag is not a
            // directory, and the shell's case does exactly this dance.
            if (next === undefined || next === '') { targetval = process.cwd(); i += 1; }
            else if (next.startsWith('-')) { targetval = process.cwd(); i += 1; }
            else { targetval = next; i += 2; }
        }
        else if (arg === '--all') { target = 'all'; targetval = 'true'; i += 1; }
        else if (arg === '--prompt') { prompt = argv[i + 1] ?? ''; i += 2; }
        else if (arg === '-h' || arg === '--help') { say(usage); return 0; }
        else if (arg.startsWith('-')) { warn(`drover flip: unknown option ${arg}`); return 2; }
        else { account = arg; i += 1; }
    }

    if (!target) {
        // No explicit target: this pane. A key binding knows nothing else, and
        // $TMUX_PANE is stamped on every session by the hook adapters.
        const pane = process.env.TMUX_PANE;
        if (!pane) {
            warn('drover flip: not in tmux and no target given — pass --session, --cwd or --all');
            return 2;
        }
        target = 'pane';
        targetval = pane;
    }

    const body: Record<string, unknown> = target === 'all' ? { all: true } : { [target]: targetval };
    if (account) body.account = account;
    if (prompt) body.prompt = prompt;
    body.by = process.env.DROVER_FLIP_BY || 'cli';
    body.reason = 'manual';

    const url = droverEnv().droverUrl;
    let res;
    try {
        res = await busPost('/v1/flip', body, 5);
    } catch (err) {
        void (err as BusError);
        warn(`drover flip: bus unreachable at ${url}`);
        return 1;
    }
    if (res.body.includes('"error"')) {
        warn(`drover flip: ${res.body}`);
        return 1;
    }
    say(`flip requested (${account || 'next account with headroom'})`);

    // The bus only broadcasts — a frame nobody matches vanishes silently, and
    // from the outside that is indistinguishable from a flip that worked. So
    // check the registry for a session matching the target and SAY when there
    // is none: the usual cause is a session started with plain `claude` (or
    // `drover account <name>`, which execs claude directly), which no wrapper
    // manages.
    if (target !== 'all') {
        let matches = -1;
        try {
            const list = await busGet('/v1/sessions?limit=100', 3);
            const parsed = JSON.parse(list.body) as { sessions?: Array<Record<string, unknown>> };
            const rows = Array.isArray(parsed.sessions) ? parsed.sessions : [];
            matches = rows.filter((s) => s.state !== 'ended' && (
                (target === 'pane' && s.pane === targetval) ||
                (target === 'cwd' && s.cwd === targetval) ||
                (target === 'sessionId' && s.id === targetval)
            )).length;
        } catch { /* unreadable is not "no session": say nothing rather than guess */ }
        if (matches === 0) {
            warn('drover flip: note — the bus lists no live session for this target.');
            warn('If that session was started with plain `claude` or `drover account <name>`,');
            warn('it is not drover-managed and cannot flip; start it with `drover`');
            warn('(or `drover account <name> drover`).');
        }
    }
    return 0;
}
