/**
 * The daemon's provider-write relay (DROVE-276).
 *
 * What these pin, and why each one is here rather than trusted:
 *
 *   THE REFUSAL RUNS ON THIS SIDE TOO. The phone checks first so a key never
 *   leaves the handset, but this handler is reachable by anything that can talk
 *   to the daemon, and the phone's check is exactly the one a different client
 *   would skip.
 *
 *   THE BUS IS THE ONLY WRITER. `machineMcps.ts` falls back to
 *   `drover mcps --json` when the bus is down, and that is right for a READ.
 *   A write must not have a second path into a config file, so a bus that
 *   cannot be reached is an error and not a fallback.
 *
 *   A 404 SAYS "RESTART IT". A drover that predates this ticket answers 404 on
 *   every route here, and that is the likeliest failure in the field: the
 *   daemon is running the code that shipped before the kickstart. "the bus
 *   answered 404" is not something anybody can act on.
 */

import { describe, expect, it, vi } from 'vitest';

import {
    configureMachineModel,
    listMachineProviders,
    putMachineProvider,
    removeMachineProvider,
} from './machineProviders';

const okBody = {
    ok: true,
    harness: 'opencode',
    config: '~/.config/opencode/opencode.jsonc',
    did: 'appended',
    backup: null,
    providers: [{ id: 'gw', name: 'Corp Gateway', origin: 'drover', models: [{ id: 'big-1', name: 'Big One' }], modelCount: 1 }],
    count: 1,
    restartRequired: true,
};

// The parameter list is spelled out so `mock.calls[0][1]` is a typed tuple
// rather than an empty one: an inferred zero-arg mock makes every path
// assertion below a compile error.
const bus = (json: unknown, status = 200) => vi.fn(async (_method: string, _path: string, _body?: unknown) => ({ status, json }));

describe('putMachineProvider', () => {
    it('sends the provider under its id and returns what the bus said', async () => {
        const callBus = bus(okBody);
        const result = await putMachineProvider(
            { id: 'gw', name: 'Corp Gateway', baseURL: 'https://gw.example.com/v1', apiKeyEnv: 'CORP_GW_KEY' },
            { callBus },
        );
        expect(result.ok).toBe(true);
        expect(callBus).toHaveBeenCalledWith('PUT', '/v1/providers/opencode/gw', {
            name: 'Corp Gateway',
            baseURL: 'https://gw.example.com/v1',
            apiKeyEnv: 'CORP_GW_KEY',
        });
        // The id rides the path, not the body: it is the key of the thing being
        // replaced, and a body that could disagree with the path is a body that
        // will one day rename somebody's provider.
        expect(callBus.mock.calls[0][2]).not.toHaveProperty('id');
    });

    it('percent-encodes an id rather than pasting it into a path', async () => {
        const callBus = bus({ ok: false, error: 'refused' });
        await putMachineProvider({ id: 'a.b-c' }, { callBus });
        expect(callBus.mock.calls[0][1]).toBe('/v1/providers/opencode/a.b-c');
    });

    it('refuses a credential without calling the bus at all', async () => {
        const callBus = bus(okBody);
        const result = await putMachineProvider(
            { id: 'gw', apiKeyEnv: 'sk-proj-FIXTURESECRETabcdefghij' },
            { callBus },
        );
        expect(result.ok).toBe(false);
        expect(result.ok === false && result.error).toContain('environment variable');
        // Nothing left this process. That is the point of checking here as well
        // as on the phone.
        expect(callBus).not.toHaveBeenCalled();
    });

    it('says restart it when the drover has no provider routes yet', async () => {
        const callBus = bus({ error: 'not found' }, 404);
        const result = await putMachineProvider({ id: 'gw' }, { callBus });
        expect(result.ok).toBe(false);
        expect(result.ok === false && result.error).toContain('restart the drover');
    });

    it('passes the machine\'s own refusal through, word for word', async () => {
        // The bus answers 400 with a sentence the person can act on. Rewriting
        // it here into "the write failed" is how a good message gets lost.
        const said = 'That looks like an API key — send the NAME of the environment variable that holds it, never the key itself.';
        const callBus = bus({ ok: false, error: said }, 400);
        const result = await putMachineProvider({ id: 'gw' }, { callBus });
        expect(result).toEqual({ ok: false, error: said });
    });

    it('never falls back to spawning a binary when the bus is unreachable', async () => {
        const callBus = vi.fn(async (_method: string, _path: string, _body?: unknown) => {
            throw new Error('connect ECONNREFUSED 127.0.0.1:7970');
        });
        const result = await putMachineProvider({ id: 'gw' }, { callBus });
        expect(result.ok).toBe(false);
        expect(result.ok === false && result.error).toContain('Could not reach the drover');
        expect(result.ok === false && result.error).toContain('start it');
    });
});

describe('removeMachineProvider', () => {
    it('deletes by id and sends no body', async () => {
        const callBus = bus({ ...okBody, did: 'rewrote', providers: [], count: 0 });
        const result = await removeMachineProvider('gw', { callBus });
        expect(result.ok).toBe(true);
        expect(callBus).toHaveBeenCalledWith('DELETE', '/v1/providers/opencode/gw');
    });

    it('refuses an empty id before it becomes a request for the whole collection', async () => {
        const callBus = bus(okBody);
        const result = await removeMachineProvider('', { callBus });
        expect(result.ok).toBe(false);
        expect(callBus).not.toHaveBeenCalled();
    });
});

describe('configureMachineModel', () => {
    it('patches one model under its provider', async () => {
        const callBus = bus({ ...okBody, did: 'rewrote' });
        const result = await configureMachineModel(
            'gw',
            { id: 'big-1', contextWindow: 400000, maxOutput: 64000, options: { temperature: 0.7 } },
            { callBus },
        );
        expect(result.ok).toBe(true);
        expect(callBus).toHaveBeenCalledWith('PATCH', '/v1/providers/opencode/gw/models/big-1', {
            contextWindow: 400000,
            maxOutput: 64000,
            options: { temperature: 0.7 },
        });
    });

    it('encodes a model id that carries a slash, because lmstudio\'s do', async () => {
        const callBus = bus(okBody);
        await configureMachineModel('lmstudio', { id: 'openai/gpt-oss-20b' }, { callBus });
        expect(callBus.mock.calls[0][1]).toBe('/v1/providers/opencode/lmstudio/models/openai%2Fgpt-oss-20b');
    });

    it('refuses a credential-named option without calling the bus', async () => {
        const callBus = bus(okBody);
        const result = await configureMachineModel('gw', { id: 'm', options: { apiKey: 'x' } }, { callBus });
        expect(result.ok).toBe(false);
        expect(callBus).not.toHaveBeenCalled();
    });
});

describe('listMachineProviders', () => {
    it('reads without changing anything', async () => {
        const callBus = bus({ ...okBody, did: 'unchanged', restartRequired: false });
        const result = await listMachineProviders({ callBus });
        expect(result.ok).toBe(true);
        expect(callBus).toHaveBeenCalledWith('GET', '/v1/providers');
    });
});
