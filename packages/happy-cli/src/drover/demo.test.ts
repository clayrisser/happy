import { describe, expect, it, vi } from 'vitest'

import { demoPushMessage, isDroverDemoId, registerDroverDemoPushHandler } from './demo'
import { busResolutionFor } from './droverBridge'
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'
import type { PushNotificationClient } from '@/api/pushNotifications'

/**
 * The Mac's wall against the phone's demo namespace (DROVE-75), and the one
 * push the demo sends. The push client is stubbed at sendPushNotifications,
 * which is the seam the bridge's own gate pushes go through.
 */

describe('the demo namespace on the Mac', () => {
    it('recognises the prefix and nothing else', () => {
        expect(isDroverDemoId('demo:permission')).toBe(true)
        expect(isDroverDemoId('demo:cattle-drover')).toBe(true)
        expect(isDroverDemoId('7f0c3a2e-demo')).toBe(false)
        expect(isDroverDemoId(undefined)).toBe(false)
        expect(isDroverDemoId(42)).toBe(false)
    })

    it('makes busResolutionFor refuse a demo answer, whatever the event says', () => {
        // Even an event that somehow got mirrored under a demo id must not
        // produce a body the handler would POST. null is "left pending".
        const ev = {
            id: 'demo:permission',
            kind: 'permission' as const,
            state: 'pending' as const,
            title: 'Demo',
        }
        expect(busResolutionFor(ev, { id: 'demo:permission', approved: true })).toBeNull()
        expect(busResolutionFor(undefined, { id: 'demo:permission', approved: false })).toBeNull()
    })
})

describe('the demo push', () => {
    it('is titled as a demo, opens nothing, and carries the real gate sound', () => {
        const message = demoPushMessage('ExponentPushToken[abc]', 'Clay’s iPhone')
        expect(message.to).toBe('ExponentPushToken[abc]')
        expect(message.title).toBe('Demo · Needs you')
        expect(message.body).toContain('Clay’s iPhone')
        expect(message.data).toEqual({ demo: true, kind: 'demo', type: 'drover-demo' })
        expect(message.data).not.toHaveProperty('sessionId')
        expect(message.sound).toBe('default')
        expect(message.priority).toBe('high')
    })

    function handlerFor(push: Partial<PushNotificationClient>) {
        let handler: ((request: unknown) => Promise<unknown>) | null = null
        const manager = {
            registerHandler: (method: string, fn: (request: unknown) => Promise<unknown>) => {
                expect(method).toBe('drover-demo-push')
                handler = fn
            },
        } as unknown as RpcHandlerManager
        registerDroverDemoPushHandler(manager, push as PushNotificationClient)
        return handler!
    }

    it('sends exactly one message, to the token the phone gave and nowhere else', async () => {
        const sendPushNotifications = vi.fn().mockResolvedValue({ sent: 1, failed: 0 })
        const fetchPushTokens = vi.fn()
        const handle = handlerFor({ sendPushNotifications, fetchPushTokens })

        const result = await handle({ token: 'ExponentPushToken[abc]', deviceLabel: 'phone' })

        expect(result).toEqual({ ok: true, sent: 1, failed: 0 })
        expect(sendPushNotifications).toHaveBeenCalledTimes(1)
        const [messages, opts] = sendPushNotifications.mock.calls[0]
        expect(messages).toHaveLength(1)
        expect(messages[0].to).toBe('ExponentPushToken[abc]')
        expect(opts).toEqual({ retryWindowMs: 0 })
        // The registered-token list is never read: a demo cannot fan out.
        expect(fetchPushTokens).not.toHaveBeenCalled()
    })

    it('refuses a token that is not an Expo push token without touching Expo', async () => {
        const sendPushNotifications = vi.fn()
        const handle = handlerFor({ sendPushNotifications })

        const result = await handle({ token: 'not-a-token' }) as { ok: boolean; error?: string }

        expect(result.ok).toBe(false)
        expect(result.error).toContain('push token')
        expect(sendPushNotifications).not.toHaveBeenCalled()
    })

    it("reports Expo's rejection rather than claiming a send", async () => {
        const sendPushNotifications = vi.fn().mockResolvedValue({ sent: 0, failed: 1 })
        const handle = handlerFor({ sendPushNotifications })
        const result = await handle({ token: 'ExponentPushToken[abc]' })
        expect(result).toEqual({ ok: false, sent: 0, failed: 1 })
    })

    it('returns a thrown failure as an error line instead of an RPC failure', async () => {
        const sendPushNotifications = vi.fn().mockRejectedValue(new Error('InvalidCredentials'))
        const handle = handlerFor({ sendPushNotifications })
        const result = await handle({ token: 'ExponentPushToken[abc]' })
        expect(result).toEqual({ ok: false, sent: 0, failed: 1, error: 'InvalidCredentials' })
    })
})
