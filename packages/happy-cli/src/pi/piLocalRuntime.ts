/**
 * Is the thing that serves this model actually running? (DROVE-316)
 *
 * pi is the LOCAL-model harness. On this machine it fronts LM Studio's
 * OpenAI-compatible server on :1234 and a local GLM on :8420, registered as
 * packages in ~/.pi/agent/settings.json. ~/.pi/agent/auth.json is empty by
 * design: there is no cloud login to fall back on.
 *
 * DROVE-295 measured what happens when the runtime is down, and it is the worst
 * kind of failure — the session STARTS. pi loads, answers get_state, reports a
 * model, and the phone shows a healthy session with a prompt. The failure lands
 * on the first turn, as a connection error from a provider the human never
 * chose to think about, in a session they have already typed into.
 *
 * So the runtime is probed BEFORE the session is offered as ready, and a dead
 * one is a startup failure that names the port and the provider. That is the
 * whole point: "LM Studio is not answering on http://localhost:1234/v1" is
 * actionable, and "fetch failed" thirty seconds later is not.
 *
 * WHERE THE LINE IS. Unreachable is FATAL — nothing this session does can
 * succeed. Reachable but not listing the model is a WARNING, because LM Studio
 * loads models on demand and a model absent from /v1/models can still answer
 * once asked. Failing on that would refuse sessions that work.
 *
 * A cloud provider is not probed at all. This says nothing about whether an
 * API key is good; that is not this file's business and guessing at it would
 * mean refusing sessions over a check that cannot be right.
 */

import { PI_LOCAL_PROVIDERS } from './piModels';

export interface PiRuntimeCheck {
    /** false only when the runtime could not be reached at all. */
    ok: boolean;
    provider: string;
    baseUrl: string | null;
    /** Set when ok is false: the message to fail with. */
    error?: string;
    /** Set when the runtime answered but did not list the model. */
    warning?: string;
}

/** Whether this provider is served by something on this machine. */
export function isLocalPiProvider(
    provider: string,
    env: NodeJS.ProcessEnv = process.env,
): boolean {
    const raw = env.DROVER_PI_LOCAL;
    const list = raw ? raw.split(',') : PI_LOCAL_PROVIDERS;
    return list.map((s) => s.trim()).includes(provider);
}

/** What the human is told when the runtime is not there. */
export function piRuntimeDownMessage(
    provider: string,
    baseUrl: string,
    detail: string,
): string {
    const runtime = provider === 'lmstudio' ? 'LM Studio' : provider;
    return (
        `drover pi: ${runtime} is not answering on ${baseUrl}\n`
        + `  ${detail}\n`
        + '\n'
        + `  pi is the local-model harness and '${provider}' is served by something\n`
        + '  on this machine, not by a cloud account — ~/.pi/agent/auth.json is empty\n'
        + '  here on purpose. Nothing this session does can succeed until the runtime\n'
        + '  is up, so it is refused now rather than on the first turn.\n'
        + '\n'
        + (provider === 'lmstudio'
            ? '  start it:  open LM Studio and start its server on the Developer tab\n'
                + '        or:  lms server start\n'
            : `  start whatever serves '${provider}' and try again.\n`)
        + '\n'
        + '  a cloud model instead:  drover pi --model <provider/id>\n'
        + '  what pi knows about:    pi --list-models'
    );
}

export interface ProbePiRuntimeOptions {
    provider: string;
    /** The `baseUrl` off pi's own get_state, e.g. http://localhost:1234/v1 */
    baseUrl: string | null;
    /** The model id, checked against the runtime's list when it answers. */
    modelId?: string | null;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
}

/**
 * Probe the runtime behind a model.
 *
 * A non-local provider, or a local one with no baseUrl to probe, is `ok` with
 * nothing said. Silence beats a check that cannot be right.
 */
export async function probePiRuntime(opts: ProbePiRuntimeOptions): Promise<PiRuntimeCheck> {
    const env = opts.env ?? process.env;
    const { provider, baseUrl } = opts;
    if (!isLocalPiProvider(provider, env)) return { ok: true, provider, baseUrl };
    if (!baseUrl) return { ok: true, provider, baseUrl };

    const doFetch = opts.fetchImpl ?? fetch;
    const timeoutMs = opts.timeoutMs ?? 4000;
    const url = `${baseUrl.replace(/\/+$/, '')}/models`;

    let body: unknown = null;
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        let res: Response;
        try {
            res = await doFetch(url, { signal: controller.signal });
        } finally {
            clearTimeout(timer);
        }
        if (!res.ok) {
            return {
                ok: false,
                provider,
                baseUrl,
                error: piRuntimeDownMessage(provider, baseUrl, `GET ${url} answered HTTP ${res.status}`),
            };
        }
        body = await res.json();
    } catch (err) {
        const detail = err instanceof Error
            // An abort is a timeout, and saying "aborted" would send someone
            // looking for a bug in drover rather than at their runtime.
            ? (err.name === 'AbortError' ? `GET ${url} timed out after ${timeoutMs}ms` : `GET ${url}: ${err.message}`)
            : `GET ${url} failed`;
        return { ok: false, provider, baseUrl, error: piRuntimeDownMessage(provider, baseUrl, detail) };
    }

    const listed = readModelIds(body);
    if (opts.modelId && listed.length > 0 && !listed.includes(opts.modelId)) {
        return {
            ok: true,
            provider,
            baseUrl,
            warning:
                `drover pi: ${provider} is up on ${baseUrl} but does not list '${opts.modelId}'.\n`
                + '  It may still load on demand. If the first turn fails, this is why.',
        };
    }
    return { ok: true, provider, baseUrl };
}

/** The ids out of an OpenAI-shaped /v1/models body. */
function readModelIds(body: unknown): string[] {
    if (!body || typeof body !== 'object') return [];
    const data = (body as { data?: unknown }).data;
    if (!Array.isArray(data)) return [];
    const out: string[] = [];
    for (const row of data) {
        if (row && typeof row === 'object' && typeof (row as { id?: unknown }).id === 'string') {
            out.push((row as { id: string }).id);
        }
    }
    return out;
}
