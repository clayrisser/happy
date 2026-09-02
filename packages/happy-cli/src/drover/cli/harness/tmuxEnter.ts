/**
 * The ONE place a drover session gets a tmux window (DROVE-308), in node
 * (DROVE-315 wave 3a). The port of cattle-drover/libexec/drover-tmux-enter.
 *
 * Clay, specifying the whole of it:
 *
 *   "if tmux wasn't installed in the first place it would install it. if you
 *    run drover outside tmux and tmux isn't running it will actually run tmux
 *    and run drover inside it. if tmux is already running it will create a new
 *    window in tmux and run drover in it. if you run drover while already in
 *    tmux it of course just runs. in other words this should work for pros with
 *    a complex tmux setup as well as dummies who doesn't know anything. keep in
 *    mind you should also be able to spawn sessions from the mobile app"
 *
 * THE OBSERVATION THIS FILE IS BUILT ON. "server already running" and "spawned
 * from the phone" are the SAME operation — open a window on the user's server
 * and run the command in it — and they differ by exactly one step at the end:
 * one attaches a terminal to it and the other does not. Written as two
 * functions they drift, and the one nobody watches (the phone) is the one that
 * rots. So there is one path here and `--attach` / `--no-attach` is the whole
 * difference. `--no-attach` is not a lesser mode: it is this file with the last
 * step skipped.
 *
 * WHAT A PRO IS OWED, which is most of the code below:
 *
 *   The right SERVER. There can be several, and two of them are drover's own
 *   (`-L drover-login`). ./tmuxEntry answers which one is the user's; nothing
 *   here guesses from "the first server I can find".
 *
 *   The right SESSION. A pro has several open. Putting a window in the wrong
 *   one makes it appear under somebody mid-task in another terminal, which is
 *   the actual "you trashed my setup" complaint. tmux keeps its own notion of
 *   which session you were last in — `session_last_attached` — and that is the
 *   answer used here. When there is more than one to choose between, the choice
 *   is PRINTED. A wrong guess you can see beats a wrong guess you cannot.
 *
 *   Their conventions. `base-index` and `renumber-windows` are honoured by not
 *   having an opinion: the window is created with no index at all, so tmux
 *   applies whatever the user configured. No `-a`, no `-b`, no `-k` — those are
 *   the flags that move existing windows around. And no `-n` unless the caller
 *   asked for a name, because passing one turns `automatic-rename` off for that
 *   window and a pro's naming scheme is usually automatic-rename doing its job.
 *
 *   Nothing else touched. This file never runs kill-server, never renames,
 *   renumbers, moves or swaps an existing window, and never sets a global tmux
 *   option. The vitest greps for every one of those by name, because the day
 *   somebody adds a `set -g` here to make something line up is the day a drover
 *   start starts editing the user's tmux config.
 *
 * NO TTY IS A FIRST-CLASS STATE, not an error. The phone's spawn has no
 * terminal, and neither does a cron run or a test. Attaching is therefore off
 * unless there IS a terminal to attach — `--attach` asked for explicitly with
 * no tty is refused up front rather than left to hang on tmux's own
 * "open terminal failed".
 *
 * WHAT NODE CHANGES, AND WHAT IT DOES NOT. The shell rebuilt argv as one
 * `eval` string because POSIX sh has no arrays; here the words travel as an
 * array and only `--command`, whose caller already holds a built shell string,
 * is split back into words. tmux therefore receives the same argv it always
 * did, which is what `#{pane_start_command}` renders. Where the shell said
 * `exec`, this spawns with stdio inherited and exits with the child's code:
 * node has no execve, and the observable contract — the command runs in THIS
 * pane, owns the terminal, and its status is ours — is unchanged.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

import { droverTmuxSocket, droverTmuxState, shQuote, TmuxSocketError, type Env } from './tmuxEntry';

export const usage = `drover tmux-enter — open a tmux window on the user's own server and run a
command in it. The window is created the same way whether or not a terminal
is attached to it afterwards; --attach is the only difference.

USAGE
  drover tmux-enter [options] [--] <command> [args...]

OPTIONS
  --attach            attach after opening. Refused when there is no tty.
  --no-attach         never attach. The phone's path, and any script's.
                      Default: attach when stdout is a terminal, else not.
  --cwd <dir>         working directory for the window (default: $PWD)
  --name <name>       window name. Omitted by default so the user's
                      automatic-rename setting keeps deciding.
  --session <name>    force the target session instead of picking the most
                      recently attached one.
  -e KEY=VALUE        set a variable in the window's environment (repeatable)
  --no-forward-env    do not carry this process's DROVER_*, HAPPY_* and
                      CLAUDE_CONFIG_DIR into the window. For a caller that
                      builds the window's environment itself.
  --command <string>  the command as ONE already-quoted shell string, for a
                      caller that built it that way. Mutually exclusive with
                      trailing arguments.
  --print <format>    print this tmux FORMAT for the new pane, e.g.
                      '#{pane_pid}'. Implies nothing about attaching.
  -q, --quiet         no informational lines on stderr.

STATE
  Inside the user's server already      runs the command in place, unchanged.
  Inside a DIFFERENT server (nested)    runs in place, and says which socket.
  Inside drover's own login server      not a home for a session: opens a
                                        window on the user's server instead.
  No server running                     starts one, opens the session in it.
  Server running                        one new window in the chosen session.

ENVIRONMENT
  DROVER_TMUX_SOCKET  which socket is the user's server (default: default)
  DROVER_TMUX_BIN     the tmux to use
`;

/**
 * Everything the entry needs that is not argv. Injected so a test can drive
 * every branch without a terminal, a tmux, or a real environment — and so a
 * test that forgot to inject fails loudly rather than reaching Clay's server.
 */
export interface EnterIo {
    env: Env;
    cwd: string;
    /** Is stdout a terminal? stdin too — attaching needs both. */
    isTty: () => boolean;
    out: (line: string) => void;
    err: (line: string) => void;
    /** Run tmux and capture it. */
    tmux: (bin: string, args: string[]) => { status: number | null; stdout: string; stderr: string };
    /** Run something with this process's stdio, and answer with its code. */
    passthrough: (bin: string, args: string[]) => number;
    /** Resolve a binary on PATH, or null. */
    which: (name: string) => string | null;
}

export interface EnterOptions {
    attach: 'auto' | boolean;
    cwd: string | null;
    name: string | null;
    session: string | null;
    print: string | null;
    quiet: boolean;
    forwardEnv: boolean;
    /** -e KEY=VALUE, in the order given. */
    envOpts: string[];
    /** The command, as argv words. */
    command: string[];
    commandGiven: boolean;
}

/** A parse that failed: the lines to print and the code to exit with. */
export interface ParseFailure {
    error: string[];
    code: number;
}

export function isParseFailure(v: EnterOptions | ParseFailure): v is ParseFailure {
    return (v as ParseFailure).error !== undefined;
}

/**
 * Split an already-quoted shell string back into words, for `--command`.
 *
 * The shell spliced that string into an `eval` and let sh do this; node has to
 * do it, because tmux wants argv. Single quotes, double quotes and backslash
 * are honoured — which is everything drover's own callers emit, all of them
 * built by shQuote — and nothing else in sh's grammar is guessed at: a string
 * carrying a `$(...)` is passed through as literal text rather than run.
 */
export function splitShellWords(input: string): string[] {
    const words: string[] = [];
    let word = '';
    let has = false;
    let i = 0;
    while (i < input.length) {
        const c = input[i];
        if (c === ' ' || c === '\t' || c === '\n') {
            if (has) {
                words.push(word);
                word = '';
                has = false;
            }
            i += 1;
            continue;
        }
        has = true;
        if (c === '\'') {
            const end = input.indexOf('\'', i + 1);
            const stop = end === -1 ? input.length : end;
            word += input.slice(i + 1, stop);
            i = stop + 1;
            continue;
        }
        if (c === '"') {
            i += 1;
            while (i < input.length && input[i] !== '"') {
                if (input[i] === '\\' && i + 1 < input.length && '"\\$`'.includes(input[i + 1])) {
                    word += input[i + 1];
                    i += 2;
                    continue;
                }
                word += input[i];
                i += 1;
            }
            i += 1;
            continue;
        }
        if (c === '\\' && i + 1 < input.length) {
            word += input[i + 1];
            i += 2;
            continue;
        }
        word += c;
        i += 1;
    }
    if (has) words.push(word);
    return words;
}

/**
 * The option loop, one for one with the shell's. Unknown options exit 2 the
 * way they always did; `--` ends the options and everything after it is the
 * command.
 */
export function parseEnterArgs(argv: readonly string[]): EnterOptions | ParseFailure {
    const o: EnterOptions = {
        attach: 'auto',
        cwd: null,
        name: null,
        session: null,
        print: null,
        quiet: false,
        forwardEnv: true,
        envOpts: [],
        command: [],
        commandGiven: false,
    };
    let commandString: string | null = null;
    const args = [...argv];
    while (args.length > 0) {
        const a = args[0];
        if (a === '--attach') { o.attach = true; args.shift(); continue; }
        if (a === '--no-attach') { o.attach = false; args.shift(); continue; }
        if (a === '--cwd') { o.cwd = args[1] ?? ''; args.splice(0, 2); continue; }
        if (a.startsWith('--cwd=')) { o.cwd = a.slice('--cwd='.length); args.shift(); continue; }
        if (a === '--name') { o.name = args[1] ?? ''; args.splice(0, 2); continue; }
        if (a.startsWith('--name=')) { o.name = a.slice('--name='.length); args.shift(); continue; }
        if (a === '--session') { o.session = args[1] ?? ''; args.splice(0, 2); continue; }
        if (a.startsWith('--session=')) { o.session = a.slice('--session='.length); args.shift(); continue; }
        if (a === '--print') { o.print = args[1] ?? ''; args.splice(0, 2); continue; }
        if (a.startsWith('--print=')) { o.print = a.slice('--print='.length); args.shift(); continue; }
        if (a === '--command') { commandString = args[1] ?? ''; o.commandGiven = true; args.splice(0, 2); continue; }
        if (a.startsWith('--command=')) { commandString = a.slice('--command='.length); o.commandGiven = true; args.shift(); continue; }
        if (a === '-e') { o.envOpts.push(args[1] ?? ''); args.splice(0, 2); continue; }
        if (a.startsWith('-e') && a.length > 2) { o.envOpts.push(a.slice(2)); args.shift(); continue; }
        if (a === '--no-forward-env') { o.forwardEnv = false; args.shift(); continue; }
        if (a === '-q' || a === '--quiet') { o.quiet = true; args.shift(); continue; }
        if (a === '-h' || a === '--help') return { error: [], code: 0 };
        if (a === '--') { args.shift(); break; }
        if (a.startsWith('-')) {
            return { error: [`drover tmux-enter: unknown option '${a}' (try --help)`], code: 2 };
        }
        break;
    }

    if (o.commandGiven && args.length > 0) {
        return {
            error: [
                'drover tmux-enter: --command and trailing arguments say the same thing',
                '  two different ways. Give one or the other.',
            ],
            code: 2,
        };
    }

    // Trailing argv is the primary spelling. --command is for the one caller
    // that already holds a built shell string (the daemon wraps the pane
    // command in an environment sanitizer before it ever gets here). Both
    // converge on one argv immediately, so there is one command and one
    // window-opening path below.
    o.command = o.commandGiven ? splitShellWords(commandString ?? '') : args;

    if (o.command.length === 0) {
        return { error: ['drover tmux-enter: no command given (try --help)'], code: 2 };
    }
    return o;
}

/** Was --help asked for anywhere in the option run? */
function wantsHelp(argv: readonly string[]): boolean {
    for (const a of argv) {
        if (a === '--') return false;
        if (a === '-h' || a === '--help') return true;
    }
    return false;
}

/**
 * The command as one shell string, for the `inside` and `nested` states where
 * the shell said `eval "exec $cmd"`. Quoted here so a value cannot become
 * syntax, exactly as shquote did.
 */
export function commandLine(command: readonly string[]): string {
    return command.map(shQuote).join(' ');
}

/**
 * Which session a window should land in, from the `tmux list-sessions` block
 * the entry already holds. The shell's `sort -k1,1nr -k3,3nr -k2,2nr | head -1`,
 * on `<last_attached> <activity> <attached> <name...>`.
 *
 * Never-attached sessions report an empty session_last_attached, so the format
 * substitutes 0 for them and they sort last — a session you have never looked
 * at is the worst place to put a window you are about to look at. The name is
 * LAST on the line and read as "the rest", because tmux session names may
 * contain spaces.
 */
export function chooseSession(sessions: string): { name: string; count: number } {
    const lines = sessions.split('\n').filter((l) => l.length > 0);
    const rows = lines.map((line) => {
        const parts = line.split(' ');
        return {
            lastAttached: Number(parts[0]) || 0,
            activity: Number(parts[1]) || 0,
            attached: Number(parts[2]) || 0,
            name: parts.slice(3).join(' '),
        };
    });
    const sorted = [...rows].sort((a, b) =>
        b.lastAttached - a.lastAttached || b.attached - a.attached || b.activity - a.activity);
    return { name: sorted[0]?.name ?? '', count: rows.length };
}

/** Every session name in the listing, for `--session`'s check. */
export function sessionNames(sessions: string): string[] {
    return sessions.split('\n').filter((l) => l.length > 0).map((l) => l.split(' ').slice(3).join(' '));
}

/**
 * The variables that ride into the window, by name and by three prefixes.
 *
 * A tmux window inherits the SERVER's environment, not this process's, so
 * `DROVER_SERVER_MODE=relay drover` would silently lose the thing it was asked
 * to do the moment the session moved into a window. Carried by name and
 * nothing else — this is not a place to copy a whole environment into a
 * long-lived server.
 *
 * The denylist is the entry machinery's own state. DROVER_ALLOW_NO_TMUX would
 * tell the command in the window to skip the pane requirement it just got, and
 * DROVER_TMUX_* / DROVER_CHECKED describe this hop, not the next one.
 */
export function forwardedEnv(env: Env): string[] {
    const out: string[] = [];
    for (const [name, value] of Object.entries(env)) {
        if (value === undefined) continue;
        if (name === 'DROVER_ALLOW_NO_TMUX' || name === 'DROVER_CHECKED' || name === 'DROVER_DRY_RUN') continue;
        if (name.startsWith('DROVER_') || name.startsWith('HAPPY_') || name === 'CLAUDE_CONFIG_DIR') {
            out.push(`${name}=${value}`);
        }
    }
    return out;
}

/** The default io: the real process, the real tmux. */
export function defaultIo(): EnterIo {
    return {
        env: process.env,
        cwd: process.cwd(),
        isTty: () => Boolean(process.stdout.isTTY) && Boolean(process.stdin.isTTY),
        out: (line) => process.stdout.write(`${line}\n`),
        err: (line) => process.stderr.write(`${line}\n`),
        tmux: (bin, args) => {
            const r = spawnSync(bin, args, { encoding: 'utf8' });
            return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
        },
        passthrough: (bin, args) => {
            const r = spawnSync(bin, args, { stdio: 'inherit' });
            return r.status ?? 1;
        },
        which: (name) => {
            const path = process.env.PATH ?? '';
            for (const dir of path.split(delimiter)) {
                if (!dir) continue;
                const candidate = join(dir, name);
                if (existsSync(candidate)) return candidate;
            }
            return null;
        },
    };
}

/**
 * Find a tmux, installing it if the installer is on disk.
 *
 * Installing it is DROVE-307's job and this file must not grow a second answer
 * to it. The seam is a file: if the installer is on disk it is run, and if it
 * is not, this says what to type. Two spellings are accepted because the
 * installer ticket is in flight and may land either shape; neither is an
 * implementation of anything, they are both "hand it to the thing that owns
 * this".
 */
function resolveTmux(io: EnterIo, say: (m: string) => void, libexec: string): string | null {
    let bin = io.env.DROVER_TMUX_BIN || '';
    if (!bin) bin = io.which('tmux') ?? '';
    if (bin) return bin;

    let installed = false;
    const perTool = join(libexec, 'drover-install-tmux');
    const installer = join(libexec, 'drover-install');
    if (existsSync(perTool)) {
        say('tmux is not installed — installing it (DROVE-307)…');
        installed = io.passthrough(perTool, []) === 0;
    } else if (existsSync(installer)) {
        say('tmux is not installed — installing it (DROVE-307)…');
        installed = io.passthrough(installer, ['tmux']) === 0;
    }
    if (installed) bin = io.which('tmux') ?? '';
    return bin || null;
}

export async function runEnter(argv: string[], io: EnterIo = defaultIo(), libexec = ''): Promise<number> {
    if (wantsHelp(argv)) {
        io.out(usage.trimEnd());
        return 0;
    }
    const parsed = parseEnterArgs(argv);
    if (isParseFailure(parsed)) {
        for (const line of parsed.error) io.err(line);
        return parsed.code;
    }
    const o = parsed;
    const say = (m: string) => { if (!o.quiet) io.err(`drover: ${m}`); };

    const tmuxBin = resolveTmux(io, say, libexec);
    if (!tmuxBin) {
        io.err('drover: tmux is not installed, and a drover session lives in a tmux pane');
        io.err('  so the phone can reach it without switching to remote mode (BASED-113).');
        io.err('');
        if (process.platform === 'darwin') io.err('  install it:  brew install tmux');
        else io.err('  install it:  sudo apt install tmux   (or your package manager\'s tmux)');
        io.err('');
        io.err('  headless on purpose:  DROVER_ALLOW_NO_TMUX=1 drover ...');
        return 127;
    }

    let socket: string;
    try {
        socket = droverTmuxSocket(io.env);
    } catch (e) {
        if (e instanceof TmuxSocketError) {
            io.err(e.message);
            return 2;
        }
        throw e;
    }

    // Every tmux call goes through here, with -L always explicit. Inside a
    // session a bare `tmux` follows $TMUX to the server it is in, which is the
    // wrong server precisely when we are in a login pane or a nested one.
    const tm = (args: string[]) => io.tmux(tmuxBin, ['-L', socket, ...args]);

    // --- already have a pane? -----------------------------------------------
    //
    // The cheap answer, and the common one. `nested` runs here too — a pane on
    // a server the user deliberately started is a real pane, and moving them to
    // another server because the socket name differs would be drover overruling
    // a choice they made on purpose. It is NOT silent, though: it is a
    // different state from `inside` and the line says which socket the session
    // actually landed on, because everything else in drover addresses
    // $DROVER_TMUX_SOCKET.
    const state = droverTmuxState(io.env);
    if (state === 'inside' || state === 'nested') {
        if (state === 'nested') {
            const here = (io.env.TMUX ?? '').split(',')[0];
            say(`already in tmux on socket '${here}', which is not '${socket}' — running here.`);
        }
        return io.passthrough(o.command[0], o.command.slice(1));
    }

    // From here on this process is a tmux CLIENT standing outside every server,
    // so $TMUX must not travel with it. This is not tidiness: measured on tmux
    // 3.7c, `tmux -L other new-session -d -P -F ...` run from inside a pane
    // whose $TMUX names a DIFFERENT socket HANGS — no error, no output, no
    // server created. The state that reaches this line with $TMUX set is
    // `login` (a pane in drover's own -L drover-login server), so without this
    // a session started from a login flow would wedge silently.
    delete io.env.TMUX;
    delete io.env.TMUX_PANE;

    // --- attach or not ------------------------------------------------------
    //
    // A terminal is the precondition, not a preference. The phone has none, a
    // cron run has none, a test has none, and in all three "open the window, do
    // not attach" is the right answer rather than an error. Asking for --attach
    // explicitly without one is the only failure, and it fails HERE rather than
    // inside tmux's "open terminal failed: not a terminal".
    let doAttach: boolean;
    if (o.attach === 'auto') {
        doAttach = io.isTty();
    } else if (o.attach === true) {
        if (!io.isTty()) {
            io.err('drover: --attach needs a terminal and this invocation has none.');
            io.err('  The window can still be opened without one: --no-attach');
            return 3;
        }
        doAttach = true;
    } else {
        doAttach = false;
    }

    const cwd = o.cwd || io.cwd;

    const envOpts: string[] = [];
    if (o.forwardEnv) for (const line of forwardedEnv(io.env)) envOpts.push('-e', line);
    for (const line of o.envOpts) envOpts.push('-e', line);

    const nameOpt = o.name ? ['-n', o.name] : [];
    const printOpt = o.print ? ['-P', '-F', o.print] : [];

    // --- no server: start one -----------------------------------------------
    //
    // `new-session` with NO `-s`, which is what bare `tmux` does: the session
    // gets tmux's own default name, and someone who has never used tmux ends up
    // with exactly the session they would have had if they had typed `tmux`
    // themselves. Naming it "drover" would put a name in `tmux ls` that the
    // user did not choose, forever, for no gain.
    //
    // ONE tmux invocation answers both "is there a server" and "which sessions"
    // (DROVE-314). `has-session` first would be a second process to learn
    // something this list already says: tmux exits non-zero when there is no
    // server, and a server with no sessions does not exist because tmux stops
    // when its last one closes.
    const listed = tm(['list-sessions', '-F',
        '#{?session_last_attached,#{session_last_attached},0} #{?session_activity,#{session_activity},0} #{session_attached} #{session_name}']);
    const sessions = listed.status === 0 ? listed.stdout.replace(/\n+$/, '') : '';

    if (!sessions) {
        const created = tm(['new-session', '-d', '-c', cwd, ...nameOpt, ...envOpts,
            '-P', '-F', '#{session_name}', '--', ...o.command]);
        if (created.status !== 0) {
            io.err(`drover: could not start a tmux server on socket '${socket}'.`);
            return 1;
        }
        const session = created.stdout.replace(/\n+$/, '');
        // `=name:` and not `=name` — a bare session target does not resolve to
        // a pane, so `#{pane_pid}` comes back EMPTY from it. Measured on tmux
        // 3.7c: `-t '=0'` prints nothing, `-t '=0:'` prints the pid. The window
        // the session was just created with is its only one, so this is that
        // pane.
        if (o.print) {
            const shown = tm(['display-message', '-p', '-t', `=${session}:`, o.print]);
            io.out(shown.stdout.replace(/\n+$/, ''));
        }
        say(`no tmux server was running — started one and opened this session in '${session}'.`);
        if (doAttach) return io.passthrough(tmuxBin, ['-L', socket, 'attach-session', '-t', `=${session}`]);
        return 0;
    }

    // --- server running: which session --------------------------------------
    let session: string;
    if (o.session) {
        // Checked against the list already in hand rather than with another
        // `has-session` process.
        if (!sessionNames(sessions).includes(o.session)) {
            io.err(`drover: no tmux session named '${o.session}' on socket '${socket}'.`);
            return 1;
        }
        session = o.session;
    } else {
        const chosen = chooseSession(sessions);
        if (!chosen.name) {
            io.err(`drover: could not read the session list on socket '${socket}'.`);
            return 1;
        }
        session = chosen.name;
        // The ambiguous case is the one that has to speak. With one session
        // there is nothing to have got wrong; with several, this line is how
        // you find out a window went somewhere you did not expect.
        if (chosen.count > 1) {
            say(`${chosen.count} tmux sessions on socket '${socket}' — opening in '${session}' (most recently attached).`);
        }
    }

    // --- the window ---------------------------------------------------------
    //
    // `-t "=$session:"` is the session with NO window index, so tmux picks the
    // next free one under the user's own base-index. An index here is what
    // would collide with, overwrite or shove along a window they already had.
    //
    // `-d` when we are not attaching, and that is the whole of the phone's
    // difference. Without it tmux makes the new window CURRENT, which yanks the
    // view of anyone already attached to that session — a session started from
    // the phone should appear in the list, not take over the screen of whoever
    // is working in another window.
    const selectOpt = doAttach ? [] : ['-d'];
    const created = tm(['new-window', '-t', `=${session}:`, '-c', cwd,
        ...nameOpt, ...selectOpt, ...envOpts, ...printOpt, '--', ...o.command]);
    if (created.status !== 0) {
        io.err(`drover: could not open a tmux window in session '${session}'.`);
        return 1;
    }
    if (o.print) io.out(created.stdout.replace(/\n+$/, ''));

    if (doAttach) return io.passthrough(tmuxBin, ['-L', socket, 'attach-session', '-t', `=${session}`]);
    return 0;
}

/**
 * Hand this process back to the window opener, the way every harness does when
 * its preflight has passed and it has no pane.
 *
 * The command is THIS cli, re-entered: node's own binary, the entry the caller
 * was reached through, and the original argv. One implementation per harness
 * and no shell in the middle — the window runs the node verb, not a wrapper
 * that spawns it.
 */
export async function reenter(
    entry: string,
    argv: readonly string[],
    io: EnterIo = defaultIo(),
    libexec = '',
): Promise<number> {
    return runEnter(['--cwd', io.cwd, '--', process.execPath, entry, ...argv], io, libexec);
}

/** The line a DROVER_DRY_RUN prints instead of opening anything. */
export function reenterLine(selfDir: string, script: string, argv: readonly string[], cwd: string): string {
    let out = `${join(selfDir, 'drover-tmux-enter')} --cwd ${cwd} -- ${join(selfDir, script)}`;
    for (const a of argv) out += ` ${shQuote(a)}`;
    return out;
}

export async function run(args: string[]): Promise<number> {
    return runEnter(args);
}
