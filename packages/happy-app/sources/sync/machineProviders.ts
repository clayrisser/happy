/**
 * Adding and configuring OpenCode's providers from the phone (DROVE-276).
 *
 * The write counterpart of `machineMcps.ts`, and it follows that file's
 * convention rather than `ops.ts`'s: these return `{ ok: false, error }`
 * instead of throwing, because every caller renders the machine's own sentence
 * and a thrown Error there turns a readable refusal into "something went
 * wrong".
 *
 * NO CREDENTIAL LEAVES THE HANDSET. `apiKeyEnv` is the NAME of an environment
 * variable; the machine writes OpenCode's `{env:NAME}` and reads the value out
 * of the shell it starts in. `providerInputRefusal` runs BEFORE the call, so a
 * value shaped like a key is never encrypted, never relayed, and never sits in
 * a buffer — it is refused while it is still only on screen. The machine
 * refuses the same shapes independently.
 */

import {
    providerInputRefusal,
    providerModelRefusal,
    type ProviderInput,
    type ProviderModelInput,
    type ProviderWriteResult,
} from '@slopus/happy-wire';

import { apiSocket } from '@/sync/apiSocket';

async function call(machineId: string, method: string, params: unknown): Promise<ProviderWriteResult> {
    try {
        return await apiSocket.machineRPC<ProviderWriteResult, unknown>(machineId, method, params);
    } catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : 'the computer did not answer',
        };
    }
}

/** What drover has written into this machine's OpenCode config. */
export async function machineProviders(machineId: string): Promise<ProviderWriteResult> {
    return await call(machineId, 'drover-providers', {});
}

/** Add a provider, or replace one drover already owns. */
export async function machineProviderPut(
    machineId: string,
    input: ProviderInput,
): Promise<ProviderWriteResult> {
    const refusal = providerInputRefusal(input);
    if (refusal) return { ok: false, error: refusal };
    return await call(machineId, 'drover-provider-put', input);
}

/** Take one back out. The machine refuses to remove one drover did not add. */
export async function machineProviderRemove(
    machineId: string,
    id: string,
): Promise<ProviderWriteResult> {
    return await call(machineId, 'drover-provider-remove', { id });
}

/** Set one model's options on a provider drover owns. */
export async function machineModelConfigure(
    machineId: string,
    providerId: string,
    model: ProviderModelInput,
): Promise<ProviderWriteResult> {
    const refusal = providerModelRefusal(model);
    if (refusal) return { ok: false, error: refusal };
    return await call(machineId, 'drover-model-configure', { providerId, model });
}
