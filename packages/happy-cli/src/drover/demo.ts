/**
 * The Mac's side of the channel demo (DROVE-75).
 *
 * Two jobs, both small:
 *
 * 1. THE THIRD WALL. The phone's demo cards live in the `demo:` namespace and
 *    the phone refuses to put one on the wire (ops.ts, apiSocket.ts). This is
 *    the refusal on the Mac for the same id, in case one ever arrives by a
 *    path nobody has written yet: the bridge's permission handler checks it
 *    before touching the bus, and busResolutionFor returns null for it.
 *
 * 2. THE DEMO PUSH. Push is the one channel a phone cannot exercise alone:
 *    the sender is this process and the carrier is Expo. So the daemon takes
 *    a `drover-demo-push` RPC carrying the phone's own token and sends ONE
 *    message to it through the same sendPushNotifications a gate uses. That
 *    proves the DROVE-70 path end to end without a to-do having to be raised.
 *
 * Nothing here reads or writes the bus.
 */

import type { ExpoPushMessage } from 'expo-server-sdk'
import { Expo } from 'expo-server-sdk'
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'
import type { PushNotificationClient } from '@/api/pushNotifications'
import { logger } from '@/ui/logger'

export const droverDemoIdPrefix = 'demo:'

/** A session id or request id in the demo namespace. Never a real event. */
export function isDroverDemoId(id: unknown): boolean {
    return typeof id === 'string' && id.startsWith(droverDemoIdPrefix)
}

export interface DroverDemoPushRequest {
    token?: unknown
    deviceLabel?: unknown
}

export interface DroverDemoPushResponse {
    ok: boolean
    sent: number
    failed: number
    error?: string
}

/**
 * The one message the demo sends. Titled as a demo so it reads as one on the
 * lock screen, and `data.demo` so the app's push routing has no session to
 * open. Same sound and priority as a real gate, because feeling the real
 * arrival is the point.
 */
export function demoPushMessage(token: string, deviceLabel?: string): ExpoPushMessage {
    return {
        to: token,
        title: 'Demo · Needs you',
        body: `Cattle Drover test push${deviceLabel ? ` to ${deviceLabel}` : ''}. Nothing is waiting.`,
        data: { demo: true, kind: 'demo', type: 'drover-demo' },
        sound: 'default',
        priority: 'high',
    }
}

export function registerDroverDemoPushHandler(
    rpcHandlerManager: RpcHandlerManager,
    push: PushNotificationClient,
): void {
    rpcHandlerManager.registerHandler<DroverDemoPushRequest, DroverDemoPushResponse>(
        'drover-demo-push',
        async (request) => {
            const token = typeof request?.token === 'string' ? request.token : ''
            const deviceLabel = typeof request?.deviceLabel === 'string' ? request.deviceLabel : undefined
            // Only the token the phone handed over. The registered-token list
            // is never consulted here, so a demo can never fan out to every
            // device on the account the way a gate does.
            if (!Expo.isExpoPushToken(token)) {
                logger.debug(`[drover-demo] push refused: not an Expo push token (${deviceLabel ?? 'unknown device'})`)
                return { ok: false, sent: 0, failed: 1, error: 'the phone sent no usable push token' }
            }
            logger.debug(`[drover-demo] push to ${deviceLabel ?? 'this phone'} requested`)
            try {
                // No retry window: the person is holding the phone waiting for
                // the banner, and a push that arrives two minutes late proves
                // nothing about the path.
                const outcome = await push.sendPushNotifications([demoPushMessage(token, deviceLabel)], { retryWindowMs: 0 })
                logger.debug(`[drover-demo] push to ${deviceLabel ?? 'this phone'}: sent=${outcome.sent} failed=${outcome.failed}`)
                return { ok: outcome.sent > 0, sent: outcome.sent, failed: outcome.failed }
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                logger.debug(`[drover-demo] push failed: ${message}`)
                return { ok: false, sent: 0, failed: 1, error: message }
            }
        },
    )
}
