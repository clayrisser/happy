/**
 * `drover flip-menu` — a tmux picker for which account this pane flips to.
 * Ported from libexec/drover-flip-menu (DROVE-315 wave 2b).
 *
 * Bound to prefix + M-f. The plain prefix + F is the one-keystroke "next
 * account with headroom" and is what gets used; this is for the times Clay
 * wants a specific subscription and wants to SEE which of them are cooling
 * before choosing.
 *
 * THREE THINGS THIS FILE HAS TO GET RIGHT, all of them lessons the shell file
 * records and did not start with:
 *
 * 1. TMUX_PANE has to be BAKED INTO every menu command. A menu item runs
 *    through run-shell, which executes in the tmux SERVER's environment where
 *    TMUX_PANE is unset — so `drover flip <name>` hit its "not in tmux and no
 *    target given" guard and exited 2. Every pick from this menu failed, and
 *    `-b` threw the message away, so it failed silently.
 * 2. Every pick SAYS what happened. Success and failure both put a line on the
 *    status bar. `drover flip` exits 0 and prints "flip requested" on stdout,
 *    which run-shell -b discards — so even the working path was invisible, and
 *    a picker you cannot tell apart from a dead key is not a picker.
 * 3. No eval, no nested quoting. Each item re-enters THIS verb with `--pick`,
 *    so the tmux command string is one fixed shape with no interpolated shell
 *    in it, and the logic lives here where it can be read and tested.
 *
 * ORDERED BY HEADROOM, most to least, not by registry position — through the
 * same rankAccounts the limit prompt and the fork's picker use, so the menu and
 * the prompt can never disagree about which account is best.
 */

import { spawnSync } from 'node:child_process';

import { rankAccounts, best, type RankedAccount } from '../flip/rank';

const usage = `drover flip-menu — pick which account this tmux pane flips to.

USAGE
  drover flip-menu              Show the menu for THIS pane
  drover flip-menu --pane <id>  ... for a pane other than $TMUX_PANE

Bound to prefix + M-f. prefix + F is the same flip without the menu: next
account with headroom, one keystroke.

The menu is ordered by HEADROOM, most to least, and every row carries the key
it was sorted on — "main — 62% left", "alt — 0% · back Thu 21:00". Registry
order only breaks ties between accounts nobody has measured. A cooling account
is still selectable, because picking one is a deliberate choice rather than an
accident — the session warns on this status bar and waits for a second press
before it moves (DROVE-64); an account a flip cannot land on is shown DIM and
cannot be chosen, because it would wedge the session in a dialog nothing can
answer. Two of those, and they need different fixes:

  no login    nothing has ever logged in there.   drover account add <name>
  never run   logged in, but that config dir has never been through Claude
              Code's one-time first run, so a session opens on the theme
              picker.                              drover trust

  --pick <account> / --pick-any   what a menu item runs; not for typing

See also: drover accounts (the same list, with reset times)`;

/**
 * tmux treats menu names and commands as FORMATS, so a literal # has to be
 * doubled or tmux eats it as the start of #{...}.
 */
function fmt(s: string): string {
    return s.split('#').join('##');
}

function tmux(args: string[]): { code: number; out: string } {
    const r = spawnSync('tmux', args, { encoding: 'utf8' });
    return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function display(message: string): void {
    // -d holds it long enough to read; the default is 750ms. Older tmux has no
    // -d, so fall back rather than losing the message to a usage error.
    if (tmux(['display-message', '-d', '6000', message]).code !== 0) {
        tmux(['display-message', message]);
    }
}

/**
 * One place decides what a pick means, and it always reports.
 *
 * "Next with headroom" resolves through the SAME ranking the menu above it is
 * sorted by, and names the account explicitly. A bare `drover flip` posts
 * account:null and lets the fork's controller pick, so the top entry of a
 * headroom-sorted menu could flip you somewhere other than the first row you
 * were looking at. A menu that disagrees with itself is worse than no menu.
 *
 * prefix + F (bare `drover flip`) still delegates to the controller. That is
 * deliberate: it is the one-keystroke path with no list on screen, so there is
 * nothing for it to contradict.
 */
async function doPick(name: string, pane: string): Promise<number> {
    if (pane) process.env.TMUX_PANE = pane;
    process.env.DROVER_FLIP_BY = 'tmux';

    let chosen = name;
    if (!chosen) {
        try {
            chosen = best(rankAccounts({}))?.name ?? '';
        } catch { chosen = ''; }
    }

    // `drover flip` writes to both stdout and stderr and exits 0 even when it
    // has a warning to give, so the message is built from the COMBINED output
    // rather than from the exit status alone.
    const said: string[] = [];
    const stdout = process.stdout.write.bind(process.stdout);
    const stderr = process.stderr.write.bind(process.stderr);
    const capture = (chunk: unknown): boolean => { said.push(String(chunk)); return true; };
    let status = 0;
    try {
        (process.stdout as unknown as { write: unknown }).write = capture;
        (process.stderr as unknown as { write: unknown }).write = capture;
        const { run: flip } = await import('./flip');
        // Nothing eligible, or the ranking could not be read: fall through to
        // the controller rather than refusing — it holds the ledger and may
        // still have somewhere to park.
        status = await flip(chosen ? [chosen] : []);
    } catch (err) {
        status = 1;
        said.push(String(err));
    } finally {
        (process.stdout as unknown as { write: unknown }).write = stdout;
        (process.stderr as unknown as { write: unknown }).write = stderr;
    }

    // The status line is one line. `drover flip`'s "no live session for this
    // target" note is four, and tmux would show only the first.
    const text = said.join('').replace(/[\n\t]/g, ' ').trim();
    display(status === 0
        ? `drover: ${text || 'flip requested'}`
        : `drover flip FAILED (${status}): ${text || 'no output'}`);
    return 0;
}

/** Which of the three dead-end states a row is in, as the menu labels them. */
function loginState(r: RankedAccount): 'in' | 'nologin' | 'neverrun' {
    if (!r.loggedIn) return 'nologin';
    if (!r.onboarded) return 'neverrun';
    return 'in';
}

export async function run(argv: string[]): Promise<number> {
    const say = (line: string) => process.stdout.write(line + '\n');
    const warn = (line: string) => process.stderr.write(line + '\n');

    let pane = '';
    let pick = false;
    let picked = '';
    let i = 0;
    while (i < argv.length) {
        const arg = argv[i]!;
        if (arg === '--pane' || arg === '--pick') {
            // `shift 2` with one argument left is an error, and under set -e it
            // aborts with no message at all — so the missing value is named.
            if (i + 1 >= argv.length) { warn(`drover flip-menu: ${arg} needs a value`); return 2; }
            if (arg === '--pane') pane = argv[i + 1]!;
            else { pick = true; picked = argv[i + 1]!; }
            i += 2;
        } else if (arg === '--pick-any') { pick = true; picked = ''; i += 1; }
        else if (arg === '-h' || arg === '--help') { say(usage); return 0; }
        else { warn(`drover flip-menu: unknown argument '${arg}' (try --help)`); return 2; }
    }

    if (pick) return doPick(picked, pane);

    if (!process.env.TMUX) { warn('drover flip-menu: not inside tmux'); return 2; }
    if (pane) process.env.TMUX_PANE = pane;
    if (!process.env.TMUX_PANE) { warn('drover flip-menu: no TMUX_PANE to address'); return 2; }
    pane = process.env.TMUX_PANE;

    let rows: RankedAccount[];
    try {
        rows = rankAccounts({});
    } catch {
        display('drover: could not read the account registry');
        return 1;
    }
    if (rows.length === 0) {
        display('drover: could not parse the account registry');
        return 1;
    }

    const me = process.argv[1] ?? 'drover';
    const item = (flag: string, value: string) =>
        `run-shell -b "${fmt(me)} flip-menu ${flag}${value ? ` '${value}'` : ''} --pane '${pane}'"`;

    // Shortcut keys. `n` is the headroom entry and `q` closes the menu, so
    // neither can be an account's. Beyond the alphabet an entry simply has no
    // shortcut and is still reachable with the arrow keys.
    const keys = '123456789abcdefghijklmoprstuvwxyz';
    const menu: string[] = ['-T', ' flip this pane ', '-t', pane, '-x', 'P', '-y', 'P',
        'next with headroom', 'n', item('--pick-any', ''), ''];

    let n = 0;
    let skipped = 0;
    for (const r of rows) {
        if (!r.name) continue;
        // The name is interpolated into a tmux command string, so anything that
        // is not a plain account name is refused rather than quoted around. The
        // set is valid_name's, character for character (DROVE-59): the narrower
        // [A-Za-z0-9._-] drops `@` and `+`, and `@` is the DEFAULT shape here
        // because `drover account add` names an account after the address.
        if (r.name.match(/[^A-Za-z0-9._@+-]/)) { skipped += 1; continue; }
        // The key is on the row, always. It is the whole reason this list is in
        // the order it is in.
        const state = loginState(r);
        if (state !== 'in') {
            // A leading hyphen is tmux's own spelling for "disabled": dim, and
            // not selectable. TWO REASONS, TWO FIXES (DROVE-246) — "no login" is
            // fixed by logging in; "never run" is an account that IS logged in
            // and whose config dir has never been through Claude Code's first
            // run, so it opens on the theme picker.
            menu.push(state === 'neverrun'
                ? `-${r.name} (never run — drover trust)`
                : `-${r.name} (no login — drover account add ${r.name})`, '', '');
            continue;
        }
        // Counted AFTER the disabled rows are skipped, so the shortcut keys stay
        // 1,2,3… down the list you can actually choose from.
        n += 1;
        menu.push(fmt(`${r.name} — ${r.key}`), keys.charAt(n - 1), item('--pick', r.name));
    }

    if (skipped) menu.push(`-${skipped} account(s) hidden: the name is not [A-Za-z0-9._@+-]`, '', '');

    // The headroom entry is always there, so a registry that yields nothing
    // usable is still a menu.
    tmux(['display-menu', ...menu]);
    return 0;
}

/** For the tests: the argv a real tmux display-menu would be handed. */
export { fmt, loginState };
