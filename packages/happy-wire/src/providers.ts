/**
 * Adding and configuring OpenCode's custom providers from the phone
 * (DROVE-276).
 *
 * `mcp.ts` is the READ half: what providers a machine has and what models they
 * carry. This is the WRITE half, and the reason it can exist at all is that it
 * carries no key.
 *
 * DROVE-296 held this. Its reason was sound -- a provider needs an API key,
 * and two paths a phone answer takes were writing free text to disk in the
 * clear. The hold lifts by never sending one: the phone sends `apiKeyEnv`, the
 * NAME of an environment variable, and the machine writes OpenCode's own
 * `{env:NAME}` reference. OpenCode resolves it from Clay's shell at its own
 * start. There is no field in any type here that takes a key value, and the
 * validator below refuses one in every field that takes free text.
 *
 * THE CHECK RUNS ON BOTH ENDS ON PURPOSE. Here, so a value shaped like a
 * credential never leaves the handset -- not encrypted, not relayed, not in a
 * buffer. And again on the machine, in cattle-drover's
 * `engine/opencode-providers.js`, so a client that skipped this one gets
 * nothing written either. The two lists are deliberate twins.
 *
 * THE MODEL SCHEMA IS OPENCODE'S OWN, read off the installed 1.18.20
 * (`@opencode-ai/sdk` `ProviderConfig`), and one thing in it is worth stating
 * because it reads backwards: `temperature` on a model is a BOOLEAN -- "this
 * model accepts one" -- and the VALUE lives in that model's free-form
 * `options`, which is what OpenCode hands the SDK. Both are settable and they
 * are different fields.
 */

import { looksLikeSecret } from './redact';

/** One model, as the phone sends it. Field names are the phone's, not OpenCode's. */
export interface ProviderModelInput {
    /** `gpt-5`, or `openai/gpt-oss-20b`. A slash is legitimate; lmstudio's have one. */
    id: string;
    name?: string;
    /** OpenCode's `limit.context`. Needs `maxOutput` too: the binary wants both. */
    contextWindow?: number;
    /** OpenCode's `limit.output`. */
    maxOutput?: number;
    /** OpenCode's `cost.input`, per million tokens. Needs `costOutput` too. */
    costInput?: number;
    costOutput?: number;
    /** Capability flags, all four booleans. `temperature` is NOT a value. */
    reasoning?: boolean;
    attachment?: boolean;
    tool_call?: boolean;
    temperature?: boolean;
    releaseDate?: string;
    experimental?: boolean;
    status?: 'alpha' | 'beta' | 'deprecated' | 'active';
    /**
     * Everything else OpenCode hands the SDK, which is where a real numeric
     * temperature goes. Scalars only, and a key that NAMES a credential is
     * refused whatever is in it.
     */
    options?: Record<string, string | number | boolean>;
}

/** One provider, as the phone sends it. */
export interface ProviderInput {
    /** `my-gateway`. Lowercase-ish, no slashes. */
    id: string;
    name?: string;
    /**
     * The endpoint. No query string and no userinfo: those are where a token
     * ends up, which is why `mcp.ts` refuses to READ a base URL at all.
     */
    baseURL?: string;
    /**
     * The NAME of the environment variable holding the API key. NEVER the key.
     * The machine writes `{env:<NAME>}` and OpenCode reads the value from the
     * shell it starts in.
     */
    apiKeyEnv?: string;
    /** The SDK package, for a provider models.dev has never heard of. */
    npm?: string;
    models?: ProviderModelInput[];
}

/** A provider as the machine reports it back: names and model ids, nothing else. */
export interface ProviderWriteSummary {
    id: string;
    name: string;
    /** Always `drover` here: these are the ones drover wrote and can rewrite. */
    origin: string;
    models: { id: string; name: string }[];
    modelCount: number;
}

export interface ProviderWriteReport {
    harness: 'opencode';
    /** The config file, `$HOME` collapsed to `~`. */
    config: string;
    /** `created` | `appended` | `rewrote` | `unchanged`, DROVE-306's four words. */
    did: string;
    /** Where the pre-drover copy went, on the first write to this file only. */
    backup: string | null;
    providers: ProviderWriteSummary[];
    count: number;
    /**
     * OpenCode reads its config at start, so a pane already running keeps the
     * models it had. The app says so rather than offering a model that will
     * fail at exec.
     */
    restartRequired: boolean;
}

export type ProviderWriteResult =
    | ({ ok: true } & ProviderWriteReport)
    | { ok: false; error: string };

/** The one sentence, and it says where the thing goes rather than just no. */
export const providerSecretRefusal =
    'That looks like an API key — send the NAME of the environment variable that holds it, never the key itself.';

const providerIdShape = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const modelIdShape = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const envNameShape = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const npmNameShape = /^(@[a-z0-9][a-z0-9._-]{0,63}\/)?[a-z0-9][a-z0-9._-]{0,63}$/;
const optionKeyShape = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const credentialOptionKey =
    /^(api[-_]?key|access[-_]?key|secret|secret[-_]?key|token|access[-_]?token|refresh[-_]?token|password|passwd|auth|authorization|bearer|cookie|credential|credentials|private[-_]?key|client[-_]?secret|passphrase)$/i;

/**
 * Everything wrong with what the phone is about to send, as ONE sentence, or
 * null when it is safe.
 *
 * One sentence and not a list, because the caller shows it in an alert under a
 * text field and a paragraph there is a paragraph nobody reads. The first
 * problem is the one worth fixing.
 *
 * Order matters: the secret check runs before the shape check on every string,
 * so somebody who pasted their key into the id field is told about the key
 * rather than about the id's character set.
 */
export function providerInputRefusal(input: ProviderInput): string | null {
    const secret = (value: unknown): string | null => (looksLikeSecret(value) ? providerSecretRefusal : null);

    const idSecret = secret(input.id);
    if (idSecret) return idSecret;
    if (!input.id || !providerIdShape.test(input.id)) {
        return 'A provider id is letters, digits, dots, dashes and underscores, starting with a letter or a digit.';
    }

    const nameSecret = secret(input.name);
    if (nameSecret) return nameSecret;
    if (input.name !== undefined && (input.name.length > 96 || /[\u0000-\u001f\u007f]/.test(input.name))) {
        return 'A provider name is one line, at most 96 characters.';
    }

    if (input.apiKeyEnv !== undefined && input.apiKeyEnv !== '') {
        const keySecret = secret(input.apiKeyEnv);
        if (keySecret) return keySecret;
        if (!envNameShape.test(input.apiKeyEnv)) {
            // The one refusal that is really an instruction. Somebody typing a
            // key here has the right intent and the wrong field.
            return 'That field takes the NAME of an environment variable, like OPENAI_API_KEY — the key itself stays on the computer.';
        }
    }

    if (input.npm !== undefined && input.npm !== '' && !npmNameShape.test(input.npm)) {
        return 'That is not an npm package name.';
    }

    if (input.baseURL !== undefined && input.baseURL !== '') {
        const urlSecret = secret(input.baseURL);
        if (urlSecret) return urlSecret;
        let url: URL;
        try {
            url = new URL(input.baseURL);
        } catch {
            return 'A base URL is a full http or https address.';
        }
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
            return 'A base URL is a full http or https address.';
        }
        if (url.username || url.password) {
            return 'A base URL cannot carry a username or password — put the key in an environment variable and send its name.';
        }
        if (url.search) {
            return 'A base URL cannot carry a query string, because that is where a token ends up — send the key’s environment variable name instead.';
        }
        if (url.hash) return 'A base URL cannot carry a #fragment.';
    }

    for (const model of input.models ?? []) {
        const refusal = providerModelRefusal(model);
        if (refusal) return refusal;
    }

    return null;
}

/** The same, for one model on its own — what the configure sheet sends. */
export function providerModelRefusal(model: ProviderModelInput): string | null {
    if (looksLikeSecret(model.id)) return providerSecretRefusal;
    if (!model.id || !modelIdShape.test(model.id)) {
        return 'A model id is letters, digits, dots, dashes, underscores and slashes.';
    }
    if (looksLikeSecret(model.name)) return providerSecretRefusal;

    const bothOrNeither = (a: unknown, b: unknown, sentence: string): string | null =>
        (a === undefined) === (b === undefined) ? null : sentence;

    const limits = bothOrNeither(
        model.contextWindow,
        model.maxOutput,
        'OpenCode needs both a context window and a max output — fill in the other one.',
    );
    if (limits) return limits;
    const costs = bothOrNeither(
        model.costInput,
        model.costOutput,
        'OpenCode needs both an input and an output price — fill in the other one.',
    );
    if (costs) return costs;

    for (const [field, value] of [
        ['context window', model.contextWindow],
        ['max output', model.maxOutput],
    ] as const) {
        if (value === undefined) continue;
        if (!Number.isInteger(value) || value < 1 || value > 100_000_000) {
            return `The ${field} is a whole number of tokens.`;
        }
    }

    for (const [key, value] of Object.entries(model.options ?? {})) {
        if (!optionKeyShape.test(key)) return `${key} is not a plain option name.`;
        if (credentialOptionKey.test(key)) {
            return 'A credential belongs in an environment variable — set the key on the computer and name the variable above.';
        }
        if (looksLikeSecret(value)) return providerSecretRefusal;
        if (typeof value === 'number' && !Number.isFinite(value)) return `${key} is not a number.`;
    }

    return null;
}
