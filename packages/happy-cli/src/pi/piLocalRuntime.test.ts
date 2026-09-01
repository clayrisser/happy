/**
 * A dead LM Studio fails at STARTUP, naming the cause (DROVE-316).
 *
 * The failure this prevents is the worst kind, because the session starts: pi
 * loads, answers get_state, reports a model, and the phone shows a healthy
 * session with a prompt. The error then lands on the first turn as a connection
 * failure from a provider the human never chose to think about, in a session
 * they have already typed into.
 */

import { describe, it, expect } from 'vitest';

import { probePiRuntime, isLocalPiProvider, piRuntimeDownMessage } from './piLocalRuntime';

const okBody = { data: [{ id: 'openai/gpt-oss-120b' }, { id: 'glm-5.2-reap25-mlx' }] };

function fetchOk(body: unknown = okBody): typeof fetch {
    return (async () => new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch;
}

function fetchRefused(message = 'connect ECONNREFUSED 127.0.0.1:1234'): typeof fetch {
    return (async () => { throw new Error(message); }) as unknown as typeof fetch;
}

describe('isLocalPiProvider', () => {
    it('knows the runtimes this machine serves', () => {
        expect(isLocalPiProvider('lmstudio', {})).toBe(true);
        expect(isLocalPiProvider('glm', {})).toBe(true);
        expect(isLocalPiProvider('huggingface', {})).toBe(false);
        expect(isLocalPiProvider('google', {})).toBe(false);
    });

    it('is overridable, because the honest default cannot fit every machine', () => {
        expect(isLocalPiProvider('vllm', { DROVER_PI_LOCAL: 'vllm,ollama' })).toBe(true);
        expect(isLocalPiProvider('lmstudio', { DROVER_PI_LOCAL: 'vllm' })).toBe(false);
    });
});

describe('probePiRuntime', () => {
    it('fails when LM Studio is not answering, and NAMES it', () => {
        return probePiRuntime({
            provider: 'lmstudio',
            baseUrl: 'http://localhost:1234/v1',
            fetchImpl: fetchRefused(),
            env: {},
        }).then((check) => {
            expect(check.ok).toBe(false);
            expect(check.error).toContain('LM Studio is not answering');
            expect(check.error).toContain('http://localhost:1234/v1');
            expect(check.error).toContain('ECONNREFUSED');
            // Actionable, not just true.
            expect(check.error).toContain('lms server start');
        });
    });

    it('fails on an HTTP error, saying which status', async () => {
        const fetchImpl = (async () => new Response('nope', { status: 502 })) as unknown as typeof fetch;
        const check = await probePiRuntime({
            provider: 'lmstudio',
            baseUrl: 'http://localhost:1234/v1',
            fetchImpl,
            env: {},
        });
        expect(check.ok).toBe(false);
        expect(check.error).toContain('HTTP 502');
    });

    it('reports a timeout as a timeout, not as an abort', async () => {
        // "aborted" sends someone looking for a bug in drover rather than at
        // their runtime.
        const fetchImpl = ((_url: string, init?: RequestInit) => new Promise<Response>((_, reject) => {
            init?.signal?.addEventListener('abort', () => {
                const err = new Error('The operation was aborted.');
                err.name = 'AbortError';
                reject(err);
            });
        })) as unknown as typeof fetch;
        const check = await probePiRuntime({
            provider: 'lmstudio',
            baseUrl: 'http://localhost:1234/v1',
            fetchImpl,
            timeoutMs: 20,
            env: {},
        });
        expect(check.ok).toBe(false);
        expect(check.error).toContain('timed out');
    });

    it('passes when the runtime answers and lists the model', async () => {
        const check = await probePiRuntime({
            provider: 'lmstudio',
            baseUrl: 'http://localhost:1234/v1',
            modelId: 'openai/gpt-oss-120b',
            fetchImpl: fetchOk(),
            env: {},
        });
        expect(check.ok).toBe(true);
        expect(check.warning).toBeUndefined();
    });

    it('WARNS rather than fails when the model is not listed', async () => {
        // LM Studio loads models on demand, so a model absent from /v1/models
        // can still answer. Failing on that would refuse sessions that work.
        const check = await probePiRuntime({
            provider: 'lmstudio',
            baseUrl: 'http://localhost:1234/v1',
            modelId: 'nobody/such-model',
            fetchImpl: fetchOk(),
            env: {},
        });
        expect(check.ok).toBe(true);
        expect(check.warning).toContain('does not list');
    });

    it('does not probe a cloud provider at all', async () => {
        let called = false;
        const fetchImpl = (async () => { called = true; return new Response('{}'); }) as unknown as typeof fetch;
        const check = await probePiRuntime({
            provider: 'google',
            baseUrl: 'https://generativelanguage.googleapis.com/v1',
            fetchImpl,
            env: {},
        });
        expect(check.ok).toBe(true);
        // Guessing at whether an API key is good would refuse sessions over a
        // check that cannot be right.
        expect(called).toBe(false);
    });

    it('says nothing when there is no baseUrl to probe', async () => {
        const check = await probePiRuntime({
            provider: 'lmstudio',
            baseUrl: null,
            fetchImpl: fetchRefused(),
            env: {},
        });
        expect(check.ok).toBe(true);
    });
});

describe('piRuntimeDownMessage', () => {
    it('names a non-LM-Studio runtime by its provider', () => {
        const msg = piRuntimeDownMessage('glm', 'http://localhost:8420/v1', 'refused');
        expect(msg).toContain('glm is not answering on http://localhost:8420/v1');
        expect(msg).not.toContain('LM Studio');
    });
});
