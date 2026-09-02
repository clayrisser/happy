/**
 * The account registry, the config dirs behind it, and the cursor token store
 * (DROVE-315 wave 2a).
 *
 * The node twin of the account half of cattle-drover/lib/drover-json.sh, plus
 * the READ half of lib/drover-cursor-auth.sh. Every verb in this family —
 * `accounts`, `account`, `account of`, `account add|rm|rename` — used to reach
 * these through `. "$root/lib/drover-json.sh"`, so they land here once rather
 * than four times.
 *
 * THE RULES THAT SURVIVE THE PORT, because each of them is a bug somebody
 * already paid for:
 *
 *   - A CONFIG DIR PATH IS NEVER REWRITTEN. On macOS the credential lives in
 *     the Keychain under a service name derived from the CONFIG DIR PATH
 *     (sha256, first 8 hex). Moving, renaming or re-spelling a `configDir`
 *     orphans the login while the account goes on reading as logged in. So
 *     nothing here normalises a stored spelling on the way back out: it is
 *     expanded for READING and written back byte for byte.
 *   - IDENTITY IS (harness, name), not the name alone (DROVE-338). A Claude
 *     row is a config dir and a cursor row is a token, and both are named
 *     after the address they logged in as, so one address may legitimately
 *     sit in the registry twice. `accountRow` therefore takes the harness as
 *     an argument and never defaults it.
 *   - `~/.claude` IS THE AMBIENT SPELLING. Pointing CLAUDE_CONFIG_DIR there
 *     moves the global config to an empty ~/.claude/.claude.json, so reading
 *     it any other way describes an account nobody has ever wanted.
 *   - PRESENCE, NEVER VALUE. `loggedIn` is the presence of an `oauthAccount`
 *     key or a `.credentials.json`. Nothing here reads a token, and the only
 *     value ever read out of a config is the address, which is identity.
 *   - A WRITE IS ATOMIC AND MODE-PRESERVING. Temp file beside the target,
 *     seeded from the target so a 0600 file stays 0600, parsed, then renamed.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** A registry row, as accounts.json holds it. Unknown fields are carried. */
export interface AccountRow {
    name?: string;
    configDir?: string;
    harness?: string;
    flipPrompt?: string;
    [key: string]: unknown;
}

/** A ledger entry, as $STATE_DIR/cooldowns.json holds it. */
export interface LedgerEntry {
    until?: number;
    reason?: string;
    family?: string;
    [key: string]: unknown;
}

export function home(env: NodeJS.ProcessEnv = process.env): string {
    return env.HOME || homedir();
}

/** json_expand_home: a leading `~/` becomes `$HOME/`; a bare `~` is $HOME. */
export function expandHome(path: string, h: string = home()): string {
    if (path.startsWith('~/')) return `${h}/${path.slice(2)}`;
    if (path === '~') return h;
    return path;
}

/** json_tilde: the reverse, for a message. Anything outside $HOME unchanged. */
export function tilde(path: string, h: string = home()): string {
    if (path === h) return '~';
    if (path.startsWith(`${h}/`)) return `~${path.slice(h.length)}`;
    return path;
}

/**
 * json_is_ambient — the spellings that mean "the account you are already
 * logged into". The case list is the shell's exactly: '', default, ambient,
 * DEFAULT, Default, ~ — and NOT an arbitrary lowercasing, because the shell
 * `case` names those five and nothing else.
 */
export function isAmbient(configDir: string | undefined | null, h: string = home()): boolean {
    const d = configDir ?? '';
    if (d === '' || d === 'default' || d === 'ambient' || d === 'DEFAULT' || d === 'Default' || d === '~') return true;
    if (d === '~/.claude' || d === `${h}/.claude`) return true;
    return false;
}

/** json_account_data_dir — where that account's transcripts and commands live. */
export function accountDataDir(configDir: string | undefined | null, h: string = home()): string {
    if (isAmbient(configDir, h)) return `${h}/.claude`;
    return expandHome(configDir ?? '', h);
}

/** json_account_config_file — the .claude.json holding identity + onboarding. */
export function accountConfigFile(configDir: string | undefined | null, h: string = home()): string {
    if (isAmbient(configDir, h)) return `${h}/.claude.json`;
    return `${expandHome(configDir ?? '', h)}/.claude.json`;
}

/**
 * json_account_row — the row of that harness with that name, or undefined. A
 * row with no `harness` field is a Claude row, so every registry written
 * before cursor accounts existed reads exactly as it did.
 */
export function accountRow(registry: AccountRow[], name: string, harness: string): AccountRow | undefined {
    return registry.find((r) => r?.name === name && (r?.harness ?? 'claude') === harness);
}

/**
 * json_account_dir_label — where a Claude row lives, said for a human. This is
 * what a refusal names, so that "registered at default" — a place nobody can
 * look — never appears again (DROVE-338).
 */
export function accountDirLabel(configDir: string | undefined | null, h: string = home()): string {
    if (isAmbient(configDir, h)) return '~/.claude (default)';
    return tilde(expandHome(configDir ?? '', h), h);
}

/** A document read off disk, or null when it is missing or does not parse. */
export type ConfigDoc = Record<string, unknown> | null;

/**
 * json_read_configs — every named file as one {path: document} map.
 *
 * The shell reads them in ONE jq because a fork per file was the whole bill
 * (DROVE-280: 108 jq, 4.4s best and 30.7s worst at load 22). In node there is
 * no fork to save, so the loop IS the one pass — but the OTHER half of that
 * function's contract still matters and is kept: A FILE THAT DOES NOT PARSE
 * COSTS ONLY ITSELF. jq's input stream stops at a bad document and the shell
 * falls back to one jq per file for exactly that reason; here each read is
 * already its own try, so a single malformed .claude.json can never take the
 * whole table with it.
 */
export function readConfigs(files: string[]): Record<string, ConfigDoc> {
    const out: Record<string, ConfigDoc> = {};
    for (const f of files) {
        if (f in out) continue;
        try {
            const parsed: unknown = JSON.parse(readFileSync(f, 'utf8'));
            out[f] = (parsed && typeof parsed === 'object') ? parsed as Record<string, unknown> : null;
        } catch {
            // Only itself. See above.
        }
    }
    return out;
}

/** One config document, or null. */
export function readConfig(file: string): ConfigDoc {
    return readConfigs([file])[file] ?? null;
}

/**
 * json_account_logged_in — has a login ever been WRITTEN here?
 *
 * Identity, not credential (DROVE-238). This says a login was once recorded.
 * It does not say the secret behind it still exists, because on macOS that
 * secret is a Keychain item and this reads a JSON file.
 */
export function accountLoggedIn(configDir: string | undefined | null, h: string = home()): boolean {
    const dir = accountDataDir(configDir, h);
    if (existsSync(`${dir}/.credentials.json`)) return true;
    const doc = readConfig(accountConfigFile(configDir, h));
    if (doc === null) return false;
    return Object.prototype.hasOwnProperty.call(doc, 'oauthAccount');
}

/**
 * json_account_onboarded — has Claude Code's one-time first-run wizard been
 * settled for this config dir? ONE key decides it, measured on 2.1.251.
 */
export function accountOnboarded(configDir: string | undefined | null, h: string = home()): boolean {
    const doc = readConfig(accountConfigFile(configDir, h));
    if (doc === null) return false;
    return doc.hasCompletedOnboarding === true;
}

/**
 * json_account_email — the address that account is logged in AS, or undefined.
 *
 * Undefined rather than an empty string on purpose: a caller naming an account
 * after its address has to be able to tell "not logged in" from "logged in as
 * the empty string".
 */
export function accountEmail(configDir: string | undefined | null, h: string = home()): string | undefined {
    const doc = readConfig(accountConfigFile(configDir, h));
    if (doc === null) return undefined;
    const oauth = doc.oauthAccount;
    if (!oauth || typeof oauth !== 'object') return undefined;
    const mail = (oauth as Record<string, unknown>).emailAddress;
    if (typeof mail !== 'string' || mail === '') return undefined;
    return mail;
}

/** One orphan: the tilde spelling, and the address that login belongs to. */
export interface OrphanCandidate {
    /** `~/.claude-accounts/<name>`, the spelling a registry row would use. */
    spelled: string;
    /** The absolute dir, the spelling the other kind of row would use. */
    abs: string;
    /** The address, or '' when the config names none. */
    email: string;
}

/**
 * json_account_orphans — config dirs under ~/.claude-accounts holding a login
 * that NO registry row points at (DROVE-251).
 *
 * THE ADDRESS IS CARRIED, not left for the caller to go and read, because it
 * is the whole disposition: an orphan whose address a registered row also
 * holds is the duplicate a retried login minted, and purging it loses nothing;
 * an orphan whose address nothing holds is a good login whose ROW was lost,
 * and purging it throws the account away. Same shape on disk, opposite answer.
 *
 * IT ONLY EVER REPORTS. Nothing in the drover deletes a directory that has a
 * credential in it, and this is the same rule said out loud.
 *
 * ~/.claude is never a candidate: it is the ambient account, not something a
 * login made, and it lives outside this root anyway.
 */
export function accountOrphans(registry: AccountRow[] | null, h: string = home()): OrphanCandidate[] {
    const root = `${h}/.claude-accounts`;
    let entries: string[];
    try {
        entries = readdirSync(root).sort();
    } catch {
        return [];
    }
    const files: string[] = [];
    const cands: { spelled: string; abs: string; cfg: string; cred: boolean }[] = [];
    for (const base of entries) {
        const abs = `${root}/${base}`;
        try {
            if (!statSync(abs).isDirectory()) continue;
        } catch {
            continue;
        }
        let cfg = `${abs}/.claude.json`;
        const cred = existsSync(`${abs}/.credentials.json`);
        if (existsSync(cfg)) files.push(cfg);
        else cfg = '';
        cands.push({ spelled: `~/.claude-accounts/${base}`, abs, cfg, cred });
    }
    if (cands.length === 0) return [];
    const docs = readConfigs(files);
    // A registry that is missing or does not parse reads as "no row points
    // anywhere", so every logged-in dir is an orphan — the shell's own retry
    // with an empty registry, said directly.
    const reg = registry ?? [];
    const out: OrphanCandidate[] = [];
    for (const c of cands) {
        const doc = c.cfg === '' ? null : (docs[c.cfg] ?? null);
        const hasOauth = doc !== null && Object.prototype.hasOwnProperty.call(doc, 'oauthAccount');
        if (!c.cred && !hasOauth) continue;
        const pointed = reg.some((r) => r?.configDir === c.spelled || r?.configDir === c.abs);
        if (pointed) continue;
        let email = '';
        if (doc !== null) {
            const oauth = doc.oauthAccount;
            if (oauth && typeof oauth === 'object') {
                const mail = (oauth as Record<string, unknown>).emailAddress;
                if (mail !== undefined && mail !== null) email = String(mail);
            }
        }
        out.push({ spelled: c.spelled, abs: c.abs, email });
    }
    return out;
}

/**
 * json_read — the file's contents, or the default when it is missing.
 *
 * A file that EXISTS but does not parse is NOT silently replaced by the
 * default: that would discard Clay's registry on a typo. It throws instead,
 * and the caller prints the shell's refusal.
 */
export class NotJsonError extends Error {
    constructor(readonly path: string) {
        super(`drover: ${path} is not valid JSON — refusing to rewrite it`);
        this.name = 'NotJsonError';
    }
}

export function jsonRead<T>(path: string, fallback: T): T {
    let text: string;
    try {
        text = readFileSync(path, 'utf8');
    } catch {
        return fallback;
    }
    try {
        return JSON.parse(text) as T;
    } catch {
        throw new NotJsonError(path);
    }
}

/**
 * json_write — atomic replace, mode preserved.
 *
 * The temp file lives beside the target so the rename stays within one
 * filesystem; across filesystems rename is neither atomic nor guaranteed to be
 * a rename. It is seeded from the target's MODE so the replacement of a 0600
 * file is still 0600 — without that the rename hands ~/.claude.json whatever
 * the umask says and quietly widens a private file.
 */
export function jsonWrite(path: string, value: unknown): void {
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true });
    let mode: number | undefined;
    try {
        mode = statSync(path).mode & 0o777;
    } catch {
        mode = undefined;
    }
    const tmp = `${dir}/.drover-${process.pid}.json`;
    const text = `${typeof value === 'string' ? value : jqJson(value)}\n`;
    try {
        writeFileSync(tmp, text, 'utf8');
        if (mode !== undefined) {
            try {
                chmodSync(tmp, mode);
            } catch {
                // A mode we could not carry is not a reason to lose the write.
            }
        }
        // Parse before replacing. The old file is still the live one here, so
        // a bad write costs nothing.
        JSON.parse(text);
        renameSync(tmp, path);
    } catch (error) {
        try {
            unlinkSync(tmp);
        } catch {
            // Already gone.
        }
        throw error;
    }
}

/**
 * jq's pretty printer, which is what `--json` has to be byte-identical to.
 *
 * jq's default output is two-space indented with keys in insertion order, one
 * element per line, `[]` and `{}` for the empty containers, and a trailing
 * newline the caller adds. JSON.stringify agrees on every one of those, and on
 * number formatting: both print the shortest round-tripping decimal.
 */
export function jqJson(value: unknown): string {
    return JSON.stringify(value, null, 2);
}

// --- the cursor token store --------------------------------------------------
//
// A cursor row carries a TOKEN rather than a config dir, so none of the Claude
// questions above has an answer for it. Its two facts — how its token is doing
// and which address it belongs to — come from this store, never from the
// shared Keychain and never from a .claude.json it does not have.

/** Anything claiming to expire before 2000-01-01 is a MARKER, not a token. */
const cursorTombstoneBefore = 946684800;

/** Seven days out of sixty. See lib/drover-cursor-auth.sh for why seven. */
export function cursorRenewWithin(env: NodeJS.ProcessEnv = process.env): number {
    const raw = env.DROVER_CURSOR_RENEW_WITHIN;
    if (raw === undefined || raw === '' || raw.match(/[^0-9]/)) return 604800;
    return Number(raw);
}

export type CursorTokenState = 'live' | 'renew' | 'expiring' | 'expired' | 'tombstone' | 'unreadable';

/** One claim out of a JWT payload, without verifying anything. */
export function jwtClaim(token: string, key: string): string | undefined {
    const parts = token.split('.');
    if (parts.length < 2) return undefined;
    let payload: unknown;
    try {
        payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch {
        return undefined;
    }
    if (!payload || typeof payload !== 'object') return undefined;
    const v = (payload as Record<string, unknown>)[key];
    if (v === undefined || v === null) return undefined;
    return String(v);
}

function cursorTokenExp(token: string): number | undefined {
    const raw = jwtClaim(token, 'exp');
    if (raw === undefined || raw === '' || raw.match(/[^0-9]/)) return undefined;
    return Number(raw);
}

/**
 * cursor_token_state — live | renew | expiring | expired | tombstone |
 * unreadable.
 *
 * `renew` IS A WORKING TOKEN, reported separately because a cursor token
 * cannot be refreshed and its replacement needs a human at a browser, so the
 * useful moment to say something is a week BEFORE it dies.
 *
 * A token whose claims cannot be read is `unreadable` and NOT assumed dead:
 * cursor could change its format, and refusing every session over a parse
 * failure would be a worse outage than trying and being told no.
 */
export function cursorTokenState(token: string, nowSec: number = Math.floor(Date.now() / 1000), env: NodeJS.ProcessEnv = process.env): CursorTokenState {
    const exp = cursorTokenExp(token);
    if (exp === undefined) return 'unreadable';
    if (exp < cursorTombstoneBefore) return 'tombstone';
    if (exp <= nowSec) return 'expired';
    if (exp - nowSec < 300) return 'expiring';
    if (exp - nowSec < cursorRenewWithin(env)) return 'renew';
    return 'live';
}

/** cursor_token_days_left — whole days, rounded DOWN, or undefined. */
export function cursorTokenDaysLeft(token: string, nowSec: number = Math.floor(Date.now() / 1000)): number | undefined {
    const exp = cursorTokenExp(token);
    if (exp === undefined) return undefined;
    const left = exp - nowSec;
    if (left <= 0) return 0;
    return Math.floor(left / 86400);
}

export interface CursorAuthEntry {
    token?: string;
    authId?: string;
    email?: string;
    storedAt?: number;
    [key: string]: unknown;
}

/** cursor_auth_store — where the token store lives. */
export function cursorAuthStore(stateDir: string, env: NodeJS.ProcessEnv = process.env): string {
    return env.DROVER_CURSOR_AUTH || join(stateDir, 'cursor-auth.json');
}

/** cursor_auth_read — that account's stored object, or undefined. */
export function cursorAuthRead(store: string, name: string): CursorAuthEntry | undefined {
    let doc: unknown;
    try {
        doc = JSON.parse(readFileSync(store, 'utf8'));
    } catch {
        return undefined;
    }
    if (!doc || typeof doc !== 'object') return undefined;
    const entry = (doc as Record<string, unknown>)[name];
    if (!entry || typeof entry !== 'object') return undefined;
    return entry as CursorAuthEntry;
}

/**
 * cursor_auth_forget — drop the secret, so a removed cursor account does not
 * leave a live token on disk. A store that is not there is already forgotten.
 */
export function cursorAuthForget(store: string, name: string): boolean {
    let doc: Record<string, unknown>;
    try {
        const parsed: unknown = JSON.parse(readFileSync(store, 'utf8'));
        if (!parsed || typeof parsed !== 'object') return false;
        doc = parsed as Record<string, unknown>;
    } catch {
        return !existsSync(store);
    }
    delete doc[name];
    const tmp = `${store}.${process.pid}`;
    try {
        writeFileSync(tmp, `${jqJson(doc)}\n`, { encoding: 'utf8', mode: 0o600 });
        renameSync(tmp, store);
        return true;
    } catch {
        try {
            unlinkSync(tmp);
        } catch {
            // Already gone.
        }
        return false;
    }
}
