/**
 * `drover account add|rm|rename` — the registry, edited by the one command
 * (ported from libexec/drover-account-edit at DROVE-315 wave 2a).
 *
 * What this does NOT do, ever: touch a credential. It creates an EMPTY config
 * dir and hands off to Claude Code's own OAuth flow, which is the only thing
 * that should ever hold a token. Nothing here reads, writes, prints or logs
 * one, and the login is a hand-off, not a login of its own.
 *
 * AN ACCOUNT'S IDENTITY IS (harness, name), NOT THE NAME ALONE (DROVE-338). A
 * Claude row is a config dir and a Cursor row is a token, and both are named
 * after the address they logged in as, so the same address can legitimately
 * sit in the registry twice. Every verb here resolves the harness before it
 * acts, and refuses an ambiguous name rather than guessing at one.
 *
 * THE CONFIG DIR PATH IS THE KEY TO THE CREDENTIAL. On macOS the login lives
 * in the Keychain under `Claude Code-credentials-<first 8 hex of
 * sha256(CLAUDE_CONFIG_DIR)>`, measured against three real directories. So the
 * directory is picked BEFORE the login and never moved, and only the registry
 * NAME carries the address — which is also why `rename` leaves configDir
 * alone.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { basename, join } from 'node:path';

import {
    type AccountRow,
    type LedgerEntry,
    accountConfigFile,
    accountDataDir,
    accountDirLabel,
    accountEmail,
    accountLoggedIn,
    accountOnboarded,
    accountRow,
    cursorAuthForget,
    cursorAuthStore,
    expandHome,
    home as homeOf,
    isAmbient,
    jsonRead,
    jsonWrite,
} from './account-store';
import { stateDir } from './accounts';
import { busGet } from './bus';
import { droverEnv } from './env';

const usage = `drover account add|rm|rename — manage the subscription registry.

USAGE
  drover account add [name] [options]
      --config-dir <path>       where that account's CLAUDE_CONFIG_DIR lives
                                (default ~/.claude-accounts/<name>)
      --flip-prompt <text>      what a session is told when it lands here
      --flip-prompt-file <path> the same, read from a file
      --no-login                skip the login; print the command to run later

  drover account rm <name> [--purge] [--harness claude|cursor]
      --purge                   also delete the config dir. Refused for
                                ~/.claude — that is your main account.
      --harness claude|cursor   which row, when a Claude account and a Cursor
                                account share the name. A bare name that two
                                rows answer to is refused, never guessed.

  drover account rename <old> <new> [--harness claude|cursor]
      Keeps the config dir and carries the cooldown ledger, so the account's
      headroom history is not silently reset. --harness as for rm.

ADD LOGS IN. An account row with no credential is not a place work can go: a
session there opens Claude Code's first-run wizard, which a wrapped session
cannot answer, so auto-flip would pick a dead account. Adding and logging in
are one action.

THE NAME IS OPTIONAL, and leaving it off is the shorter path. \`drover account
add\` opens the login first and then names the row after the address it logged
in as — clayrisser@gmail.com — so there is no label to invent and no second
name to remember. \`@\` and \`.\` are legal in an account name for exactly that
reason. Naming it yourself still works and is not going away: the accounts
already in the registry are hand-named, and the cooldown ledger and the
whereabouts records key on the name, so renaming them would discard that
history.

Nothing here ever touches a credential. It writes the row, creates an EMPTY
config dir, and launches Claude Code's own login in that environment.

  drover accounts             list them, and which are cooling
`;

/** The refusal shape: `drover account: <what>` on stderr, then an exit code. */
class Die extends Error {
    constructor(readonly text: string, readonly code: number = 2) {
        super(text);
        this.name = 'Die';
    }
}

function die(text: string, code = 2): never {
    throw new Die(text, code);
}

/**
 * Names that would collide with a verb. Refused at creation, because `drover
 * account` resolves a verb BEFORE an account name, so an account called `add`
 * is an account nothing can address.
 */
export function reservedName(name: string): boolean {
    return ['add', 'login', 'rm', 'remove', 'rename', 'mv', 'list', 'ls', 'use', 'help'].includes(name)
        || name.startsWith('-');
}

/**
 * The character set, decided by where a name actually TRAVELS: the registry
 * JSON, a config-dir path component, an argv slot in every verb, a jq --arg,
 * and tmux and launchd command lines.
 *
 *   A-Z a-z 0-9 . _ - @ +  safe in all five. `@` and `.` are what make an
 *                          email address a legal name, which is the whole
 *                          point of naming an account from its login.
 *   /                      REFUSED — the path separator, so `a/b` puts the
 *                          config dir a level down and `../x` walks out.
 *   space, quotes, shell metacharacters
 *                          REFUSED — each is a metacharacter to some shell in
 *                          the chain, and the chain ends in commands a human
 *                          retypes from a help screen.
 *   leading - or .         REFUSED — one reads as an option, the other makes
 *                          the config dir hidden (and `.`/`..` are dirs).
 */
export function validName(name: string): boolean {
    if (name === '') return false;
    if (name.match(/[^A-Za-z0-9._@+-]/)) return false;
    if (name.startsWith('.') || name.startsWith('-')) return false;
    // Longer than any real address, shorter than any filesystem's component
    // limit, so a name can never be the reason mkdir fails.
    return name.length <= 128;
}

const nameRules = `  allowed: letters, digits, and . _ - @ +   (an email address is fine)
  refused: / space quotes and shell metacharacters, and a leading . or -`;

interface Ctx {
    env: NodeJS.ProcessEnv;
    home: string;
    droverDir: string;
    registry: string;
    ledger: string;
    example: string;
    state: string;
    out: (line: string) => void;
    err: (line: string) => void;
}

/** A sibling shell verb's path in the cattle-drover checkout. */
function verbPath(ctx: Ctx, name: string): string {
    return join(ctx.droverDir, 'libexec', name);
}

/** Run a sibling verb for its side effect, never for its status. */
function quietly(path: string): void {
    if (!existsSync(path)) return;
    try {
        spawnSync(path, [], { stdio: 'ignore' });
    } catch {
        // `2>/dev/null || true`, said in node.
    }
}

// --- Claude Code's own answers ------------------------------------------------

/**
 * json_account_credential_ok — is there a CREDENTIAL behind this account, and
 * not only an identity? 0 yes, 1 no, 2 could not tell.
 *
 * ASKED OF CLAUDE CODE, NOT OF THE FILE (DROVE-238). `oauthAccount` in
 * .claude.json is an ADDRESS; the token is a separate write, to the Keychain,
 * and Clay's four phone-added accounts had the first without the second — "I
 * tried to flip to them it actually got stuck on these screens and I had to
 * actually authenticate it in the terminal as it wasn't ACTUALLY
 * authenticated" is this check's absence.
 */
function credentialOk(ctx: Ctx, configDir: string): 0 | 1 | 2 {
    const env = { ...ctx.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    if (isAmbient(configDir, ctx.home)) {
        // UNSET, not ~/.claude: pointing the variable there is a different
        // account entirely. See account-store.ts.
        delete env.CLAUDE_CONFIG_DIR;
    } else {
        env.CLAUDE_CONFIG_DIR = accountDataDir(configDir, ctx.home);
    }
    let res;
    try {
        res = spawnSync('claude', ['auth', 'status'], { env, encoding: 'utf8', timeout: 20_000 });
    } catch {
        return 2;
    }
    if (res.error || typeof res.stdout !== 'string' || res.stdout === '') return 2;
    try {
        const doc: unknown = JSON.parse(res.stdout);
        const v = (doc as Record<string, unknown> | null)?.loggedIn;
        if (v === true) return 0;
        if (v === false) return 1;
        return 2;
    } catch {
        return 2;
    }
}

/**
 * json_account_verify_wait — both halves, and WHY when it fails.
 *
 * THE THREE ANSWERS ARE THE CALLER'S CONTRACT. 0 usable. 1 with `first-run` or
 * `no-credential`, a refusal that names which half. 2 with `unknown`, which is
 * NOT a refusal: it means this machine could not answer, and every caller
 * treats it as a pass.
 *
 * A login has just finished when the waiting form runs, so the probe is being
 * asked about a Keychain item made seconds ago by another process, and a probe
 * that does not come back is not an account that does not work (DROVE-251).
 * Attempts at 0s and then 1, 2, 4, 8, 16, 16 … apart until the budget is
 * spent; the LAST answer wins, not the worst one.
 */
function verifyWait(ctx: Ctx, configDir: string, budget?: number): { rc: 0 | 1 | 2; why: string } {
    // Read FIRST and never retried: it is a key in a file this codebase stamps
    // itself, so it is true the moment the directory is made.
    if (!accountOnboarded(configDir, ctx.home)) return { rc: 1, why: 'first-run' };
    let spend = budget;
    if (spend === undefined) {
        const raw = ctx.env.DROVER_CREDENTIAL_WAIT_S ?? '';
        spend = raw === '' || raw.match(/[^0-9]/) ? 60 : Number(raw);
    }
    const end = Date.now() + spend * 1000;
    let gap = 1;
    for (;;) {
        const rc = credentialOk(ctx, configDir);
        if (rc === 0) return { rc: 0, why: '' };
        if (Date.now() >= end) return { rc, why: rc === 2 ? 'unknown' : 'no-credential' };
        // Sleep without a busy loop, the way the shell's `sleep` does.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, gap * 1000);
        if (gap < 16) gap *= 2;
    }
}

function verify(ctx: Ctx, configDir: string): { rc: 0 | 1 | 2; why: string } {
    return verifyWait(ctx, configDir, 0);
}

/**
 * json_account_settle_first_run — stamp the one-time wizard as settled.
 *
 * ONE key decides it, measured on 2.1.251: hasCompletedOnboarding in the
 * account's global config. Leave it out and every interactive session there
 * starts at "Choose the text style that looks best with your terminal".
 * Never fatal: a config dir that could not be stamped still gets a login.
 */
function settleFirstRun(ctx: Ctx, configDir: string): void {
    const cfg = accountConfigFile(configDir, ctx.home);
    const dir = cfg.slice(0, cfg.lastIndexOf('/'));
    if (!existsSync(dir)) return;
    let version = '';
    try {
        const res = spawnSync('claude', ['--version'], { encoding: 'utf8', timeout: 20_000 });
        if (typeof res.stdout === 'string') version = res.stdout.trim().split(/\s+/)[0] ?? '';
    } catch {
        version = '';
    }
    let doc: Record<string, unknown> = {};
    if (existsSync(cfg)) {
        if (accountOnboarded(configDir, ctx.home)) return;
        try {
            const parsed: unknown = JSON.parse(readFileSync(cfg, 'utf8'));
            if (parsed && typeof parsed === 'object') doc = parsed as Record<string, unknown>;
        } catch {
            return;
        }
    }
    doc.hasCompletedOnboarding = true;
    doc.hasSeenTasksHint = true;
    doc.remoteDialogSeen = true;
    if (version !== '') {
        doc.lastOnboardingVersion = version;
        doc.lastReleaseNotesSeen = version;
    }
    try {
        jsonWrite(cfg, doc);
    } catch {
        // Never fatal. The account just shows the wizard, which is where we were.
    }
}

/**
 * Launch Claude Code's OWN login against a CONFIG DIR.
 *
 * A PLAIN `claude`, never the drover wrapper, and that is the whole reason
 * this is its own function. Measured: `drover account use alt /login` began
 * running happy-cli once the wrapper became the account verb's default
 * program, and happy-cli's session branch does Happy pairing (a QR) plus the
 * daemon before it ever reaches claude. So adding an account dragged you
 * through phone pairing instead of an OAuth login.
 *
 * Run, never rolled back: for a named add the registry row is written FIRST,
 * so a cancelled login leaves an account that exists and is simply not logged
 * in, and `drover account add <name>` finishes the job.
 */
function loginIn(ctx: Ctx, configDir: string): boolean {
    ctx.out('');
    ctx.out('Opening Claude Code\'s login. It takes over this terminal and finishes');
    ctx.out('in your browser — this is not a hang.');
    ctx.out('');
    const env = { ...ctx.env };
    // Subscription auth only: an inherited ANTHROPIC_API_KEY authenticates as
    // the metered API, and /login then has nothing to do.
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    if (isAmbient(configDir, ctx.home)) delete env.CLAUDE_CONFIG_DIR;
    else env.CLAUDE_CONFIG_DIR = accountDataDir(configDir, ctx.home);
    let res;
    try {
        // Failure is expected and survivable (cancelled, no browser, wrong
        // account), so it must not abort the add.
        res = spawnSync('claude', ['/login'], { env, stdio: 'inherit' });
    } catch {
        ctx.err('drover account: claude is not on PATH, so no login can be opened.');
        return false;
    }
    if (res.error && (res.error as NodeJS.ErrnoException).code === 'ENOENT') {
        ctx.err('drover account: claude is not on PATH, so no login can be opened.');
        return false;
    }
    ctx.out('');
    return true;
}

/**
 * Point a brand-new config dir at the shared session store, if there is one
 * (DROVE-59).
 *
 * `drover share-sessions` gave every account ONE projects/ dir so a flip stops
 * copying transcripts (DROVE-40) — but it is a one-shot migration, and nothing
 * re-runs it, so an account added afterwards was the only one on the machine
 * holding a private projects/ and a flip onto it landed in a fresh
 * conversation with none of the history.
 *
 * A REAL DIR IS NEVER REPLACED. Linking over it would hide whatever
 * transcripts are in there; merging two populated trees is the migration's job.
 */
function joinSharedStore(ctx: Ctx, dir: string): void {
    const store = ctx.env.DROVER_SHARED_STORE || `${ctx.home}/.claude-shared`;
    if (!existsSync(`${store}/projects`)) return;
    const link = `${dir}/projects`;
    try {
        if (lstatSync(link).isSymbolicLink()) return;
        if (statSync(link).isDirectory()) {
            ctx.err(`note: ${link} is a real directory, so it was left alone.`);
            ctx.err('  It will not see sessions the other accounts share. To merge it in:');
            ctx.err(`    ${verbPath(ctx, 'drover-share-sessions')} --apply`);
            return;
        }
    } catch {
        // Not there at all, which is the case the link is for.
    }
    try {
        symlinkSync(`${store}/projects`, link);
    } catch {
        // A link we could not make is not a reason to lose the account.
    }
}

/** The temporary login session's name, the same rule the shell writes once. */
export function loginSessionName(slug: string): string {
    return `login-${slug.replace(/[^A-Za-z0-9_-]/g, '-')}`;
}

/**
 * A LOGIN STILL WAITING FOR THIS ACCOUNT GOES WITH IT (DROVE-238).
 *
 * Removing the row is the one exit `drover account login` cannot see for
 * itself: it is blocked on a card nobody is going to answer, for an account
 * that is about to stop existing, and its 15-minute timeout would leave a pane
 * on the login server for a quarter of an hour after the account was gone.
 */
function loginSessionKill(ctx: Ctx, slugs: string[]): boolean {
    const sock = ctx.env.DROVER_LOGIN_SOCKET || 'drover-login';
    let hit = false;
    for (const slug of slugs) {
        if (slug === '') continue;
        const name = loginSessionName(slug);
        try {
            if (spawnSync('tmux', ['-L', sock, 'has-session', '-t', name], { stdio: 'ignore' }).status !== 0) continue;
            if (spawnSync('tmux', ['-L', sock, 'kill-session', '-t', name], { stdio: 'ignore' }).status !== 0) continue;
            hit = true;
        } catch {
            // No tmux is no login session.
        }
    }
    return hit;
}

/**
 * Is a session currently running on this account? Only a POSITIVE answer
 * refuses the removal: a bus that is down cannot prove there is no session,
 * but refusing on an unreachable bus would make the registry uneditable
 * whenever the daemon is stopped — so that case warns and continues, out loud.
 */
async function liveSessionOn(ctx: Ctx, name: string): Promise<boolean> {
    const base = ctx.env.DROVER_URL || droverEnv(ctx.env, ctx.home).droverUrl;
    let body: string;
    try {
        body = (await busGet('/v1/sessions?limit=200', 5000, base)).body;
    } catch {
        ctx.err(`drover account: the bus did not answer, so a live session on '${name}' could not be`);
        ctx.err('  ruled out. Continuing.');
        return false;
    }
    try {
        const doc: unknown = JSON.parse(body);
        const sessions = (doc as { sessions?: unknown[] } | null)?.sessions;
        if (!Array.isArray(sessions)) return false;
        return sessions.some((s) => {
            const row = s as Record<string, unknown> | null;
            return row?.account === name && row?.state !== 'ended';
        });
    } catch {
        return false;
    }
}

// --- registry helpers ---------------------------------------------------------

function readRegistry(ctx: Ctx): AccountRow[] {
    const rows = jsonRead<AccountRow[]>(ctx.registry, []);
    return Array.isArray(rows) ? rows : [];
}

/**
 * Seed the registry from the example when there is none, so a fresh clone can
 * add an account without a copy step. The example itself is never written to.
 */
function ensureRegistry(ctx: Ctx): void {
    if (existsSync(ctx.registry)) return;
    if (existsSync(ctx.example)) {
        try {
            jsonWrite(ctx.registry, JSON.parse(readFileSync(ctx.example, 'utf8')));
        } catch {
            die(`could not seed ${ctx.registry} from ${ctx.example}`);
        }
        ctx.err(`drover account: seeded ${ctx.registry} from accounts.example.json`);
        return;
    }
    try {
        jsonWrite(ctx.registry, []);
    } catch {
        die(`could not create ${ctx.registry}`);
    }
}

/**
 * Which harness's row a bare name means (DROVE-338).
 *
 * An account's identity is (harness, name). One row answers to the name: that
 * one, whatever its harness. Two — a Claude account and a Cursor account that
 * logged in as the same address — and the caller has to say which with
 * --harness, because rm or rename on the wrong one is silent and the two are
 * different things entirely (a config dir with a Keychain item; a token).
 */
function resolveHarness(ctx: Ctx, current: AccountRow[], name: string, asked: string, example: string): string {
    const hits = current.filter((r) => r?.name === name);
    if (hits.length === 0) die(`no account '${name}' in ${ctx.registry} — try: drover accounts`);
    const seen: string[] = [];
    let rows = '';
    for (const r of hits) {
        const h = String(r?.harness ?? 'claude');
        seen.push(h);
        rows += h === 'cursor'
            ? '\n  cursor  (a token, no config dir)'
            : `\n  ${h}  ${accountDirLabel(String(r?.configDir ?? 'default'), ctx.home)}`;
    }
    if (asked !== '') {
        if (seen.includes(asked)) return asked;
        die(`no ${asked} account named '${name}'. What answers to that name:${rows}`);
    }
    if (hits.length > 1) {
        die(`two accounts are named '${name}', one per harness:${rows}\n  Say which one:  drover account ${example} --harness claude   (or --harness cursor)`);
    }
    return seen[0];
}

/**
 * The configDir spelling recorded for an account, "default" when omitted. The
 * CLAUDE row's, by harness (DROVE-338): a cursor row under the same name has
 * no configDir at all and is not where a Claude login lands.
 */
function accountConfigOf(ctx: Ctx, name: string): string {
    let rows: AccountRow[];
    try {
        rows = readRegistry(ctx);
    } catch {
        return 'default';
    }
    const row = accountRow(rows, name, 'claude');
    if (row === undefined) return 'default';
    return String(row.configDir ?? 'default');
}

/**
 * WHERE a configDir spelling actually lands, refusing the ones that land
 * nowhere. Measured before this check existed: `--config-dir default` wrote
 * the row, then created a stray `default/` folder in whatever directory the
 * command was run from, and the account pointed at nothing. "default" is not a
 * wild guess either — it is the spelling accounts.example.json ships.
 */
function resolveConfigDir(ctx: Ctx, spelling: string): string {
    const real = accountDataDir(spelling, ctx.home);
    if (!real.startsWith('/')) {
        die(`--config-dir '${spelling}' is relative, and a config dir has to be
  somewhere fixed — a session starts in a different directory every time.
  Use an absolute path, a ~/ path, or the word 'default' for the account you
  are already logged into.`);
    }
    return real;
}

/** Legal (two names for one login) but almost always a typo, so it warns. */
function warnSharedConfigDir(ctx: Ctx, current: AccountRow[], spelling: string): void {
    const names = current.filter((r) => r?.configDir === spelling).map((r) => String(r?.name));
    if (names.length === 0) return;
    ctx.err(`drover account: warning — ${spelling} is already used by: ${names.join(', ')}`);
    ctx.err('  two accounts on one config dir are ONE login; a flip between them moves nothing.');
}

/**
 * The config dir an UNNAMED add logs into. Serial, not the address, and that
 * is forced rather than chosen: the Keychain item is keyed to the PATH, so
 * logging in somewhere and then renaming the directory to the address would
 * orphan the credential while the account went on reading as logged in.
 *
 * Serial numbers are reused rather than accumulated: an add whose login was
 * cancelled leaves account-N holding no login and no row, and the next run
 * takes that one back instead of leaving a trail of empty directories.
 */
function nextConfigDir(ctx: Ctx, current: AccountRow[]): string | null {
    for (let n = 1; n <= 999; n += 1) {
        const spelled = `~/.claude-accounts/account-${n}`;
        const abs = expandHome(spelled, ctx.home);
        const taken = current.some((r) => r?.configDir === spelled || r?.configDir === abs);
        if (!taken && !accountLoggedIn(spelled, ctx.home)) return spelled;
    }
    return null;
}

/** The named add's login: log in, then say honestly whether it took. */
function doLogin(ctx: Ctx, name: string): void {
    const cfg = accountConfigOf(ctx, name);
    settleFirstRun(ctx, cfg);
    loginIn(ctx, cfg);
    // The behavioural check, not the file (DROVE-246): "there is an
    // oauthAccount key" and "a session can start here" are different claims,
    // and printing the first as though it were the second is what put Clay in
    // a theme picker. The _wait spelling because a login just finished.
    const { rc, why } = verifyWait(ctx, cfg);
    if (rc === 0) {
        ctx.out(`'${name}' is logged in, and a session there starts.`);
    } else if (rc === 2) {
        ctx.out(`'${name}' looks logged in, but this shell has no claude to confirm it with.`);
    } else if (why === 'first-run') {
        ctx.out(`'${name}' is logged in but has NOT been through Claude Code's first run, so a`);
        ctx.out('  session there opens the theme picker. Settle it with:  drover trust');
    } else {
        ctx.out(`'${name}' exists in the registry but is still NOT logged in.`);
        ctx.out('  A flip cannot land there until it is. Run again when ready:');
        ctx.out(`    drover account add ${name}`);
    }
}

// --- add ----------------------------------------------------------------------

interface AddOptions {
    configdir: string;
    flipprompt: string;
    haveprompt: boolean;
    login: boolean;
}

function appendRow(current: AccountRow[], name: string, configDir: string, opts: AddOptions): AccountRow[] {
    const row: AccountRow = opts.haveprompt
        ? { name, configDir, flipPrompt: opts.flipprompt }
        : { name, configDir };
    return [...current, row];
}

/**
 * `drover account add` with NO name: the account names itself.
 *
 * The order is the reverse of the named path, and it has to be — there is
 * nothing to call a row until somebody has logged in. So: pick the dir, log
 * in, read the address Claude Code recorded, and only then write the row.
 * Nothing reaches the registry before the login, so a cancelled one leaves it
 * exactly as it was.
 */
function addAuto(ctx: Ctx, current: AccountRow[], opts: AddOptions): void {
    if (!opts.login) {
        die(`add with no name has to log in, because the name COMES from the
  login. Drop --no-login, or name it yourself: drover account add <name>`);
    }
    let configdir = opts.configdir;
    if (configdir === '') {
        const picked = nextConfigDir(ctx, current);
        if (picked === null) {
            die(`every ~/.claude-accounts/account-N up to 999 is taken — name this
  one yourself: drover account add <name>`);
        }
        configdir = picked;
    }
    const real = resolveConfigDir(ctx, configdir);
    warnSharedConfigDir(ctx, current, configdir);

    // An EMPTY dir, and nothing else. Claude Code's login puts the credential
    // in it or in the keychain keyed to it; the drover never handles one.
    mkdirSync(real, { recursive: true });
    joinSharedStore(ctx, real);
    // Settle Claude Code's first run before anything opens on this directory
    // (DROVE-246): loginIn runs `claude /login`, which is the REPL, so an
    // unsettled dir puts the theme picker in front of the login.
    settleFirstRun(ctx, configdir);
    if (!loginIn(ctx, configdir)) {
        die(`no login was opened, so there is no address to name an account
  after. Nothing was written to ${ctx.registry}.`, 1);
    }

    const mail = accountEmail(configdir, ctx.home);
    if (mail === undefined) {
        die(`the login did not finish, so there is no address to name the account
  after. Nothing was written to ${ctx.registry}.
  The config dir is ${real} — run \`drover account add\` again to reuse it, or
  name it yourself:  drover account add <name> --config-dir ${configdir}`, 1);
    }

    // The row is conditional on a REAL check, not on a key appearing in a file
    // (DROVE-246). Exit 2 means the check could not RUN — or was asked and did
    // not answer (DROVE-251) — and that is not the same as failing it.
    const { rc, why } = verifyWait(ctx, configdir);
    if (rc === 1) {
        if (why === 'first-run') {
            die(`logged in as '${mail}', but ${real} has not been through Claude Code's first
  run, so a session there opens the theme picker instead of a prompt. Nothing
  was written to ${ctx.registry}. Run \`drover trust\`, then add it again.`, 1);
        }
        die(`logged in as '${mail}', but Claude Code does not read ${real} as signed in
  — \`claude auth status\` says no, so the credential is not where a session
  would look for it. Nothing was written to ${ctx.registry}.`, 1);
    }

    // The address is a name now, so it answers to the name rules like any
    // other. An address cannot collide with a verb — every one has an `@` and
    // no verb does — but the check is cheap and the verb list is not frozen.
    if (!validName(mail)) {
        die(`logged in as '${mail}', which is not a usable account name.
${nameRules}
  Name it yourself instead:  drover account add <name> --config-dir ${configdir}`);
    }
    if (reservedName(mail)) {
        die(`logged in as '${mail}', which is a reserved verb — name it
  yourself:  drover account add <name> --config-dir ${configdir}`);
    }

    // Re-read: the login just held the terminal for as long as a human took,
    // and another drover may have edited the registry in that window.
    const fresh = readRegistry(ctx);
    // A CLAUDE row with this address is the duplicate; a cursor row with it is
    // a different account and does not block this one (DROVE-338). And the
    // refusal names the row's REAL directory, never the raw "default".
    const takenRow = accountRow(fresh, mail, 'claude');
    if (takenRow !== undefined) {
        const taken = String(takenRow.configDir ?? 'default');
        die(`'${mail}' is already in ${ctx.registry}, pointing at ${accountDirLabel(taken, ctx.home)}.
  Nothing was changed — a second row would silently shadow the first, and the
  cooldown ledger keys on the name, so the two would share one another's
  headroom history.
  Use the one that is already there:  drover account use ${mail}
  Or keep this second login under a name of its own:
    drover account add <name> --config-dir ${configdir}
  This login landed in ${real} and still holds a credential, so \`drover accounts\`
  lists it as an orphan until you name it or remove it (DROVE-251). To move the
  account onto it instead:
    drover account rm ${mail} --harness claude && drover account add ${mail} --config-dir ${configdir}`, 1);
    }

    try {
        jsonWrite(ctx.registry, appendRow(fresh, mail, configdir, opts));
    } catch {
        die(`could not write ${ctx.registry}`, 1);
    }
    // Give the new account /flip straight away rather than at its second run.
    quietly(verbPath(ctx, 'drover-sync-commands'));

    ctx.out(`added '${mail}' -> ${configdir}`);
    ctx.out('named from the login, so there is nothing to remember it by but the address:');
    ctx.out(`  drover account use ${mail}`);
}

function cmdAdd(ctx: Ctx, args: string[]): number {
    // The name is OPTIONAL, and it is only ever the FIRST argument: anything
    // starting with `-` is an option, so `drover account add --config-dir /x`
    // is an unnamed add and not a name of "--config-dir".
    let name = '';
    let rest = args;
    if (rest.length > 0 && rest[0] !== '' && !rest[0].startsWith('-')) {
        name = rest[0];
        rest = rest.slice(1);
    }
    if (name !== '') {
        if (!validName(name)) die(`'${name}' is not a usable account name.\n${nameRules}`);
        if (reservedName(name)) die(`'${name}' is a reserved word — pick another name`);
    }

    const opts: AddOptions = { configdir: '', flipprompt: '', haveprompt: false, login: true };
    for (let i = 0; i < rest.length;) {
        const arg = rest[i];
        if (arg === '--config-dir') {
            if (!rest[i + 1]) die('--config-dir needs a path');
            opts.configdir = rest[i + 1];
            i += 2;
        } else if (arg === '--flip-prompt') {
            if (!rest[i + 1]) die('--flip-prompt needs text');
            opts.flipprompt = rest[i + 1];
            opts.haveprompt = true;
            i += 2;
        } else if (arg === '--flip-prompt-file') {
            if (!rest[i + 1]) die('--flip-prompt-file needs a path');
            if (!existsSync(rest[i + 1])) die(`no readable file at ${rest[i + 1]}`);
            opts.flipprompt = readFileSync(rest[i + 1], 'utf8');
            opts.haveprompt = true;
            i += 2;
        } else if (arg === '--no-login') {
            opts.login = false;
            i += 1;
        } else if (arg === '--login') {
            // Accepted and ignored: it was the old opt-in and is now the
            // default. Refusing it would break a command somebody has in a
            // note somewhere for no gain.
            i += 1;
        } else if (arg === '-h' || arg === '--help') {
            ctx.out(usage.replace(/\n$/, ''));
            return 0;
        } else {
            die(`unknown option '${arg}' for add`);
        }
    }

    ensureRegistry(ctx);
    const current = readRegistry(ctx);

    if (name === '') {
        addAuto(ctx, current, opts);
        return 0;
    }

    // Never silently repoint an existing account. A second `add alt` pointing
    // somewhere else would move a logged-in subscription's config dir out from
    // under it and read as a no-op.
    //
    // A CLAUDE row, specifically (DROVE-338). This verb makes Claude accounts,
    // so a cursor row that happens to carry the same address is not "already
    // there"; it is a different account and the two may share the name.
    const haveRow = accountRow(current, name, 'claude');
    if (haveRow !== undefined) {
        // Already there. The natural way to reach this is a first `add` whose
        // login was cancelled, so it RECOVERS rather than erroring flatly.
        const have = String(haveRow.configDir ?? 'default');
        const haveAt = accountDirLabel(have, ctx.home);
        if (accountLoggedIn(have, ctx.home)) {
            ctx.out(`'${name}' already exists at ${haveAt} and is logged in — nothing to do.`);
            ctx.out(`  To point it somewhere else:  drover account rm ${name} --harness claude && drover account add ${name} --config-dir <path>`);
            return 0;
        }
        ctx.out(`'${name}' already exists at ${haveAt} but is NOT logged in.`);
        if (!opts.login) {
            ctx.out(`  Log it in with:  drover account add ${name}`);
            return 0;
        }
        doLogin(ctx, name);
        return 0;
    }

    const configdir = opts.configdir !== '' ? opts.configdir : `~/.claude-accounts/${name}`;
    const real = resolveConfigDir(ctx, configdir);
    warnSharedConfigDir(ctx, current, configdir);

    try {
        jsonWrite(ctx.registry, appendRow(current, name, configdir, opts));
    } catch {
        die(`could not write ${ctx.registry}`, 1);
    }

    // An EMPTY dir, and nothing else. `real` was resolved above, so the ambient
    // spelling creates nothing new — ~/.claude is already there.
    mkdirSync(real, { recursive: true });
    joinSharedStore(ctx, real);
    // The named path writes the row FIRST by design, so this row can
    // legitimately exist before any login — but it must never be a row whose
    // only problem is a theme picker (DROVE-246).
    settleFirstRun(ctx, configdir);
    quietly(verbPath(ctx, 'drover-sync-commands'));

    ctx.out(`added '${name}' -> ${configdir}`);
    if (opts.login) {
        doLogin(ctx, name);
        return 0;
    }
    ctx.out('');
    // ASKED, not assumed. --no-login means "do not open a login", not "there is
    // no login" — a second name pointed at an already-authenticated dir (the
    // ambient one especially) is logged in the moment the row is written.
    const { rc, why } = verify(ctx, configdir);
    if (rc === 0 || rc === 2) {
        ctx.out('That config dir is already logged in, so a flip can land there.');
    } else if (why === 'first-run') {
        ctx.out('It is logged in but has not been through Claude Code\'s first run, so a');
        ctx.out('flip would land in the theme picker. Settle it with:  drover trust');
    } else {
        ctx.out('It is NOT logged in, so a flip cannot land there yet. Log it in with:');
        ctx.out(`  drover account add ${name}`);
    }
    return 0;
}

// --- rm -----------------------------------------------------------------------

async function cmdRm(ctx: Ctx, args: string[]): Promise<number> {
    const name = args[0] ?? '';
    if (name === '') die('rm needs a name: drover account rm <name>');
    let purge = false;
    let harness = '';
    for (let i = 1; i < args.length;) {
        const arg = args[i];
        if (arg === '--purge') {
            purge = true;
            i += 1;
        } else if (arg === '--harness') {
            if (!args[i + 1]) die('--harness needs a value: claude or cursor');
            harness = args[i + 1];
            i += 2;
        } else if (arg === '-h' || arg === '--help') {
            ctx.out(usage.replace(/\n$/, ''));
            return 0;
        } else {
            die(`unknown option '${arg}' for rm`);
        }
    }

    if (!existsSync(ctx.registry)) die(`no registry at ${ctx.registry}`);
    const current = readRegistry(ctx);

    // WHICH ROW (DROVE-338). A name one row answers to is that row; a name a
    // Claude row and a Cursor row share needs --harness, and is refused
    // otherwise rather than removing whichever came first.
    const hns = resolveHarness(ctx, current, name, harness, `rm ${name}`);
    const row = accountRow(current, name, hns);

    // A cursor row has no configDir at all, and every path below that treats
    // one as a directory would be talking about a directory that does not
    // exist (DROVE-256).
    const dir = hns === 'cursor' ? '' : String(row?.configDir ?? 'default');

    if (current.length <= 1) {
        die(`'${name}' is the only account — removing it would leave the drover
  with nowhere to run. Add another first: drover account add <name>`);
    }

    if (await liveSessionOn(ctx, name)) {
        die(`a live session is running on '${name}'.
  Removing it now would leave that session pointing at an account the registry
  no longer knows, and a flip out of it would refuse. Let it finish, or flip it
  first: drover flip --all`);
    }

    const real = dir === '' ? '' : accountDataDir(dir, ctx.home);
    // Both spellings, because a login is named after whichever the caller used:
    // `drover account login alt` is login-alt and a nameless add that landed on
    // this row's directory is login-account-3. A nameless cursor login is named
    // after the placeholder `cursor`, and that one is only in the list when
    // this row is a cursor account — otherwise removing any Claude account
    // would reap an unrelated cursor login.
    const slugs = [name];
    if (real !== '') slugs.push(basename(real));
    if (hns === 'cursor') slugs.push('cursor');
    if (loginSessionKill(ctx, slugs)) {
        ctx.out(`drover account: ended the login that was waiting for '${name}'`);
    }

    // THE TOKEN GOES WITH THE ROW (DROVE-256). A cursor account keeps its
    // secret in the token store rather than in a config dir, so removing the
    // row and leaving the token behind would keep a live subscription
    // credential on disk that nothing points at any more. Unconditional, not
    // gated on --purge: --purge is about a DIRECTORY full of transcripts, and
    // this is one line in a store that is worth nothing without the row.
    if (hns === 'cursor') {
        if (!cursorAuthForget(cursorAuthStore(ctx.state, ctx.env), name)) {
            ctx.err(`drover account: could not drop the cursor token for '${name}'`);
        }
    }

    if (purge && hns !== 'cursor') {
        // ~/.claude is the main account and holds everything Claude Code has
        // ever stored for Clay. Deleting it is never what someone meant by
        // "remove this entry from a list".
        const main = `${ctx.home}/.claude`;
        if ([main, `${main}/`, ctx.home, `${ctx.home}/`, '/', ''].includes(real)) {
            die(`refusing --purge on ${real} — that is your main Claude config dir.
  Remove the registry entry without it:  drover account rm ${name}`);
        }
        if (!existsSync(real)) ctx.err(`drover account: nothing at ${real} to purge`);
    }

    // ONLY THAT HARNESS'S ROW GOES. The other harness's row under the same
    // name, if there is one, is a different account and stays.
    const next = current.filter((r) => r?.name !== name || String(r?.harness ?? 'claude') !== hns);
    try {
        jsonWrite(ctx.registry, next);
    } catch {
        die(`could not write ${ctx.registry}`, 1);
    }

    // The ledger keys on the account NAME, so a stale entry would apply this
    // account's cooldown to a future account that reuses the name.
    //
    // A CLAUDE row's entry only (DROVE-338). The ledger is Claude's, so
    // removing a cursor row must not take the cooldown history of the Claude
    // account that shares its name.
    if (hns === 'claude' && existsSync(ctx.ledger)) {
        try {
            const led = jsonRead<Record<string, LedgerEntry>>(ctx.ledger, {});
            delete led[name];
            jsonWrite(ctx.ledger, led);
        } catch {
            ctx.err(`drover account: could not update the cooldown ledger at ${ctx.ledger}`);
        }
    }

    ctx.out(`removed '${name}' from ${ctx.registry}`);
    if (hns === 'cursor') {
        ctx.out('its cursor token was dropped from the token store as well.');
        ctx.out('note: the subscription itself is untouched — this only forgets the login.');
    } else if (purge && existsSync(real)) {
        rmSync(real, { recursive: true, force: true });
        ctx.out(`purged ${real}`);
        ctx.out('note: on macOS the login itself lives in the keychain, not that directory.');
        ctx.out('  Remove it there if you want the subscription fully forgotten.');
    } else {
        ctx.out(`the config dir was left alone: ${real}`);
        ctx.out(`  delete it too with: drover account rm ${name} --purge`);
    }
    return 0;
}

// --- rename -------------------------------------------------------------------

function cmdRename(ctx: Ctx, args: string[]): number {
    const old = args[0] ?? '';
    const fresh = args[1] ?? '';
    if (old === '' || fresh === '') die('rename needs both names: drover account rename <old> <new>');
    let harness = '';
    for (let i = 2; i < args.length;) {
        const arg = args[i];
        if (arg === '--harness') {
            if (!args[i + 1]) die('--harness needs a value: claude or cursor');
            harness = args[i + 1];
            i += 2;
        } else if (arg === '-h' || arg === '--help') {
            ctx.out(usage.replace(/\n$/, ''));
            return 0;
        } else {
            die(`unknown option '${arg}' for rename`);
        }
    }
    if (!validName(fresh)) die(`'${fresh}' is not a usable account name (letters, digits, . _ - only)`);
    if (reservedName(fresh)) die(`'${fresh}' is a reserved word — pick another name`);

    if (!existsSync(ctx.registry)) die(`no registry at ${ctx.registry}`);
    const current = readRegistry(ctx);

    // WHICH ROW, and the new name must be free WITHIN THAT HARNESS
    // (DROVE-338): a Claude account may take a name a cursor account already
    // has, and the other way round, because the two never shadow each other.
    const hns = resolveHarness(ctx, current, old, harness, `rename ${old} ${fresh}`);
    if (accountRow(current, fresh, hns) !== undefined) {
        die(`'${fresh}' already exists as a ${hns} account — pick another name`);
    }

    // configDir is untouched on purpose: renaming is a relabelling, and moving
    // the dir would invalidate the login keyed to it.
    const next = current.map((r) => (
        r?.name === old && String(r?.harness ?? 'claude') === hns ? { ...r, name: fresh } : r
    ));
    try {
        jsonWrite(ctx.registry, next);
    } catch {
        die(`could not write ${ctx.registry}`, 1);
    }

    // CARRY THE LEDGER. It keys on the name, so a rename that ignored it would
    // silently reset the account's headroom history — the drover would then
    // send work to a subscription it had just watched hit a limit, which is the
    // one thing the ledger exists to prevent. A Claude row's only.
    let carried = false;
    if (hns === 'claude' && existsSync(ctx.ledger)) {
        let led: Record<string, LedgerEntry> | null = null;
        try {
            led = jsonRead<Record<string, LedgerEntry>>(ctx.ledger, {});
        } catch {
            led = null;
        }
        if (led !== null && Object.prototype.hasOwnProperty.call(led, old)) {
            led[fresh] = led[old];
            delete led[old];
            try {
                jsonWrite(ctx.ledger, led);
            } catch {
                die(`renamed in the registry but could NOT carry the cooldown ledger at ${ctx.ledger}`, 1);
            }
            carried = true;
        }
    }

    ctx.out(`renamed '${old}' -> '${fresh}'`);
    if (carried) ctx.out('carried its cooldown entry, so its headroom history is intact');
    ctx.out('the config dir is unchanged — the login is keyed to that path, not to the name');
    return 0;
}

// --- the verb -----------------------------------------------------------------

export function editContext(env: NodeJS.ProcessEnv = process.env): Ctx {
    const h = homeOf(env);
    const droverDir = droverEnv(env, h).droverDir;
    const state = stateDir(env, h);
    return {
        env,
        home: h,
        droverDir,
        registry: env.DROVER_ACCOUNTS || join(droverDir, 'accounts.json'),
        ledger: join(state, 'cooldowns.json'),
        example: join(droverDir, 'accounts.example.json'),
        state,
        out: (line) => process.stdout.write(`${line}\n`),
        err: (line) => process.stderr.write(`${line}\n`),
    };
}

export async function run(args: string[], ctx: Ctx = editContext()): Promise<number> {
    const verb = args[0] ?? '';
    try {
        if (verb === 'add') return cmdAdd(ctx, args.slice(1));
        if (verb === 'rm' || verb === 'remove') return await cmdRm(ctx, args.slice(1));
        if (verb === 'rename' || verb === 'mv') return cmdRename(ctx, args.slice(1));
        if (verb === '-h' || verb === '--help' || verb === '') {
            ctx.out(usage.replace(/\n$/, ''));
            return 0;
        }
        die(`unknown verb '${verb}' (add, rm, rename)`);
    } catch (error) {
        if (error instanceof Die) {
            ctx.err(`drover account: ${error.text}`);
            return error.code;
        }
        throw error;
    }
}
