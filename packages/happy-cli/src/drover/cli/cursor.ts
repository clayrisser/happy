/**
 * `drover cursor` — start a Cursor agent as a drover-managed session (DROVE-57),
 * in node (DROVE-315). The port of cattle-drover/libexec/drover-cursor.
 *
 * Same rules as a Claude Code session, because ONE MODE is a rule about
 * sessions and not about Claude: the agent is a real TUI in a tmux pane, the
 * registry learns about it from its own hooks, and the app is a window onto
 * that pane. A cursor session started outside tmux is not refused — it OPENS
 * one, through the same shared entry every other harness uses.
 *
 * What this does beyond starting the runner:
 *
 *   1. Opens a pane when there is none, with the same reasoning bin/drover uses.
 *   2. Registers adapters/cursor-session.sh in ~/.cursor/hooks.json, merging
 *      rather than replacing — Clay already has ~/.shotgun hooks in that file
 *      and a hook installer that stomps them is worse than no installer.
 *      Idempotent: re-running adds nothing and rewrites nothing.
 *   3. Leaves the PERMISSION GATE opt-in (--gate). The session adapter is a
 *      pure observer and gating is not: ~/.cursor/hooks.json is also what
 *      Cursor's IDE reads, so registering a blocking gate there changes the
 *      behaviour of every Cursor window on the machine, not just this pane.
 *      Changing that unasked is not a thing a launcher gets to do.
 *   4. Turns a bare --resume into a chat id BEFORE the runner starts, from
 *      drover-pick-cursor-chat. `cursor-agent ls` and `cursor-agent resume`
 *      are Ink TUIs that refuse a non-TTY, so neither can be asked for an id
 *      from a script (DROVE-253).
 *   5. Takes --seed <file> and hands it to the runner, which submits the file
 *      as the session's first turn. That is the seeded start `drover clone
 *      --to cursor` needs, and its absence is why the clone refused (DROVE-337).
 *
 * MEASURED, so nobody re-derives it: `cursor-agent --model X` does not scope
 * the model to that run — it WRITES X into ~/.cursor/cli-config.json as the
 * new default for every later session, IDE included. So --model is passed
 * through (it is Clay's flag to use) but it is not something drover sets on
 * his behalf.
 *
 * WHAT NODE CHANGES. The shell ended with `exec node $cli/bin/drover.mjs cursor
 * $args_pre ...` — one node process spawning another node process to run an arm
 * this file is already inside of. Here the rewritten argv is handed to the
 * fork's own `cursor` arm in process, through io.launch. The DROVER_DRY_RUN
 * line still prints the old command line byte for byte, because that string is
 * what the bats pin and what a human reads to see which flags survived the
 * parse.
 *
 * The other shelling-out is gone the same way: the hooks merge was `desired |
 * jq --slurpfile`, and it is JSON.parse/JSON.stringify here. Same shape, same
 * event ordering (jq's `keys` and `unique` sort, so the events come out
 * alphabetical), same 2-space pretty print. The token store reads were
 * lib/drover-cursor-auth.sh and are a CursorAuth port here, so a test hands in
 * a fake and no test on this machine ever reads a real credential.
 *
 * Help answers before anything else — no env read, no file, no state dir — the
 * way the shell answered it before its parse loop touched a thing.
 */

import { spawnSync } from 'node:child_process';
import { accessSync, constants, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

import { droverEnv } from './env';
import { guardHarness } from './harness/failure';
import { defaultIo as defaultEnterIo, reenterLine, runEnter } from './harness/tmuxEnter';
import { droverTmuxHavePane, type Env } from './harness/tmuxEntry';
import { cursorCredentialHomeDir, prepareCursorCredentialHome } from '@/cursor/cursorCredentialHome';
import { cursorCredentialHomeVar } from '@/cursor/cursorEnv';

export const HELP = `drover cursor — a Cursor agent session, managed like a Claude Code one.

USAGE
  drover cursor [cursor-agent args...]   Start it. Needs a tmux pane.
  drover cursor --gate [args...]         Also register the permission gate,
                                         so a Cursor tool call is brokered on
                                         the bus and answerable from gum, the
                                         phone and the watch. Applies to every
                                         Cursor window on this machine, which
                                         is why it is not the default.
  drover cursor --resume                 Pick a past Cursor chat in this
                                         directory and resume it.
  drover cursor --resume <chatId>        Resume that chat, no picker.
  drover cursor --continue               Resume the most recent one here.
  drover cursor --print-hooks            Print the hooks drover would merge
                                         in, and exit. Reads only.
  drover cursor --account <name> [args]  Run on a named cursor subscription
                                         instead of the one this Mac is
                                         logged into. Add one from the phone
                                         with:
                                           drover account login --harness cursor
  drover cursor --seed <file> [args]     The file's contents become this
                                         session's first prompt. What
                                         \`drover clone <session> --to cursor\`
                                         uses to retell a conversation into a
                                         fresh Cursor session.

WHAT IS AND IS NOT WIRED (measured on cursor-agent 2026.08)
  a row in the app   yes. The fork CLI's cursor runner creates the Happy
                     session, so the phone lists it like any other.
  cards              yes. Each turn is \`cursor-agent --print --output-format
                     stream-json\`, and those frames go through the same
                     message mapper Gemini and OpenClaw use.
  phone -> session   yes. A message from the phone is the next turn. Typing in
                     the pane is the same turn queue, so both halves of the
                     conversation appear in both places.
  model picker       yes. The session publishes \`cursor-agent --list-models\`,
                     folded into families, and a pick applies to the next turn.
                     It cannot reach the IDE: each session runs under its own
                     CURSOR_CONFIG_DIR, because \`--model\` WRITES the global
                     default.
  effort             yes, as the tier spelled into the model id. The bracket
                     override cursor-agent's help advertises
                     (\`id[effort=high]\`) was measured to be REJECTED on this
                     login, so the id is split and rejoined by lookup instead.
  permission modes   yes. Full access (--force), Plan (--mode plan) and Read
                     only (--mode ask); Auto review (--auto-review) as well
                     when --gate is on, because it prompts and only the gate
                     can answer. The choice is not read back off the init
                     frame: that reports "default" for all of them.
  token counts       yes, per turn and summed, off the result frame's \`usage\`.
                     Turn end only — Cursor publishes nothing finer, so there
                     is no live token clock for this harness.
  resume picker      yes, from ~/.cursor/chats/*/*/meta.json. \`cursor-agent
                     ls\` and \`resume\` are TUIs that refuse a non-TTY.
  brokered prompts   with --gate only, and it is a machine-wide hook. The gate
                     answers allow or deny and never \`ask\`: a hook returning
                     \`ask\` under --print was measured to stall ~20s and then
                     run the command anyway.
  accounts           yes, with --account (DROVE-256). Each session is handed
                     that account's own token inline, so two cursor accounts run
                     side by side in two panes with no flip and no swap.
                     DROVE-253 said "no" here and was right when it was written;
                     the token store is what changed the answer.
  flip               no. A flip is a CLAUDE_CONFIG_DIR swap and a respawn, and
                     a cursor account has no config dir to swap to.
  headroom           no. Cursor publishes no quota anywhere, so a cursor
                     account reads as UNMEASURED rather than as a healthy
                     100%. See \`drover accounts\`.
  expiry             a cursor token lasts 60 days and CANNOT be refreshed, so
                     the repair always needs a browser. For the last week the
                     account reads \`renew in Nd\`, this command says so at
                     session start, and a card goes to the phone once a day.
                     It still runs: the warning never parks work.
`;

// --- the hooks drover owns ---------------------------------------------------

/** One entry in a Cursor hooks.json event array. */
export interface HookEntry {
    command: string;
    _drover?: string;
    [key: string]: unknown;
}

/**
 * The hook block drover owns, as the shell's `desired()` printed it.
 *
 * `_drover` is provenance, not decoration: it is how the merge below recognises
 * its own entries on a re-run instead of appending a second copy every time a
 * session starts. The padding is the heredoc's, kept byte for byte because
 * `--print-hooks` is a thing a human reads.
 */
export function desiredHooks(root: string, wantGate: boolean): string {
    const sessionCmd = join(root, 'adapters', 'cursor-session.sh');
    const gateCmd = join(root, 'adapters', 'cursor-permission-gate.sh');
    if (wantGate) {
        return `{
  "sessionStart":         [{"command": "${sessionCmd}", "_drover": "session"}],
  "sessionEnd":           [{"command": "${sessionCmd}", "_drover": "session"}],
  "postToolUse":          [{"command": "${sessionCmd}", "_drover": "session"}],
  "beforeShellExecution": [{"command": "${sessionCmd}", "_drover": "session"},
                           {"command": "${gateCmd}",    "_drover": "gate"}],
  "preToolUse":           [{"command": "${gateCmd}",    "_drover": "gate"}]
}
`;
    }
    return `{
  "sessionStart":         [{"command": "${sessionCmd}", "_drover": "session"}],
  "sessionEnd":           [{"command": "${sessionCmd}", "_drover": "session"}],
  "postToolUse":          [{"command": "${sessionCmd}", "_drover": "session"}],
  "beforeShellExecution": [{"command": "${sessionCmd}", "_drover": "session"}]
}
`;
}

/**
 * Merge, never replace — the node twin of the jq program the shell piped
 * `desired` into.
 *
 * Reads the file, drops any entry this launcher wrote before (matched on
 * `_drover`, so a hand-written entry pointing at the same script is left
 * alone), appends the current set, and drops an event whose array came out
 * empty so an event drover no longer wants loses its stale entry rather than
 * keeping an empty stub.
 *
 * EVERY EVENT NAMED IN EITHER SIDE is walked, alphabetically: jq's `keys` and
 * `unique` both sort, and the ordering is observable in the written file, so it
 * is reproduced rather than left to insertion order. Top-level keys keep the
 * positions they had, because `$have | .version = … | .hooks = …` sets in place
 * and appends only what was missing — which is what an object spread does too.
 *
 * Throws on anything jq would have exited non-zero for (an unparseable file, a
 * non-object). The caller warns and starts the session anyway; see installHooks.
 */
export function mergeHooks(current: string | null, want: Record<string, HookEntry[]>): string {
    let have: Record<string, unknown> = { version: 1, hooks: {} };
    if (current !== null && current.trim() !== '') {
        const parsed: unknown = JSON.parse(current);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('drover cursor: hooks file is not a JSON object');
        }
        have = parsed as Record<string, unknown>;
    }
    const hooksRaw = have.hooks;
    const hooks: Record<string, HookEntry[]> =
        hooksRaw !== null && typeof hooksRaw === 'object' && !Array.isArray(hooksRaw)
            ? (hooksRaw as Record<string, HookEntry[]>)
            : {};
    const events = [...new Set([...Object.keys(hooks), ...Object.keys(want)])].sort();
    const merged: Record<string, HookEntry[]> = {};
    for (const event of events) {
        const kept = (hooks[event] ?? []).filter(
            (entry) => !(entry !== null && typeof entry === 'object' && '_drover' in entry),
        );
        const next = [...kept, ...(want[event] ?? [])];
        if (next.length > 0) merged[event] = next;
    }
    const out: Record<string, unknown> = { ...have };
    out.version = have.version ?? 1;
    out.hooks = merged;
    return `${JSON.stringify(out, null, 2)}\n`;
}

// --- backing a file up before drover's first write to it ---------------------
//
// The half of lib/drover-config-block.sh that applies here (DROVE-306).
// ~/.cursor/hooks.json is JSON and has no comment syntax to hang a marker on,
// so the marked-block half does not apply and the merge above is the
// convergence; this brings the BACKUP half, unchanged.

const backupSuffix = '.bak';

/** The flattened basename a backup of <path> is filed under. */
export function backupName(path: string): string {
    return path.replace(/^\//, '').split('/').join('-');
}

/**
 * Where the pre-drover copies live. SCOPED TO THE HOME THE CONFIG BELONGS TO:
 * STATE_DIR is exported into every shell drover starts, so a test that fakes
 * HOME and not STATE_DIR would otherwise file its fixtures' backups in Clay's
 * real state dir, one more on every run, forever.
 */
export function backupDir(env: Env, home: string): string {
    if (env.DROVER_CONFIG_BACKUP_DIR) return env.DROVER_CONFIG_BACKUP_DIR;
    let base = env.STATE_DIR ?? '';
    if (base !== home && !base.startsWith(`${home}/`)) base = '';
    if (!base) {
        let state = env.XDG_STATE_HOME || join(home, '.local', 'state');
        if (state !== home && !state.startsWith(`${home}/`)) state = join(home, '.local', 'state');
        base = join(state, 'cattle-drover');
    }
    return join(base, 'backups');
}

/** The UTC stamp a backup is named after: date -u +%Y%m%dT%H%M%SZ. */
export function backupStamp(now: Date): string {
    return `${now.toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`;
}

/**
 * Copy <path> aside ONCE, before drover's first write to it. True when there is
 * a way back (including "nothing to copy"), false when it wanted to make a copy
 * and could not — which is a refusal to proceed and not a warning.
 */
export function configBackup(env: Env, home: string, path: string, err: (line: string) => void, now: Date): boolean {
    if (!existsSync(path) || !statSync(path).isFile()) return true;
    // Drover's own files are not somebody's config.
    for (const own of [env.DROVER_DIR, env.STATE_DIR]) {
        if (own && path.startsWith(`${own}/`)) return true;
    }
    const dir = backupDir(env, home);
    const name = backupName(path);
    if (existsSync(dir)) {
        const already = readdirSync(dir).some((f) => f.startsWith(`${name}.`) && f.endsWith(backupSuffix));
        if (already) return true;
    }
    try {
        mkdirSync(dir, { recursive: true });
    } catch {
        err(`drover: cannot create ${dir} — refusing to edit ${path} without a backup`);
        return false;
    }
    let out = join(dir, `${name}.${backupStamp(now)}${backupSuffix}`);
    let n = 0;
    while (existsSync(out) && n < 100) {
        n += 1;
        out = `${out.slice(0, -backupSuffix.length)}-${n}${backupSuffix}`;
    }
    try {
        // cp -p: the copy carries the original's mode, because a backup of a
        // private file that is not itself private is a new problem in place of
        // an old one.
        copyFileSync(path, out);
        return true;
    } catch {
        err(`drover: could not back ${path} up to ${out} — refusing to edit it`);
        return false;
    }
}

// --- cursor credentials, read locally ----------------------------------------
//
// The node port of the reads in lib/drover-cursor-auth.sh. Every token here is
// a SUBSCRIPTION session token minted by `cursor-agent login`; nothing in this
// file mints, reads or writes an API key.

export type CursorTokenState = 'live' | 'renew' | 'expiring' | 'expired' | 'tombstone' | 'unreadable';

/** Anything claiming to expire before this is a MARKER, not a credential. */
const tombstoneBefore = 946684800;

/** Seven days out of sixty — more than one weekend, and short enough to still be read. */
const defaultRenewWithin = 604800;

/** The decoded JWT claims, or null. base64url, re-padded. */
export function cursorJwtPayload(token: string | null): Record<string, unknown> | null {
    if (!token) return null;
    const seg = token.split('.')[1];
    if (!seg) return null;
    try {
        const b = seg.split('-').join('+').split('_').join('/');
        const padded = b + '='.repeat((4 - (b.length % 4)) % 4);
        const parsed: unknown = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
        return parsed as Record<string, unknown>;
    } catch {
        return null;
    }
}

/** The expiry as a unix timestamp, or null. */
export function cursorTokenExp(token: string | null): number | null {
    const claims = cursorJwtPayload(token);
    const exp = claims?.exp;
    if (typeof exp === 'number' && Number.isInteger(exp) && exp >= 0) return exp;
    if (typeof exp === 'string' && /^[0-9]+$/.test(exp)) return Number(exp);
    return null;
}

/**
 * live | renew | expiring | expired | tombstone | unreadable.
 *
 * `renew` IS A WORKING TOKEN, reported separately because a cursor token cannot
 * be refreshed and its replacement needs a human at a browser. `expiring` uses
 * the same 300-second margin cursor-agent uses internally. A token whose claims
 * cannot be read is `unreadable` and NOT assumed dead: refusing every session on
 * a parse failure would be a worse outage than trying and being told no.
 */
export function cursorTokenState(token: string | null, now: number, renewWithin = defaultRenewWithin): CursorTokenState {
    const exp = cursorTokenExp(token);
    if (exp === null) return 'unreadable';
    if (exp < tombstoneBefore) return 'tombstone';
    if (exp <= now) return 'expired';
    if (exp - now < 300) return 'expiring';
    if (exp - now < renewWithin) return 'renew';
    return 'live';
}

/** Whole days until it dies, rounded DOWN so "1 day left" never means ninety minutes. */
export function cursorTokenDaysLeft(token: string | null, now: number): string | null {
    const exp = cursorTokenExp(token);
    if (exp === null) return null;
    const left = exp - now;
    if (left <= 0) return '0';
    return String(Math.floor(left / 86400));
}

/** 0 when a session may start on it. `expiring` is refused with `expired`. */
export function cursorTokenUsable(state: CursorTokenState): boolean {
    return state === 'live' || state === 'renew' || state === 'unreadable';
}

/**
 * The token store, behind a port.
 *
 * INJECTED, ALWAYS. A test hands in a fake and never reads a real credential —
 * not the Keychain, not $STATE_DIR/cursor-auth.json, not ~/.cursor/auth.json.
 * The default below is the only thing that opens the store on disk.
 */
export interface CursorAuth {
    /**
     * cursor_run_env: the NAME=value lines a managed run needs, and the shell's
     * exit code — 0 fine, 2 the token is dead on its face, anything else no
     * token is stored at all.
     */
    runEnv(account: string): { code: number; lines: string[] };
    /** cursor_auth_token — just the token. */
    token(account: string): string | null;
    /** cursor_token_state. */
    state(token: string | null): CursorTokenState;
    /** cursor_renew_warn — the days left when it warned, null when it did not. */
    renewWarn(account: string): Promise<string | null>;
}

function readJsonFile(path: string): Record<string, unknown> | null {
    try {
        const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
        return parsed as Record<string, unknown>;
    } catch {
        return null;
    }
}

/** The stamp file that remembers the last renewal warning for an account. */
function renewStamp(stateDir: string, account: string): string {
    return join(stateDir, `cursor-renew.${account.replace(/[^A-Za-z0-9._-]/g, '_')}`);
}

/** The real store: $DROVER_CURSOR_AUTH, else $STATE_DIR/cursor-auth.json. */
export function storeAuth(env: Env, home: string): CursorAuth {
    const denv = droverEnv(env, home);
    const store = env.DROVER_CURSOR_AUTH || join(denv.stateDir, 'cursor-auth.json');
    const renewWithin = env.DROVER_CURSOR_RENEW_WITHIN ? Number(env.DROVER_CURSOR_RENEW_WITHIN) : defaultRenewWithin;
    const now = (): number => Math.floor(Date.now() / 1000);
    const token = (account: string): string | null => {
        const all = readJsonFile(store);
        const row = all?.[account];
        if (row === null || row === undefined || typeof row !== 'object') return null;
        const tok = (row as Record<string, unknown>).token;
        return typeof tok === 'string' && tok !== '' ? tok : null;
    };
    const state = (tok: string | null): CursorTokenState => cursorTokenState(tok, now(), renewWithin);
    return {
        token,
        state,
        runEnv(account) {
            const tok = token(account);
            if (!tok) return { code: 1, lines: [] };
            if (!cursorTokenUsable(state(tok))) return { code: 2, lines: [] };
            // THE TOKEN DOES NOT TRAVEL AS A VARIABLE (DROVE-387). It used to
            // go out as CURSOR_AUTH_TOKEN beside AGENT_CLI_CREDENTIAL_STORE=
            // memory, and DROVE-253 scrubs that variable out of every turn — so
            // the only half that survived was the empty store, and the session
            // started as nobody with no way to sign in. It goes into the file
            // store under a private HOME instead, which is where cursor-agent
            // reads a login from and the only path that never touches the
            // shared Keychain. The store is still not the machine's, which was
            // the whole point of `memory`; it is a store with the credential in
            // it. See cursor/cursorCredentialHome.ts for the measurement.
            let credHome: string;
            try {
                credHome = prepareCursorCredentialHome(cursorCredentialHomeDir(denv.stateDir, account), tok, home);
            } catch {
                return { code: 3, lines: [] };
            }
            return { code: 0, lines: [`${cursorCredentialHomeVar}=${credHome}`, 'AGENT_CLI_CREDENTIAL_STORE=file'] };
        },
        async renewWarn(account) {
            const tok = token(account);
            if (!tok) return null;
            if (state(tok) !== 'renew') return null;
            // Stamped to once a day per account: a card on every session start
            // is a card he stops reading. 23 hours, not 24, so a daily chore run
            // a minute early does not skip a day.
            const stamp = renewStamp(denv.stateDir, account);
            const last = existsSync(stamp) ? Number((readFileSync(stamp, 'utf8') || '').trim()) : NaN;
            if (Number.isFinite(last) && now() - last < 82800) return null;
            const days = cursorTokenDaysLeft(tok, now()) ?? '0';
            await postRenewNotice(denv.droverUrl, account, days);
            try {
                mkdirSync(dirname(stamp), { recursive: true });
                writeFileSync(stamp, `${now()}\n`);
            } catch {
                // Never fails a session. A stamp that could not be written
                // means one more card tomorrow, which is not a reason to refuse.
            }
            return days;
        },
    };
}

/**
 * The renewal card, on the bus. Fire-and-forget with a short timeout: a bus
 * that is down is a reason to run the work anyway, not a reason to refuse it.
 * Posted as a one-option question because that is the only shape the bridge
 * mirrors into a card.
 */
async function postRenewNotice(droverUrl: string, account: string, days: string): Promise<void> {
    const reason = `The Cursor login for ${account} expires in ${days} day(s) and cannot be renewed automatically. Log in again before it dies: drover account login --harness cursor ${account}`;
    try {
        await fetch(`${droverUrl}/v1/events`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                kind: 'question',
                title: `Cursor login for ${account} expires in ${days} day(s)`,
                reason,
                preview: reason,
                ttlMs: 86400000,
                channel: 'external',
                options: [{ id: 'ok', label: 'OK' }],
                origin: {
                    harness: 'drover', gate: 'account-renew', account,
                    sessionId: null, cwd: null, surface: null,
                },
            }),
            signal: AbortSignal.timeout(5000),
        });
    } catch {
        // Deliberately silent, as `bus_post … || :` was.
    }
}

// --- the io ------------------------------------------------------------------

/** What a Cursor launch needs that is not argv. Injected so no test starts one. */
export interface CursorIo {
    env: Env;
    cwd: string;
    home: string;
    out: (line: string) => void;
    err: (line: string) => void;
    /** `command -v <name>`. */
    which: (name: string) => string | null;
    /** The credential store. */
    auth: CursorAuth;
    /** libexec/drover-pick-cursor-chat, which is an interactive picker. */
    pick: (mode: 'pick' | 'latest') => { status: number; chatId: string };
    /** The shared window opener, for the no-pane hand-off. */
    enter: (argv: string[]) => Promise<number>;
    /** The fork's own `cursor` arm, in process. */
    launch: (argv: string[]) => Promise<number>;
    /** The clock, for the backup stamp. */
    now: () => Date;
}

function whichOnPath(name: string, env: Env): string | null {
    for (const dir of (env.PATH ?? '').split(delimiter)) {
        if (!dir) continue;
        const candidate = join(dir, name);
        if (existsSync(candidate)) return candidate;
    }
    return null;
}

/**
 * The rewritten argv the fork's own `cursor` arm parses — `['cursor', …]`,
 * because that arm reads from index 1.
 */
export interface CursorLaunch {
    argv: string[];
}

/**
 * The seed rides BESIDE args_pre rather than folded into it, and that is the
 * whole reason for the second expansion in the shell. args_pre is drover's own
 * flags, built from a chat id and fixed literals, so it splits on spaces. A
 * seed path is a PATH the human chose, so a clone under "~/My Projects" folded
 * in there would split into two arguments and reach the runner as a file that
 * does not exist.
 */
export function cursorLaunch(argsPre: string, seed: string | null, rest: readonly string[]): CursorLaunch {
    const pre = argsPre.split(' ').filter((w) => w.length > 0);
    return { argv: ['cursor', ...pre, ...(seed ? ['--seed', seed] : []), ...rest] };
}

/**
 * The real runner: the fork's `cursor` arm, reached in process rather than by
 * spawning `node bin/drover.mjs cursor`. Same parse, same options object.
 *
 * AND THE SAME CATCH (DROVE-374). The arm this replaced wrapped runCursor in a
 * try/catch that printed one line and exited 1; the port dropped it, so a
 * cursor-agent that failed — a locked login keychain, on the day it was found —
 * came back as an unhandled rejection and a raw node stack. guardHarness is
 * that catch, shared with the codex and pi launchers, which lost it the same
 * way.
 */
async function launchCursor(argv: string[]): Promise<number> {
    return guardHarness('cursor', (line) => process.stderr.write(`${line}\n`), () => runCursorArm(argv));
}

async function runCursorArm(argv: string[]): Promise<number> {
    const { runCursor } = await import('@/cursor/runCursor');
    const { authAndSetupMachineIfNeeded } = await import('@/ui/auth');
    const { ensureDaemonRunning } = await import('@/daemon/ensureDaemonRunning');

    let startedBy: 'daemon' | 'terminal' | undefined;
    let model: string | null = null;
    let resumeChatId: string | null = null;
    let permissionMode: string | null = null;
    let gated = false;
    let seedFile: string | null = null;
    for (let i = 1; i < argv.length; i++) {
        if (argv[i] === '--started-by') startedBy = argv[++i] as 'daemon' | 'terminal';
        else if (argv[i] === '--model') model = argv[++i] ?? null;
        else if (argv[i] === '--resume') resumeChatId = argv[++i] ?? null;
        else if (argv[i] === '--permission-mode') permissionMode = argv[++i] ?? null;
        else if (argv[i] === '--gated') gated = true;
        else if (argv[i] === '--seed') seedFile = argv[++i] ?? null;
        else if (argv[i].startsWith('--seed=')) seedFile = argv[i].slice('--seed='.length);
    }
    const { credentials } = await authAndSetupMachineIfNeeded();
    await ensureDaemonRunning();
    await runCursor({ credentials, startedBy, model, resumeChatId, permissionMode, gated, seedFile });
    return 0;
}

/** The default io: the real process, the real store, the real runner. */
export function defaultIo(): CursorIo {
    const env = process.env as Env;
    const home = homedir();
    const denv = droverEnv(env, home);
    const libexec = join(denv.droverDir, 'libexec');
    return {
        env,
        cwd: process.cwd(),
        home,
        out: (line) => process.stdout.write(`${line}\n`),
        err: (line) => process.stderr.write(`${line}\n`),
        which: (name) => whichOnPath(name, env),
        auth: storeAuth(env, home),
        pick: (mode) => {
            const r = spawnSync(join(libexec, 'drover-pick-cursor-chat'), mode === 'latest' ? ['--latest'] : [], {
                encoding: 'utf8',
                stdio: ['inherit', 'pipe', 'inherit'],
            });
            return { status: r.status ?? 1, chatId: (r.stdout ?? '').replace(/\n+$/, '') };
        },
        enter: (argv) => runEnter(argv, defaultEnterIo(), libexec),
        launch: launchCursor,
        now: () => new Date(),
    };
}

// --- registering the hooks ---------------------------------------------------

/**
 * Merge drover's hooks into the machine-wide file, or say why it did not.
 *
 * Everything here warns and starts the session anyway, because a missing hook
 * costs a row in `drover sessions`. The ONE exception is the backup: editing a
 * machine-wide file with no way back is a different size of mistake and gets
 * the stricter answer.
 *
 * The shell's "jq not found" arm has no twin — node parses JSON itself, so the
 * dependency that arm existed for is gone.
 */
export function installHooks(io: CursorIo, cursorHome: string, hooksFile: string, want: string): void {
    mkdirSync(cursorHome, { recursive: true });
    if (!existsSync(hooksFile)) writeFileSync(hooksFile, '{"version":1,"hooks":{}}\n');
    const current = readFileSync(hooksFile, 'utf8');
    let merged: string;
    try {
        merged = mergeHooks(current, JSON.parse(want) as Record<string, HookEntry[]>);
    } catch {
        io.err(`drover cursor: could not merge hooks into ${hooksFile} — starting`);
        io.err('  anyway, but this session will NOT appear in `drover sessions`.');
        io.err('  See what it wanted to add:  drover cursor --print-hooks');
        return;
    }
    if (merged === current) return;
    // Once, before the first write drover ever makes to this file, and never
    // again (DROVE-306). The merge above already preserves every entry that is
    // not drover's, so this is the way back from a merge that preserved the
    // wrong thing rather than from a clobber.
    if (!configBackup(io.env, io.home, hooksFile, io.err, io.now())) {
        io.err(`drover cursor: hooks NOT registered — could not back ${hooksFile} up`);
        io.err('  first, so this session will not appear in `drover sessions`.');
        return;
    }
    const tmp = `${hooksFile}.drover.${process.pid}`;
    try {
        writeFileSync(tmp, merged);
        renameSync(tmp, hooksFile);
    } catch {
        try {
            unlinkSync(tmp);
        } catch {
            // Already gone, which is the state we wanted.
        }
        io.err(`drover cursor: could not merge hooks into ${hooksFile} — starting`);
        io.err('  anyway, but this session will NOT appear in `drover sessions`.');
        io.err('  See what it wanted to add:  drover cursor --print-hooks');
        return;
    }
    io.err(`drover cursor: registered drover hooks in ${hooksFile}`);
}

// --- the verb ----------------------------------------------------------------

function readable(path: string): boolean {
    try {
        accessSync(path, constants.R_OK);
        return true;
    } catch {
        return false;
    }
}

export async function run(args: string[], io: CursorIo = defaultIo()): Promise<number> {
    // Before anything else: no env read, no state dir, no store.
    if (args[0] === '-h' || args[0] === '--help') {
        io.out(HELP.trimEnd());
        return 0;
    }

    // The argv is captured HERE, before the parse loop starts shifting, because
    // the pane check has to stay after the preflight — a missing cursor-agent
    // has to be reported in the terminal you typed in, not in a window that
    // opens, prints it and closes half a second later.
    const original = [...args];

    let wantGate = false;
    let printHooks = false;
    let account: string | null = null;
    let pickMode: 'pick' | 'latest' | null = null;
    let argsPre = '';
    let seed: string | null = null;
    const rest = [...args];

    while (rest.length > 0) {
        const a = rest[0];
        // `drover clone <session> --to cursor` (DROVE-337). A FILE, because a
        // clone seed is tens of kilobytes of retold conversation and one stray
        // quote on a command line turns the launch into a syntax error.
        //
        // THIS VERB OWNS THE WHOLE CONTRACT, both spellings and both refusals.
        // bin/drover normalises --seed=<file> and validates the file only for a
        // session START, and its scan is gated on is_start, which is 0 the
        // moment argv[1] is a word like `cursor`.
        if (a === '--seed') {
            const value = rest[1] ?? '';
            if (!value) {
                io.err('drover cursor: --seed needs a file');
                return 2;
            }
            if (!readable(value)) {
                io.err(`drover cursor: cannot read the seed file '${value}'`);
                return 2;
            }
            seed = value;
            rest.splice(0, 2);
            continue;
        }
        // One spelling below, two on the command line: rewritten into the
        // two-word form and re-read by the arm above, so there is one place
        // that decides what a bad seed does.
        if (a.startsWith('--seed=')) {
            rest.splice(0, 1, '--seed', a.slice('--seed='.length));
            continue;
        }
        if (a === '--account') {
            if (rest.length < 2) {
                io.err('drover cursor: --account needs a name');
                return 2;
            }
            account = rest[1];
            rest.splice(0, 2);
            continue;
        }
        if (a === '--gate') {
            wantGate = true;
            rest.shift();
            continue;
        }
        if (a === '--print-hooks') {
            printHooks = true;
            rest.shift();
            continue;
        }
        // A bare --resume or -r means "ask me which chat"; --resume <id> is
        // passed straight through. Same split bin/drover makes for Claude.
        if (a === '--resume' || a === '-r') {
            const next = rest[1];
            if (rest.length >= 2 && next !== undefined && next !== '' && !next.startsWith('-')) {
                argsPre = `--resume ${next}`;
                rest.splice(0, 2);
            } else {
                pickMode = 'pick';
                rest.shift();
            }
            continue;
        }
        if (a === '--continue' || a === '-c') {
            pickMode = 'latest';
            rest.shift();
            continue;
        }
        if (a === '-h' || a === '--help') {
            io.out(HELP.trimEnd());
            return 0;
        }
        break;
    }

    const denv = droverEnv(io.env, io.home);
    const root = denv.droverDir;
    const libexec = join(root, 'libexec');
    const want = desiredHooks(root, wantGate);

    if (printHooks) {
        io.out(want.trimEnd());
        return 0;
    }

    if (!io.which('cursor-agent')) {
        io.err('drover cursor: cursor-agent is not on PATH.');
        io.err('  install it:  curl https://cursor.com/install -fsS | sh');
        return 127;
    }

    // ONE MODE, and it OPENS a pane rather than refusing (DROVE-308). For
    // Cursor the pane is load-bearing twice over — it is also the only way a
    // message from the phone can arrive at all. droverTmuxHavePane and not
    // `[ -z "$TMUX" ]`, because $TMUX is set inside drover's own -L drover-login
    // server too and that is not a home for a session.
    if ((io.env.DROVER_ALLOW_NO_TMUX ?? '0') !== '1' && !droverTmuxHavePane(io.env)) {
        // The ORIGINAL argv and not what is left: the loop above has already
        // eaten this verb's own flags, and re-entering without them would run a
        // DIFFERENT command than the one that was typed.
        if (io.env.DROVER_DRY_RUN) {
            io.out(reenterLine(libexec, 'drover-cursor', original, io.cwd));
            return 0;
        }
        return io.enter(['--cwd', io.cwd, '--', join(libexec, 'drover-cursor'), ...original]);
    }

    io.env.DROVER_URL = denv.droverUrl;
    io.env.DROVER_DIR = denv.droverDir;
    io.env.STATE_DIR = denv.stateDir;
    io.env.DROVER_ORIGIN = io.env.DROVER_ORIGIN || 'terminal';

    // WHICH SUBSCRIPTION THIS SESSION BILLS (DROVE-256).
    //
    // With no --account the session runs on whatever this Mac is logged into,
    // and nothing here touches its environment. With one, the account's token
    // goes into a private FILE credential store and the run is sealed off from
    // the shared one entirely — see storeAuth and cursor/cursorCredentialHome.ts
    // for the measurement behind that.
    //
    // A DEAD ACCOUNT IS REFUSED BEFORE THE SESSION STARTS rather than discovered
    // mid-turn. A cursor token CANNOT be renewed, so the repair is another
    // login, and saying that here is the difference between a clear instruction
    // and "Authentication failed" in the middle of a turn.
    //
    // THE GUARD IS NOT COMPLETE. It catches a token dead ON ITS FACE — past its
    // own `exp`, or a signed-out tombstone — because that is readable locally.
    // It does NOT catch a token revoked server-side while its `exp` is still in
    // the future, and that has been observed.
    if (account) {
        const resolved = io.auth.runEnv(account);
        if (resolved.code === 2) {
            // Two different dead tokens, two different sentences. An aged-out
            // token means the login lapsed; a tombstone means something signed
            // the account out. The repair is the same, but only one of them is
            // worth telling him about a lapse.
            if (io.auth.state(io.auth.token(account)) === 'tombstone') {
                io.err(`drover cursor: '${account}' has been signed out of Cursor.`);
                io.err('  What is stored for it is a signed-out marker, not a credential. Log in again:');
            } else {
                io.err(`drover cursor: the cursor login for '${account}' has expired.`);
                io.err('  A cursor token cannot be renewed — cursor-agent has no refresh flow for one,');
                io.err('  and drover will not mint an API key. Log it in again:');
            }
            io.err('');
            io.err(`      drover account login --harness cursor ${account}`);
            return 4;
        }
        if (resolved.code === 3) {
            // The token is fine; the place to put it is not. Saying "no token
            // stored" here would send him to log in again, which repairs
            // nothing and costs a browser round trip.
            io.err(`drover cursor: could not prepare the private cursor home for '${account}'.`);
            io.err(`  Wanted:  ${cursorCredentialHomeDir(denv.stateDir, account)}`);
            io.err('  Check that STATE_DIR is writable, then try again.');
            return 5;
        }
        if (resolved.code !== 0) {
            io.err(`drover cursor: no cursor token stored for '${account}'.`);
            io.err('  Known cursor accounts:  drover accounts');
            io.err(`  Add this one:           drover account login --harness cursor ${account}`);
            return 2;
        }
        // Applied as NAME=value lines rather than one by one, so the set of
        // variables lives in exactly one place (runEnv) and this cannot drift
        // from it.
        for (const line of resolved.lines) {
            const eq = line.indexOf('=');
            if (eq > 0) io.env[line.slice(0, eq)] = line.slice(eq + 1);
        }
        io.env.DROVER_ACCOUNT = account;
        // WHICH HARNESS THE STAMP BELONGS TO (DROVE-338). A Claude account and
        // a cursor account may share a name, and `drover accounts` marks the
        // current row by DROVER_ACCOUNT — without this it would star both.
        io.env.DROVER_HARNESS = 'cursor';

        // EXPIRY GETS A WARNING, NOT JUST AN EPITAPH. A token with a week left
        // is still perfectly good to run on — the session starts normally — but
        // this is the last cheap chance to say so while he can still act.
        // stderr, not stdout: stdout belongs to the session.
        const renewDays = await io.auth.renewWarn(account);
        if (renewDays) {
            io.err(`drover cursor: the login for '${account}' expires in ${renewDays} day(s) and cannot`);
            io.err('  be renewed automatically. Before it dies, run:');
            io.err(`      drover account login --harness cursor ${account}`);
        }
        // An inherited API key outranks nothing here — cursor checks the auth
        // token FIRST — but it is unset anyway so a stray key can never bill
        // Clay for a session he asked to run on a subscription.
        delete io.env.CURSOR_API_KEY;
    }

    const cli = join(denv.forkDir, 'packages', 'happy-cli');
    if (!existsSync(cli)) {
        io.err(`drover cursor: fork not found at ${denv.forkDir}`);
        return 1;
    }

    // A bare --resume/-c becomes a real chat id here, before the session is
    // created, so the runner attaches to that chat instead of minting a new
    // one. Same reason bin/drover owns the Claude picker (DROVE-50): the id has
    // to exist before the session is created, or the phone gets an empty twin
    // of a conversation it already has.
    if (pickMode) {
        const picked = io.pick(pickMode);
        if (picked.status !== 0) return picked.status;
        argsPre = `--resume ${picked.chatId}`;
    }

    // --gated is a STATEMENT, not a request: it tells the runner that this
    // launch registered the gate, so the app may offer the auto-review mode
    // that only a gate can answer. Without it that mode is a twenty-second
    // pause and then yes.
    if (wantGate) argsPre = `${argsPre} --gated`;

    // HOOKS ARE REGISTERED LAST, and never by a run that is not starting a
    // session. Two lanes found the same file being written by runs that had no
    // business writing it, from opposite directions, and both fixes are kept.
    //
    //   DROVE-256: a run that REFUSES must not write. Registering at the top
    //   was measured printing "registered drover hooks" and then exiting 4
    //   because the account was dead. So this sits below the account checks,
    //   the fork check, and the resume picker — every path that can decline has
    //   already had its chance.
    //
    //   DROVE-253: a run that only PRINTS must not write either. DROVER_DRY_RUN
    //   is meant to show the command line, and it re-pointed Clay's real hooks
    //   at a worktree checkout once already. `--print-hooks` is the read-only
    //   path people are told about, and a flag named DRY RUN that mutates a
    //   machine-wide file is a trap whatever the docstring says.
    const cursorHome = io.env.CURSOR_CONFIG_DIR
        || (io.env.XDG_CONFIG_HOME ? join(io.env.XDG_CONFIG_HOME, 'cursor') : join(io.home, '.cursor'));
    const hooksFile = join(cursorHome, 'hooks.json');
    if (!io.env.DROVER_DRY_RUN) installHooks(io, cursorHome, hooksFile, want);

    // The old command line, rendered exactly as the shell rendered it — an
    // unquoted args_pre inside one double-quoted echo, so an empty args_pre
    // leaves the double space it always left. This string is what the bats pin
    // and what a human reads to see which flags survived the parse.
    if (io.env.DROVER_DRY_RUN) {
        const seedPart = seed ? ` --seed ${seed}` : '';
        io.out(`node ${cli}/bin/drover.mjs cursor ${argsPre}${seedPart} ${rest.join(' ')}`);
        return 0;
    }

    return io.launch(cursorLaunch(argsPre, seed, rest).argv);
}
