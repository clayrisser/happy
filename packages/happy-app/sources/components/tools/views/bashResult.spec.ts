import { describe, expect, it } from 'vitest';

import { readBashResult } from './bashResult';

// The exact tool_result recorded for session 19c2f0a8, tool_use
// toolu_0173G9EJxTKJCchyHz71xYs8 ("File the push-tap routing ticket"),
// 2026-08-31T01:37:56Z: content a plain string, is_error false, and the
// structured toolUseResult beside it. The phone showed "[Command completed
// with no output]" for this call.
const stdout = 'DROVE-94 https://projects.corp.bitspur.com/tracker/DROVE-94';
const measuredToolUseResult = { stdout, stderr: '', interrupted: false, isImage: false, noOutputExpected: false };
const measuredContent = stdout;

describe('readBashResult (DROVE-95)', () => {
    it('reads stdout off the measured structured toolUseResult', () => {
        expect(readBashResult({ state: 'completed', result: measuredToolUseResult })).toEqual({
            stdout,
            stderr: '',
            error: null,
        });
    });

    it('reads the measured plain-string content as stdout', () => {
        expect(readBashResult({ state: 'completed', result: measuredContent })).toEqual({
            stdout,
            stderr: null,
            error: null,
        });
    });

    it('reads every text block of an array-of-text-blocks result', () => {
        const result = [{ type: 'text', text: stdout }, { type: 'text', text: 'second line' }];
        expect(readBashResult({ state: 'completed', result })).toEqual({
            stdout: `${stdout}\nsecond line`,
            stderr: null,
            error: null,
        });
    });

    it('keeps stderr apart from stdout', () => {
        expect(readBashResult({ state: 'completed', result: { stdout: 'ok', stderr: 'warn' } })).toEqual({
            stdout: 'ok',
            stderr: 'warn',
            error: null,
        });
    });

    it('shows nothing for a call that has no result yet, or that really returned nothing', () => {
        expect(readBashResult({ state: 'running', result: undefined })).toEqual({ stdout: null, stderr: null, error: null });
        expect(readBashResult({ state: 'completed', result: null })).toEqual({ stdout: null, stderr: null, error: null });
        expect(readBashResult({ state: 'completed', result: { stdout: '', stderr: '' } })).toEqual({ stdout: '', stderr: '', error: null });
    });

    it('prints an unknown object as JSON rather than dropping it', () => {
        expect(readBashResult({ state: 'completed', result: { exitCode: 3 } })).toEqual({
            stdout: '{"exitCode":3}',
            stderr: null,
            error: null,
        });
    });

    it('reads an error from a string, a permission refusal, or text blocks', () => {
        expect(readBashResult({ state: 'error', result: 'command not found' }).error).toBe('command not found');
        expect(readBashResult({ state: 'error', result: { error: 'denied by user' } }).error).toBe('denied by user');
        expect(readBashResult({ state: 'error', result: [{ type: 'text', text: 'boom' }] }).error).toBe('boom');
        expect(readBashResult({ state: 'error', result: undefined })).toEqual({ stdout: null, stderr: null, error: null });
    });
});
