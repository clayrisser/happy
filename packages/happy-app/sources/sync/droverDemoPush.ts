/**
 * A real push to THIS phone, on demand (DROVE-75).
 *
 * The push path is the one channel a phone cannot exercise on its own: the
 * sender is the Mac (happy-cli's PushNotificationClient), the carrier is Expo,
 * and the only way to prove the DROVE-70 route end to end is to have the Mac
 * send one. So the phone hands its own Expo token to the machine daemon over
 * a `drover-demo-push` RPC and the daemon sends exactly one message to that
 * token, through the same sendPushNotifications the bridge uses for a gate.
 *
 * Nothing about it touches a session or the bus: the RPC is machine-scoped,
 * the message is titled as a demo, and `data.demo` is true so the app's push
 * routing has no session to open.
 */

import { apiSocket } from './apiSocket';

export interface DroverDemoPushRequest {
    /** This device's Expo push token; the daemon sends to it and nothing else. */
    token: string;
    /** For the Mac's log, so the line says which phone asked. */
    deviceLabel?: string;
}

export interface DroverDemoPushResponse {
    ok: boolean;
    /** Messages Expo accepted. One or zero. */
    sent: number;
    failed: number;
    error?: string;
}

/**
 * Errors are RETURNED, never thrown away, for the same reason droverPolicy
 * returns them: the screen has to say why the push did not go, and "the
 * computer did not answer" is a different failure from "Expo rejected the
 * token".
 */
export async function machineDemoPush(
    machineId: string,
    request: DroverDemoPushRequest,
): Promise<DroverDemoPushResponse> {
    try {
        return await apiSocket.machineRPC<DroverDemoPushResponse, DroverDemoPushRequest>(
            machineId,
            'drover-demo-push',
            request,
        );
    } catch (error) {
        return {
            ok: false,
            sent: 0,
            failed: 0,
            error: error instanceof Error ? error.message : 'the computer did not answer',
        };
    }
}
