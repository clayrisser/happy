import { describe, expect, it } from 'vitest';

import {
    cloneSeedArgv,
    exportCloneSeed,
    isCloneTargetHarness,
    readCloneSeedOutcome,
    type CloneSeedRun,
} from './cloneSeed';

const request = {
    transcriptPath: '/Users/clay/.claude/projects/-repo/db93e97b-9857-440f-ab9c-f265bd007e28.jsonl',
    sessionId: 'db93e97b-9857-440f-ab9c-f265bd007e28',
    directory: '/Users/clay/Projects/bitspur/cattle-drover',
    harness: 'cursor' as const,
};

describe('the command that exports a conversation for another harness', () => {
    it('names the transcript rather than asking the bus to find it', () => {
        expect(cloneSeedArgv(request)).toEqual([
            'clone',
            'db93e97b-9857-440f-ab9c-f265bd007e28',
            '--transcript', request.transcriptPath,
            '--cwd', request.directory,
            '--to', 'cursor',
            '--seed-only',
        ]);
    });

    // Without --seed-only, `drover clone` opens the window itself and the
    // daemon has no session id to hand the phone, no account decision applied
    // and no precondition check. It has to be there, and it has to be last.
    it('always ends in --seed-only, so nothing is started by the export', () => {
        expect(cloneSeedArgv(request).at(-1)).toBe('--seed-only');
        expect(cloneSeedArgv({ ...request, turns: 10 }).at(-1)).toBe('--seed-only');
    });

    it('passes a turn cap through only when one was asked for', () => {
        expect(cloneSeedArgv({ ...request, turns: 10 })).toContain('--turns');
        expect(cloneSeedArgv({ ...request, turns: 10 })).toContain('10');
        expect(cloneSeedArgv(request)).not.toContain('--turns');
        expect(cloneSeedArgv({ ...request, turns: -1 })).not.toContain('--turns');
        expect(cloneSeedArgv({ ...request, turns: 1.5 })).not.toContain('--turns');
    });

    it('knows which harnesses drover clone accepts', () => {
        expect(isCloneTargetHarness('cursor')).toBe(true);
        expect(isCloneTargetHarness('claude')).toBe(true);
        expect(isCloneTargetHarness('opencode')).toBe(true);
        expect(isCloneTargetHarness('pi')).toBe(true);
        expect(isCloneTargetHarness('codex')).toBe(false);
        expect(isCloneTargetHarness(undefined)).toBe(false);
    });
});

describe('reading what drover clone said', () => {
    const run = (over: Partial<CloneSeedRun>): CloneSeedRun => ({ code: 0, stdout: '', stderr: '', ...over });

    it('takes the seed path off stdout', () => {
        const outcome = readCloneSeedOutcome(run({ stdout: '/Users/clay/.local/state/cattle-drover/clones/x.md\n' }));

        expect(outcome).toEqual({ type: 'success', seedPath: '/Users/clay/.local/state/cattle-drover/clones/x.md' });
    });

    // The whole point of shelling out to the real command: its refusals are
    // written sentences, and a written sentence is the most useful thing the
    // phone can be shown. Never replaced with wording of our own.
    it('passes a refusal through word for word', () => {
        const refusal = 'drover clone: session db93e97b has written no transcript yet, so there is\n'
            + '  no conversation to clone. Say something to it first.';
        const outcome = readCloneSeedOutcome(run({ code: 1, stderr: `${refusal}\n` }));

        expect(outcome).toEqual({ type: 'error', errorMessage: refusal });
    });

    it('invents wording only for a failure that said nothing', () => {
        expect(readCloneSeedOutcome(run({ code: 3 })))
            .toEqual({ type: 'error', errorMessage: 'drover clone exited with code 3 and said nothing.' });
    });

    it('treats a zero exit with no path as a failure, not an empty success', () => {
        const outcome = readCloneSeedOutcome(run({ code: 0, stdout: '  \n' }));

        expect(outcome.type).toBe('error');
    });
});

describe('exporting a seed', () => {
    it('refuses before running anything when the wrapper is not on this machine', async () => {
        let ran = false;
        const result = await exportCloneSeed(request, {
            droverBin: () => '/nope/bin/drover',
            droverExists: () => false,
            run: async () => { ran = true; return { code: 0, stdout: '', stderr: '' }; },
        });

        expect(ran).toBe(false);
        expect(result.type).toBe('error');
        expect(result.type === 'error' && result.errorMessage).toContain('/nope/bin/drover');
    });

    it('runs the wrapper in the session directory and returns the seed', async () => {
        const seen: { bin?: string; argv?: string[]; cwd?: string } = {};
        const result = await exportCloneSeed(request, {
            droverBin: () => '/d/bin/drover',
            droverExists: () => true,
            run: async (bin, argv, cwd) => {
                seen.bin = bin;
                seen.argv = argv;
                seen.cwd = cwd;
                return { code: 0, stdout: '/state/clones/seed.md\n', stderr: '' };
            },
        });

        expect(seen.bin).toBe('/d/bin/drover');
        expect(seen.cwd).toBe(request.directory);
        expect(seen.argv?.[0]).toBe('clone');
        expect(result).toEqual({ type: 'success', seedPath: '/state/clones/seed.md' });
    });
});
