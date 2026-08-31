/**
 * The one line the session info screen shows (DROVE-3).
 *
 * The two things worth pinning are the honest cases: nothing stamped at all,
 * and a stamp that says the bus was unreachable. Both used to be the same
 * screen state — built-in defaults rendered as though they were live — which
 * tells Clay his session is set to prompt when nobody knows what it is set to.
 */

import { describe, expect, it } from 'vitest';
import { droverPolicySummary } from './droverPolicySummary';
import type { DroverPolicy } from '@/sync/storageTypes';

const policy = (over: Partial<DroverPolicy>): DroverPolicy => ({
    capturedAt: 1,
    sessionId: 'abc',
    effective: {},
    overrides: {},
    defaults: {},
    machine: {},
    builtIn: {},
    updatedAt: null,
    updatedBy: null,
    ...over,
} as DroverPolicy);

describe('droverPolicySummary', () => {
    it('names both policies in the words the engine uses', () => {
        expect(droverPolicySummary(policy({
            effective: { onLimit: 'auto', onFamilyExhausted: 'fallback' },
        }))).toBe('Switches on its own, falls back to another model');

        expect(droverPolicySummary(policy({
            effective: { onLimit: 'prompt', onFamilyExhausted: 'stop' },
        }))).toBe('Asks which account, stops when your model is out');
    });

    it('says nothing was reported rather than inventing a default', () => {
        expect(droverPolicySummary(undefined)).toBe('Not reported');
    });

    it('says the bus is down rather than showing a stale answer as live', () => {
        expect(droverPolicySummary(policy({ unavailable: 'the drover bus is not answering' })))
            .toBe('The drover bus is not answering');
    });
});
