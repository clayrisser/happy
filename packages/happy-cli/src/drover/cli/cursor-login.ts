/**
 * `drover account login --harness cursor` — add a Cursor subscription from the
 * PHONE (DROVE-256/270/348/365), in node (DROVE-315 wave 4).
 *
 * The Claude twin is ./account-login and this is deliberately its sibling
 * rather than a branch inside it. Everything that is genuinely the same IS
 * shared and not copied: ./harness/droverWindow owns the named window on the
 * user's own server and the window name that doubles as the lock, ./bus posts,
 * ./account-store owns the token store. What is NOT shared is the middle of the
 * flow, because the two logins are not the same shape:
 *
 *     claude auth login    prints a URL, then BLOCKS on a code typed back in
 *     cursor-agent login   prints a URL, then POLLS its own API until the
 *                          browser approves. There is no code, and there is
 *                          nothing to type into the pane at all.
 *
 * Measured 2026-09-01 on cursor-agent 2026.08.25-3e8eec8, in a pane:
 *
 *     Starting login process...
 *     Authenticating with Cursor...
 *     Waiting for browser authentication...
 *     Open a browser and navigate to this link: https://cursor.com/loginDeepControl?challenge=…
 *     Press q to show a QR code to log in from another device.
 *
 * ONE URL, AND IT ALREADY WORKS FROM A PHONE. Claude Code prints two — a
 * loopback one the phone cannot reach and a platform one it can — and picking
 * the wrong one is a login that can never be completed remotely. Cursor prints
 * exactly one, and it is the remote-capable one. So there is no URL to choose
 * between here, and the card carries the only link there is.
 *
 * THE CARD IS NOT A QUESTION, and that is the real structural difference. The
 * Claude flow's card IS the mechanism: the code Clay sends back is what
 * finishes the login. Here the login finishes on its own the moment he approves
 * in the browser, so the card exists to CARRY THE LINK and to offer Cancel. It
 * is therefore raised alongside the wait instead of being waited on, and a
 * stray answer that is not `cancel` re-arms it rather than deciding anything.
 *
 * NOTHING TOUCHES CLAY'S OWN CURSOR LOGIN. cursor-agent keeps ONE machine-wide
 * credential — Keychain services `cursor-access-token` and
 * `cursor-refresh-token` under account `cursor-user` — and a login writes it.
 * So a naive `cursor-agent login` for a second account would silently replace
 * the account every unwrapped `cursor-agent` on this Mac uses, from a phone,
 * with no way to undo it from there. The escape is
 * AGENT_CLI_CREDENTIAL_STORE=file, so the login runs under a PRIVATE HOME, its
 * credential lands in a 0600 file in a directory this verb made and deletes,
 * and the shared Keychain slot is never opened.
 *
 * NO API KEY, EVER. Clay: "I want the cursor agent cli, not cursor api key."
 * This flow mints a subscription session token and nothing else.
 *
 * NOBODY IS ASKED TO TYPE A NAME. The account is named from the login itself —
 * the address cursor-agent cached under the private HOME, else the JWT's own
 * subject.
 *
 * WHAT NODE CHANGES, AND WHERE IT STOPS.
 *
 *   - Every tmux, clock, signal, subprocess and filesystem-temp call sits
 *     behind ONE injectable io (`CursorLoginIo`). A test hands in a double, and
 *     a double that was asked for something it does not model THROWS — so a
 *     path that reached for Clay's real machine fails the test rather than
 *     measuring it. Nothing in the test suite runs `cursor-agent login`.
 *   - The re-exec into a window runs THIS cli (`process.execPath <entry>
 *     cursor-login …`) where the shell re-exec'd `"$0"`. Same window, same
 *     name, same environment; one fewer shell in the middle.
 *   - The shell's traps become process signal handlers with the same exit
 *     codes: INT 130, TERM 143, HUP 129, QUIT 131. HUP is the one that matters
 *     — tmux hangs up this pane when its window is killed, and an untrapped HUP
 *     runs no cleanup at all under dash.
 *   - `date +%s` is `Math.floor(Date.now() / 1000)`, taken through the io so a
 *     test can hold the clock still.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import {
    type AccountRow,
    accountRow,
    cursorAuthHarvest,
    cursorAuthIdentity,
    cursorAuthStore,
    cursorAuthForget,
    cursorAuthWrite,
    cursorTokenExpiry,
    cursorTokenState,
    jsonRead,
    jsonWrite,
    jwtClaim,
    NotJsonError,
} from './account-store';
import { busPost } from './bus';
import { droverEnv } from './env';
import { DroverWindow, defaultWindowIo, loginWindowBootVars, loginWindowName } from './harness/droverWindow';

export const usage = `drover account login --harness cursor — add a Cursor subscription from the phone.

USAGE
  drover account login --harness cursor [name] [options]
      --timeout <seconds>   how long the login may wait. Default 900.
      --session <id>        attach the card to a session, so it shows there as
                            well as in the all-questions view.
      --local               let the Mac's own browser open too. Off by default:
                            this exists to be run while nobody is at the Mac.
      --window              run in a named tmux window on your own server even
                            when you have a terminal, and watch it there.
      --no-window           never open one; run wherever this was started.

HOW IT RUNS
  It opens a NAMED tmux window on your own server (\`login-cursor-<account>\`,
  the same mechanism the Claude login uses), runs \`cursor-agent login\` in it,
  reads the link off the pane and puts that link on the bus. Whichever surface
  Clay is on shows it.

  THERE IS NO CODE TO SEND BACK. cursor-agent polls its own API, so the login
  finishes the moment the link is approved in a browser. The card carries the
  link and a Cancel; approving in the browser is what completes it.

  Watch one:  switch to the window named login-cursor-<account>. Its pane is
  left open when the login ends, so what happened is still there to read
  (DROVE-348).

YOUR OWN CURSOR LOGIN IS NOT TOUCHED
  cursor-agent keeps one machine-wide credential in the login Keychain, and a
  plain \`cursor-agent login\` would overwrite it — replacing the account every
  unwrapped \`cursor-agent\` on this Mac uses. This login runs under a private
  HOME with cursor's file credential store instead, so its token lands in a
  0600 file that is read once and deleted. The Keychain is never opened.

  No API key is minted, read or stored anywhere in this flow.

WHEN IT FINISHES
  The token is checked, named after the address it logged in as, and written
  to $STATE_DIR/cursor-auth.json (0600). The registry row in accounts.json
  carries the name and the harness and NO secret.

  A cursor token lasts 60 days and CANNOT BE RENEWED. cursor-agent has no
  refresh flow for it — its two Keychain slots hold the same string, and the
  only endpoint that mints a fresh token authenticates with an API key. So an
  expired cursor account is logged in again here; \`drover accounts\` says so
  before a session tries to start on it, rather than failing mid-turn.
`;

// --- what a card looks like ---------------------------------------------------

/**
 * The notice card the phone gets when this cannot even start, or when it
 * failed.
 *
 * Same shape and same reasoning as the Claude login's: a notice, posted as a
 * one-option question because that is the only kind the bridge mirrors into a
 * card, fire-and-forget because blocking on an acknowledgement from a man who
 * has put his phone down keeps a process alive for nothing.
 */
export function cursorNotifyPayload(
    label: string,
    reason: string,
    cwd: string,
    session: string,
    suffix: string = 'failed',
): Record<string, unknown> {
    return {
        kind: 'question',
        title: `Cursor login for ${label === '' ? 'a new cursor account' : label} ${suffix}`,
        reason,
        preview: reason,
        ttlMs: 300000,
        channel: 'external',
        options: [{ id: 'ok', label: 'OK' }],
        origin: {
            harness: 'drover',
            gate: 'account-login',
            account: null,
            sessionId: session === '' ? null : session,
            cwd,
            surface: null,
        },
    };
}

export interface CursorCard {
    label: string;
    url: string;
    timeoutS: number;
    session: string;
    /** The `Watch it in tmux: …` fragment, empty when there is no window. */
    watch: string;
}

/**
 * The `drover ask` command line the login raises, argument for argument.
 *
 * `--gate account-login` is what tells the app this is a login card and not an
 * ordinary multiple-choice question, so it draws the link with an
 * open-in-browser row. The app also offers a code field on that gate, which is
 * meaningless here — there is no code in a cursor login — so a non-cancel
 * answer is not an error and not an answer: the card is simply raised again.
 *
 * `${watch:+ $watch}` in the shell is "a space and the fragment, when there is
 * one", which is the whole of the DROVE-346 wording: one fragment on the end of
 * the reason, never a paragraph of its own.
 */
export function cursorAskArgv(card: CursorCard): string[] {
    const reason = 'Open this in a browser and approve it. Nothing to send back — '
        + `the login finishes on its own.${card.watch === '' ? '' : ` ${card.watch}`}`;
    const argv = [
        `Log in to Cursor for ${card.label}`,
        '--reason', reason,
        '--preview', card.url,
        '--option', 'cancel:Cancel the login',
        '--gate', 'account-login',
        '--harness', 'drover',
        '--timeout', String(card.timeoutS),
    ];
    if (card.session !== '') argv.push('--session', card.session);
    return argv;
}

/**
 * The login link off the pane.
 *
 * Matched on the URL itself rather than on the sentence around it. "Open a
 * browser and navigate to this link:" is wording; a loginDeepControl link on
 * the screen is the invariant.
 *
 * The shell is `tr ' \\t\\r' '\\n\\n\\n'` then a whole-line match, which is what
 * makes "link: https://…" yield the bare URL. It relies on the capture being
 * `capture-pane -p -J`, which has already rejoined the lines a long link wraps
 * onto.
 */
export function readLoginLink(paneText: string): string {
    for (const token of paneText.split(/[ \t\r\n]+/)) {
        if (token.startsWith('https://') && token.includes('loginDeepControl')) return token;
    }
    return '';
}

/**
 * The last three non-empty lines of the pane, space-joined — what the shell's
 * `grep . | tail -3 | tr '\\n' ' '` says when the login died without a link.
 *
 * `tr` leaves the trailing newline as a trailing SPACE, and that space is on
 * the card. It is kept because these sentences are compared byte for byte
 * against the shell's, and a trimmed one is a different string.
 */
export function paneTail(paneText: string): string {
    const lines = paneText.split('\n').filter((l) => l !== '');
    if (lines.length === 0) return '';
    return `${lines.slice(-3).join(' ')} `;
}

/** `fmt_epoch <exp> '+%Y-%m-%d'` — a LOCAL date, the way `date -r` prints one. */
export function fmtEpochDay(at: number): string {
    const d = new Date(at * 1000);
    const pad = (n: number): string => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// --- arguments ----------------------------------------------------------------

export interface CursorLoginOptions {
    name: string;
    timeoutS: number;
    session: string;
    localBrowser: boolean;
    /** null is the shell's `auto`: a terminal means here, none means a window. */
    wantWindow: boolean | null;
    help: boolean;
}

export interface ParseFailure {
    /** The sentence `die` prints, WITHOUT its `drover account login: ` prefix. */
    die: string;
    code: number;
}

export function isCursorParseFailure(v: CursorLoginOptions | ParseFailure): v is ParseFailure {
    return (v as ParseFailure).die !== undefined;
}

/**
 * The option loop, one for one with the shell's.
 *
 * THE NAME IS POSITIONAL AND MAY SIT ANYWHERE, which is not fussiness: the
 * caller that reaches this file is `drover account login`, whose own scan for
 * `--harness cursor` walks the WHOLE argument list precisely so that
 *
 *     drover account login jam --harness cursor
 *     drover account login --harness cursor jam
 *
 * are the same request. Parsing the name only in first position made the second
 * of those die with "unknown option 'jam'" — the front door accepted a spelling
 * the back door then refused.
 */
export function parseCursorLoginArgs(argv: readonly string[]): CursorLoginOptions | ParseFailure {
    const o: CursorLoginOptions = {
        name: '',
        timeoutS: 900,
        session: '',
        localBrowser: false,
        wantWindow: null,
        help: false,
    };
    let rawTimeout = '900';
    const args = [...argv];
    const needVal = (flag: string): ParseFailure | null =>
        (args.length >= 2 ? null : { die: `${flag} needs a value`, code: 2 });
    while (args.length > 0) {
        const a = args[0];
        if (a === '--harness') {
            const bad = needVal(a);
            if (bad) return bad;
            args.splice(0, 2);
            continue;
        }
        if (a === '--timeout') {
            const bad = needVal(a);
            if (bad) return bad;
            rawTimeout = args[1];
            args.splice(0, 2);
            continue;
        }
        if (a === '--session') {
            const bad = needVal(a);
            if (bad) return bad;
            o.session = args[1];
            args.splice(0, 2);
            continue;
        }
        if (a === '--window') { o.wantWindow = true; args.shift(); continue; }
        if (a === '--no-window') { o.wantWindow = false; args.shift(); continue; }
        if (a === '--local') { o.localBrowser = true; args.shift(); continue; }
        if (a === '--config-dir') {
            const bad = needVal(a);
            if (bad) return bad;
            return {
                die: `a cursor account has no config dir: cursor-agent keeps one
  machine-wide credential and drover hands each session its own token instead.
  Drop --config-dir.`,
                code: 2,
            };
        }
        if (a === '-h' || a === '--help') { o.help = true; return o; }
        if (a.startsWith('-')) return { die: `unknown option '${a}' (try --help)`, code: 2 };
        if (o.name !== '') {
            return { die: `two names given ('${o.name}' and '${a}') — a login adds one account`, code: 2 };
        }
        o.name = a;
        args.shift();
    }
    if (rawTimeout === '' || rawTimeout.match(/[^0-9]/)) {
        return { die: '--timeout takes whole seconds', code: 2 };
    }
    o.timeoutS = Number(rawTimeout);
    return o;
}

// --- the io -------------------------------------------------------------------

/** A `drover ask` in flight: the card is up until this resolves or is stopped. */
export interface AskRun {
    /** Resolves when the card is answered, times out or is withdrawn. */
    done: Promise<{ code: number; text: string }>;
    /** Is it still up? The shell's `kill -0 "$ask_pid"`. */
    running: () => boolean;
    /**
     * TERM, not KILL: drover-ask traps TERM to WITHDRAW its card, and a card
     * left standing after the login it belongs to has finished is the orphan
     * this whole design is trying not to leave.
     */
    stop: () => void;
}

/**
 * Everything this verb needs that is not argv, injected.
 *
 * A test hands in a double. A double asked for something it does not model
 * throws, so a code path that reached for Clay's real machine — a real
 * cursor-agent, a real tmux server, the real Keychain — fails the test instead
 * of measuring it.
 */
export interface CursorLoginIo {
    env: NodeJS.ProcessEnv;
    cwd: string;
    pid: number;
    isTty: () => boolean;
    out: (line: string) => void;
    err: (line: string) => void;
    window: DroverWindow;
    which: (name: string) => string | null;
    /** Seconds since the epoch, the way `date +%s` answers. */
    now: () => number;
    sleep: (ms: number) => Promise<void>;
    /** `kill -0 <pid>` — is that process still there? */
    alive: (pid: number) => boolean;
    /** `kill -TERM` / `kill -KILL`, which only ever names a pid read off a pane. */
    signal: (pid: number, sig: 'SIGTERM' | 'SIGKILL') => void;
    mkdtemp: (prefix: string) => string;
    rmrf: (path: string) => void;
    /** Fire-and-forget bus post; never throws, never fails a login. */
    notify: (payload: Record<string, unknown>) => Promise<void>;
    ask: (argv: string[], tmp: string) => AskRun;
    /** The argv the window re-exec runs. `"$0" $login_argv` in the shell. */
    selfCommand: (argv: readonly string[]) => string[];
    onSignal: (handler: (name: 'SIGINT' | 'SIGTERM' | 'SIGHUP' | 'SIGQUIT') => void) => void;
}

/** The real process. Never used by a test. */
export function defaultCursorLoginIo(): CursorLoginIo {
    const window = new DroverWindow(defaultWindowIo());
    return {
        env: process.env,
        cwd: process.cwd(),
        pid: process.pid,
        isTty: () => Boolean(process.stdout.isTTY),
        out: (line) => process.stdout.write(`${line}\n`),
        err: (line) => process.stderr.write(`${line}\n`),
        window,
        which: (name) => {
            for (const dir of (process.env.PATH ?? '').split(delimiter)) {
                if (!dir) continue;
                const candidate = join(dir, name);
                if (existsSync(candidate)) return candidate;
            }
            return null;
        },
        now: () => Math.floor(Date.now() / 1000),
        sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); }),
        alive: (pid) => {
            try {
                process.kill(pid, 0);
                return true;
            } catch {
                return false;
            }
        },
        signal: (pid, sig) => {
            try {
                process.kill(pid, sig);
            } catch {
                // `kill … 2>/dev/null || :`. A process already gone is done.
            }
        },
        mkdtemp: (prefix) => {
            const root = mkdtempSync(join(process.env.TMPDIR || tmpdir(), prefix));
            return root;
        },
        rmrf: (path) => {
            try {
                rmSync(path, { recursive: true, force: true });
            } catch {
                // `rm -rf … 2>/dev/null || :`.
            }
        },
        notify: async (payload) => {
            try {
                await busPost('/v1/events', payload, 5_000);
            } catch {
                // `|| :` — a bus that is down is not a reason to keep a process
                // alive, and the sentence is already going to stderr.
            }
        },
        ask: (argv, tmp) => {
            // THE ONLY BACKGROUND PROCESS IS THE CARD, never the login. It is a
            // short-lived helper whose answer is its stdout, which already traps
            // TERM to withdraw its own card, and which this process is the direct
            // parent of — so reaping it is one signal and the card comes down
            // with it.
            const entry = process.argv[1] ?? '';
            const child = spawn(process.execPath, [entry, 'ask', ...argv], {
                env: { ...process.env, TMPDIR: tmp },
                stdio: ['ignore', 'pipe', 'ignore'],
            });
            let text = '';
            child.stdout?.on('data', (chunk: Buffer) => { text += chunk.toString('utf8'); });
            let live = true;
            const done = new Promise<{ code: number; text: string }>((resolve) => {
                child.on('close', (code) => {
                    live = false;
                    resolve({ code: code ?? 1, text: text.replace(/\n+$/, '') });
                });
                child.on('error', () => {
                    live = false;
                    resolve({ code: 1, text: '' });
                });
            });
            return {
                done,
                running: () => live,
                stop: () => {
                    if (!live) return;
                    try {
                        child.kill('SIGTERM');
                    } catch {
                        // Already gone.
                    }
                },
            };
        },
        selfCommand: (argv) => [process.execPath, process.argv[1] ?? '', 'cursor-login', ...argv],
        onSignal: (handler) => {
            process.on('SIGINT', () => handler('SIGINT'));
            process.on('SIGTERM', () => handler('SIGTERM'));
            process.on('SIGHUP', () => handler('SIGHUP'));
            process.on('SIGQUIT', () => handler('SIGQUIT'));
        },
    };
}

// --- the run ------------------------------------------------------------------

/** The shell's `die`: the sentence on stderr under one prefix, and the code. */
function die(io: CursorLoginIo, why: string, code: number = 2): number {
    io.err(`drover account login: ${why}`);
    return code;
}

export async function run(args: string[], io: CursorLoginIo = defaultCursorLoginIo()): Promise<number> {
    // --help FIRST, before any env read, file read or subprocess: a subprocess
    // spawned on --help is a load-time side effect, and cattle-drover's
    // tests/libexec-loadtime.bats treats it as one.
    const parsed = parseCursorLoginArgs(args);
    if (isCursorParseFailure(parsed)) return die(io, parsed.die, parsed.code);
    if (parsed.help) {
        io.out(usage.trimEnd());
        return 0;
    }
    const o = parsed;

    const env = io.env;
    const cfg = droverEnv(env);
    const registry = env.DROVER_ACCOUNTS || cfg.accounts;
    const home = env.HOME || homedir();

    let label = o.name === '' ? 'a new cursor account' : o.name;
    const notifyFailed = async (reason: string, suffix: string = 'failed'): Promise<void> => {
        await io.notify(cursorNotifyPayload(label, reason, io.cwd, o.session, suffix));
    };

    // THE PATH THE LAUNCHER MEANT. Same delivery mechanism as the Claude login,
    // and same reason: `tmux new-window -e PATH=…` does not reach the pane, so
    // the value arrives under its own name and is applied here. cursor-agent
    // lives in ~/.local/bin, which an interactive shell has on PATH and a
    // launchd job does not — the exact hole that made phone logins die in
    // silence for Claude.
    if (env.DROVER_LOGIN_PATH) env.PATH = env.DROVER_LOGIN_PATH;

    // `jq` is the shell's hard dependency and node's is JSON.parse, so the guard
    // is kept for the ONE thing that still needs it — a `drover ask` further
    // down is still a subprocess — and it is the shell's sentence and exit code.
    if (io.which('jq') === null) return die(io, 'jq is required (brew install jq)', 5);

    if (io.which('cursor-agent') === null) {
        await notifyFailed('cursor-agent is not on this process\'s PATH, so there is no login to open. It is usually in ~/.local/bin, which a launchd daemon does not inherit. Install it: curl https://cursor.com/install -fsS | sh');
        return die(io, 'cursor-agent is not on PATH, so there is no login to open', 5);
    }
    if (io.which('tmux') === null) {
        await notifyFailed('tmux is not on this process\'s PATH, and the login runs in a tmux window.');
        return die(io, 'tmux is required: the login runs in a tmux window', 5);
    }

    // --- INTO A WINDOW YOU CAN WATCH, when nobody is watching this ------------
    //
    // The Claude login's rule, for the same reasons and with the same shape. A
    // terminal is the window and this runs in it; without one — the daemon, the
    // app — this re-execs itself into `login-cursor-<account>` on the user's own
    // server, so the wrapper's narration and the login it drives share one named
    // window instead of going to a /dev/null nobody can read afterwards.
    const wantWindow = o.wantWindow === null ? !io.isTty() : o.wantWindow;
    const window = io.window;
    if (wantWindow && !env.DROVER_LOGIN_WINDOW) {
        const bootWin = loginWindowName('cursor', o.name === '' ? 'new' : o.name);
        window.envReset();
        window.envAdd('DROVER_LOGIN_WINDOW', bootWin);
        for (const name of loginWindowBootVars) {
            const value = env[name];
            if (value) window.envAdd(name, value);
        }
        const opened = window.open(bootWin, home, io.selfCommand(args));
        if (opened.status === 0) {
            io.out(`drover account login: running in ${window.target(bootWin) ?? bootWin}`);
            return 0;
        }
        // A window that could not be opened is not a reason to refuse a login.
        io.err('drover account login: could not open a tmux window — running here, where only this process can see it.');
    }

    // --- the tmux window, which is also the lock ------------------------------
    //
    // A nameless cursor add cannot be named after a config dir, because a cursor
    // account HAS no config dir. `new` is the placeholder — the same one the
    // Claude login uses, since the harness is in the window name and
    // `login-cursor-new` cannot collide with `login-claude-new` — so a second
    // nameless cursor login wants the same window name and is refused exactly as
    // a second nameless Claude one is.
    const win = loginWindowName('cursor', o.name === '' ? 'new' : o.name);
    const inherited = Boolean(env.DROVER_LOGIN_WINDOW);

    if (!claimWindow(io, win, inherited, env.DROVER_LOGIN_WINDOW ?? '')) {
        return die(io, `a cursor login is already waiting on this machine.
  Answer or cancel that one first — its card is still on the phone.
  Watch it in tmux:  ${window.target(win) ?? win}`, 3);
    }

    // WHO IS DRIVING, stamped the moment the name is ours rather than when the
    // login starts. It is only ever asked whether it is still there; nothing
    // kills it.
    stampDriver(io, win);

    label = o.name === '' ? 'a new cursor account' : o.name;

    // --- the private HOME the credential lands in -----------------------------
    //
    // THE WHOLE POINT OF THIS DIRECTORY is that cursor-agent's credential goes
    // into it instead of into the Keychain slot Clay's own cursor-agent reads.
    // It also holds the `drover ask` long-poll file, which carries a resolved
    // event, so it is 0700 and ours either way.
    let work = '';
    let ask: AskRun | null = null;
    let loginPane = '';
    let started = false;

    const dropWork = (): void => {
        if (work === '') return;
        io.rmrf(work);
        work = '';
    };
    const stopAsk = (): void => {
        if (ask === null) return;
        ask.stop();
        ask = null;
    };
    /**
     * The login is ended and THE PANE IS LEFT (DROVE-348): the pane holding what
     * the login said is the thing Clay asked for, and `kill-window` takes the
     * receipt away with the process.
     *
     * LIVENESS BEFORE THE SIGNAL, and this is a measured bug rather than an
     * ordering preference. Under remain-on-exit a DEAD pane still answers
     * `#{pane_pid}` with the pid its command had, and that pid has been free to
     * be reused since the moment it exited. Signalling it kills whatever holds
     * it now: the first version of this killed the bats runner itself,
     * reproducibly. The pane being dead is also the only thing this wanted to
     * achieve, so the check is the early return as well as the guard.
     */
    const stopLogin = async (): Promise<void> => {
        if (!started) return;
        started = false;
        if (loginPane === '') return;
        if (!window.paneLive(loginPane)) return;
        const shown = window.tmux(['display-message', '-p', '-t', loginPane, '#{pane_pid}']);
        const raw = shown.stdout.replace(/\n+$/, '');
        if (raw === '' || raw.match(/[^0-9]/)) return;
        const pid = Number(raw);
        io.signal(pid, 'SIGTERM');
        for (let n = 0; n < 20; n++) {
            if (!window.paneLive(loginPane)) return;
            await io.sleep(100);
        }
        // Still running after two seconds. Re-read liveness one last time rather
        // than trusting the loop's last look, for the same recycled-pid reason.
        if (!window.paneLive(loginPane)) return;
        io.signal(pid, 'SIGKILL');
    };

    // Every exit, and the list is the Claude login's list for the same reasons —
    // including HUP and QUIT, because `#!/bin/sh` is not one shell and the three
    // it runs under do not agree about whether an untrapped fatal signal still
    // runs the EXIT trap. Nothing here sweeps on a timer.
    io.onSignal((name) => {
        stopAsk();
        void stopLogin();
        dropWork();
        const code = name === 'SIGINT' ? 130 : name === 'SIGTERM' ? 143 : name === 'SIGHUP' ? 129 : 131;
        process.exitCode = code;
    });

    const finish = async (code: number): Promise<number> => {
        stopAsk();
        await stopLogin();
        dropWork();
        return code;
    };

    try {
        work = io.mkdtemp('drover-cursor-login.');
    } catch {
        return die(io, 'could not make a working directory', 1);
    }
    const loginHome = join(work, 'home');
    try {
        mkdirSync(loginHome, { recursive: true, mode: 0o700 });
    } catch {
        return await finish(die(io, 'could not make a working directory', 1));
    }

    let why = '';
    const fail = async (reason: string): Promise<number> => {
        await notifyFailed(reason);
        return await finish(die(io, reason, 1));
    };

    // --- driving the pane ----------------------------------------------------
    //
    // The binary is resolved to an ABSOLUTE path rather than left to the pane's
    // PATH: the pane inherits the tmux SERVER's environment, which is whatever
    // the first client on this socket happened to have, and a login that works
    // or not depending on who opened the server first is a bug that hides.
    //
    // CURSOR_API_KEY is unset in the pane. An inherited key would authenticate
    // as the metered API and the login would have nothing to do — the same trap
    // ANTHROPIC_API_KEY sets for the Claude login, and the same answer.
    //
    // THE ENVIRONMENT GOES THROUGH envAdd and the COMMAND is the command
    // (DROVE-365). They were one list until DROVE-348 turned `tm new-session -d
    // -s "$sess" "$@"` into `open … -- "$@"`, at which point tmux's own flags
    // became the pane's argv, `exec -n` answered with bash's usage line, and the
    // private HOME never reached the pane at all.
    const paneText = (): string => (loginPane === '' ? '' : window.capture(loginPane));
    const startLogin = (): boolean => {
        const bin = io.which('cursor-agent');
        if (bin === null) return false;
        window.envReset();
        window.envAdd('HOME', loginHome);
        window.envAdd('AGENT_CLI_CREDENTIAL_STORE', 'file');
        if (!o.localBrowser) window.envAdd('NO_OPEN_BROWSER', '1');
        const command = ['sh', '-c', 'unset CURSOR_API_KEY CURSOR_AUTH_TOKEN; exec "$0" login', bin];
        if (inherited) {
            // A SECOND PANE in the window this wrapper is already running in, so
            // one named window holds both halves. $TMUX_PANE is ours by
            // construction here; the window's first pane is the fallback for a
            // launcher that opened the window without running us in it.
            const into = env.TMUX_PANE || window.pane(win) || '';
            if (into === '') return false;
            const pane = window.add(into, command);
            if (pane === null) return false;
            loginPane = pane;
        } else {
            const opened = window.open(win, home, command);
            if (opened.status !== 0) return false;
            loginPane = opened.pane;
        }
        if (loginPane === '') return false;
        started = true;
        stampDriver(io, win);
        return true;
    };

    if (!startLogin()) return await fail('could not open the tmux session for the login');

    // Wait for the link, and believe it only when the SAME link is read twice
    // 250ms apart. The pane is a live screen and a poll can land mid-repaint,
    // which would hand the phone a truncated link — a card that opens, a page
    // that refuses, and a login that looks broken rather than a read that was.
    let url = '';
    let seen = '';
    for (let waited = 0; waited < 120; waited++) {
        url = readLoginLink(paneText());
        if (url !== '' && url === seen) break;
        seen = url;
        if (url === '' && !window.paneLive(loginPane)) {
            const tail = paneTail(paneText());
            return await fail(tail === '' ? 'cursor-agent login exited before printing a login link' : tail);
        }
        await io.sleep(250);
    }
    if (url === '') return await fail('cursor-agent login printed no login link within 30s');

    // --- the card, raised beside the wait ------------------------------------
    const watch = window.watch(win) ?? '';
    const raiseCard = (): AskRun =>
        io.ask(cursorAskArgv({ label, url, timeoutS: o.timeoutS, session: o.session, watch }), work);
    ask = raiseCard();

    // --- wait for the browser ------------------------------------------------
    //
    // Three things can end this and they are checked in this order, which
    // matters.
    //
    // THE CREDENTIAL FIRST, always. cursor-agent exits when it succeeds, so the
    // pane dying is ALSO what success looks like from the outside; asking "did
    // the pane die" first would report every successful login as a failure. The
    // credential file is the only unambiguous signal, so it is asked first here
    // and once more after the pane has gone.
    //
    // The card second: a tapped Cancel is a decision and should not wait out the
    // remaining poll interval.
    //
    // The pane last, and only as a failure once the credential is known absent.
    let token = '';
    const deadline = io.now() + o.timeoutS;
    for (;;) {
        token = cursorAuthHarvest(loginHome) ?? '';
        if (token !== '') break;

        if (ask !== null && !ask.running()) {
            const answered = await ask.done;
            ask = null;
            if (answered.code === 0) {
                if (answered.text === 'cancel') {
                    why = 'cancelled from the phone';
                    break;
                }
                // Anything else came from the code field the app draws on this
                // gate. There is no code in a cursor login, so the card goes
                // straight back up with the same link.
                ask = raiseCard();
            } else if (answered.code === 3) {
                // The card timed out. The login itself may still be approvable,
                // so the overall deadline below decides when to stop, not this.
            } else if (answered.code === 4) {
                why = 'the login card was withdrawn';
                break;
            } else if (answered.code === 5) {
                why = 'the bus could not be reached, so the link never left this Mac';
                break;
            } else {
                why = `the login card failed (drover ask exit ${answered.code})`;
                break;
            }
        }

        if (!window.paneLive(loginPane)) {
            started = false;
            token = cursorAuthHarvest(loginHome) ?? '';
            if (token !== '') break;
            const tail = paneTail(paneText());
            why = tail === '' ? 'the login ended without writing a credential' : tail;
            break;
        }

        if (io.now() >= deadline) {
            why = `nobody approved the login within ${o.timeoutS}s`;
            break;
        }
        await io.sleep(1000);
    }

    if (token === '') return await fail(why === '' ? 'the login ended without writing a credential' : why);

    // The card has done its job the moment a credential exists. Down it comes
    // before anything else, so it cannot outlive the thing it was asking about.
    stopAsk();
    await stopLogin();

    // --- is the token one a session can actually run on? ---------------------
    //
    // The equivalent of the Claude flow's `claude auth status` gate, and it is
    // CHEAPER rather than weaker: a cursor token is a JWT, so its expiry is a
    // local read with no network call and no second process. What it cannot do
    // is prove the signature, so the check is "not already dead", not "accepted
    // by the server".
    //
    // `cursor-agent status` is deliberately NOT used. Measured: it reports the
    // KEYCHAIN login and ignores CURSOR_AUTH_TOKEN entirely — passing a
    // deliberately invalid token still printed "authenticated" and Clay's own
    // address — so it would answer a question about a different account than the
    // one being added.
    const state = cursorTokenState(token, io.now(), env);
    if (state === 'tombstone') {
        // NOT the clock. A tombstone is the stub cursor-agent leaves behind when
        // something signs the account out, so it means the login did not
        // actually take. Sending Clay to check his clock here would point him at
        // the one thing that is certainly fine.
        return await fail(`the login wrote a signed-out marker rather than a credential, so there is
  nothing to add. That usually means the browser approval never landed, or the
  account was signed out again while this was waiting. Try the login again.`);
    }
    if (state === 'expired' || state === 'expiring') {
        return await fail(`the login finished but the token it returned is already expired. That is a
  clock problem on this Mac more often than anything else. Nothing was added.`);
    }

    // --- name it, without asking ---------------------------------------------
    //
    // The address cursor-agent cached under the private HOME first, because that
    // is what the login itself resolved. The JWT subject is the fallback: it is
    // stable per account and unique, so two accounts can never collide on it,
    // and it is better than a prompt Clay has already said twice he does not
    // want.
    const authId = jwtClaim(token, 'sub') ?? '';
    const mail = cursorAuthIdentity(loginHome) ?? '';
    const final = o.name !== '' ? o.name : (mail !== '' ? mail : authId);
    if (final === '') {
        return await fail(`the login worked but returned no address and no subject, so there is
  nothing to name the account after. Nothing was added.`);
    }

    // --- the registry row, and the secret, which are two different files ------
    //
    // accounts.json gets the NAME, the HARNESS and the identity. It does not get
    // the token, and that is not squeamishness: that file is committed as an
    // example, is hand-edited, and every other reader of it is documented as
    // never touching a credential. The secret goes to
    // $STATE_DIR/cursor-auth.json at 0600.
    let current: AccountRow[];
    try {
        current = jsonRead<AccountRow[]>(registry, []);
    } catch (error) {
        if (error instanceof NotJsonError) {
            io.err(error.message);
            return await finish(1);
        }
        throw error;
    }
    // THE CURSOR ROW ONLY (DROVE-338). A Claude row under this address is a
    // different account — a config dir and a Keychain item, where this is a
    // token — and it neither blocks this login nor is touched by it.
    const taken = accountRow(current, final, 'cursor');
    const store = cursorAuthStore(cfg.stateDir, env);

    if (taken !== undefined) {
        // THE EXISTING ROW STANDS, and the fresh token REPLACES the stored one.
        // A repeat Claude login lands in a whole new config dir with its own
        // Keychain item, so the second one is an orphan and the row must not be
        // repointed at it. A cursor account has no directory at all: logging in
        // again produces a NEWER TOKEN FOR THE SAME ACCOUNT and nothing else.
        if (!cursorAuthWrite(store, final, token, authId, mail, io.now())) {
            return await finish(die(io, 'logged in, but could not write the token store', 1));
        }
        io.out(`refreshed the cursor token for ${final}`);
    } else {
        if (!cursorAuthWrite(store, final, token, authId, mail, io.now())) {
            return await finish(die(io, 'logged in, but could not write the token store', 1));
        }
        try {
            jsonWrite(registry, [...current, { name: final, harness: 'cursor', authId }]);
        } catch {
            cursorAuthForgetQuietly(store, final);
            return await finish(die(io, `logged in, but could not write ${registry}`, 1));
        }
    }

    const exp = cursorTokenExpiry(token);
    io.out(`logged in as ${mail !== '' ? mail : final} (cursor)${exp === undefined ? '' : `, token good until ${fmtEpochDay(exp)}`}`);
    return await finish(0);
}

/**
 * `cursor_auth_forget … 2>/dev/null || :` on the rollback path: the registry
 * write failed, so the secret this run stored has no row to belong to and must
 * not be left behind. A forget that also fails changes nothing about what the
 * caller is told.
 */
function cursorAuthForgetQuietly(store: string, name: string): void {
    try {
        cursorAuthForget(store, name);
    } catch {
        // Already said.
    }
}

/**
 * Is a login already in flight for this account?
 *
 * Byte for byte the Claude login's claim rule, and it lives beside each flow
 * rather than in the shared helper for one reason: it asks tmux about THIS
 * run's window and answers with this run's exit code.
 *
 * The launcher cannot know which account a nameless add will pick, so on the
 * phone path it opens the window under a placeholder name and this claims the
 * real one by RENAMING into it. tmux refuses a rename onto a name in use, so the
 * claim is atomic either way and there is no window where two runs both believe
 * they have it.
 *
 * Two questions decide whether a name already taken is a live login or a corpse,
 * and the order is the point. The pid on the window answers the first: a run
 * that was SIGKILLed left this behind and nobody is driving it. Whether any pane
 * in it is STILL RUNNING answers the second, and it covers the moment between
 * the launcher opening a window and this run stamping its pid on it.
 *
 * A CORPSE IS REUSED, NOT KILLED (DROVE-348). The old rule killed the session
 * and took the name; on the user's own server a dead pane is the receipt of the
 * last attempt and stacking a second window beside it is exactly the mess Clay
 * asked not to have. `open` respawns it in place instead.
 */
export function claimWindow(io: CursorLoginIo, win: string, inherited: boolean, opened: string): boolean {
    const window = io.window;
    if (inherited) {
        if (win === opened) return true;
        const from = window.target(opened);
        if (from === null) return false;
        if (window.tmux(['rename-window', '-t', from, win]).status !== 0) return false;
        window.stamp(win);
        return true;
    }
    if (!window.exists(win)) return true;
    const target = window.target(win);
    if (target === null) return false;
    const shown = window.tmux(['show-options', '-w', '-t', target, '-qv', '@drover-login-pid']);
    const pid = shown.stdout.replace(/\n+$/, '');
    if (pid !== '' && !pid.match(/[^0-9]/) && io.alive(Number(pid))) return false;
    // NOBODY IS DRIVING IT. An idle window is the receipt of a finished login
    // and `open` respawns it in place, which is how a second start leaves one
    // window rather than two. A window still RUNNING something under a dead
    // driver is different: a run that was SIGKILLed left its login behind with
    // nothing reading its pane, and that orphan has to go.
    if (!window.idle(win)) return window.kill(win);
    return true;
}

/**
 * `@drover-login-pid` — who is driving this window, so a run that was SIGKILLed
 * leaves a window the NEXT run can tell apart from a live one. Nothing ever
 * kills this pid; it is only ever asked whether it is still there. Silent when
 * the window does not exist yet.
 */
export function stampDriver(io: CursorLoginIo, win: string): void {
    const target = io.window.target(win);
    if (target === null) return;
    io.window.tmux(['set-option', '-w', '-t', target, '@drover-login-pid', String(io.pid)]);
}
