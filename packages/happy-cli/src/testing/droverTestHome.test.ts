/**
 * DROVE-81: the harness never points a claude at the shared session store.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    applyDroverTestHome,
    droverTestHomeDir,
    fixtureProjectNames,
    isClaudeConfigDirLoggedIn,
    mungedProjectName,
    sharedStoreProjectsDir,
} from './droverTestHome';

let scratch: string;

beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'drover-test-home-'));
});

afterEach(() => {
    rmSync(scratch, { force: true, recursive: true });
});

describe('droverTestHomeDir', () => {
    it('honours DROVER_TEST_HOME', () => {
        expect(droverTestHomeDir({ DROVER_TEST_HOME: '/x/y' })).toBe('/x/y');
    });

    it('defaults under the drover state dir, so a login there survives the run', () => {
        expect(droverTestHomeDir({})).toBe(join(homedir(), '.local', 'state', 'cattle-drover', 'test-home'));
        expect(droverTestHomeDir({ XDG_STATE_HOME: '/s' })).toBe('/s/cattle-drover/test-home');
        expect(droverTestHomeDir({ STATE_DIR: '/d' })).toBe('/d/test-home');
    });
});

describe('applyDroverTestHome', () => {
    it('replaces an inherited account config dir with one under the test home', () => {
        const env: Record<string, string | undefined> = {
            DROVER_TEST_HOME: join(scratch, 'home'),
            CLAUDE_CONFIG_DIR: join(homedir(), '.claude-accounts', 'jamrizzi'),
            DROVER_ACCOUNT: 'jamrizzi',
        };
        const home = applyDroverTestHome(env);
        expect(env.CLAUDE_CONFIG_DIR).toBe(join(scratch, 'home', 'claude-config'));
        expect(env.DROVER_ACCOUNT).toBeUndefined();
        expect(home.projectsDir).toBe(join(scratch, 'home', 'claude-config', 'projects'));
        expect(lstatSync(home.projectsDir).isDirectory()).toBe(true);
        expect(lstatSync(home.projectsDir).isSymbolicLink()).toBe(false);
    });

    it('never lands under a real account or the shared store', () => {
        const env: Record<string, string | undefined> = { DROVER_TEST_HOME: join(scratch, 'home') };
        const home = applyDroverTestHome(env);
        for (const forbidden of [join(homedir(), '.claude'), join(homedir(), '.claude-accounts'), join(homedir(), '.claude-shared')]) {
            expect(home.claudeConfigDir.startsWith(forbidden)).toBe(false);
        }
    });

    it('refuses a projects dir that is a symlink', () => {
        const home = join(scratch, 'home');
        mkdirSync(join(home, 'claude-config'), { recursive: true });
        mkdirSync(join(scratch, 'elsewhere'));
        symlinkSync(join(scratch, 'elsewhere'), join(home, 'claude-config', 'projects'));
        expect(() => applyDroverTestHome({ DROVER_TEST_HOME: home })).toThrow(/symlink/);
    });
});

describe('isClaudeConfigDirLoggedIn', () => {
    it('reads the oauthAccount Claude Code records, and nothing else', () => {
        expect(isClaudeConfigDirLoggedIn(scratch)).toBe(false);
        writeFileSync(join(scratch, '.claude.json'), '{"oauthAccount":{"emailAddress":"x@y"}}');
        expect(isClaudeConfigDirLoggedIn(scratch)).toBe(true);
    });
});

describe('fixtureProjectNames', () => {
    it('is the three cwd patterns drover hides, as munged names', () => {
        const projects = join(scratch, 'projects');
        for (const cwd of [
            '/private/tmp/happy-testing-ground-0a1b2c3d',
            '/Users/x/happy/environments/data/envs/bold-forest/project',
            join(homedir(), '.cache', 'drover-worktrees', 'DROVE-1', 'happy'),
            '/Users/x/Projects/real',
        ]) {
            mkdirSync(join(projects, mungedProjectName(cwd)), { recursive: true });
        }
        expect(fixtureProjectNames(projects)).toEqual([
            '-Users-x-happy-environments-data-envs-bold-forest-project',
            mungedProjectName(join(homedir(), '.cache', 'drover-worktrees', 'DROVE-1', 'happy')),
            '-private-tmp-happy-testing-ground-0a1b2c3d',
        ].sort());
        expect(fixtureProjectNames(join(scratch, 'missing'))).toEqual([]);
    });

    it('names the shared store every account links into', () => {
        expect(sharedStoreProjectsDir()).toBe(join(homedir(), '.claude-shared', 'projects'));
    });
});
