/**
 * The WATCHABLE window, in node — the twin of cattle-drover/lib/drover-window.sh
 * and lib/drover-login-session.sh (DROVE-348/DROVE-365, ported under DROVE-315).
 *
 * One rule, and Clay stated it in one sentence:
 *
 *   "Do you remember how you opened up a tmux window to get EAS logged in and I
 *    could watch it build? Shouldn't you be doing that whenever you're trying to
 *    log into or add a Claude account, or add a Cursor agent, or basically
 *    anything like that, where I could see a new tmux window and actually watch
 *    it do it."
 *
 * WHAT THIS REVERSES. DROVE-212 put the account login in a tmux session and then
 * deliberately hid it on a private socket, `-L drover-login`, and said why:
 * "Clay has a screen full of sessions and a login pane sitting among his
 * projects would be its own bug." That reasoning is sound and it has been
 * overruled. Invisible is the property he does not want — he cannot watch a
 * login he cannot see, and when one fails there is nothing left on screen to
 * read.
 *
 * Everything the private socket bought is kept, and none of it needed the
 * socket:
 *
 *   the pane holds the output          capture-pane reads it either way
 *   the NAME is the lock               a window name is as unique as a session name
 *   killing takes the process group    kill-window does, wherever the window is
 *
 * THE PANE IS LEFT OPEN, and that is the other half of the ask. `remain-on-exit`
 * turns an exited pane into a DEAD pane rather than a closed one: the scrollback
 * survives, `capture-pane -S -` reads it back, and `#{pane_dead_status}` carries
 * the exit code. So "watch it" and "see what happened afterwards" are one
 * mechanism, and a driver still has a crisp liveness answer — `#{pane_dead}` —
 * where before it had "does the pane still exist".
 *
 * IT IS SET FROM INSIDE THE PANE, before the command execs, and that is not a
 * style choice. `remain-on-exit` is a window option, so setting it from outside
 * means new-window then set-option — two calls, with a command running in
 * between. A command that exits inside that gap takes its window with it and the
 * outcome is gone, which is the one failure this file exists to prevent.
 *
 * WHY IT IS HERE AND NOT IN ./tmuxEnter. They are two different questions and
 * the shell kept them in two files for the same reason. ./tmuxEnter is where a
 * SESSION gets a pane: it may attach, it honours base-index and
 * automatic-rename, and it never names a window unless asked. This is where a
 * FLOW gets a window you watch: always detached, always named, always
 * remain-on-exit, stamped so nothing here can ever kill one of Clay's, and
 * reused rather than stacked. What they do share is shared for real —
 * `droverTmuxSocket` and `chooseSession` are imported, not copied, so "which
 * server" and "the user's most recent session" have one definition between them.
 *
 * WHAT NODE CHANGES, AND WHAT IT DOES NOT.
 *
 *   - The environment is an ARRAY of `-e NAME=value` words rather than an
 *     already-quoted `eval` fragment. POSIX sh has no arrays, which is the only
 *     reason drover_window_env_add quoted anything; tmux receives the identical
 *     argv either way.
 *   - `droverWindowSlug` walks BYTES, not code points, because `tr -c` does. A
 *     name carrying a multi-byte character therefore yields the same number of
 *     dashes here as it does in the shell.
 *   - `droverTmuxSocket` THROWS on a login socket where the shell printed to
 *     stderr and let `-L ""` through. A window opened on the empty socket name
 *     is not a window anybody can watch, so the refusal is total here.
 *   - Ties in the session sort: the shell's `sort` falls back to comparing the
 *     whole line, JS's sort is stable and keeps tmux's order. Inherited from
 *     ./tmuxEnter's chooseSession, which is where that choice was made.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

import { chooseSession } from './tmuxEnter';
import { droverTmuxSocket, type Env } from './tmuxEntry';

export interface TmuxResult {
    status: number | null;
    stdout: string;
    stderr: string;
}

/**
 * Every tmux shell-out this file makes, behind one object.
 *
 * Injected rather than reached for, so a test can drive every branch without a
 * tmux server — and so a double that was handed an unmodelled call can THROW
 * instead of quietly measuring Clay's own windows.
 */
export interface WindowIo {
    env: Env;
    /**
     * `input` is stdin for the one call that needs it: `load-buffer -` takes the
     * OAuth code on a pipe rather than as an argument, so the code never appears
     * in an argv anything can list.
     */
    tmux: (bin: string, args: string[], input?: string) => TmuxResult;
    which: (name: string) => string | null;
    err: (line: string) => void;
}

/** The real process, the real tmux. Never used by a test. */
export function defaultWindowIo(): WindowIo {
    return {
        env: process.env,
        tmux: (bin, args, input) => {
            const r = spawnSync(bin, args, { encoding: 'utf8', input });
            return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
        },
        which: (name) => {
            for (const dir of (process.env.PATH ?? '').split(delimiter)) {
                if (!dir) continue;
                const candidate = join(dir, name);
                if (existsSync(candidate)) return candidate;
            }
            return null;
        },
        err: (line) => process.stderr.write(`${line}\n`),
    };
}

/**
 * drover_window_slug — tmux forbids `.` and `:` in a name, so everything
 * outside [A-Za-z0-9_-] becomes a dash: clayrisser@gmail.com is
 * clayrisser-gmail-com.
 *
 * ONE DASH PER CHARACTER, and the shell's `tr -c` is only that in a UTF-8
 * locale. Measured on this Mac: `printf 'café' | tr -c 'A-Za-z0-9_-' '-'` gives
 * `caf-` under en_US.UTF-8 and `caf--` under LC_ALL=C, because BSD tr walks
 * characters when LC_CTYPE says it can and bytes when it cannot. This follows
 * the first, because that is the locale every interactive shell and every login
 * anybody has typed a name into actually runs under.
 *
 * The divergence that leaves is a non-ASCII account name logged in from a
 * launchd job with no locale, which would slug one dash short of the shell's.
 * It is written down rather than defended: every name in the registry today is
 * an address or an `account-N`, and a login window's name is not a key anything
 * stores.
 */
export function droverWindowSlug(value: string): string {
    let out = '';
    for (const ch of value) out += /^[A-Za-z0-9_-]$/.test(ch) ? ch : '-';
    return out;
}

/**
 * lib/drover-login-session.sh login_window_name — the window name for a harness
 * and an account spelling, which is ALSO the lock.
 *
 * THE HARNESS IS IN THE NAME, where the old session name left it out. On a
 * private socket holding nothing else `login-alt` was unambiguous; in a session
 * beside a day's work it is not, and Clay reads these names in a window list
 * rather than in `tmux -L drover-login ls`. `login-claude-account-3` says what
 * it is at a glance, which is the whole point of the ticket.
 *
 * A nameless add is `login-<harness>-new` and that is a PLACEHOLDER, not an
 * answer: which ~/.claude-accounts/account-N it lands on is decided inside the
 * login, and the window is renamed once it knows. It still holds the lock in the
 * meantime, because two nameless adds both want it and tmux refuses the second.
 */
export function loginWindowName(harness: string, spelling: string): string {
    return `login-${harness}-${droverWindowSlug(spelling)}`;
}

/**
 * The variables that travel into a LOGIN window explicitly, in the shell's
 * order (libexec/drover-account-login and libexec/drover-cursor-login, which
 * carry the identical list).
 *
 * A pane gets the tmux SERVER's environment, and on the user's own server that
 * is whichever terminal started it days ago. PATH is carried by the bootstrap
 * itself, under its own name, because `-e PATH=` never reaches the pane; these
 * are the variables that decide which bus, which registry and which home.
 */
export const loginWindowBootVars = [
    'HOME', 'DROVER_URL', 'DROVER_DIR', 'DROVER_BIN', 'DROVER_ACCOUNTS',
    'STATE_DIR', 'DROVER_SHARED_STORE', 'DROVER_TMUX_SOCKET', 'DROVER_TMUX_BIN',
] as const;

/**
 * drover_window_sessions_fmt — the one format string both this and ./tmuxEnter
 * list sessions with.
 */
export const windowSessionsFormat =
    '#{?session_last_attached,#{session_last_attached},0} #{?session_activity,#{session_activity},0} #{session_attached} #{session_name}';

/**
 * drover_window_pick — the user's most recent session out of that listing.
 * chooseSession is ./tmuxEnter's, imported rather than copied, so there is one
 * definition of "the session a window belongs in" and not two that can drift.
 */
export function droverWindowPick(listing: string): string {
    return chooseSession(listing).name;
}

/**
 * The bootstrap: remain-on-exit, then PATH, then the command. `$0` is a label,
 * `$1` is the tmux binary by ABSOLUTE path — the pane inherits the tmux SERVER's
 * PATH, which is whoever started it, and a window whose outcome survives or not
 * depending on that would be its own bug.
 *
 * PATH TRAVELS UNDER ITS OWN NAME, and this is DROVE-212's finding measured
 * again for `new-window` (2026-09-02, tmux 3.7c): `-e PATH=…` reaches
 * `show-environment` and NEVER reaches the pane, which keeps the server's. Any
 * other variable is delivered normally, so PATH rides as DROVER_WINDOW_PATH and
 * is applied here.
 *
 * Byte for byte the shell's string, because it is the same `sh -c` argument in
 * both: a paraphrase would be a different program running in the pane.
 */
export const droverWindowBoot =
    'tb=$1; shift; "$tb" set-option -w -t "$TMUX_PANE" remain-on-exit on 2>/dev/null || :; '
    + '[ -z "${DROVER_WINDOW_PATH:-}" ] || { PATH=$DROVER_WINDOW_PATH; export PATH; }; '
    + 'unset DROVER_WINDOW_PATH; exec "$@"';

/** What `open` and `add` answer with: 0 opened, 1 could not, 2 still running. */
export interface WindowOpened {
    status: 0 | 1 | 2;
    pane: string;
}

/**
 * The named window on the user's own server, and everything done to one.
 *
 * The session is resolved ONCE and remembered, exactly as the shell's
 * `drover_window_session_name` is: every target in a run names the same session,
 * even if the user attaches to another one halfway through.
 */
export class DroverWindow {
    private sessionName = '';

    /** `-e NAME=value` words, accumulated by the caller before it opens. */
    private envOpts: string[] = [];

    constructor(readonly io: WindowIo = defaultWindowIo()) {}

    /** drover_window_bin. DROVER_TMUX_BIN is drover-tmux-enter's variable. */
    bin(): string {
        return this.io.env.DROVER_TMUX_BIN || 'tmux';
    }

    /**
     * drover_window_tmux — every call carries -L explicitly, for
     * drover-tmux-enter's reason: inside a pane a bare `tmux` follows $TMUX to
     * the server it is in, which is the wrong server exactly when we are
     * somewhere else.
     */
    tmux(args: string[], input?: string): TmuxResult {
        return this.io.tmux(this.bin(), ['-L', droverTmuxSocket(this.io.env), ...args], input);
    }

    /**
     * drover_window_session — the session to open windows in.
     *
     * With a server running it is the most recently attached one. With NO server
     * it is a fresh detached one, made the way drover-tmux-enter makes it —
     * `new-session -d` with no `-s`, so the user gets the session they would
     * have had if they had typed `tmux` themselves — and sized 200x50 because a
     * server with no client gives a pane 80 columns and a login URL is 300-odd
     * characters.
     *
     * ONE list-sessions answers both "is there a server" and "which sessions":
     * a server with no sessions does not exist, because tmux stops when its last
     * one goes.
     */
    session(): string | null {
        if (this.sessionName !== '') return this.sessionName;
        const listed = this.tmux(['list-sessions', '-F', windowSessionsFormat]);
        const list = listed.status === 0 ? listed.stdout.replace(/\n+$/, '') : '';
        if (list !== '') {
            this.sessionName = droverWindowPick(list);
        } else {
            const made = this.tmux(['new-session', '-d', '-x', '200', '-y', '50', '-P', '-F', '#{session_name}']);
            this.sessionName = made.status === 0 ? made.stdout.replace(/\n+$/, '') : '';
        }
        return this.sessionName === '' ? null : this.sessionName;
    }

    /**
     * `<session>:<window>` — what a human types to switch to it, and what a card
     * says. `=` is NOT used here even though it is the exact-match prefix tmux
     * offers, because this string is also read by people.
     */
    target(name: string): string | null {
        const session = this.session();
        return session === null ? null : `${session}:${name}`;
    }

    /** The sentence a card carries. One fragment, no paragraph (DROVE-346). */
    watch(name: string): string | null {
        const target = this.target(name);
        return target === null ? null : `Watch it in tmux: ${target}`;
    }

    envReset(): void {
        this.envOpts = [];
    }

    envAdd(name: string, value: string): void {
        this.envOpts.push('-e', `${name}=${value}`);
    }

    /**
     * THE COMMAND HAS TO BE A COMMAND, and this is checked here rather than
     * discovered in the pane (DROVE-365).
     *
     * Everything after `--` becomes the argv the bootstrap hands to `exec`, so a
     * first word that is empty, or shaped like an option, is not a program. It
     * is a caller still assembling the argv some OLDER tmux call wanted, with
     * that call's flags still on the front. What the pane does with it is
     * useless: bash answers `exec -n …` with
     *
     *     exec: usage: exec [-cl] [-a name] file [redirection ...]
     *
     * and exits 2, and a driver reading `#{pane_dead_status}` puts that sentence
     * on Clay's phone. It names no file, no variable and no caller, and the only
     * way back to the cause is `#{pane_start_command}` — which nobody thinks to
     * look at, because the message reads like the login failed rather than like
     * it never ran. That is exactly how the Cursor login was lost for a night.
     */
    argvOk(command: readonly string[]): boolean {
        const first = command[0] ?? '';
        if (first === '') {
            this.io.err('drover-window: nothing to run — the command after -- is empty');
            return false;
        }
        if (first.startsWith('-')) {
            this.io.err(
                `drover-window: '${first}' is not a program to run: the command after -- begins with `
                + 'an option, so flags meant for tmux have leaked into the pane\'s argv',
            );
            return false;
        }
        return true;
    }

    /**
     * drover_window_open — the window, detached and named, and the new pane's
     * id.
     *
     * An existing window of the same name is REUSED rather than stacked (Clay: a
     * second start must not leave two): a window still running something is
     * refused with 2, and a window whose pane is dead is respawned in place,
     * which keeps the name stable and the scrollback replaced rather than
     * duplicated.
     *
     * `-d` always. This never steals the view of whoever is attached — the
     * window appears in the list and the human switches to it when they want to.
     */
    open(name: string, cwd: string, command: readonly string[]): WindowOpened {
        if (!this.argvOk(command)) return { status: 1, pane: '' };
        const bin = this.io.which(this.bin()) ?? this.bin();
        this.envAdd('DROVER_WINDOW_PATH', this.io.env.PATH ?? '');
        const target = this.target(name);
        if (target === null) return { status: 1, pane: '' };
        const boot = ['sh', '-c', droverWindowBoot, 'drover-window', bin, ...command];
        if (this.exists(name)) {
            if (!this.idle(name)) return { status: 2, pane: '' };
            const again = this.tmux(['respawn-pane', '-k', '-t', target, '-c', cwd, ...this.envOpts, '--', ...boot]);
            if (again.status !== 0) return { status: 1, pane: '' };
            this.stamp(name);
            return { status: 0, pane: this.pane(name) ?? '' };
        }
        // `-t "<session>:"` — the session with NO window index, which is how
        // tmux is asked for the next free one. A `session:name` target on
        // new-window means an existing window and answers "can't find window".
        const at = `${this.session() ?? ''}:`;
        const made = this.tmux(['new-window', '-d', '-t', at, '-n', name, '-c', cwd,
            '-P', '-F', '#{pane_id}', ...this.envOpts, '--', ...boot]);
        if (made.status !== 0) return { status: 1, pane: '' };
        const pane = made.stdout.replace(/\n+$/, '');
        if (pane === '') return { status: 1, pane: '' };
        this.stamp(name);
        return { status: 0, pane };
    }

    /**
     * drover_window_add — a second pane in the SAME window.
     *
     * For a flow with two halves worth watching side by side: the wrapper
     * narrating, and the thing it is driving. remain-on-exit is a WINDOW option,
     * so the pane this makes inherits it and both halves survive their own
     * exits.
     */
    add(into: string, command: readonly string[]): string | null {
        if (!this.argvOk(command)) return null;
        const bin = this.io.which(this.bin()) ?? this.bin();
        this.envAdd('DROVER_WINDOW_PATH', this.io.env.PATH ?? '');
        const made = this.tmux(['split-window', '-d', '-t', into, '-P', '-F', '#{pane_id}',
            ...this.envOpts, '--', 'sh', '-c', droverWindowBoot, 'drover-window', bin, ...command]);
        if (made.status !== 0) return null;
        const pane = made.stdout.replace(/\n+$/, '');
        return pane === '' ? null : pane;
    }

    /**
     * OURS, stamped at creation. Nothing here ever kills a window without this:
     * the windows are on the user's OWN server now, beside real work, and a name
     * collision must cost a refusal rather than one of Clay's panes.
     */
    stamp(name: string): void {
        const target = this.target(name);
        if (target === null) return;
        this.tmux(['set-option', '-w', '-t', target, '@drover-window', name]);
    }

    owned(name: string): boolean {
        const target = this.target(name);
        if (target === null) return false;
        const shown = this.tmux(['show-options', '-w', '-t', target, '-qv', '@drover-window']);
        return shown.stdout.replace(/\n+$/, '') === name;
    }

    exists(name: string): boolean {
        const session = this.session();
        if (session === null) return false;
        const listed = this.tmux(['list-windows', '-t', session, '-F', '#{window_name}']);
        if (listed.status !== 0) return false;
        return listed.stdout.split('\n').some((line) => line === name);
    }

    /** The first pane in the window, which is the one a driver talks to. */
    pane(name: string): string | null {
        const target = this.target(name);
        if (target === null) return null;
        const listed = this.tmux(['list-panes', '-t', target, '-F', '#{pane_id}']);
        if (listed.status !== 0) return null;
        const first = listed.stdout.split('\n')[0] ?? '';
        return first === '' ? null : first;
    }

    /**
     * Is this pane still RUNNING something? With remain-on-exit a pane that has
     * finished still exists, so "the pane is there" stopped being the liveness
     * question and `#{pane_dead}` became it. A pane that has gone entirely
     * answers nothing, which is also not alive.
     */
    paneLive(pane: string): boolean {
        const shown = this.tmux(['display-message', '-p', '-t', pane, '#{pane_dead}']);
        return shown.stdout.replace(/\n+$/, '') === '0';
    }

    /** Is this window free to be reused — no pane in it still running? */
    idle(name: string): boolean {
        const target = this.target(name);
        if (target === null) return false;
        const listed = this.tmux(['list-panes', '-t', target, '-F', '#{pane_dead}']);
        if (listed.status !== 0) return true;
        return !listed.stdout.split('\n').some((line) => line === '0');
    }

    /** Kill one, and ONLY one of ours. A window nothing stamped is the user's. */
    kill(name: string): boolean {
        if (!this.owned(name)) return false;
        const target = this.target(name);
        if (target === null) return false;
        return this.tmux(['kill-window', '-t', target]).status === 0;
    }

    /** What is on that pane's screen right now, joined the way -J joins it. */
    capture(pane: string): string {
        const shown = this.tmux(['capture-pane', '-p', '-J', '-t', pane]);
        return shown.status === 0 ? shown.stdout : '';
    }
}

/**
 * lib/drover-login-session.sh login_window_kill — end any login waiting under
 * these window names, and say whether there was one.
 *
 * `kill-window` takes the pane's whole process group — the harness login AND, on
 * the phone path, the wrapper that is driving it — so the login's own traps run
 * and undo whatever it had made.
 *
 * DroverWindow.kill refuses a window drover did not open. That guard did not
 * exist while these lived on their own socket, where every window on it was ours
 * by construction; on the user's server it is the difference between reaping a
 * login and closing whatever Clay happened to name the same thing.
 */
export function loginWindowKill(window: DroverWindow, names: readonly string[]): boolean {
    let hit = false;
    for (const name of names) {
        if (name === '') continue;
        if (!window.exists(name)) continue;
        if (!window.kill(name)) continue;
        hit = true;
    }
    return hit;
}
