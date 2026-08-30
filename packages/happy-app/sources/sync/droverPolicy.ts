/**
 * Reading and writing the Cattle Drover flip policy from the app (DROVE-3).
 *
 * Clay, 2026-08-29: "we should support the ability for the mobile app to
 * control these settings, as that's gonna be the most straightforward way to
 * control settings that we want to set for sessions." He is not at the terminal
 * when a session hits a limit — that is the whole reason Cattle Drover exists —
 * so a policy only the terminal can set is unreachable exactly when it matters.
 *
 * The phone never touches the store. It lives behind the bus on loopback :7970
 * on the Mac; the CLI forwards, keyed by the CLAUDE session id so a toggle here
 * and `drover settings set` in a terminal write the same row. Everything below
 * is presentation plus one RPC.
 *
 * WHICH LAYER WON is the whole reason `overrides` is carried separately. A
 * merged value cannot tell "Clay chose prompt for this session" from "prompt is
 * simply what every session gets", and those are different answers to "why did
 * it do that".
 */

import { apiSocket } from './apiSocket';
import type { DroverPolicy } from './storageTypes';
// The pure layer helpers live in utils/ so a node test can import them without
// dragging in the socket, and therefore React Native (DROVE-3).
import type { PolicyPatch } from '@/utils/droverPolicyLayers';

export type { PolicyKey, PolicyPatch, PolicySource } from '@/utils/droverPolicyLayers';
export { defaultValue, effectiveValue, sourceOf } from '@/utils/droverPolicyLayers';

export interface DroverPolicyRequest {
    scope?: 'session' | 'defaults';
    action?: 'set' | 'clear' | 'get';
    patch?: PolicyPatch;
    by?: string;
}

export interface DroverPolicyResponse {
    ok: boolean;
    policy: DroverPolicy;
    error?: string;
}

/**
 * Send a policy request to one session's CLI.
 *
 * Errors are RETURNED, never thrown away: the bus refuses an unknown key or a
 * value outside its enum with a sentence, and a settings screen that swallows
 * it leaves a control that looks like it worked and did not.
 */
export async function sessionDroverPolicy(
    sessionId: string,
    request: DroverPolicyRequest,
): Promise<DroverPolicyResponse> {
    try {
        return await apiSocket.sessionRPC<DroverPolicyResponse, DroverPolicyRequest>(
            sessionId,
            'drover-policy',
            request,
        );
    } catch (error) {
        return {
            ok: false,
            policy: undefined as unknown as DroverPolicy,
            error: error instanceof Error ? error.message : 'the computer did not answer',
        };
    }
}

/**
 * Send a policy request to a machine's daemon, for the app-level defaults.
 *
 * Separate from the session call because the default has to be settable when
 * nothing is running — which is the case it exists for, since it is what the
 * NEXT session picks up.
 */
export async function machineDroverPolicy(
    machineId: string,
    request: DroverPolicyRequest,
): Promise<DroverPolicyResponse> {
    try {
        return await apiSocket.machineRPC<DroverPolicyResponse, DroverPolicyRequest>(
            machineId,
            'drover-policy',
            request,
        );
    } catch (error) {
        return {
            ok: false,
            policy: undefined as unknown as DroverPolicy,
            error: error instanceof Error ? error.message : 'the computer did not answer',
        };
    }
}
