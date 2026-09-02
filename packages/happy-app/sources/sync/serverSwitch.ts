/**
 * Moving the app from one relay to another, and getting a bearer back when the
 * one we hold stops being valid (DROVE-332).
 *
 * THE PROBLEM THIS SOLVES. A bearer token is signed by the server that minted
 * it, so the moment Settings > Server points somewhere else, every request
 * carries a token the new server has never seen and answers 401. The app did
 * not re-authenticate on a 401, so the documented cure was "Restore with backup
 * key" or a logout and a fresh pairing — for a switch between two servers that
 * hold the SAME account.
 *
 * They hold the same account because identity here is the secret key on the
 * device, not a row on a server: `POST /v1/auth` with the same key is the same
 * public key, so it is the same account anywhere it is presented. That makes a
 * server switch a re-auth, not a re-registration — which is what these two
 * functions are.
 *
 * WHAT DOES NOT COME WITH YOU. Sessions and messages live on the server that
 * holds them and are encrypted to keys it does not have, so nothing can copy
 * them across. The list on the new relay starts empty until new sessions start.
 * That is the honest cost, the app says it before the switch rather than after,
 * and flipping back to the old URL brings the old list back.
 *
 * EVERYTHING IS INJECTED. The real auth path reaches libsodium and expo-crypto,
 * which do not load outside a device; keeping the deps as arguments is what
 * lets serverSwitch.spec.ts drive the whole flow against a real stub server.
 */

export interface StoredCredentials {
    token: string;
    secret: string;
}

export interface AuthDeps {
    /** POST /v1/auth: a challenge signed by the secret, in exchange for a bearer. */
    authGetToken(secret: Uint8Array, serverUrl: string): Promise<string>;
    /** The stored base64url secret as the 32 bytes the challenge is signed with. */
    decodeSecret(secret: string): Uint8Array;
    readCredentials(): Promise<StoredCredentials | null>;
    writeCredentials(credentials: StoredCredentials): Promise<boolean>;
}

export interface SwitchDeps extends AuthDeps {
    getServerUrl(): string;
    setServerUrl(url: string | null): void;
    /** What a null `nextUrl` resets to — the URL the app ships pointing at. */
    defaultServerUrl: string;
    /**
     * Restart the app. `syncCreate` refuses a second initialization, so the
     * socket keeps the endpoint it was opened with however new the token is;
     * a reload is how the app already changes account (see AuthContext.logout)
     * and it is the smallest thing that actually re-points the socket.
     */
    reload(): Promise<void>;
}

export type SwitchResult =
    | { ok: true; serverUrl: string; reauthenticated: boolean }
    | { ok: false; reason: 'auth-failed'; error: unknown };

/**
 * A fresh bearer from `serverUrl`, signed by the secret already on this device.
 * Null when there is no secret to sign with (nobody is signed in) or the server
 * refuses — never a throw, because both callers have somewhere better to put
 * the failure than a crash.
 */
export async function reauthenticate(serverUrl: string, deps: AuthDeps): Promise<string | null> {
    const credentials = await deps.readCredentials();
    if (!credentials?.secret) {
        return null;
    }
    let token: string;
    try {
        token = await deps.authGetToken(deps.decodeSecret(credentials.secret), serverUrl);
    } catch {
        return null;
    }
    if (!token) {
        return null;
    }
    const written = await deps.writeCredentials({ token, secret: credentials.secret });
    return written ? token : null;
}

/**
 * Point the app at `nextUrl` (null resets to the default) and come back signed
 * in to it.
 *
 * THE ORDER IS THE SAFETY. The new server is asked for a token FIRST, with the
 * key we already hold, and nothing is written until it answers. A server that
 * is unreachable, or that refuses this key, therefore leaves the app exactly
 * where it was — same URL, same token, same session list — instead of stranding
 * it on a URL it has no credential for.
 *
 * Not signed in yet? Then there is no token to replace: set the URL and let the
 * pairing that follows happen against the new server.
 */
export async function switchServer(nextUrl: string | null, deps: SwitchDeps): Promise<SwitchResult> {
    const target = nextUrl?.trim() || null;
    const credentials = await deps.readCredentials();

    if (!credentials?.secret) {
        deps.setServerUrl(target);
        return { ok: true, serverUrl: target ?? deps.getServerUrl(), reauthenticated: false };
    }

    // Which server the token has to come from, worked out BEFORE anything is
    // written: a null target is the reset, and the reset lands on the default.
    const resolved = target ?? deps.defaultServerUrl;

    let token: string;
    try {
        token = await deps.authGetToken(deps.decodeSecret(credentials.secret), resolved);
        if (!token) {
            throw new Error('the server returned no token');
        }
    } catch (error) {
        return { ok: false, reason: 'auth-failed', error };
    }

    const written = await deps.writeCredentials({ token, secret: credentials.secret });
    if (!written) {
        return { ok: false, reason: 'auth-failed', error: new Error('could not store the new token') };
    }
    deps.setServerUrl(target);
    await deps.reload();
    return { ok: true, serverUrl: resolved, reauthenticated: true };
}

/**
 * Send a request, and on a 401 mint a new bearer and send it once more.
 *
 * ONE RETRY, NEVER A LOOP. A 401 that survives a fresh token is a real refusal
 * — a server that does not know this account, a revoked key — and answering it
 * with more auth attempts turns a wrong server into a spin. The second 401 is
 * returned to the caller as the answer it is.
 *
 * `send` reads the stored token itself on each call, so the retry carries the
 * token `reauth` just wrote without either of them being passed one.
 */
export async function fetchWithReauth(
    send: () => Promise<Response>,
    reauth: () => Promise<string | null>,
): Promise<Response> {
    const first = await send();
    if (first.status !== 401) {
        return first;
    }
    const token = await reauth();
    if (!token) {
        return first;
    }
    return await send();
}
