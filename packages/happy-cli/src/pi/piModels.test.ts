/**
 * Model resolution by full provider-qualified lookup (DROVE-316).
 *
 * The table below is the REAL one off `pi --list-models` on Clay's machine,
 * trimmed. It is worth being real because the ambiguity it contains is real:
 * `openai/gpt-oss-120b` is listed under BOTH huggingface and lmstudio, one of
 * which has a local server behind it and the other of which has no key, since
 * ~/.pi/agent/auth.json is empty here on purpose. Guessing between those two is
 * a session that starts and then fails its first turn on an auth error about a
 * provider nobody chose.
 */

import { describe, it, expect } from 'vitest';

import { parsePiModels, resolvePiModel, defaultPiModelRef } from './piModels';

const LIST_MODELS_OUTPUT = [
    'provider     model                                context  max-out  thinking  images',
    'glm          glm-5.2                              131.1K   8.2K     no        no',
    'google       gemini-3.1-pro-preview               1.0M     65.5K    yes       yes',
    'huggingface  openai/gpt-oss-120b                  131.1K   32.8K    yes       no',
    'lmstudio     google/gemma-4-31b                   131.1K   8.2K     no        yes',
    'lmstudio     openai/gpt-oss-120b                  131.1K   8.2K     no        no',
    'lmstudio     qwen/qwen3-coder-next                131.1K   8.2K     no        no',
    '',
].join('\n');

const models = parsePiModels(LIST_MODELS_OUTPUT, {});

describe('parsePiModels', () => {
    it('drops the header row BY NAME, not by position', () => {
        // A table that grew a title line above it would break a slice(1) and
        // not this.
        expect(models.some((m) => m.provider === 'provider')).toBe(false);
        expect(models).toHaveLength(6);
    });

    it('joins provider and id on the FIRST slash, since ids contain slashes', () => {
        const ref = models.find((m) => m.provider === 'lmstudio' && m.id === 'openai/gpt-oss-120b');
        expect(ref?.ref).toBe('lmstudio/openai/gpt-oss-120b');
    });

    it('marks the providers something on this machine is serving', () => {
        expect(models.filter((m) => m.local).map((m) => m.ref)).toEqual([
            'glm/glm-5.2',
            'lmstudio/google/gemma-4-31b',
            'lmstudio/openai/gpt-oss-120b',
            'lmstudio/qwen/qwen3-coder-next',
        ]);
    });

    it('honours DROVER_PI_LOCAL when a machine serves something else', () => {
        const custom = parsePiModels(LIST_MODELS_OUTPUT, { DROVER_PI_LOCAL: 'google' });
        expect(custom.filter((m) => m.local).map((m) => m.ref)).toEqual(['google/gemini-3.1-pro-preview']);
    });
});

describe('resolvePiModel', () => {
    it('REFUSES an ambiguous short name rather than guessing', () => {
        // The whole point. One of these is served by LM Studio on :1234 and
        // answers; the other is a cloud endpoint with no key here.
        const r = resolvePiModel(models, 'gpt-oss-120b');
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.reason).toBe('ambiguous');
        expect(r.message).toContain('huggingface/openai/gpt-oss-120b');
        expect(r.message).toContain('lmstudio/openai/gpt-oss-120b');
    });

    it('takes an exact full ref, which can never lose to a substring', () => {
        const r = resolvePiModel(models, 'lmstudio/openai/gpt-oss-120b');
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.model.provider).toBe('lmstudio');
        expect(r.model.id).toBe('openai/gpt-oss-120b');
    });

    it('resolves a substring that hits exactly one row', () => {
        const r = resolvePiModel(models, 'qwen3-coder');
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.model.ref).toBe('lmstudio/qwen/qwen3-coder-next');
    });

    it('refuses an unknown name and names what IS reachable here', () => {
        const r = resolvePiModel(models, 'claude-opus-5');
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.reason).toBe('unknown');
        expect(r.message).toContain('lmstudio/openai/gpt-oss-120b');
        // The local ones are what a machine with no cloud key can actually run.
        expect(r.message).not.toContain('google/gemini-3.1-pro-preview');
    });

    it('refuses when pi listed nothing at all, rather than picking a default', () => {
        const r = resolvePiModel([], 'anything');
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.reason).toBe('empty');
    });

    it('never resolves an ambiguous name by preferring the local one', () => {
        // Tempting, and wrong: the pick would be silent and the human would
        // never learn there were two.
        const r = resolvePiModel(models, 'openai/gpt-oss-120b');
        expect(r.ok).toBe(false);
    });
});

describe('defaultPiModelRef', () => {
    it('reads pi own settings rather than guessing', () => {
        expect(defaultPiModelRef({ defaultProvider: 'lmstudio', defaultModel: 'openai/gpt-oss-120b' }))
            .toBe('lmstudio/openai/gpt-oss-120b');
    });

    it('is null when either half is missing', () => {
        expect(defaultPiModelRef({ defaultProvider: 'lmstudio' })).toBeNull();
        expect(defaultPiModelRef(null)).toBeNull();
        expect(defaultPiModelRef({ defaultProvider: '', defaultModel: 'x' })).toBeNull();
    });
});
