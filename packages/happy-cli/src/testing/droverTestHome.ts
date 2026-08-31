/**
 * The throwaway home the test harness runs Claude in (DROVE-81).
 *
 * Every integration suite here starts a REAL claude: planMode against
 * /tmp/happy-testing-ground-<hex>, claude.integration against
 * environments/data/envs/<name>/project, the authenticated project through the
 * daemon. src/claude/sdk/query.ts copies process.env into that child, so the
 * child inherits CLAUDE_CONFIG_DIR from the shell the tests were started in:
 * an agent's drover session (~/.claude-accounts/<acct>) or, unset, ~/.claude.
 * Since drover-share-sessions, every one of those has its projects/ symlinked
 * into ~/.claude-shared/projects, which is exactly where Cattle Drover's
 * registry scans and its picker reads. Measured 2026-08-31: 79 of the 90
 * transcripts under a day old in that store were "Say exactly ready" and
 * "Count slowly from 1 to 40", and `drover sessions` showed nineteen idle
 * fixture rows against one real session.
 *
 * So the harness gets a config dir of its own. DROVER_TEST_HOME names it
 * (the same variable the bats suite in cattle-drover honours), and
 * CLAUDE_CONFIG_DIR becomes <DROVER_TEST_HOME>/claude-config, whose projects/
 * is a plain directory and never a link into the store.
 *
 * WHY THE DEFAULT IS STABLE, not a per-run tmpdir. On macOS the login lives in
 * a Keychain item named for a hash of the CLAUDE_CONFIG_DIR path, so a fresh
 * directory has no login and the integration suites skip. A stable path
 * (~/.local/state/cattle-drover/test-home/claude-config) can be logged in
 * ONCE, by a human, with
 *
 *     CLAUDE_CONFIG_DIR=~/.local/state/cattle-drover/test-home/claude-config claude auth login
 *
 * and every later run is authenticated. Nothing here copies a credential.
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type DroverTestHome = {
    home: string;
    claudeConfigDir: string;
    projectsDir: string;
};

type Env = Record<string, string | undefined>;

/** Where the test home is: DROVER_TEST_HOME, else under the drover state dir. */
export function droverTestHomeDir(env: Env = process.env): string {
    if (env.DROVER_TEST_HOME) {
        return env.DROVER_TEST_HOME;
    }
    const stateDir = env.STATE_DIR
        || join(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'cattle-drover');
    return join(stateDir, 'test-home');
}

/**
 * Point the given env (process.env by default) at the test home. Creates the
 * config dir and its projects/ if missing, and refuses to proceed if that
 * projects/ is a symlink: a link into the store is the bug this exists to end.
 */
export function applyDroverTestHome(env: Env = process.env): DroverTestHome {
    const home = droverTestHomeDir(env);
    const claudeConfigDir = join(home, 'claude-config');
    const projectsDir = join(claudeConfigDir, 'projects');
    mkdirSync(projectsDir, { recursive: true });
    if (lstatSync(projectsDir).isSymbolicLink()) {
        throw new Error(`${projectsDir} is a symlink; the test home's projects dir must be a real directory (DROVE-81)`);
    }
    env.DROVER_TEST_HOME = home;
    env.CLAUDE_CONFIG_DIR = claudeConfigDir;
    // The drover wrapper's account stamp names the account CLAUDE_CONFIG_DIR
    // used to point at; with the dir replaced the stamp would be a lie.
    delete env.DROVER_ACCOUNT;
    return { home, claudeConfigDir, projectsDir };
}

/** True when Claude Code has recorded a login in that config dir. */
export function isClaudeConfigDirLoggedIn(claudeConfigDir: string): boolean {
    try {
        const raw = readFileSync(join(claudeConfigDir, '.claude.json'), 'utf8');
        const parsed = JSON.parse(raw) as { oauthAccount?: unknown };
        return Boolean(parsed.oauthAccount);
    } catch {
        return false;
    }
}

/** The one store every real account's projects/ links into. */
export function sharedStoreProjectsDir(): string {
    return join(homedir(), '.claude-shared', 'projects');
}

/** The projects/ dir name Claude Code derives from a cwd. */
export function mungedProjectName(cwd: string): string {
    return cwd.replace(/[^a-zA-Z0-9-]/g, '-');
}

/**
 * The fixture-shaped directory names in a projects dir: the cwd patterns
 * cattle-drover's lib/drover-fixtures.sh hides, as their munged names. Used
 * to assert that a run added none of them to the shared store. A worktree
 * under ~/.cache/drover-worktrees is NOT one: a real session starts there;
 * only its environments/data/envs/<name>/project copy is a fixture, and that
 * path matches the envs pattern on its own.
 */
export function fixtureProjectNames(projectsDir: string): string[] {
    if (!existsSync(projectsDir)) {
        return [];
    }
    return readdirSync(projectsDir).filter((name) => {
        return name.startsWith('-private-tmp-happy-testing-ground-')
            || name.startsWith('-tmp-happy-testing-ground-')
            || name.startsWith('-private-tmp-happy-claude-goal-fixtures')
            || name.startsWith('-tmp-happy-claude-goal-fixtures')
            || name.startsWith('-private-tmp-drover-trust-test')
            || name.startsWith('-tmp-drover-trust-test')
            || /-environments-data-envs-.+-project(-|$)/.test(name);
    }).sort();
}
