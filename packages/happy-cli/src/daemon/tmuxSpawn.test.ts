import { describe, expect, it } from 'vitest';

import {
    buildDroverPaneArgv,
    droverBinPath,
    formatDroverPaneCommand,
    resolveDaemonAgent,
    shellescape,
    spawnPreconditionError,
    tmuxWindowNameForDirectory,
} from './tmuxSpawn';
import { appendDaemonSpawnModeArgs } from './spawnModeArgs';
import { wrapTmuxCommandWithSessionEnvironmentSanitizer } from './sessionEnvironment';

// DROVE-2: a session started from the phone opens in a tmux window running the
// drover wrapper, in local mode, so the terminal and the app are one session.
describe('the pane command a phone-started session runs', () => {
    it('launches the drover wrapper in LOCAL mode, never remote', () => {
        const argv = buildDroverPaneArgv({ droverBin: '/d/bin/drover', agent: 'claude' });

        expect(argv).toEqual([
            '/d/bin/drover',
            'claude',
            '--happy-starting-mode', 'local',
            '--started-by', 'daemon',
        ]);
        expect(argv).not.toContain('remote');
    });

    it('carries the permission, model and effort flags the daemon resolved', () => {
        const modeArgs: string[] = [];
        appendDaemonSpawnModeArgs(modeArgs, { directory: '/repo', modelMode: 'opus' }, 'claude', true);

        const argv = buildDroverPaneArgv({ droverBin: '/d/bin/drover', agent: 'claude', modeArgs });

        expect(argv.slice(-3)).toEqual(['--dangerously-skip-permissions', '--model', 'opus']);
    });

    // A fork requested from the phone is an ordinary spawn carrying the parent
    // Claude conversation id, so it opens its own window the same way.
    it('attaches a fork to the conversation it was forked from', () => {
        const argv = buildDroverPaneArgv({
            droverBin: '/d/bin/drover',
            agent: 'claude',
            resumeId: '11111111-2222-4333-8444-555555555555',
        });

        expect(argv.slice(-2)).toEqual(['--resume', '11111111-2222-4333-8444-555555555555']);
    });

    // DROVE-337: a CLONE lands here too. A fork resumes a conversation the
    // target can read; a clone cannot, so the conversation is exported to a
    // file and the pane is told to start from it. The PATH travels, never the
    // text: a seed runs to tens of kilobytes.
    it('hands a clone its seed file, and never the seed itself', () => {
        const argv = buildDroverPaneArgv({
            droverBin: '/d/bin/drover',
            agent: 'cursor',
            seedFile: '/state/cattle-drover/clones/20260901T231800Z-4242.md',
        });

        expect(argv.slice(-2)).toEqual(['--seed', '/state/cattle-drover/clones/20260901T231800Z-4242.md']);
    });

    it('leaves --seed off a spawn that has no seed', () => {
        const argv = buildDroverPaneArgv({ droverBin: '/d/bin/drover', agent: 'cursor' });

        expect(argv).not.toContain('--seed');
    });

    it('quotes a seed path with a space, so a clone under "My Projects" starts', () => {
        const command = formatDroverPaneCommand({
            droverBin: '/d/bin/drover',
            agent: 'cursor',
            seedFile: '/Users/clay/My State/clones/seed one.md',
        });

        expect(command.endsWith("'--seed' '/Users/clay/My State/clones/seed one.md'")).toBe(true);
    });

    it('quotes every word, so a checkout path with a space still starts', () => {
        const command = formatDroverPaneCommand({
            droverBin: "/Users/clay/My Projects/cattle-drover/bin/drover",
            agent: 'codex',
        });

        expect(command).toBe(
            "'/Users/clay/My Projects/cattle-drover/bin/drover' 'codex'"
            + " '--happy-starting-mode' 'local' '--started-by' 'daemon'",
        );
    });

    it('survives the session-environment unset prefix the tmux window gets', () => {
        const command = wrapTmuxCommandWithSessionEnvironmentSanitizer(
            formatDroverPaneCommand({ droverBin: '/d/bin/drover', agent: 'claude' }),
            {},
        );

        expect(command.startsWith('unset ')).toBe(true);
        expect(command).toContain("'/d/bin/drover' 'claude'");
    });

    it('escapes a quote rather than ending the shell word', () => {
        expect(shellescape("it's")).toBe("'it'\\''s'");
    });
});

describe('which agent a spawn request names', () => {
    it('defaults to claude when the app sends none', () => {
        expect(resolveDaemonAgent(undefined)).toBe('claude');
    });

    it('keeps every agent the daemon can launch', () => {
        expect(resolveDaemonAgent('codex')).toBe('codex');
        expect(resolveDaemonAgent('gemini')).toBe('gemini');
        expect(resolveDaemonAgent('openclaw')).toBe('openclaw');
        expect(resolveDaemonAgent('agy')).toBe('agy');
    });

    // The old tmux path fell back to claude through a ternary chain, which was
    // harmless while nothing could reach it and is a wrong-agent bug now that
    // every phone spawn goes this way.
    it('refuses an agent it does not know instead of quietly running claude', () => {
        expect(resolveDaemonAgent('rig')).toBeNull();
        expect(resolveDaemonAgent('bogus')).toBeNull();
    });
});

describe('the tmux window name', () => {
    it('is the directory basename, so the window list reads like the work', () => {
        expect(tmuxWindowNameForDirectory('/Users/clay/Projects/bitspur/cattle-drover'))
            .toBe('cattle-drover');
    });

    it('ignores a trailing slash', () => {
        expect(tmuxWindowNameForDirectory('/Users/clay/Projects/happy/')).toBe('happy');
    });

    it('replaces what tmux targets would misread', () => {
        expect(tmuxWindowNameForDirectory('/tmp/my repo:v2')).toBe('my-repo-v2');
    });

    it('falls back rather than naming a window nothing', () => {
        expect(tmuxWindowNameForDirectory('/')).toBe('drover');
        expect(tmuxWindowNameForDirectory('///')).toBe('drover');
    });

    it('stays short enough to read in a status line', () => {
        const name = tmuxWindowNameForDirectory('/tmp/' + 'a'.repeat(120));
        expect(name).toHaveLength(40);
    });
});

describe('finding the drover wrapper', () => {
    it('takes DROVER_BIN outright', () => {
        expect(droverBinPath({ DROVER_BIN: '/elsewhere/drover' }, '/checkout'))
            .toBe('/elsewhere/drover');
    });

    it('otherwise sits next to the adapters the bus hooks already use', () => {
        expect(droverBinPath({}, '/checkout')).toBe('/checkout/bin/drover');
    });
});

// Clay's ruling on DROVE-2: no headless session is ever created. A spawn that
// cannot get a pane FAILS with something the phone can show, rather than
// quietly producing a second kind of session the terminal can never see.
describe('what has to be true before a window is opened', () => {
    const ok = { tmuxAvailable: true, droverBin: '/d/bin/drover', droverExists: true };

    it('goes ahead when tmux answers and the wrapper is there', () => {
        expect(spawnPreconditionError(ok)).toBeNull();
    });

    it('fails rather than falling back to headless when tmux is unreachable', () => {
        const error = spawnPreconditionError({ ...ok, tmuxAvailable: false });

        expect(error).toMatch(/tmux is not available/);
        expect(error).toMatch(/the terminal and the app are the same session/);
    });

    it('names the wrapper it could not find, and how to point at it', () => {
        const error = spawnPreconditionError({ ...ok, droverExists: false });

        expect(error).toContain('/d/bin/drover');
        expect(error).toMatch(/DROVER_BIN/);
    });

    it('reports tmux first, because a missing wrapper is the lesser problem', () => {
        expect(spawnPreconditionError({ ...ok, tmuxAvailable: false, droverExists: false }))
            .toMatch(/tmux is not available/);
    });
});
