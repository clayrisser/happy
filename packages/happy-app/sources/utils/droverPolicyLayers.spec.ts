/**
 * Which layer a policy value came from (DROVE-3).
 *
 * This is the whole reason the CLI carries `overrides`, `machine` and `builtIn`
 * apart instead of one merged object: the screen has to say "you set this for
 * this session" rather than "prompt", because those are different answers to
 * "why did it not ask me".
 */

import { describe, expect, it } from 'vitest';
import { defaultValue, effectiveValue, sourceOf } from '@/utils/droverPolicyLayers';
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

describe('policy layers', () => {
    it('a session override beats the machine default beats the built-in', () => {
        const layered = policy({
            effective: { onLimit: 'prompt' },
            overrides: { onLimit: 'prompt' },
            machine: { onLimit: 'auto' },
            builtIn: { onLimit: 'prompt' },
        });
        expect(sourceOf(layered, 'onLimit')).toBe('session');
        expect(effectiveValue(layered, 'onLimit')).toBe('prompt');

        const machine = policy({
            effective: { onLimit: 'auto' },
            machine: { onLimit: 'auto' },
            builtIn: { onLimit: 'prompt' },
        });
        expect(sourceOf(machine, 'onLimit')).toBe('machine');

        const shipped = policy({
            effective: { onLimit: 'prompt' },
            builtIn: { onLimit: 'prompt' },
        });
        expect(sourceOf(shipped, 'onLimit')).toBe('builtIn');
    });

    it('reports unknown, never a value, when the bus was unreachable', () => {
        const down = policy({ unavailable: 'not answering', builtIn: { onLimit: 'prompt' } });
        expect(sourceOf(down, 'onLimit')).toBe('unknown');
        expect(effectiveValue(down, 'onLimit')).toBeNull();
        expect(defaultValue(down, 'onLimit')).toBeNull();
    });

    it('the default is the merged machine layer, not the session one', () => {
        const layered = policy({
            effective: { onFamilyExhausted: 'fallback' },
            overrides: { onFamilyExhausted: 'fallback' },
            defaults: { onFamilyExhausted: 'stop' },
        });
        expect(effectiveValue(layered, 'onFamilyExhausted')).toBe('fallback');
        expect(defaultValue(layered, 'onFamilyExhausted')).toBe('stop');
    });
});
