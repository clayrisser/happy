/**
 * A server switch and a 401, driven against a REAL stub relay (DROVE-332).
 *
 * The stub is a node http server that behaves the way a Happy relay does about
 * the one thing this code cares about: it mints a bearer for a key it is shown,
 * and it answers 401 to a bearer it did not mint. That is enough to catch the
 * bug this exists for — a phone pointed at the drover relay while carrying a
 * token Happy's server signed, which is every phone the moment Clay changes the
 * URL.
 *
 * Real HTTP rather than a stubbed fetch because the assertion is about status
 * codes and a retry that carries a DIFFERENT header than the first attempt, and
 * a hand-rolled fake is exactly where that stops being true.
 */

import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fetchWithReauth, reauthenticate, switchServer, type SwitchDeps } from './serverSwitch';

/** A relay that mints `token-for-<key>` and rejects anything it did not sign. */
function startRelay(name: string) {
    let issued = 0;
    const server: Server = createServer((req, res) => {
        const mint = `token-${name}`;
        if (req.url === '/v1/auth' && req.method === 'POST') {
            issued += 1;
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ success: true, token: mint }));
            return;
        }
        if (req.headers.authorization !== `Bearer ${mint}`) {
            res.writeHead(401).end('unauthorized');
            return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ sessions: [], server: name }));
    });
    return {
        server,
        get issued() { return issued; },
        async url(): Promise<string> {
            await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
            const address = server.address();
            if (!address || typeof address === 'string') throw new Error('no address');
            return `http://127.0.0.1:${address.port}`;
        },
        async stop() {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}

/** The real auth call's shape: POST the challenge, take the token. */
async function authGetToken(_secret: Uint8Array, serverUrl: string): Promise<string> {
    const response = await fetch(`${serverUrl}/v1/auth`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ challenge: 'c', signature: 's', publicKey: 'p' }),
    });
    if (!response.ok) throw new Error(`auth failed: ${response.status}`);
    return (await response.json() as { token: string }).token;
}

describe('a phone moving between relays', () => {
    let hosted: ReturnType<typeof startRelay>;
    let estate: ReturnType<typeof startRelay>;
    let hostedUrl: string;
    let estateUrl: string;
    let stored: { token: string; secret: string } | null;
    let current: string | null;
    let reloads: number;

    const deps = (): SwitchDeps => ({
        authGetToken,
        decodeSecret: () => new Uint8Array(32),
        readCredentials: async () => stored,
        writeCredentials: async (c) => { stored = c; return true; },
        getServerUrl: () => current ?? hostedUrl,
        setServerUrl: (url) => { current = url; },
        defaultServerUrl: '',
        reload: async () => { reloads += 1; },
    });

    beforeEach(async () => {
        hosted = startRelay('hosted');
        estate = startRelay('estate');
        hostedUrl = await hosted.url();
        estateUrl = await estate.url();
        stored = { token: 'token-hosted', secret: 'sssecret' };
        current = null;
        reloads = 0;
    });

    afterEach(async () => {
        await hosted.stop();
        await estate.stop();
    });

    // The switch itself: one call, the identity kept (the same secret is
    // re-presented), a token the NEW server signed, and a reload so the socket
    // reopens against it.
    it('keeps the identity and comes back holding the new server\'s token', async () => {
        const result = await switchServer(estateUrl, { ...deps(), defaultServerUrl: hostedUrl });
        expect(result).toEqual({ ok: true, serverUrl: estateUrl, reauthenticated: true });
        expect(current).toBe(estateUrl);
        expect(stored).toEqual({ token: 'token-estate', secret: 'sssecret' });
        expect(reloads).toBe(1);
    });

    // The one that matters when the URL is a typo or the relay is down: the app
    // must not end up on a server it has no credential for.
    it('leaves the app exactly where it was when the new server will not have it', async () => {
        await estate.stop();
        const result = await switchServer(estateUrl, { ...deps(), defaultServerUrl: hostedUrl });
        expect(result.ok).toBe(false);
        expect(current).toBeNull();
        expect(stored).toEqual({ token: 'token-hosted', secret: 'sssecret' });
        expect(reloads).toBe(0);
    });

    it('resets to the default the same way, re-authing against it', async () => {
        current = estateUrl;
        stored = { token: 'token-estate', secret: 'sssecret' };
        const result = await switchServer(null, { ...deps(), defaultServerUrl: hostedUrl });
        expect(result).toEqual({ ok: true, serverUrl: hostedUrl, reauthenticated: true });
        expect(current).toBeNull();
        expect(stored?.token).toBe('token-hosted');
    });

    // Nobody signed in yet: there is no token to replace, and the pairing that
    // follows should happen against the server just chosen.
    it('just moves the URL when there is nothing signed in', async () => {
        stored = null;
        const result = await switchServer(estateUrl, { ...deps(), defaultServerUrl: hostedUrl });
        expect(result).toEqual({ ok: true, serverUrl: estateUrl, reauthenticated: false });
        expect(current).toBe(estateUrl);
        expect(reloads).toBe(0);
    });
});

describe('a 401 from the server we are pointed at', () => {
    let relay: ReturnType<typeof startRelay>;
    let url: string;
    let stored: { token: string; secret: string } | null;

    const authDeps = () => ({
        authGetToken,
        decodeSecret: () => new Uint8Array(32),
        readCredentials: async () => stored,
        writeCredentials: async (c: { token: string; secret: string }) => { stored = c; return true; },
    });

    const send = () => fetch(`${url}/v1/sessions`, {
        headers: { Authorization: `Bearer ${stored?.token ?? ''}` },
    });

    beforeEach(async () => {
        relay = startRelay('estate');
        url = await relay.url();
        // The whole bug in one line: a token Happy's server signed, presented
        // to the drover relay.
        stored = { token: 'token-hosted', secret: 'sssecret' };
    });

    afterEach(async () => {
        await relay.stop();
    });

    it('re-auths with the key on the device and retries once, so the request succeeds', async () => {
        const response = await fetchWithReauth(send, () => reauthenticate(url, authDeps()));
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ server: 'estate' });
        expect(stored?.token).toBe('token-estate');
        expect(relay.issued).toBe(1);
    });

    it('does not touch a request that was never refused', async () => {
        stored = { token: 'token-estate', secret: 'sssecret' };
        const response = await fetchWithReauth(send, () => reauthenticate(url, authDeps()));
        expect(response.status).toBe(200);
        expect(relay.issued).toBe(0);
    });

    // A 401 that survives a fresh token is a real refusal. Answering it with
    // more auth attempts turns a wrong server into a spin.
    it('returns the 401 rather than looping when a fresh token is refused too', async () => {
        const refusing = createServer((req, res) => {
            if (req.url === '/v1/auth') {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ success: true, token: 'still-wrong' }));
                return;
            }
            res.writeHead(401).end('no');
        });
        await new Promise<void>((resolve) => refusing.listen(0, '127.0.0.1', resolve));
        const address = refusing.address();
        if (!address || typeof address === 'string') throw new Error('no address');
        url = `http://127.0.0.1:${address.port}`;
        try {
            const response = await fetchWithReauth(send, () => reauthenticate(url, authDeps()));
            expect(response.status).toBe(401);
        } finally {
            await new Promise<void>((resolve) => refusing.close(() => resolve()));
        }
    });

    // Nothing to sign with: the 401 is the answer, and the caller sees it.
    it('gives back the 401 untouched when there is no secret on the device', async () => {
        stored = null;
        const response = await fetchWithReauth(send, () => reauthenticate(url, authDeps()));
        expect(response.status).toBe(401);
        expect(relay.issued).toBe(0);
    });
});
