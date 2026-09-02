/**
 * Talking to the bus, and telling the truth about what happened (DROVE-315).
 *
 * The node twin of cattle-drover/lib/drover-bus.sh (BASED-110). That file
 * exists because three different worlds used to collapse into one sentence:
 * a refused connection, a request that timed out against a perfectly healthy
 * daemon, and a 200 with an empty body are not the same event and do not have
 * the same fix. Clay hit the middle one — `drover sessions` said "bus
 * unreachable, start it with: drover bus" while the bus was alive under
 * launchd, LISTENing, answering /v1/status in 16ms — and would have started a
 * second copy of a running service.
 *
 * curl's exit code knew which world it was; fetch's error does too, one layer
 * down in `cause.code`. Same three cases, same three sentences, so a person
 * who learned the shell's wording sees the same words from the node verb.
 *
 *   refused   ECONNREFUSED — nothing is listening. THIS is "not running".
 *   timeout   the request hit its deadline — something IS listening and did
 *             not answer in time. Never call this unreachable.
 *   resolve   ENOTFOUND / EAI_AGAIN — a misconfigured DROVER_URL, not a
 *             down bus.
 *
 * Nothing here retries and nothing here decides: the verb asks, gets a body or
 * a BusError, and says what it wants to say.
 */

import { droverEnv } from './env';

export type BusFailure = 'refused' | 'timeout' | 'resolve' | 'other';

export class BusError extends Error {
    constructor(
        readonly kind: BusFailure,
        readonly url: string,
        readonly timeoutMs: number,
        readonly detail: string,
    ) {
        super(`bus ${kind}: ${detail}`);
        this.name = 'BusError';
    }

    /**
     * What went wrong, in the words that name the actual fix. `what` is the
     * endpoint being described, for the timeout case; the caller has the
     * context. One line per shell line, so the wording stays the shell's.
     */
    explain(what: string = 'that request'): string[] {
        const base = busBase(this.url);
        switch (this.kind) {
            case 'refused':
                return [
                    `drover: bus not running at ${base} — start it with: drover bus`,
                    '  (or run the supervised stack: make -C "$DROVER_DIR" launchd)',
                ];
            case 'resolve':
                return [`drover: cannot resolve the host in DROVER_URL (${base})`];
            case 'timeout':
                return [
                    `drover: the bus is up but slow answering ${what} (>${Math.round(this.timeoutMs / 1000)}s).`,
                    '  It is listening and healthy enough to accept the connection, so this is',
                    '  NOT a down bus — do not start a second one. Check: drover status',
                ];
            default:
                return [`drover: bus request failed (${this.detail}) at ${base}`];
        }
    }
}

/** The origin of a bus URL, which is what the shell prints as $DROVER_URL. */
function busBase(url: string): string {
    try {
        return new URL(url).origin;
    } catch {
        return url;
    }
}

export interface BusResponse {
    status: number;
    body: string;
}

function classify(error: unknown): BusFailure {
    if (error && typeof error === 'object') {
        const e = error as { name?: string; code?: string; cause?: { code?: string } };
        if (e.name === 'TimeoutError' || e.name === 'AbortError') return 'timeout';
        const code = e.cause?.code ?? e.code;
        if (code === 'ECONNREFUSED') return 'refused';
        if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'resolve';
        if (code === 'UND_ERR_CONNECT_TIMEOUT') return 'timeout';
    }
    return 'other';
}

function describe(error: unknown): string {
    if (error && typeof error === 'object') {
        const e = error as { message?: string; cause?: { code?: string; message?: string } };
        if (e.cause?.code) return e.cause.code;
        if (e.cause?.message) return e.cause.message;
        if (e.message) return e.message;
    }
    return String(error);
}

async function request(url: string, init: RequestInit, timeoutMs: number): Promise<BusResponse> {
    let res: Response;
    try {
        res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
        throw new BusError(classify(error), url, timeoutMs, describe(error));
    }
    // A completed request is a completed request, whatever the status. The
    // body may still be empty or an error object; that is a different
    // question, and the caller asks it — exactly as bus_get leaves it.
    return { status: res.status, body: await res.text() };
}

export interface BusRequestOptions {
    /** How long the request may take, in milliseconds. */
    timeoutMs: number;
    /** The body, ALREADY serialised — bytes, so the caller owns the encoding. */
    body?: string;
    /** Headers. Content-Type is the caller's to set when it sends a body. */
    headers?: Record<string, string>;
    /** The bus. Defaults to DROVER_URL, the way every shell verb reads it. */
    base?: string;
}

/**
 * Any method, one request path (DROVE-315 wave 4).
 *
 * `drover settings` writes with PATCH and DELETE, which the shell spelled as
 * `curl -X PATCH` inside lib/drover-settings.sh — a second copy of the timeout,
 * the `2>/dev/null` and the exit-code vocabulary, one file away from the one in
 * lib/drover-bus.sh. Here there is one: busGet, busPost and every settings call
 * go through this, so `refused` / `timeout` / `resolve` are classified once and
 * a new method cannot arrive with its own idea of what a down bus looks like.
 *
 * `path` starts with a slash. Nothing here retries and nothing here decides.
 */
export function busRequest(method: string, path: string, opts: BusRequestOptions): Promise<BusResponse> {
    const base = opts.base ?? droverEnv().droverUrl;
    const init: RequestInit = { method };
    if (opts.headers) init.headers = opts.headers;
    if (opts.body !== undefined) init.body = opts.body;
    return request(`${base}${path}`, init, opts.timeoutMs);
}

/** GET <bus>/<path>. `path` starts with a slash; the bus comes from the env. */
export function busGet(path: string, timeoutMs: number, base: string = droverEnv().droverUrl): Promise<BusResponse> {
    return busRequest('GET', path, { timeoutMs, base });
}

/** POST a JSON body to <bus>/<path>. */
export function busPost(
    path: string,
    body: unknown,
    timeoutMs: number,
    base: string = droverEnv().droverUrl,
): Promise<BusResponse> {
    return busRequest('POST', path, {
        timeoutMs,
        base,
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
    });
}
