/**
 * The refusal that lets DROVE-276 ship while DROVE-304 is still open.
 *
 * DROVE-296 held the provider write because two paths on the machine were
 * writing free text to disk in the clear, and an API key typed on a phone
 * would have gone down one of them. The hold lifts by never sending a key —
 * so these tests are about exactly one thing: there is no field here through
 * which a credential can travel, and a person who tries is told where it goes
 * instead.
 *
 * The same shapes are refused again on the machine
 * (cattle-drover engine/opencode-providers.js). These are the phone's copy,
 * and the point of the phone's copy is that a refused value never leaves the
 * handset at all.
 */

import { describe, expect, it } from 'vitest';

import {
    providerInputRefusal,
    providerModelRefusal,
    providerSecretRefusal,
} from './providers';
import { looksLikeSecret } from './redact';

describe('looksLikeSecret', () => {
    it('catches the shapes real credentials come in', () => {
        for (const value of [
            'sk-ant-FIXTURESECRETabcdefgh',
            'sk-proj-FIXTURESECRETabcdefghij',
            'ghp_FIXTURESECRETabcdefghijkl',
            'github_pat_FIXTURESECRETabcdefghijklm',
            'xoxb-1234567890-FIXTURESECRET',
            'AIzaFIXTURESECRETabcdefghijklmnopqrst',
            'sk_live_FIXTURESECRETabcdefgh',
            'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJGSVhUVVJFIn0.FIXTURESECRETabcdef',
            'Bearer FIXTURESECRETabcdef',
        ]) {
            expect(looksLikeSecret(value), value).toBe(true);
        }
    });

    it('does not catch a real model id, which is the whole reason it is not entropy-based', () => {
        // An entropy heuristic tight enough for a hex key rejects these, and a
        // validator that refuses real model ids is one people route around.
        for (const value of [
            'qwen/qwen3-30b-a3b-2507',
            'openai/gpt-oss-20b',
            'claude-opus-4-20250514',
            'nemotron-3-ultra-free',
            'https://gateway.example.com/v1',
            'OPENAI_API_KEY',
        ]) {
            expect(looksLikeSecret(value), value).toBe(false);
        }
    });

    it('answers the same the second time, because the patterns are global', () => {
        // A shared /g regex asked test() twice answers about the second half of
        // the string. Getting this wrong makes the check pass every other call.
        expect(looksLikeSecret('sk-proj-FIXTURESECRETabcdefghij')).toBe(true);
        expect(looksLikeSecret('sk-proj-FIXTURESECRETabcdefghij')).toBe(true);
        expect(looksLikeSecret('gpt-5')).toBe(false);
        expect(looksLikeSecret('gpt-5')).toBe(false);
    });
});

describe('providerInputRefusal', () => {
    const valid = {
        id: 'gw',
        name: 'Corp Gateway',
        baseURL: 'https://gateway.example.com/v1',
        apiKeyEnv: 'CORP_GW_KEY',
        npm: '@ai-sdk/openai-compatible',
        models: [{ id: 'big-1', name: 'Big One', contextWindow: 200000, maxOutput: 32000 }],
    };

    it('passes a provider with every field filled in', () => {
        expect(providerInputRefusal(valid)).toBeNull();
    });

    it('refuses a key in every field that takes free text', () => {
        for (const patch of [
            { id: 'sk-proj-FIXTURESECRETabcdefghij' },
            { name: 'sk-proj-FIXTURESECRETabcdefghij' },
            { apiKeyEnv: 'ghp_FIXTURESECRETabcdefghijkl' },
            { baseURL: 'https://x.example/v1/sk-proj-FIXTURESECRETabcdefghij' },
            { models: [{ id: 'm', name: 'xoxb-1234567890-FIXTURESECRET' }] },
            { models: [{ id: 'm', options: { note: 'sk-ant-FIXTURESECRETabcdefgh' } }] },
        ]) {
            expect(providerInputRefusal({ ...valid, ...patch }), JSON.stringify(patch))
                .toBe(providerSecretRefusal);
        }
    });

    it('is one sentence, and says where the key goes', () => {
        // A paragraph under a text field is a paragraph nobody reads.
        expect(providerSecretRefusal.split('. ').length).toBe(1);
        expect(providerSecretRefusal).toContain('NAME of the environment variable');
    });

    it('tells somebody who typed a key into the key field which field it is', () => {
        // The one refusal that is really an instruction: right intent, wrong
        // field. `sk-live-…` is short enough to miss the secret patterns, which
        // is exactly why the shape check has to answer usefully too.
        const refusal = providerInputRefusal({ ...valid, apiKeyEnv: 'sk-live-abc' });
        expect(refusal).toContain('NAME of an environment variable');
        expect(refusal).toContain('stays on the computer');
    });

    it('refuses a base URL that could carry a token', () => {
        expect(providerInputRefusal({ ...valid, baseURL: 'https://x.example/v1?key=abc' }))
            .toContain('query string');
        expect(providerInputRefusal({ ...valid, baseURL: 'https://user:pw@x.example/v1' }))
            .toContain('username or password');
        expect(providerInputRefusal({ ...valid, baseURL: 'https://x.example/v1#frag' }))
            .toContain('#fragment');
        expect(providerInputRefusal({ ...valid, baseURL: 'ftp://x.example/v1' }))
            .toContain('http or https');
    });

    it('refuses an id or an npm package that is not one', () => {
        expect(providerInputRefusal({ ...valid, id: '' })).toContain('provider id');
        expect(providerInputRefusal({ ...valid, id: 'has spaces' })).toContain('provider id');
        expect(providerInputRefusal({ ...valid, id: 'a/b' })).toContain('provider id');
        expect(providerInputRefusal({ ...valid, npm: 'Not A Package' })).toContain('npm package');
    });

    it('accepts an empty optional rather than treating it as a bad value', () => {
        // A blank field means "leave this alone", which is what the editor
        // sends for a provider whose base URL the machine refuses to report.
        expect(providerInputRefusal({ id: 'gw' })).toBeNull();
        expect(providerInputRefusal({ id: 'gw', baseURL: '', apiKeyEnv: '', npm: '' })).toBeNull();
    });
});

describe('providerModelRefusal', () => {
    it('takes a model id with a slash in it, because lmstudio\'s have one', () => {
        expect(providerModelRefusal({ id: 'openai/gpt-oss-20b' })).toBeNull();
        expect(providerModelRefusal({ id: 'qwen/qwen3-30b-a3b-2507' })).toBeNull();
    });

    it('asks for the other half of a limit rather than inventing it', () => {
        // OpenCode's `limit` wants both members; half of one is a config the
        // binary rejects.
        expect(providerModelRefusal({ id: 'm', contextWindow: 200000 }))
            .toContain('context window and a max output');
        expect(providerModelRefusal({ id: 'm', maxOutput: 32000 }))
            .toContain('context window and a max output');
        expect(providerModelRefusal({ id: 'm', contextWindow: 200000, maxOutput: 32000 })).toBeNull();
    });

    it('asks for the other half of a cost too', () => {
        expect(providerModelRefusal({ id: 'm', costInput: 3 })).toContain('input and an output price');
        expect(providerModelRefusal({ id: 'm', costInput: 3, costOutput: 15 })).toBeNull();
    });

    it('refuses an option key that NAMES a credential, whatever is in it', () => {
        for (const key of ['apiKey', 'api_key', 'authorization', 'access_token', 'password', 'clientSecret']) {
            expect(providerModelRefusal({ id: 'm', options: { [key]: 'anything' } }), key)
                .toContain('credential belongs in an environment variable');
        }
    });

    it('lets a real model option through', () => {
        // The numeric temperature, which is what OpenCode hands the SDK. The
        // BOOLEAN of the same name one level up is a capability flag and a
        // different field; both are legal and they mean different things.
        expect(providerModelRefusal({ id: 'm', options: { temperature: 0.2, top_p: 0.9 } })).toBeNull();
        expect(providerModelRefusal({ id: 'm', temperature: true, reasoning: true })).toBeNull();
    });

    it('wants a whole number of tokens', () => {
        expect(providerModelRefusal({ id: 'm', contextWindow: 1.5, maxOutput: 2 }))
            .toContain('whole number of tokens');
        expect(providerModelRefusal({ id: 'm', contextWindow: 0, maxOutput: 2 }))
            .toContain('whole number of tokens');
    });
});
