/**
 * The app's write path onto the flip policy (DROVE-3).
 *
 * The phone cannot reach the bus — loopback :7970 lives on the Mac — so a
 * toggle in the app arrives here as a session RPC and this process forwards it
 * to `/v1/settings`. That also settles which key the store is written under:
 * the app knows the HAPPY session id, the store is keyed by the CLAUDE session
 * id, and only this process holds both. Resolving it here means a phone toggle
 * and `drover settings set` in a terminal write the same row instead of two
 * rows that never see each other.
 *
 * Everything is forwarded, nothing is decided. Valid keys, valid values and the
 * merge all belong to engine/settings.js; a refusal comes back with the bus's
 * own sentence so the phone can show why rather than "it did not work".
 */

import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'
import { logger } from '@/ui/logger'
import {
    clearSessionPolicy,
    readPolicy,
    writeDefaultPolicy,
    writeSessionPolicy,
    type DroverPolicy,
    type PolicyPatch,
} from './policy'

export interface DroverPolicyRequest {
    /**
     * `session` writes this session's own overrides; `defaults` moves the
     * machine defaults every session without an override follows. Named rather
     * than inferred from the payload, because "clear my override" and "clear
     * the default" are different acts that would otherwise look identical.
     */
    scope?: 'session' | 'defaults'
    /**
     * `set` merges keys (a null value clears one back to the default);
     * `clear` drops every override this session has; `get` only reads.
     */
    action?: 'set' | 'clear' | 'get'
    patch?: PolicyPatch
    /** Who to record as having changed it. Defaults to `app`. */
    by?: string
}

export interface DroverPolicyResponse {
    ok: boolean
    policy: DroverPolicy
    error?: string
}

export function registerDroverPolicyHandler(
    rpcHandlerManager: RpcHandlerManager,
    claudeSessionId: () => string | null,
    onPolicy?: (policy: DroverPolicy) => void,
): void {
    rpcHandlerManager.registerHandler<DroverPolicyRequest, DroverPolicyResponse>(
        'drover-policy',
        async (request) => {
            const req = request ?? {}
            const by = typeof req.by === 'string' && req.by ? req.by : 'app'
            const sessionId = claudeSessionId()
            const action = req.action ?? 'get'
            const scope = req.scope ?? 'session'

            if (action === 'get') {
                const policy = await readPolicy(sessionId)
                onPolicy?.(policy)
                return { ok: !policy.unavailable, policy, error: policy.unavailable }
            }

            if (scope === 'defaults') {
                const result = action === 'clear'
                    // Clearing the machine defaults means putting every key
                    // back to the built-in, which the store expresses as an
                    // explicit null per key rather than a DELETE — there is no
                    // delete verb on /v1/settings/defaults.
                    ? await writeDefaultPolicy(nullAll(req.patch), by, sessionId)
                    : await writeDefaultPolicy(req.patch ?? {}, by, sessionId)
                if (result.ok) logger.debug(`[flip] machine policy defaults updated by ${by}`)
                onPolicy?.(result.policy)
                return result
            }

            if (!sessionId) {
                // Refused rather than written under the happy id. A row the
                // terminal cannot see is worse than a clear "not yet": Claude
                // names the session within a turn, and the app can retry.
                const policy = await readPolicy(null)
                return {
                    ok: false,
                    policy,
                    error: 'this session has no Claude Code session id yet — it is set once the first turn starts',
                }
            }

            const result = action === 'clear'
                ? await clearSessionPolicy(sessionId)
                : await writeSessionPolicy(sessionId, req.patch ?? {}, by)
            if (result.ok) logger.debug(`[flip] session policy ${action} by ${by}`)
            onPolicy?.(result.policy)
            return result
        },
    )
}

/** Every key named in the patch, set to null — "put these back to the built-in". */
function nullAll(patch: PolicyPatch | undefined): PolicyPatch {
    const out: PolicyPatch = {}
    for (const k of Object.keys(patch ?? {}) as (keyof PolicyPatch)[]) {
        (out as Record<string, unknown>)[k] = null
    }
    return out
}
