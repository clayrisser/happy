/**
 * The CLI's stamp survives the app's metadata parse (DROVE-3).
 *
 * The fixture below is not hand-written. It is what `readPolicy` actually
 * returned from a real cattle-drover bus (engine/settings.js on a scratch
 * STATE_DIR) after a phone write and a `drover settings set` from a terminal —
 * captured verbatim on 2026-08-30. So this pins the SHAPE the two packages have
 * to agree on, which nothing else does: the CLI type and the app schema are
 * declared in different repositories' worth of code and can only drift.
 *
 * The second case is the one that matters more. `droverPolicy` is additive and
 * ephemeral, so a block the app cannot read must degrade to absent rather than
 * failing the whole MetadataSchema parse — a strict field here would drop the
 * SESSION, not just the policy, which is how a bad stamp takes a chat off the
 * list.
 */

import { describe, expect, it } from 'vitest';
import { MetadataSchema } from './storageTypes';

const captured = {
    capturedAt: 1788125000000,
    sessionId: '11111111-2222-3333-4444-555555555555',
    effective: {
        onLimit: 'prompt',
        onLimitTimeout: 'auto',
        onLimitPromptTtlMs: 600000,
        onFamilyExhausted: 'fallback',
        familyFallback: {
            fable: ['opus', 'sonnet'],
            mythos: ['opus', 'sonnet'],
            opus: ['sonnet'],
            sonnet: ['haiku'],
        },
    },
    overrides: { onLimit: 'prompt', onFamilyExhausted: 'fallback' },
    defaults: {
        onLimit: 'prompt',
        onLimitTimeout: 'auto',
        onLimitPromptTtlMs: 600000,
        onFamilyExhausted: 'fallback',
        familyFallback: { fable: ['opus', 'sonnet'] },
    },
    machine: { onFamilyExhausted: 'fallback' },
    builtIn: {
        onLimit: 'prompt',
        onLimitTimeout: 'auto',
        onLimitPromptTtlMs: 600000,
        onFamilyExhausted: 'stop',
        familyFallback: { fable: ['opus', 'sonnet'] },
    },
    updatedAt: 1788125385497,
    updatedBy: 'phone',
};

const base = { path: '/Users/clay/Projects/bitspur/cattle-drover', host: 'mac' };

describe('droverPolicy on session metadata', () => {
    it('keeps every layer the CLI stamped from a live bus', () => {
        const parsed = MetadataSchema.safeParse({ ...base, droverPolicy: captured });
        expect(parsed.success).toBe(true);
        const policy = parsed.success ? parsed.data.droverPolicy : undefined;
        expect(policy?.overrides.onLimit).toBe('prompt');
        expect(policy?.machine.onFamilyExhausted).toBe('fallback');
        expect(policy?.builtIn.onFamilyExhausted).toBe('stop');
        expect(policy?.effective.familyFallback?.fable).toEqual(['opus', 'sonnet']);
        expect(policy?.updatedBy).toBe('phone');
    });

    it('carries the bus-is-down stamp instead of pretending to know', () => {
        const parsed = MetadataSchema.safeParse({
            ...base,
            droverPolicy: { ...captured, unavailable: 'the drover bus at http://127.0.0.1:7970 is not answering' },
        });
        expect(parsed.success).toBe(true);
        expect(parsed.success && parsed.data.droverPolicy?.unavailable).toContain('not answering');
    });

    it('drops a malformed block, never the session', () => {
        const parsed = MetadataSchema.safeParse({ ...base, droverPolicy: { capturedAt: 'yesterday' } });
        expect(parsed.success).toBe(true);
        expect(parsed.success && parsed.data.droverPolicy).toBeUndefined();
        expect(parsed.success && parsed.data.host).toBe('mac');
    });
});
