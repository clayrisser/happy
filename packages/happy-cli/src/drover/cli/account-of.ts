/**
 * Which account THIS process is running on (DROVE-31, ported at DROVE-315).
 *
 * Prints one registry name and exits 0. Prints nothing when the environment
 * names no account this machine knows — a producer that cannot name an account
 * still has to publish its event, so this never fails and never blocks.
 *
 * WHY THE CONFIG DIR RATHER THAN THE STAMP. DROVER_ACCOUNT is a label a
 * wrapper exported once; CLAUDE_CONFIG_DIR is the directory Claude Code reads
 * its OAuth login out of, so it is what the account IS. Measured on Clay's own
 * live session (pid 61366): its environment carried DROVER_ORIGIN=terminal and
 * no DROVER_ACCOUNT at all, because a bare `drover` with no -a stamps nothing
 * — so every hook stamped null and the bus kept showing a name an earlier
 * process had left behind. A config dir re-read on every hook cannot go stale
 * that way.
 *
 * ORDER. Each step is only reached when the one above found nothing.
 *
 *   1. CLAUDE_CONFIG_DIR — empty or unset means the AMBIENT account, which is
 *      a different thing from a config dir that happens to be ~/.claude —
 *      matched against a registry configDir. Exact, and unambiguous even for
 *      two rows sharing one login: DROVE-21's twins have different config dirs.
 *   2. The oauthAccount address in that dir's .claude.json, matched against the
 *      registry's logins. Covers a config dir spelled a way the registry does
 *      not hold. Registry order breaks a tie, so the twins answer `main`.
 *   3. DROVER_ACCOUNT verbatim. A stamped name the registry has never heard of
 *      is still worth carrying: the flip has to know what it is flipping from.
 *
 * The TRANSCRIPT PATH is not consulted and must not be. All five accounts
 * share one projects/ store through symlinks now (DROVE-40), so the path names
 * every account at once, which is to say none of them.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { type AccountRow, accountDataDir, accountEmail, home as homeOf } from './account-store';
import { droverEnv } from './env';

export interface AccountOfDeps {
    env: NodeJS.ProcessEnv;
    home: string;
    registryPath: string;
}

/** The answer, or '' when nothing is measurable and nothing was stamped. */
export function accountOf(deps: AccountOfDeps): string {
    const { env, home, registryPath } = deps;
    const stamp = env.DROVER_ACCOUNT ?? '';

    let registry: AccountRow[] | null = null;
    try {
        const parsed: unknown = JSON.parse(readFileSync(registryPath, 'utf8'));
        if (Array.isArray(parsed)) registry = parsed as AccountRow[];
    } catch {
        registry = null;
    }
    // The stamp is the whole answer when nothing can be measured. Degrading to
    // silence here would make a wrapped session WORSE than it is today.
    if (registry === null) return stamp;

    // The dir Claude Code is actually reading, with the registry's own
    // spellings collapsed: ~/ expanded, the ambient spellings folded onto
    // ~/.claude, and trailing slashes dropped so `~/.claude-accounts/jamrizzi/`
    // matches the row.
    const cfg = env.CLAUDE_CONFIG_DIR ?? '';
    const dir = accountDataDir(cfg, home).replace(/\/+$/, '');

    // 1. the config dir against the registry.
    for (const row of registry) {
        if ((row?.harness ?? 'claude') !== 'claude') continue;
        const raw = row?.configDir ?? 'default';
        const spelling = String(raw).toLowerCase();
        const ambient = ['default', 'ambient', '~', ''].includes(spelling)
            || raw === '~/.claude' || raw === `${home}/.claude`;
        const d = ambient ? `${home}/.claude` : String(raw).replace(/^~\//, `${home}/`).replace(/\/+$/, '');
        if (d === dir && row?.name !== undefined && row?.name !== null) return String(row.name);
    }

    // 2. the login in that dir, against the registry's logins. Only reached
    // when the path matched nothing, so the per-account reads below are the
    // rare path and not a cost every hook pays.
    const mail = accountEmail(cfg, home);
    if (mail !== undefined) {
        for (const row of registry) {
            if ((row?.harness ?? 'claude') !== 'claude') continue;
            if (row?.name === undefined || row?.name === null) continue;
            const theirs = accountEmail(String(row?.configDir ?? 'default'), home);
            if (theirs !== undefined && theirs === mail) return String(row.name);
        }
    }

    // 3. whatever the wrapper stamped, registered or not.
    return stamp;
}

export async function run(args: string[]): Promise<number> {
    // No flags, and never has had any: this is not a verb anybody types. An
    // argument is ignored rather than refused, the way the shell ignored it.
    void args;
    const env = process.env;
    const home = homeOf(env);
    const registryPath = env.DROVER_ACCOUNTS || join(droverEnv(env, home).droverDir, 'accounts.json');
    const name = accountOf({ env, home, registryPath });
    if (name !== '') process.stdout.write(`${name}\n`);
    return 0;
}
