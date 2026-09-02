/**
 * Keeping credentials out of the things this machine writes down (DROVE-304).
 *
 * THE LEAK THIS EXISTS FOR. `apiMachine.ts` stringified the whole spawn params
 * object into the daemon log on every session spawn, and those params carry
 * `token` and `environmentVariables`. Not behind a debug flag, not sampled --
 * every spawn, in the clear, into `~/.happy/logs/*-daemon.log`. `droverBridge`
 * did the same with a whole answer body, and with
 * `DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING` set those same lines were
 * POSTed unencrypted off the machine.
 *
 * The transport was never the problem. Machine RPC is AES-256-GCM and the
 * server never holds a key. Everything here is about what happens on this side
 * of it, before the encryption and after the decryption.
 *
 * TWO FUNCTIONS, BECAUSE THERE ARE TWO MOMENTS TO CATCH IT.
 *
 * `redactSecrets` works on the OBJECT, and it is the one to reach for. It knows
 * which key held the value, so it can mask a value it would never recognise on
 * its own -- a bare uuid in `token`, a password that looks like a word.
 *
 * `redactSecretsInText` works on a STRING, and it is the net under the first.
 * By the time something has been stringified the key is gone as a key, so this
 * one has to find `token: "..."` and the known credential prefixes by shape.
 * It is weaker on purpose and is never the only thing between a secret and a
 * file: the fix at each call site is to stop writing the value at all, and this
 * catches the call site nobody has fixed yet.
 *
 * WHERE THE VOCABULARY COMES FROM. `credentialKeys` below is the one list in
 * this repository of names whose VALUE is a secret, and `mcp.ts` composes its
 * own report ban list out of it rather than keeping a second copy. That
 * direction matters for DROVE-296, which is actively adding names as it learns
 * what OpenCode's provider config hangs credentials off: a name added for the
 * MCP report is a name this redactor starts masking in logs, with nobody having
 * to remember to add it twice.
 *
 * The two lists are not identical and should not be. `url`, `command` and
 * `args` are on the report's ban list because a report has no business carrying
 * any of them -- but a log line legitimately says what URL it called, and a
 * redactor that masked every `url` would leave a daemon log nobody can debug
 * with, which is how a redactor gets switched off. Those stay in `mcp.ts`.
 */

/**
 * Names whose value is a credential, written the way code writes them.
 *
 * `isCredentialKey` normalizes before it looks, so one spelling here covers
 * every casing and punctuation of the same name.
 */
const canonicalCredentialKeys: readonly string[] = Object.freeze([
    // The classics, and the two the leak was actually made of.
    'token',
    'apiKey',
    'secret',
    'password',
    'authorization',
    'credential',
    'credentials',
    'env',
    'environmentVariables',
    'headers',
    // Auth flows. `oauthRefresh` is a real key in this tree's account records
    // and `refreshToken` is what the same value is called one layer up.
    'accessToken',
    'refreshToken',
    'idToken',
    'oauthRefresh',
    'bearer',
    'cookie',
    'sessionToken',
    'authToken',
    'passphrase',
    'privateKey',
    'clientSecret',
]);

const normalizeKey = (key: string): string => key.toLowerCase().replace(/[-_]/g, '');

const snakeOf = (key: string): string => key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

/**
 * The same names in every spelling a config file or a wire format uses:
 * `apiKey`, `apikey`, `api_key`.
 *
 * Spelled out rather than left to `isCredentialKey`, because this list has a
 * second consumer that does NOT normalize -- `mcpReportLeaks` in `mcp.ts`
 * lowercases a key and compares it, and DROVE-274's own test pins that
 * `API_KEY` is caught. A list that only carried `apiKey` would quietly stop
 * catching it, which is a security check weakening itself to accommodate a
 * refactor. Duplicates cost nothing on the `isCredentialKey` path, which
 * normalizes them all to the same string anyway.
 */
export const credentialKeys: readonly string[] = Object.freeze([
    ...new Set(canonicalCredentialKeys.flatMap((k) => [k, k.toLowerCase(), snakeOf(k)])),
]);

const credentialKeySet = new Set(credentialKeys.map(normalizeKey));

/** What a masked value reads as. One string, so a grep for it finds every one. */
export const redactedMarker = '[redacted]';

/**
 * Whether this key's value is a secret.
 *
 * Exported because a call site is often better off DROPPING the field than
 * logging a marker for it, and it needs to ask the same question this module
 * answers rather than hand-rolling a second opinion.
 */
export function isCredentialKey(key: string): boolean {
    return credentialKeySet.has(normalizeKey(key));
}

/**
 * A deep copy with every credential-keyed value replaced by the marker.
 *
 * The input is never mutated: this runs on live objects on their way to a log,
 * and a redactor that scrubbed the token out of the params the daemon is about
 * to spawn with would be a far worse bug than the one it fixes.
 *
 * A cycle returns the marker rather than recursing. Nothing that reaches a log
 * line needs to be cyclic, and a redactor that can hang is a redactor somebody
 * removes.
 */
export function redactSecrets<T>(value: T): T {
    return redactInner(value, new Set()) as T;
}

function redactInner(value: unknown, seen: Set<unknown>): unknown {
    if (value === null || typeof value !== 'object') return value;
    if (seen.has(value)) return redactedMarker;
    seen.add(value);
    if (Array.isArray(value)) return value.map((v) => redactInner(v, seen));
    // Anything that is not a plain record -- a Date, a Map, an Error -- is left
    // alone. Walking it would not find keys anyway, and rebuilding it as a
    // plain object is how a log line stops saying what the error was.
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        out[key] = isCredentialKey(key) ? redactedMarker : redactInner(child, seen);
    }
    return out;
}

/**
 * The credential shapes worth catching in a string with no key to go on.
 *
 * Anchored on the vendor prefixes rather than on entropy, deliberately. An
 * entropy heuristic masks session ids, commit shas and base64 payloads, and a
 * log full of markers is a log nobody reads -- which is the failure mode that
 * ends with the redactor being deleted.
 */
const literalSecretPatterns: readonly RegExp[] = Object.freeze([
    // Anthropic, OpenAI, GitHub, Slack, Google, Stripe.
    /\bsk-ant-[A-Za-z0-9_-]{8,}/g,
    /\bsk-[A-Za-z0-9_-]{16,}/g,
    /\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{16,}/g,
    /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
    /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
    /\bAIza[A-Za-z0-9_-]{20,}/g,
    /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g,
    // A JWT, which is how nearly every bearer token in this tree is shaped.
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    // `Authorization: Bearer <anything>`, whatever the token looks like.
    /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
]);

/**
 * True when a string carries something shaped like an issued credential.
 *
 * The same patterns the redactor masks with, asked as a QUESTION instead. The
 * redactor's job is to make a log safe after the fact; this one's is to refuse
 * an input before it travels, which is what DROVE-276 needs: a provider added
 * from the phone sends the NAME of an environment variable, so a value shaped
 * like a key in any field means somebody typed the key itself and should be
 * told where it goes instead.
 *
 * Refusing on the phone matters more than it looks. A value refused here never
 * leaves the handset at all -- it is not encrypted, not relayed, not held in
 * any buffer a crash dump could reach. The machine refuses the same shapes
 * independently, so a client that skipped this gets nothing written either.
 *
 * The patterns are global, so `lastIndex` is reset before each use: a shared
 * `/g` regex asked `test()` twice answers about the second half of the string.
 */
export function looksLikeSecret(value: unknown): boolean {
    if (typeof value !== 'string' || !value) return false;
    for (const pattern of literalSecretPatterns) {
        pattern.lastIndex = 0;
        if (pattern.test(value)) return true;
    }
    return false;
}

/**
 * `token: "abc"`, `"apiKey":"abc"`, `SECRET=abc` -- a credential key and the
 * value next to it, in any of the punctuations a stringifier produces.
 *
 * Built from `credentialKeys` so it cannot drift from the structural pass, and
 * built once at module load because this runs on every log line.
 */
const keyedSecretPattern = new RegExp(
    String.raw`(["']?\b(?:${credentialKeys.map((k) => k.split('').join('[-_]?')).join('|')})\b["']?\s*[:=]\s*)` +
        String.raw`(?:"([^"]*)"|'([^']*)'|([^\s,;}\]]+))`,
    'gi',
);

/**
 * The same masking, on text that has already lost its structure.
 *
 * Cheap-checked first: nearly every log line in this tree contains none of
 * these words and no vendor prefix, and this is on the path of every single
 * one of them.
 */
export function redactSecretsInText(text: string): string {
    if (!text) return text;
    let out = text;
    for (const pattern of literalSecretPatterns) {
        pattern.lastIndex = 0;
        out = out.replace(pattern, redactedMarker);
    }
    keyedSecretPattern.lastIndex = 0;
    // The quoting is put back, so a redacted line is still the shape it was.
    // A log reader that greps for `"token":"` should keep finding the line and
    // see the marker in it, rather than find nothing and conclude the field
    // stopped being written.
    out = out.replace(
        keyedSecretPattern,
        (match: string, lead: string, doubled?: string, singled?: string, bare?: string) => {
            if (doubled !== undefined) return `${lead}"${redactedMarker}"`;
            if (singled !== undefined) return `${lead}'${redactedMarker}'`;
            // A value that OPENS a block is left alone on purpose. This regex
            // would swallow the `{` and nothing else, producing a line that
            // reads redacted while every key inside it is still in the clear --
            // strictly worse than doing nothing, because it stops anyone
            // looking. Objects are the structural pass's job, and by the time
            // one reaches here it has already been through `redactSecrets`.
            if (bare !== undefined && !/^[{[]/.test(bare)) return `${lead}${redactedMarker}`;
            return match;
        },
    );
    return out;
}

/**
 * What a log line may say about a spawn, an answer, or anything else whose
 * whole object used to be stringified into one.
 *
 * The point is the ALLOWLIST. `redactSecrets` is a denylist and a denylist is
 * one unfamiliar key name away from being wrong; a call site that knows which
 * three fields are worth a log line should name those three. This is here so
 * that is one call rather than a hand-rolled object literal per site, and so a
 * value that arrives under an allowed name is STILL redacted if the name says
 * it is a credential.
 */
export function pickForLog<T extends object>(value: T | null | undefined, keys: readonly (keyof T & string)[]): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (!value) return out;
    for (const key of keys) {
        if (!(key in value)) continue;
        out[key] = isCredentialKey(key) ? redactedMarker : redactSecrets((value as Record<string, unknown>)[key]);
    }
    return out;
}
