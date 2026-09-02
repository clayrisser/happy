/**
 * WHERE AM I, tmux-wise? — the node twin of cattle-drover/lib/drover-tmux-entry.sh
 * (DROVE-308, ported under DROVE-315).
 *
 * Two questions only, and both are answered without running tmux at all:
 *
 *   droverTmuxSocket   which server is the USER'S
 *   droverTmuxState    are we already in it, somewhere else, or nowhere
 *
 * It is deliberately tiny and subprocess-free, because every session start asks
 * it and the overwhelmingly common answer is "you are already inside, carry on".
 * The moment that answer costs a fork the whole entry path becomes a tax on the
 * case that needed nothing. Opening a window is the expensive half and it lives
 * in ./tmuxEnter, which is the only thing here that creates a tmux window for a
 * session — one implementation, one set of rules about not disturbing a curated
 * setup.
 *
 * WHY THE SOCKET IS THE WHOLE QUESTION. `[ -n "$TMUX" ]` was the test in four
 * places (bin/drover, drover-cursor, drover-codex, drover-opencode) and it is
 * wrong in a way that only shows up on this machine: drover's own login flows
 * run a server on `-L drover-login`. Inside one of those panes $TMUX is set, so
 * the old test said "already in tmux, go ahead" and a real session would have
 * been left in a throwaway server that the login flow kills when it is done.
 * $TMUX names the socket it belongs to; reading it is the difference.
 *
 * $TMUX is `<socket-path>,<server-pid>,<session-id>` and tmux itself wrote it,
 * so the first field is authoritative. We compare BASENAMES rather than paths:
 * the socket directory is TMUX_TMPDIR-dependent and macOS resolves /tmp to
 * /private/tmp behind your back, so two spellings of the same socket compare
 * unequal as strings. The basename is the socket NAME, which is what -L takes.
 */

export type Env = Record<string, string | undefined>;

/** The four states $TMUX can put this process in. */
export type TmuxState = 'outside' | 'inside' | 'nested' | 'login';

/** Raised instead of the shell's `return 1` out of drover_tmux_socket. */
export class TmuxSocketError extends Error {}

/**
 * The socket NAME the user's server lives on. `default` is tmux's own default,
 * so a bare `tmux` and `tmux -L default` are the same server — which is what
 * lets everything below pass -L explicitly and behave identically inside and
 * outside a session. (Inside one, a bare `tmux` follows $TMUX to the server it
 * is in, so without an explicit -L the probes would answer about the wrong
 * server exactly when the answer matters.)
 *
 * DROVER_TMUX_SOCKET moves it, for a user who runs their server elsewhere and
 * for the tests, which point every tmux call at a throwaway socket under their
 * own TMUX_TMPDIR. It may never name a login socket: that would hand sessions
 * to the server the login flow is about to kill.
 */
export function droverTmuxSocket(env: Env = process.env): string {
    const socket = env.DROVER_TMUX_SOCKET || 'default';
    if (socket.startsWith('drover-login')) {
        throw new TmuxSocketError(
            `drover: DROVER_TMUX_SOCKET may not name drover's own login server (${socket}).`,
        );
    }
    return socket;
}

/**
 * One of:
 *   outside      no $TMUX. Nowhere yet.
 *   inside       $TMUX names the socket we would target. Run right here.
 *   nested       $TMUX names a DIFFERENT server the user chose themselves.
 *                Still a real pane, so still run here — but it is not the
 *                server anything else in drover addresses, and callers say so
 *                rather than quietly assuming the two are one.
 *   login        $TMUX names drover's own -L drover-login server. Not a home
 *                for a session; treated exactly like `outside`.
 *
 * Nothing here runs tmux, forks, or reads a file — it is string work on a
 * variable tmux itself wrote.
 */
export function droverTmuxState(env: Env = process.env): TmuxState {
    const tmux = env.TMUX;
    if (!tmux) return 'outside';
    const path = tmux.split(',')[0];
    const name = path.slice(path.lastIndexOf('/') + 1);
    if (name.startsWith('drover-login')) return 'login';
    return name === (env.DROVER_TMUX_SOCKET || 'default') ? 'inside' : 'nested';
}

/**
 * Does this state already give the session a pane to live in? `inside` and
 * `nested` both do; `outside` and `login` do not. Every launcher asks exactly
 * this and nothing else, so the mapping is written once here rather than as
 * five conditionals that can disagree.
 */
export function droverTmuxHavePane(env: Env = process.env): boolean {
    const state = droverTmuxState(env);
    return state === 'inside' || state === 'nested';
}

/**
 * Single-quote a string for a shell command line. The classic form: end the
 * quote, emit an escaped quote, reopen. Everything else inside single quotes is
 * literal, so this is total.
 */
export function shQuote(value: string): string {
    return `'${value.split('\'').join('\'\\\'\'')}'`;
}

/**
 * The ORIGINAL argv, quoted, for a caller that has to hand itself back to the
 * window opener AFTER it has parsed its own options.
 *
 * This exists because of a real bug and not for symmetry. Four of the five
 * harnesses consume their flags before they know whether they need a pane, and
 * the pane check must stay AFTER their preflight — a missing cursor-agent has
 * to be reported in the terminal you typed in, not in a window that opens,
 * prints it and closes half a second later. So by the time the re-entry happens
 * the remaining argv is what is LEFT, and `drover cursor --resume abc` outside
 * tmux would have opened a window running a plain `drover cursor`. Silently
 * dropping the flags somebody typed is worse than either error.
 *
 * The shell's drover_quote_args leaves a LEADING space on a non-empty list,
 * because it is spliced straight into an `eval` line. That is preserved: the
 * dry-run lines the bats pin are byte-identical only if it is.
 */
export function droverQuoteArgs(args: readonly string[]): string {
    let out = '';
    for (const arg of args) out += ` ${shQuote(arg)}`;
    return out;
}
