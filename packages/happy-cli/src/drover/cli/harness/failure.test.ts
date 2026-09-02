/**
 * The catch the node launchers lost, and the sentence it prints (DROVE-374).
 *
 * The live failure this is written against: `drover cursor` on the node arm,
 * a locked macOS login keychain, and what reached Clay was
 *
 *     Error: Command failed: cursor-agent create-chat
 *     Your macOS login keychain is locked. Run security unlock-keychain and try again.
 *         at ChildProcess.exithandler (node:child_process:...)
 *         at ... node:internal/errors:983
 *
 * — a raw stack on top of a message that had already said the useful thing.
 * One sentence, naming the command and quoting what the child said, is the
 * DROVE-337 rule and it is what these pin.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { describeHarnessFailure, guardHarness } from './failure';

const execFileAsync = promisify(execFile);

describe('describeHarnessFailure', () => {
    it('names the command, the exit code and the child\'s own stderr — the real one', async () => {
        // A real child, failing the way cursor-agent did, rather than a
        // hand-built object that could drift from node's actual error shape.
        const said = 'Your macOS login keychain is locked. Run security unlock-keychain and try again.';
        const error = await execFileAsync('sh', ['-c', `echo '${said}' >&2; exit 1`]).catch((e: unknown) => e);
        const line = describeHarnessFailure(error);

        expect(line).toContain(said);
        expect(line).toContain('exited 1');
        expect(line).toContain('sh -c');
        // The whole point: one line, no stack, and no repeat of the command
        // inside node's own "Command failed: …" concatenation.
        expect(line.split('\n')).toHaveLength(1);
        expect(line).not.toContain('Command failed');
        expect(line).not.toContain('    at ');
    });

    it('says the signal when the child was killed, and says so when it printed nothing', async () => {
        const killed = await execFileAsync('sh', ['-c', 'kill -TERM $$']).catch((e: unknown) => e);
        expect(describeHarnessFailure(killed)).toContain('killed by SIGTERM');

        const quiet = await execFileAsync('sh', ['-c', 'exit 7']).catch((e: unknown) => e);
        expect(describeHarnessFailure(quiet)).toContain('it printed nothing.');
    });

    it('falls back to the message for an error that never ran a child', () => {
        expect(describeHarnessFailure(new Error('the fork is not checked out'))).toBe('the fork is not checked out');
        expect(describeHarnessFailure(null)).toContain('carried no message');
        expect(describeHarnessFailure('a bare string')).toBe('a bare string');
    });
});

describe('guardHarness', () => {
    it('passes an exit code straight through when nothing throws', async () => {
        const lines: string[] = [];
        expect(await guardHarness('cursor', (l) => lines.push(l), async () => 0)).toBe(0);
        expect(lines).toEqual([]);
    });

    it('turns a throw into one drover-prefixed sentence and exit 1, never a stack', async () => {
        const lines: string[] = [];
        const code = await guardHarness('cursor', (l) => lines.push(l), async () => {
            await execFileAsync('sh', ['-c', 'echo keychain is locked >&2; exit 1']);
            return 0;
        });
        expect(code).toBe(1);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatch(/^drover cursor: /);
        expect(lines[0]).toContain('keychain is locked');
        expect(lines[0]).not.toContain('    at ');
    });
});
