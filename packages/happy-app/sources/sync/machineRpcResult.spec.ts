import { describe, expect, it } from 'vitest';

import { daemonThrownReason, machineRpcCatchMessage, normalizeMachineRpcResult } from './machineRpcResult';

/**
 * DROVE-337, measured on Clay's Mac on 2026-09-01 at 23:18.
 *
 * He forked a Claude session from the phone. The daemon copied the JSONL,
 * then failed to open a tmux window and said exactly why. The phone said
 * "Failed to fork the session." and nothing else, because the daemon's catch
 * answers with `{ error }` and every caller was testing `result.type ===
 * 'error'` on an object that has no `type` at all.
 */
describe('what comes back when a daemon handler threw', () => {
    const tmuxFailure = 'Could not open a tmux window for this session: Failed to extract PID from '
        + 'tmux output: . Nothing was started headless: a drover session is only a session when the '
        + 'terminal can see it.';

    it('turns the daemon envelope into a result the caller can read', () => {
        const normalized = normalizeMachineRpcResult<{ type: 'success' } | { type: 'error'; errorMessage: string }>(
            { error: tmuxFailure },
            'Failed to spawn session',
        );

        expect(normalized).toEqual({ type: 'error', errorMessage: tmuxFailure });
    });

    it('never substitutes the fallback while the daemon gave a reason', () => {
        const normalized = normalizeMachineRpcResult<{ type: 'success' }>(
            { error: tmuxFailure },
            'Failed to spawn session',
        );

        expect(normalized).not.toMatchObject({ errorMessage: 'Failed to spawn session' });
    });

    it('passes a real tagged result through untouched', () => {
        const success = { type: 'success', sessionId: 'abc' };

        expect(normalizeMachineRpcResult(success, 'Failed to spawn session')).toBe(success);
    });

    // The narrowness is deliberate. A handler that legitimately returns its own
    // `error` field alongside a `type` is a RESULT, not a throw, and rewriting
    // it here would be this fix causing the next one.
    it('leaves a tagged result that happens to carry an error field alone', () => {
        const result = { type: 'success', error: null, sessionId: 'abc' };

        expect(daemonThrownReason(result)).toBeNull();
        expect(normalizeMachineRpcResult(result, 'Failed to spawn session')).toBe(result);
    });

    it('treats an empty or whitespace reason as no reason at all', () => {
        expect(daemonThrownReason({ error: '   ' })).toBeNull();
        expect(normalizeMachineRpcResult({ error: '   ' }, 'Failed to spawn session'))
            .toEqual({ type: 'error', errorMessage: 'Failed to spawn session' });
    });

    it('falls back only for a shape with nothing readable in it', () => {
        for (const value of [null, undefined, 42, 'nope', {}]) {
            expect(normalizeMachineRpcResult(value, 'Failed to spawn session'))
                .toEqual({ type: 'error', errorMessage: 'Failed to spawn session' });
        }
    });

    it('keeps the message of an exception thrown on this side of the socket', () => {
        expect(machineRpcCatchMessage(new Error('Machine encryption not found for m1'), 'Failed to spawn session'))
            .toBe('Machine encryption not found for m1');
        expect(machineRpcCatchMessage(new Error('   '), 'Failed to spawn session'))
            .toBe('Failed to spawn session');
        expect(machineRpcCatchMessage({ weird: true }, 'Failed to spawn session'))
            .toBe('Failed to spawn session');
    });
});
