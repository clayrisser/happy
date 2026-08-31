import { describe, expect, it, vi } from 'vitest';

import {
    GATE_ANSWER_TIMEOUT_MS,
    answerWithDeadline,
    gateAnswerTrouble,
} from './gateAnswerTimeout';

/**
 * The spinner that ran for eighteen minutes (DROVE-218).
 *
 * Clay answered two Run Bash prompts and the Allow button stayed a spinner.
 * The socket RPC underneath waits 50 seconds, and an app suspended while it
 * waits runs no timer at all, so the screen said "working on it" for a quarter
 * of an hour. A spinner with no end is worse than a visible failure: he waits
 * instead of retrying.
 */
describe('an answer is never allowed to spin forever', () => {
    it('reports ok when the answer is acknowledged', async () => {
        const outcome = await answerWithDeadline(async () => undefined, 50);
        expect(outcome).toEqual({ kind: 'ok' });
    });

    it('gives up after the deadline rather than waiting on the RPC', async () => {
        const outcome = await answerWithDeadline(() => new Promise(() => { }), 10);
        expect(outcome).toEqual({ kind: 'timeout' });
    });

    it('names a real failure, so the reason is on the card and not in a console', async () => {
        const outcome = await answerWithDeadline(async () => { throw new Error('The computer did not respond'); }, 50);
        expect(outcome).toEqual({ kind: 'failed', message: 'The computer did not respond' });
    });

    it('clears its timer on a fast answer, so nothing is left pending behind it', async () => {
        const cancel = vi.fn();
        await answerWithDeadline(async () => undefined, 10_000, setTimeout, cancel);
        expect(cancel).toHaveBeenCalledTimes(1);
    });

    it('swallows a late rejection, so a timed-out answer cannot resurface as an unhandled error', async () => {
        let reject: (error: Error) => void = () => { };
        const outcome = await answerWithDeadline(() => new Promise((_, r) => { reject = r; }), 10);
        expect(outcome.kind).toBe('timeout');
        reject(new Error('too late'));
        await new Promise((r) => setTimeout(r, 5));
    });

    it('waits seconds, not the RPC\'s fifty', () => {
        expect(GATE_ANSWER_TIMEOUT_MS).toBeLessThan(50_000);
        expect(GATE_ANSWER_TIMEOUT_MS).toBeGreaterThanOrEqual(3_000);
    });
});

/**
 * DROVE-203 is the opposite bug: four destructive-bash gates resolved
 * `{"action":"allow","by":"tmux-gum"}` with nobody at the terminal. A timeout
 * that picked a side would be that bug wearing a nicer name, so the only thing
 * a deadline is allowed to do is put the buttons back.
 */
describe('a timeout decides nothing', () => {
    it('never calls the answer more than once, so nothing is retried into an allow', async () => {
        const answer = vi.fn(() => new Promise(() => { }));
        await answerWithDeadline(answer, 10);
        expect(answer).toHaveBeenCalledTimes(1);
    });

    it('says nothing was decided, in those words', () => {
        expect(gateAnswerTrouble({ kind: 'timeout' })).toContain('Nothing was decided');
        expect(gateAnswerTrouble({ kind: 'failed', message: 'offline' })).toContain('Nothing was decided');
    });

    it('offers the way out beside the failure', () => {
        expect(gateAnswerTrouble({ kind: 'timeout' })).toContain('dismiss');
    });

    it('says nothing at all when the answer landed', () => {
        expect(gateAnswerTrouble({ kind: 'ok' })).toBeNull();
    });
});
