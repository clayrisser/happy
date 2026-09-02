/**
 * `drover account` — one noun, explicit verbs (ported at DROVE-315 wave 2a).
 *
 * The shape used to be `drover account <name> [args...]` and nothing else, and
 * that shape cannot be extended. Its first argument is a VALUE, so it can
 * never also be a verb or a flag: `drover account --help` answered "no account
 * '--help' in accounts.json", which is the bug that proves the point.
 *
 * RESOLUTION ORDER, and it is deliberate:
 *   1. help flags        — --help, -h, help. Always help, at every level.
 *   2. an exact VERB     — list, add, rm, remove, rename, mv, use.
 *   3. an ACCOUNT NAME   — anything in the registry.
 *   4. otherwise         — an error that says which of the two it tried to be,
 *                          and lists both the verbs and the known accounts.
 * A verb WINS over a same-named account, which is why `add` refuses to create
 * an account named after a verb: the ambiguity is removed at the only moment
 * it can be. `use` is the unambiguous form for scripts.
 *
 * One CLAUDE_CONFIG_DIR per account, each logged in with its own
 * SUBSCRIPTION. This wrapper never sets — and actively clears —
 * ANTHROPIC_API_KEY, so every session bills the subscription that account is
 * logged into, never a metered API key.
 */

import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
    type AccountRow,
    accountDataDir,
    accountLoggedIn,
    home as homeOf,
    isAmbient,
} from './account-store';
import { stateDir } from './accounts';
import { droverEnv } from './env';

const usage = `drover account — the Claude subscriptions, and the sessions that run on them.

USAGE
  drover account                      List accounts: which is current, which
                                      are cooling, which have no login yet.
  drover account list [--json]        The same, said explicitly.
  drover account use <name> [args]    Run a session on that account. Managed:
                                      it goes through the drover wrapper, so
                                      /flip and the phone work.
  drover account <name> [args]        The same, when <name> is not a verb.
  drover account <name> -- [args]     Escape hatch: a plain, UNMANAGED claude
                                      on that account. /flip cannot move it.
  drover --account <name> [args]      The managed form again, from ANYWHERE in
  drover --account=<name> [args]      the args, next to your claude flags. An
  drover -a <name> [args]             explicit account overrules the cooldown
                                      ledger, so it starts even when every
                                      account is cooling.
      drover --resume --account main

  drover account add                  Log in, then name the account after the
                                      address you logged in as. No name to
                                      invent, so this is the short path.
  drover account add <name> [options] The same, named by hand. The accounts
                                      already in the registry are hand-named
                                      and stay that way: the cooldown ledger
                                      and the whereabouts records key on the
                                      name.
      --config-dir <path>             where its CLAUDE_CONFIG_DIR lives
                                      (default ~/.claude-accounts/<name>)
      --flip-prompt <text>            what a session is told on arrival
      --flip-prompt-file <path>       the same, read from a file
      --no-login                      just the row and the dir; print the
                                      command to log in later. Not available
                                      unnamed — the name comes from the login.

  drover account login [name]         Add and log in WITHOUT the terminal: the
                                      URL Claude Code prints goes to the phone
                                      as a bus question and the code comes back
                                      as its answer. This is the one that works
                                      when you are not at the Mac (DROVE-61).
      --config-dir <path>             which config dir to log into
      --timeout <seconds>             how long the phone has to answer (900)
      --session <id>                  attach the prompt to a session
      --local                         let the Mac's browser open as well

  drover account rm <name> [--purge]  Remove the row. --purge deletes the
                                      config dir too; refused for ~/.claude.
  drover account rename <old> <new>   Relabel, carrying the cooldown ledger
                                      so headroom history is not reset.

  drover accounts                     Alias for \`drover account list\`.

A verb wins over an account of the same name, so \`use\` is the unambiguous
form. \`add\` refuses to create an account named after a verb — which an
auto-named one never is, since every address has an \`@\` and no verb does.

An account with no login is not a place work can go — a session there opens
Claude Code's first-run wizard, which a wrapped session cannot answer. That is
why \`add\` logs in by default, and why auto-flip skips such accounts.
`;

interface Ctx {
    env: NodeJS.ProcessEnv;
    home: string;
    droverDir: string;
    registry: string;
    state: string;
}

function context(env: NodeJS.ProcessEnv = process.env): Ctx {
    const h = homeOf(env);
    const droverDir = droverEnv(env, h).droverDir;
    return {
        env,
        home: h,
        droverDir,
        registry: env.DROVER_ACCOUNTS || join(droverDir, 'accounts.json'),
        state: stateDir(env, h),
    };
}

function readRegistry(ctx: Ctx): AccountRow[] {
    try {
        const parsed: unknown = JSON.parse(readFileSync(ctx.registry, 'utf8'));
        return Array.isArray(parsed) ? parsed as AccountRow[] : [];
    } catch {
        return [];
    }
}

function knownAccounts(ctx: Ctx): string[] {
    return readRegistry(ctx)
        .map((r) => (r?.name === undefined || r?.name === null ? '' : String(r.name)))
        .filter((n) => n !== '');
}

/** `known_accounts | tr '\n' ' '`: every name, each followed by one space. */
function listed(ctx: Ctx): string {
    return knownAccounts(ctx).map((n) => `${n} `).join('');
}

function accountExists(ctx: Ctx, name: string): boolean {
    return readRegistry(ctx).some((r) => r?.name === name);
}

/** A sibling shell verb's path in the cattle-drover checkout. */
function verbPath(ctx: Ctx, name: string): string {
    return join(ctx.droverDir, 'libexec', name);
}

/** `command -v <name>`, without a shell. */
function onPath(name: string, env: NodeJS.ProcessEnv): boolean {
    if (name.includes('/')) {
        try {
            accessSync(name, constants.X_OK);
            return statSync(name).isFile();
        } catch {
            return false;
        }
    }
    for (const dir of (env.PATH ?? '').split(':')) {
        if (dir === '') continue;
        try {
            accessSync(join(dir, name), constants.X_OK);
            return true;
        } catch {
            // Next.
        }
    }
    return false;
}

/**
 * MANAGED BY DEFAULT. This used to run `claude` directly, which meant a
 * session started with `drover account <name>` had no DROVER_WRAPPER_PID and
 * so /flip answered "this session is not drover-managed" — from the drover's
 * own verb. Everything this tool exists to do (flip, the bus, the phone) needs
 * the wrapper, so the wrapper is what a bare invocation gets.
 *
 * The first remaining argument is still treated as a PROGRAM if it does not
 * start with `-` and resolves on PATH, so `drover account main -p "hi"` and
 * `drover account main "fix the bug"` pass through unchanged. `--` is the
 * escape hatch to a plain unmanaged claude.
 */
function runSession(ctx: Ctx, args: string[]): number {
    const acct = args[0] ?? '';
    if (acct === '') {
        process.stderr.write('drover account use: needs an account name (try: drover account list)\n');
        return 2;
    }
    let rest = args.slice(1);

    const registry = readRegistry(ctx);
    if (!registry.some((r) => r?.name === acct)) {
        process.stderr.write(`drover account: no account '${acct}' in ${ctx.registry}\n`);
        process.stderr.write(`  known accounts: ${listed(ctx)}\n`);
        process.stderr.write(`  add it with: drover account add ${acct}\n`);
        return 2;
    }

    // A CURSOR ACCOUNT IS NOT RUNNABLE HERE (DROVE-256), and this refusal is
    // the difference between a clear no and a silent wrong answer. A cursor row
    // carries no configDir, so the `// "default"` below would read it as the
    // AMBIENT account and start a Claude session on Clay's main login under a
    // cursor account's name — billing the wrong subscription and reporting the
    // wrong one.
    //
    // THE CLAUDE ROW WINS HERE (DROVE-338). This verb starts Claude Code
    // sessions, so when a Claude row and a cursor row share the name the Claude
    // one is the account meant. Only a name that NOTHING but a cursor row
    // answers to is refused.
    const harnesses = registry.filter((r) => r?.name === acct).map((r) => String(r?.harness ?? 'claude'));
    const hns = harnesses.includes('claude') ? 'claude' : (harnesses[0] ?? 'claude');
    if (hns === 'cursor') {
        process.stderr.write(`drover account use: '${acct}' is a cursor account, and this command starts\n`);
        process.stderr.write('  Claude Code sessions. Cursor sessions get their own token instead of a\n');
        process.stderr.write('  config dir, so they are started with:\n');
        process.stderr.write('\n');
        process.stderr.write(`      drover cursor --account ${acct}\n`);
        return 2;
    }

    // `// "default"` so a row that omits configDir means the ambient account
    // rather than reading as a missing field.
    const claudeRow = registry.find((r) => r?.name === acct && String(r?.harness ?? 'claude') === 'claude');
    const cfg = String(claudeRow?.configDir ?? 'default');

    // The AMBIENT account is the one you are already logged into, and it is
    // reached by leaving CLAUDE_CONFIG_DIR UNSET — not by pointing it at
    // ~/.claude, which moves the global config to an empty file and hands you a
    // never-logged-in account.
    const dir = accountDataDir(cfg, ctx.home);
    mkdirSync(dir, { recursive: true });

    // The wrapper, by absolute path: `drover` may not be on PATH in the
    // environment a hook or a launchd job hands us, and falling back to a bare
    // `claude` on a lookup miss is what silently produced unmanaged sessions.
    let prog = join(ctx.droverDir, 'bin', 'drover');
    if (rest[0] === '--') {
        // Explicitly unmanaged: a plain claude on this account, no wrapper.
        // `drover account add` logs in through here on purpose — a /login run
        // through the wrapper reaches happy-cli's session branch and asks for
        // Happy pairing instead.
        prog = 'claude';
        rest = rest.slice(1);
    } else if ((rest[0] ?? '') !== '' && !rest[0].startsWith('-') && onPath(rest[0], ctx.env)) {
        prog = rest[0];
        rest = rest.slice(1);
    }

    const env = { ...ctx.env };
    // Subscription auth only. An inherited API key would silently bill the API.
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;

    // Keep /flip installed in every account's config dir. Even this UNMANAGED
    // path gets it: a plain claude with /flip defined answers "this session is
    // not drover-managed" through the command itself, which beats the TUI's
    // "Unknown command: /flip" telling the user nothing.
    const sync = verbPath(ctx, 'drover-sync-commands');
    if (existsSync(sync)) {
        try {
            spawnSync(sync, [], { stdio: 'ignore' });
        } catch {
            // `2>/dev/null || true`.
        }
    }
    // And accept the workspace trust dialog, for the same reason bin/drover
    // does: it defaults to "No, exit" and a wrapped session cannot answer it.
    const trust = verbPath(ctx, 'drover-trust');
    if (existsSync(trust)) {
        try {
            spawnSync(trust, [process.cwd()], { stdio: 'ignore' });
        } catch {
            // As above.
        }
    }

    // Say so BEFORE the session starts when this account cannot actually run.
    // Without this the session opens straight into Claude Code's first-run
    // wizard with no hint of why, which is exactly what a flip onto an
    // unlogged account looked like: the drover working perfectly and the
    // screen showing a theme picker.
    //
    // ASKED OF CLAUDE CODE, NOT OF THE FILE (DROVE-238): `oauthAccount` is an
    // ADDRESS, and the token is a separate write to the Keychain that a
    // phone-driven login does not always make.
    const cred = credentialOk(ctx, cfg);
    const onFile = accountLoggedIn(cfg, ctx.home);
    if (cred === 1 && onFile) {
        process.stderr.write(`drover account: '${acct}' has an address on file but no usable credential.\n`);
        process.stderr.write('  Claude Code will ask you to log in again. On macOS the token lives in\n');
        process.stderr.write('  the Keychain, and a login driven from the phone does not always write\n');
        process.stderr.write(`  one. Finish it here:  drover account add ${acct}\n`);
    } else if (cred !== 0 && !onFile) {
        process.stderr.write(`drover account: '${acct}' has never been logged in.\n`);
        process.stderr.write('  Claude Code will open its first-run wizard; complete it to log in.\n');
        process.stderr.write(`  Or cancel and run: drover account add ${acct}\n`);
    }

    env.DROVER_ACCOUNT = acct;
    if (isAmbient(cfg, ctx.home)) {
        // UNSET, explicitly. Not setting it is not the same as clearing it when
        // this wrapper was launched from a session that had one — the child
        // would inherit the old account's config dir.
        delete env.CLAUDE_CONFIG_DIR;
    } else {
        env.CLAUDE_CONFIG_DIR = dir;
    }
    const res = spawnSync(prog, rest, { env, stdio: 'inherit' });
    if (res.error) {
        process.stderr.write(`drover account: could not start ${prog}\n`);
        return 127;
    }
    return res.status ?? 0;
}

/** The `claude auth status` probe, as `use` asks it. 0 yes, 1 no, 2 unknown. */
function credentialOk(ctx: Ctx, configDir: string): 0 | 1 | 2 {
    const env = { ...ctx.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    if (isAmbient(configDir, ctx.home)) delete env.CLAUDE_CONFIG_DIR;
    else env.CLAUDE_CONFIG_DIR = accountDataDir(configDir, ctx.home);
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

export async function run(args: string[]): Promise<number> {
    const ctx = context();
    const verb = args[0] ?? '';

    if (verb === '-h' || verb === '--help' || verb === 'help') {
        process.stdout.write(usage);
        return 0;
    }
    if (verb === '' || verb === 'list' || verb === 'ls') {
        const { run: accounts } = await import('./accounts');
        return accounts(verb === '' ? args : args.slice(1));
    }
    if (verb === 'add' || verb === 'rm' || verb === 'remove' || verb === 'rename' || verb === 'mv') {
        const { run: edit } = await import('./account-edit');
        return edit(args);
    }
    if (verb === 'login') {
        // Its own script, and it STAYS SHELL for now (DROVE-315 wave 2b owns
        // the flip family and the browser/pty login flow). `add` runs Claude
        // Code's login IN THE TERMINAL and blocks on it; this one has no
        // terminal at all — it reads the URL off a pipe and takes the code off
        // the bus. One file doing both would have to branch at every step.
        const path = verbPath(ctx, 'drover-account-login');
        if (!existsSync(path)) {
            process.stderr.write(`drover account: no login verb at ${path}\n`);
            return 2;
        }
        const res = spawnSync(path, args.slice(1), { stdio: 'inherit' });
        return res.status ?? 0;
    }
    if (verb === 'use') return runSession(ctx, args.slice(1));
    if (verb.startsWith('-')) {
        process.stderr.write(`drover account: unknown option '${verb}'\n`);
        process.stderr.write('\n');
        process.stderr.write(usage);
        return 2;
    }
    if (accountExists(ctx, verb)) return runSession(ctx, args);

    // Neither a verb nor an account. Say which two things it was checked
    // against, and name both sets — an error that only says "unknown" leaves
    // the reader guessing which kind of word was expected.
    process.stderr.write(`drover account: '${verb}' is not a verb and not an account in ${ctx.registry}\n`);
    process.stderr.write('  verbs:    list add login rm rename use\n');
    process.stderr.write(`  accounts: ${listed(ctx)}\n`);
    process.stderr.write(`  create it with: drover account add ${verb}\n`);
    return 2;
}
