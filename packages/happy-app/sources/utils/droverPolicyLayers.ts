/**
 * Which layer a flip-policy value came from (DROVE-3).
 *
 * Apart from sync/droverPolicy.ts, which owns the RPC, because these are pure
 * and the RPC module pulls in the socket — and therefore React Native — which a
 * node-side unit test cannot load.
 *
 * The split matters for more than tests. `overrides` is carried separately from
 * `machine` and `builtIn` precisely so a screen can say "you set this for this
 * session" rather than just "prompt": those are different answers to "why did
 * it not ask me", and a merged value cannot tell them apart.
 */

import type { DroverPolicy, DroverPolicyValues } from '@/sync/storageTypes';

export type PolicyKey = keyof DroverPolicyValues;

/** A patch value of null clears the key — "go back to the default". */
export type PolicyPatch = { [K in PolicyKey]?: DroverPolicyValues[K] | null };

/** Which layer a value came from, which is what the screen prints under it. */
export type PolicySource = 'session' | 'machine' | 'builtIn' | 'unknown';

export function sourceOf(policy: DroverPolicy | undefined, key: PolicyKey): PolicySource {
    if (!policy || policy.unavailable) return 'unknown';
    if (policy.overrides && policy.overrides[key] != null) return 'session';
    if (policy.machine && policy.machine[key] != null) return 'machine';
    if (policy.builtIn && policy.builtIn[key] != null) return 'builtIn';
    return 'unknown';
}

/** The value the policy engine will actually act on, or null when unknown. */
export function effectiveValue<K extends PolicyKey>(
    policy: DroverPolicy | undefined,
    key: K,
): DroverPolicyValues[K] | null {
    if (!policy || policy.unavailable) return null;
    return (policy.effective?.[key] ?? null) as DroverPolicyValues[K] | null;
}

/** The machine default a session with no override of its own follows. */
export function defaultValue<K extends PolicyKey>(
    policy: DroverPolicy | undefined,
    key: K,
): DroverPolicyValues[K] | null {
    if (!policy || policy.unavailable) return null;
    return (policy.defaults?.[key] ?? null) as DroverPolicyValues[K] | null;
}
