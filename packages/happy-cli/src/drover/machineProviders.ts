/**
 * Adding and configuring OpenCode's providers FROM the phone (DROVE-276).
 *
 * `machineMcps.ts` is the read half and says in as many words that the config
 * half was deferred and adding a write verb is a decision. This is that
 * decision, and the thing that makes it safe is that no verb here carries a
 * credential: the phone sends `apiKeyEnv`, the NAME of an environment
 * variable, and cattle-drover writes OpenCode's own `{env:NAME}`. The key
 * itself is set on the computer, by Clay, and never travels.
 *
 * DROVE-296 held this half. Its reason was two unconditional plaintext writes
 * on the machine — droverBridge's answer log and the bus journal — either of
 * which would have caught an API key typed on a phone. Both are DROVE-304's to
 * close, and neither has to close first for THIS, because:
 *
 *   - the payload has no key in it to catch;
 *   - `RpcHandlerManager` logs the method NAME, not the params;
 *   - the log lines below name the verb and the provider id and nothing else,
 *     which is the vocabulary `answerLogLine` settled on for the bridge; and
 *   - the bus route does not journal at all — `journalAppend` is reached from
 *     `createEvent` and `terminate`, and a provider write is neither.
 *
 * BUS ONLY, WITH NO CLI FALLBACK, and that is the one place this file
 * deliberately differs from `machineMcps.ts`. A read that falls back to
 * `drover mcps --json` when the bus is down is strictly better than a blank
 * page. A WRITE that falls back to spawning a binary is a second way to edit a
 * config file, on a path with different argument handling, reachable when the
 * daemon cannot even reach its own loopback. If the bus is down the honest
 * answer is that the machine is not ready, and the phone says so.
 *
 * ONE WRITER, therefore: cattle-drover's `engine/opencode-providers.js`, whether
 * the request came from the phone, from `/v1/providers`, or from
 * `drover providers` in a terminal. The same argument `machineMcps.ts` makes
 * for keeping one reader, and it matters more here — two writers to one JSONC
 * file is how somebody's hand-written provider gets eaten.
 */

import {
    providerInputRefusal,
    providerModelRefusal,
    type ProviderInput,
    type ProviderModelInput,
    type ProviderWriteResult,
} from '@slopus/happy-wire';

import { logger } from '@/ui/logger';
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';

/** Same default as machineMcps.ts and droverBridge.ts: the loopback bus. */
const droverUrl = (): string => process.env.DROVER_URL || 'http://127.0.0.1:7970';

/**
 * Longer than the read's 3000ms, because this one reads a file, splices text,
 * writes a backup and renames — and shorter than a person's patience. A write
 * that timed out having already landed is the worst answer available, so the
 * app re-reads after every one of these rather than trusting the reply alone.
 */
const BUS_TIMEOUT_MS = 8000;

export interface MachineProvidersDeps {
    /** Injected in tests. Real calls go over loopback to the drover bus. */
    callBus?: (method: string, path: string, body?: unknown) => Promise<{ status: number; json: unknown }>;
}

async function callBus(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const res = await fetch(`${droverUrl()}${path}`, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(BUS_TIMEOUT_MS),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
}

/**
 * The bus's answer, or a sentence saying why there isn't one.
 *
 * A drover that predates this ticket answers 404 on every route here, and that
 * is the single most likely failure in the field: the daemon is running the
 * code that shipped before the kickstart. It gets its own sentence rather than
 * "the bus answered 404", because "restart it" is the fix and "404" is not a
 * thing anybody can act on.
 */
function settle(result: { status: number; json: unknown }): ProviderWriteResult {
    const body = result.json as Record<string, unknown> | null;
    if (result.status === 404 && (!body || typeof body.ok !== 'boolean')) {
        return {
            ok: false,
            error: 'This machine\'s drover has no provider routes yet — restart the drover on it and try again.',
        };
    }
    if (body && typeof body.ok === 'boolean') return body as unknown as ProviderWriteResult;
    const said = body && typeof body.error === 'string' ? body.error : `the bus answered ${result.status}`;
    return { ok: false, error: said };
}

function unreachable(error: unknown): ProviderWriteResult {
    const said = error instanceof Error ? error.message : String(error);
    return {
        ok: false,
        error: `Could not reach the drover on this machine (${said}) — start it and try again.`,
    };
}

/** Read back what drover has written, without changing any of it. */
export async function listMachineProviders(deps: MachineProvidersDeps = {}): Promise<ProviderWriteResult> {
    try {
        return settle(await (deps.callBus ?? callBus)('GET', '/v1/providers'));
    } catch (error) {
        return unreachable(error);
    }
}

/**
 * Add a provider, or replace one drover already owns.
 *
 * The refusal runs HERE as well as on the phone and again on the machine. Not
 * belt and braces for its own sake: this handler is reachable by anything that
 * can talk to the daemon, and the phone's check is the only one a different
 * client would skip.
 */
export async function putMachineProvider(
    input: ProviderInput,
    deps: MachineProvidersDeps = {},
): Promise<ProviderWriteResult> {
    const refusal = providerInputRefusal(input);
    if (refusal) {
        // The refusal, never the input. A log line that quoted what it refused
        // would write down exactly the thing it just refused to carry.
        logger.debug(`[API MACHINE] refused a provider write for ${input?.id ?? '(no id)'}`);
        return { ok: false, error: refusal };
    }
    const { id, ...rest } = input;
    try {
        logger.debug(`[API MACHINE] drover-provider-put ${id}`);
        return settle(await (deps.callBus ?? callBus)('PUT', `/v1/providers/opencode/${encodeURIComponent(id)}`, rest));
    } catch (error) {
        return unreachable(error);
    }
}

/** Take one back out. Drover refuses to remove a provider it did not add. */
export async function removeMachineProvider(
    id: string,
    deps: MachineProvidersDeps = {},
): Promise<ProviderWriteResult> {
    if (!id) return { ok: false, error: 'No provider was named.' };
    try {
        logger.debug(`[API MACHINE] drover-provider-remove ${id}`);
        return settle(await (deps.callBus ?? callBus)('DELETE', `/v1/providers/opencode/${encodeURIComponent(id)}`));
    } catch (error) {
        return unreachable(error);
    }
}

/** Set one model's options on a provider drover owns. */
export async function configureMachineModel(
    providerId: string,
    model: ProviderModelInput,
    deps: MachineProvidersDeps = {},
): Promise<ProviderWriteResult> {
    if (!providerId) return { ok: false, error: 'No provider was named.' };
    const refusal = providerModelRefusal(model);
    if (refusal) {
        logger.debug(`[API MACHINE] refused a model write for ${providerId}/${model?.id ?? '(no id)'}`);
        return { ok: false, error: refusal };
    }
    const { id, ...rest } = model;
    try {
        logger.debug(`[API MACHINE] drover-model-configure ${providerId}/${id}`);
        return settle(
            await (deps.callBus ?? callBus)(
                'PATCH',
                `/v1/providers/opencode/${encodeURIComponent(providerId)}/models/${encodeURIComponent(id)}`,
                rest,
            ),
        );
    } catch (error) {
        return unreachable(error);
    }
}

export function registerMachineProvidersHandlers(
    rpcHandlerManager: RpcHandlerManager,
    deps: MachineProvidersDeps = {},
): void {
    rpcHandlerManager.registerHandler<unknown, ProviderWriteResult>(
        'drover-providers',
        async () => await listMachineProviders(deps),
    );
    rpcHandlerManager.registerHandler<ProviderInput, ProviderWriteResult>(
        'drover-provider-put',
        async (params) => await putMachineProvider(params, deps),
    );
    rpcHandlerManager.registerHandler<{ id: string }, ProviderWriteResult>(
        'drover-provider-remove',
        async (params) => await removeMachineProvider(params?.id, deps),
    );
    rpcHandlerManager.registerHandler<{ providerId: string; model: ProviderModelInput }, ProviderWriteResult>(
        'drover-model-configure',
        async (params) => await configureMachineModel(params?.providerId, params?.model, deps),
    );
}
