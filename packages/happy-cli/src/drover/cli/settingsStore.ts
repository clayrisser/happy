/**
 * Per-session settings, from the terminal (BASED-117), in node (DROVE-315).
 *
 * The node twin of cattle-drover/lib/drover-settings.sh, function for function.
 * Its header is the contract and it still holds here:
 *
 * ONE WRITER, and it is the bus. This file is a CLIENT, not a second
 * implementation: every read and every write is an HTTP call to /v1/settings,
 * and the store's shape, its defaults and its validation live in
 * cattle-drover's engine/settings.js alone. Nothing here parses
 * session-settings.json, and nothing here knows a default.
 *
 * That is a deliberate refusal of the obvious alternative — read the file, it
 * is right there — for two reasons that have both already bitten this tree.
 * First, two writers to one file is a read-modify-write race: the bus writes
 * when the phone toggles something (BASED-118), the terminal writes when Clay
 * types, and the loser's change vanishes with nothing logged. Second, a local
 * copy of the defaults is a second source of truth, and a second source of
 * truth is how `drover accounts` came to contradict the picker about which
 * accounts had headroom.
 *
 * So when the bus is down these functions FAIL, loudly — the BusError comes
 * straight out — rather than falling back to the file. The bus is a supervised
 * launchd agent; a settings write while it is down is worth a sentence, not a
 * divergence.
 *
 * ONE DIVERGENCE FROM THE SHELL, and it is spelling. `settings_url` returned an
 * absolute URL because curl needed one; here the base belongs to busRequest,
 * which is where DROVER_URL is read for every verb, so settingsUrl returns the
 * PATH and the base rides beside it. Same string on the wire, one reader for
 * the bus URL instead of two.
 */

import { busRequest, type BusResponse } from './bus';

/** Every call gives the bus ten seconds, the way lib/drover-settings.sh does. */
export const SETTINGS_TIMEOUT_MS = 10_000;

/**
 * The endpoint, as a path. Ids are [A-Za-z0-9._:-] by the bus's own rule, so
 * nothing here needs encoding; the function exists so `/v1/settings` is
 * written once.
 */
export function settingsUrl(sub: string): string {
    return `/v1/settings${sub}`;
}

/** The effective settings for one session. */
export function settingsShow(sessionId: string, base: string): Promise<BusResponse> {
    return busRequest('GET', settingsUrl(`/sessions/${sessionId}`), { timeoutMs: SETTINGS_TIMEOUT_MS, base });
}

/** The machine defaults merged over the built-ins. */
export function settingsDefaults(base: string): Promise<BusResponse> {
    return busRequest('GET', settingsUrl('/defaults'), { timeoutMs: SETTINGS_TIMEOUT_MS, base });
}

/** The whole store, for `drover settings list`. */
export function settingsAll(base: string): Promise<BusResponse> {
    return busRequest('GET', settingsUrl(''), { timeoutMs: SETTINGS_TIMEOUT_MS, base });
}

/**
 * Merge keys into one session.
 *
 * PATCH rather than PUT because that is what a single toggle means, and a
 * `null` value clears a key back to the default. `X-Drover-By` is what the bus
 * stamps as `updatedBy`, so the settings table can say a change came from the
 * terminal rather than from a thumb.
 */
export function settingsPatch(sessionId: string, patch: string, by: string, base: string): Promise<BusResponse> {
    return busRequest('PATCH', settingsUrl(`/sessions/${sessionId}`), {
        timeoutMs: SETTINGS_TIMEOUT_MS,
        base,
        body: patch,
        headers: { 'Content-Type': 'application/json', 'X-Drover-By': by || 'cli' },
    });
}

/** Drop every override for one session, back to the defaults. */
export function settingsDelete(sessionId: string, base: string): Promise<BusResponse> {
    return busRequest('DELETE', settingsUrl(`/sessions/${sessionId}`), { timeoutMs: SETTINGS_TIMEOUT_MS, base });
}

/** Move the machine defaults. */
export function settingsPatchDefaults(patch: string, by: string, base: string): Promise<BusResponse> {
    return busRequest('PATCH', settingsUrl('/defaults'), {
        timeoutMs: SETTINGS_TIMEOUT_MS,
        base,
        body: patch,
        headers: { 'Content-Type': 'application/json', 'X-Drover-By': by || 'cli' },
    });
}

/**
 * The bus said no. The 400s here are the interesting ones: an unknown key is
 * REFUSED rather than swallowed, so a typo in a settings UI is loud instead of
 * a toggle that silently does nothing.
 *
 * Returns the sentence the bus sent, or null when the answer carried no
 * `.error` — which is the shell's `jq -r '.error // empty'`, including its
 * shrug at a body that is not JSON at all.
 */
export function settingsRefused(body: string): string | null {
    let doc: unknown;
    try {
        doc = JSON.parse(body);
    } catch {
        return null;
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null;
    const err = (doc as Record<string, unknown>).error;
    // `// empty` falls through on false and null as well as absent, and jq -r
    // prints a non-string scalar as itself.
    if (err === null || err === undefined || err === false) return null;
    const text = typeof err === 'string' ? err : JSON.stringify(err);
    return text === '' ? null : text;
}
