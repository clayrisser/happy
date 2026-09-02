/**
 * Where a `--account` session's Cursor credential actually lands (DROVE-387).
 *
 * THE BUG THIS EXISTS TO FIX. `drover cursor --account <name>` used to hand the
 * account's token out as `CURSOR_AUTH_TOKEN` in the environment. DROVE-253
 * scrubs exactly that variable out of every turn — for good reason, since
 * cursor-agent EXCHANGES an inherited token and PERSISTS the pair into the
 * machine's shared credential slot — so the token never reached cursor-agent at
 * all. What did reach it was `AGENT_CLI_CREDENTIAL_STORE=memory`, which is an
 * EMPTY store. The session started as nobody, with no way to sign in.
 *
 * So the credential goes where cursor-agent reads one without any variable
 * carrying it: the FILE store. Same mechanism the login flow already uses
 * (drover/cli/cursor-login.ts: a private HOME plus
 * `AGENT_CLI_CREDENTIAL_STORE=file`, harvested back out of
 * `<home>/.cursor/auth.json`).
 *
 * MEASURED against cursor-agent 2026.08.25-3e8eec8, out of the bundle, so
 * nobody has to re-derive it:
 *
 *     getAuthFilePath(e) … case "darwin": return join(homedir(), `.${e}`, "auth.json")
 *     … new (credential store)({ domain: "cursor", store: AGENT_CLI_CREDENTIAL_STORE })
 *     writeAuthData: JSON.stringify({accessToken, refreshToken, apiKey, bedrockCredentials}), mode 384
 *     ensureDirectoryExists: chmod 448
 *
 * `homedir()`, not `CURSOR_CONFIG_DIR`, and the domain is the fixed string
 * `cursor`. There is no environment variable that moves that path. So HOME is
 * the only lever there is, 384 is 0600 and 448 is 0700, and the shape below is
 * the shape cursor-agent writes itself.
 *
 * AND THAT IS WHY THIS IS A SHADOW HOME RATHER THAN AN EMPTY ONE. Everything
 * the turn's tools run inherits HOME. A bare private directory would take
 * `~/.gitconfig`, `~/.ssh` and `~/.cursor/mcp.json` away from the session —
 * a Cursor session that commits as nobody and has no MCP servers is a worse
 * bug than the one being fixed. So the directory is a symlink farm over the
 * real home, minus the ONE file drover owns:
 *
 *     <home>/*            -> $HOME/*        (everything except .cursor)
 *     <home>/.cursor/*    -> $HOME/.cursor/*(everything except auth.json)
 *     <home>/.cursor/auth.json                 this account's token, 0600
 *
 * The real `~/.cursor/auth.json` and the real Keychain slot are never written.
 * Adding an account cannot log Clay out of his own IDE, which is the rule
 * lib/drover-cursor-auth.sh has carried since DROVE-256.
 *
 * `hooks.json` IS LINKED WHETHER OR NOT IT EXISTS YET. `drover cursor`
 * registers its hooks LAST, after the account is resolved, and on a machine
 * that has never run one the real `~/.cursor/hooks.json` is not there when
 * this mirror runs. A link that dangles until installHooks writes the file is
 * harmless (it reads as absent, exactly like no link), and it means the hooks
 * reach the turn on the first run rather than the second. cursor-agent reads
 * hooks from `homedir()/.cursor/hooks.json`, not from CURSOR_CONFIG_DIR
 * (measured in cursorConfig.ts), so under the swapped HOME the link is the
 * only way they are seen at all.
 *
 * NOT REBUILT FROM SCRATCH ON EACH START, deliberately. Two sessions may run on
 * one account at the same time, and an `rm -rf` between them would pull the
 * credential out from under a live turn. Every step below CONVERGES instead:
 * links are replaced only when they are links, a real file sitting where a link
 * should go is left alone, and the token is rewritten every time so a rotated
 * login is picked up.
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The private home for one account. Sanitised the way the renew stamp is. */
export function cursorCredentialHomeDir(stateDir: string, account: string): string {
    return join(stateDir, 'cursor-home', account.replace(/[^A-Za-z0-9._-]/g, '_'));
}

/** One symlink, without ever destroying something that is not one. */
function linkOver(target: string, at: string): void {
    try {
        const st = lstatSync(at);
        if (!st.isSymbolicLink()) return;
        if (readlinkSync(at) === target) return;
        unlinkSync(at);
    } catch {
        // Nothing there, which is the common case.
    }
    try {
        symlinkSync(target, at);
    } catch {
        // A race with the other session doing the same thing, or a filesystem
        // with no symlinks. One entry that could not be mirrored is not a
        // reason to refuse the session.
    }
}

/** Mirror `from`'s entries into `into` as symlinks, skipping `except`. */
function mirror(from: string, into: string, except: Set<string>): void {
    let entries: string[];
    try {
        entries = readdirSync(from);
    } catch {
        return;
    }
    for (const name of entries) {
        if (except.has(name)) continue;
        linkOver(join(from, name), join(into, name));
    }
}

/**
 * Build (or refresh) the private home and put the token in it. Returns the
 * home. Throws only when the credential itself could not be written, which is
 * the one failure that must not be run past: a session on a home with no
 * auth.json is the empty-store bug again, wearing a different hat.
 */
export function prepareCursorCredentialHome(home: string, token: string, realHome: string): string {
    if (home === '' || home === realHome || realHome.startsWith(`${home}/`)) {
        throw new Error(`refusing to use ${home || '<empty>'} as a private cursor home`);
    }
    mkdirSync(home, { recursive: true, mode: 0o700 });
    mirror(realHome, home, new Set(['.cursor']));
    const dotCursor = join(home, '.cursor');
    mkdirSync(dotCursor, { recursive: true, mode: 0o700 });
    mirror(join(realHome, '.cursor'), dotCursor, new Set(['auth.json']));
    // Linked even when the target does not exist yet: the hooks are written
    // after this runs, and the turn must see them the first time. See above.
    linkOver(join(realHome, '.cursor', 'hooks.json'), join(dotCursor, 'hooks.json'));
    const auth = join(dotCursor, 'auth.json');
    // Replace a LINK, never follow one: if the mirror ever raced and left the
    // real ~/.cursor/auth.json linked here, writing through it would overwrite
    // Clay's own login — the exact thing the file store is here to avoid.
    try {
        if (lstatSync(auth).isSymbolicLink()) unlinkSync(auth);
    } catch {
        // Not there.
    }
    // The shape cursor-agent's own setAuthentication writes. Both slots hold
    // the same string because that is what the login path stores (measured; see
    // lib/drover-cursor-auth.sh for the reading), and there is no refresh flow
    // for a subscription token to use a different one with.
    writeFileSync(auth, `${JSON.stringify({ accessToken: token, refreshToken: token, apiKey: null }, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
    });
    return home;
}

/** Does this home actually carry a credential? For a caller that wants to check. */
export function cursorCredentialHomeHasToken(home: string): boolean {
    return existsSync(join(home, '.cursor', 'auth.json'));
}
