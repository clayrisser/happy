import axios from 'axios'
import { logger } from '@/ui/logger'
import { Expo, ExpoPushMessage } from 'expo-server-sdk'
import type { Metadata } from './types'
import { configuration } from '@/configuration'

export interface PushToken {
    id: string
    token: string
    createdAt: number
    updatedAt: number
}

export type SessionNotificationKind = 'done' | 'permission' | 'question' | 'todo'

/**
 * The kinds `/v1/sessions/:id/push-event` will actually take (DROVE-70).
 *
 * MEASURED, not assumed: happy-server's pushRoutes.ts declares the body as
 * `kind: z.enum(['done', 'permission', 'question'])`, and Fastify rejects
 * anything else with a 400 before the handler runs. The live route is
 * UPSTREAM's (api.cluster-fluster.com) and its schema only knows Happy's own
 * kinds, so `todo` — which is ours, invented in DROVE-53 — is refused outright.
 *
 * WHY DIRECT-TO-EXPO RATHER THAN KIND-MAPPING. Mapping `todo` onto
 * `permission` and carrying the real kind in `data` keeps one path, but it
 * lies in the envelope twice over: the server fans the kind out to web tabs as
 * a session event, and it presence-suppresses on it. A to-do is precisely the
 * thing that must survive suppression — nothing is blocked on it, so it will
 * still be waiting long after the desktop tab that suppressed it was closed.
 * `sendBackgroundWake` already goes direct for the same class of reason (its
 * shape is unrepresentable on that route), so the direct path is not a new
 * one. What is given up is the ephemeral fan-out to open web tabs; a to-do
 * appears there through the ordinary session sync instead.
 *
 * A new drover kind that upstream later learns belongs in this set, not in a
 * second branch somewhere else.
 */
const serverPushEventKinds: ReadonlySet<SessionNotificationKind> = new Set([
    'done',
    'permission',
    'question',
])

/**
 * Seconds a wake is still worth delivering for.
 *
 * Past this the phone has nothing to add: it resyncs on its own the next time
 * it comes forward, and a late wake spends an APNs background budget the next
 * real gate needs.
 */
const WAKE_TTL_SECONDS = 120

/**
 * Floor between two wakes.
 *
 * iOS budgets background pushes per app and drops the surplus silently, so a
 * burst of bus events must not become a burst of wakes.
 */
const WAKE_THROTTLE_MS = 3000

/**
 * The one push shape that runs the phone app's JS while iOS has it suspended.
 *
 * This matters because the Apple Watch is fed entirely through the phone:
 * happy-app's `startDroverWatchFeed` reads pending gates out of Zustand and
 * calls `WCSession.updateApplicationContext`. Suspend the app and its JS stops,
 * so nothing ever calls the transport again. That is both of Clay's wrist bugs
 * in one line. "I have to have the drover mobile app in the FOREGROUND to get
 * the questions on my watch", and its twin "when I answer from tmux the
 * questions are still queued on my watch". The transport was never broken.
 * Nothing was calling it.
 *
 * No title, no body, no sound. Any one of those turns this into a visible
 * banner, and the alert push for the same gate has already buzzed. Two buzzes
 * for one question is worse than none.
 *
 * Apple requires a background push to go out at apns-priority 5 and answers
 * BadPriority at 10, so 'normal' is not a politeness setting here: 'high' would
 * cost the wake outright rather than making it faster.
 */
export function buildWakeMessages(
    tokens: PushToken[],
    reason: string,
    at: number = Date.now()
): ExpoPushMessage[] {
    return tokens.map((token) => ({
        to: token.token,
        data: { type: 'drover_wake', reason, at },
        _contentAvailable: true,
        priority: 'normal',
        ttl: WAKE_TTL_SECONDS,
    }))
}

/**
 * What actually went wrong with a push, in one line (DROVE-70).
 *
 * An HTTP error from the push route carries its reason in the RESPONSE BODY —
 * Fastify's schema validation names the offending field there
 * ("body/kind must be equal to one of the allowed values") — and logging the
 * error object alone throws that away and prints a stack instead. Exported so
 * a test can assert the body survives.
 */
export function describePushError(error: unknown): string {
    if (axios.isAxiosError(error)) {
        const status = error.response?.status
        const data = error.response?.data
        const body = data === undefined ? '' : typeof data === 'string' ? data : JSON.stringify(data)
        if (status !== undefined) {
            return `HTTP ${status}${body ? ` ${body}` : ' (empty body)'}`
        }
    }
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

function getSessionTitle(metadata: Metadata | null | undefined): string {
    const summaryText = metadata?.summary?.text?.trim()
    if (summaryText) {
        return summaryText
    }

    const path = metadata?.path?.trim()
    if (!path) {
        return 'Session'
    }

    const segments = path.split(/[\\/]/).filter(Boolean)
    return segments[segments.length - 1] || 'Session'
}

function getSessionNotificationUrl(data: Record<string, any> | undefined): `/session/${string}` | null {
    const sessionId = data?.sessionId
    if (typeof sessionId !== 'string') {
        return null
    }

    const trimmedSessionId = sessionId.trim()
    if (!trimmedSessionId) {
        return null
    }

    return `/session/${encodeURIComponent(trimmedSessionId)}`
}

export function getSessionNotificationTitle(
    kind: SessionNotificationKind
): string {
    switch (kind) {
        case 'done':
            return "It's ready!"
        case 'permission':
            return 'Permission request'
        case 'question':
            return 'Clarification needed'
        // A to-do asks for an ACTION, not a decision and not an answer, so it
        // says so (DROVE-53). Filing it under 'permission' would have read
        // "Permission request" on a lock screen for "push the release", which
        // tells you nothing about what is actually wanted.
        case 'todo':
            return 'Needs you'
    }
}

export function getSessionNotificationBody(
    metadata: Metadata | null | undefined
): string {
    return getSessionTitle(metadata)
}

export function getSessionNotificationCopy(
    kind: SessionNotificationKind,
    metadata: Metadata | null | undefined
): { title: string; body: string } {
    return {
        title: getSessionNotificationTitle(kind),
        body: getSessionNotificationBody(metadata),
    }
}

export class PushNotificationClient {
    private readonly token: string
    private readonly baseUrl: string
    private readonly expo: Expo
    private lastWakeAt = 0
    private wakeTimer: NodeJS.Timeout | null = null
    private pendingWakeReason: string | null = null

    constructor(token: string, baseUrl: string = 'https://api.cluster-fluster.com') {
        this.token = token
        this.baseUrl = baseUrl
        this.expo = new Expo()
    }

    /**
     * Fetch all push tokens for the authenticated user.
     * Retries up to 3 times with exponential backoff on transient errors.
     */
    async fetchPushTokens(): Promise<PushToken[]> {
        const maxAttempts = 3
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                const response = await axios.get<{ tokens: PushToken[] }>(
                    `${this.baseUrl}/v1/push-tokens`,
                    {
                        headers: {
                            'Authorization': `Bearer ${this.token}`,
                            'Content-Type': 'application/json',
                            'X-Happy-Client': `cli-daemon/${configuration.currentCliVersion}`
                        }
                    }
                )

                logger.debug(`Fetched ${response.data.tokens.length} push tokens`)

                // Log token information
                response.data.tokens.forEach((token, index) => {
                    logger.debug(`[PUSH] Token ${index + 1}: id=${token.id}, created=${new Date(token.createdAt).toISOString()}, updated=${new Date(token.updatedAt).toISOString()}`)
                })

                return response.data.tokens
            } catch (error) {
                logger.debug(`[PUSH] [ERROR] Failed to fetch push tokens (attempt ${attempt}/${maxAttempts}):`, error)
                if (attempt < maxAttempts) {
                    const delay = 1000 * Math.pow(2, attempt - 1) // 1s, 2s
                    await new Promise(resolve => setTimeout(resolve, delay))
                }
            }
        }
        logger.debug('[PUSH] [ERROR] All push token fetch attempts failed')
        return []
    }

    /**
     * Send push notification via Expo Push API with retry
     * @param messages - Array of push messages to send
     * @param opts.retryWindowMs - How long to keep retrying a failed chunk.
     *   Defaults to 5 minutes, which is right for an alert the user still wants
     *   late. A wake passes 0: it carries no content of its own, it expires in
     *   two minutes anyway, and retrying one holds a socket open for five
     *   minutes to deliver something already stale.
     * @returns How many messages Expo accepted and how many it did not. The
     *   caller needs this: a push rejected at Expo (InvalidCredentials, from a
     *   fork signed under a bundle id the upstream Expo project has no key for;
     *   see happy-app's DROVER_EAS_PROJECT_ID note) looks exactly like a push
     *   nobody sent, and that is how a total outage stayed invisible.
     */
    async sendPushNotifications(
        messages: ExpoPushMessage[],
        opts?: { retryWindowMs?: number }
    ): Promise<{ sent: number; failed: number }> {
        logger.debug(`Sending ${messages.length} push notifications`)

        // Filter out invalid push tokens
        const validMessages = messages.filter(message => {
            if (Array.isArray(message.to)) {
                return message.to.every(token => Expo.isExpoPushToken(token))
            }
            return Expo.isExpoPushToken(message.to)
        })

        let sent = 0
        let failed = messages.length - validMessages.length

        if (validMessages.length === 0) {
            // Two very different states, and saying "no valid tokens" for both
            // cost a day (BASED-98). An EMPTY messages array means nobody was
            // registered, or the caller had nothing to send — routine, and what
            // the unit tests produce. A NON-EMPTY array filtered down to zero
            // means every token we hold is malformed, which is a real fault.
            // Reading the first as the second made a healthy push path look
            // dead: the test suite's fake tokens logged the alarming line, and
            // a grep over ~/.happy/logs/*.log sorts by FILENAME, not time, so
            // those lines surfaced above the real deliveries that followed.
            if (messages.length === 0) {
                logger.debug('No push notifications to send')
            } else {
                logger.debug(`All ${messages.length} push token(s) are malformed — none is a valid Expo push token`)
            }
            return { sent, failed }
        }

        // Create chunks to respect Expo's rate limits
        const chunks = this.expo.chunkPushNotifications(validMessages)

        for (const chunk of chunks) {
            // Retry with exponential backoff until the window closes
            const startTime = Date.now()
            const timeout = opts?.retryWindowMs ?? 300000 // 5 minutes
            let attempt = 0
            
            while (true) {
                try {
                    const ticketChunk = await this.expo.sendPushNotificationsAsync(chunk)
                    
                    // Log any errors but don't throw
                    const errors = ticketChunk.filter(ticket => ticket.status === 'error')
                    if (errors.length > 0) {
                        const errorDetails = errors.map(e => ({ message: e.message, details: e.details }))
                        logger.debug('[PUSH] Some notifications failed:', errorDetails)
                    }
                    
                    // If all notifications failed, throw to trigger retry
                    if (errors.length === ticketChunk.length) {
                        throw new Error('All push notifications in chunk failed')
                    }

                    sent += ticketChunk.length - errors.length
                    failed += errors.length
                    // Success - break out of retry loop
                    break
                } catch (error) {
                    const elapsed = Date.now() - startTime
                    if (elapsed >= timeout) {
                        logger.debug(`[PUSH] Retry window of ${timeout}ms exhausted, giving up on chunk`)
                        failed += chunk.length
                        break
                    }
                    
                    // Calculate exponential backoff delay
                    attempt++
                    const delay = Math.min(1000 * Math.pow(2, attempt), 30000) // Max 30 seconds between retries
                    const remainingTime = timeout - elapsed
                    const waitTime = Math.min(delay, remainingTime)
                    
                    if (waitTime > 0) {
                        logger.debug(`[PUSH] Retrying in ${waitTime}ms (attempt ${attempt})`)
                        await new Promise(resolve => setTimeout(resolve, waitTime))
                    }
                }
            }
        }

        logger.debug(`Push notifications: ${sent} accepted by Expo, ${failed} rejected`)
        return { sent, failed }
    }

    /**
     * Send a push notification to all registered devices for the user
     * @param title - Notification title
     * @param body - Notification body
     * @param data - Additional data to send with the notification
     */
    sendToAllDevices(title: string, body?: string, data?: Record<string, any>): void {
        logger.debug(`[PUSH] sendToAllDevices called with title: "${title}", body: "${body ?? ''}"`);
        
        // Execute async operations without awaiting
        (async () => {
            try {
                // Fetch all push tokens
                logger.debug('[PUSH] Fetching push tokens...')
                const tokens = await this.fetchPushTokens()
                logger.debug(`[PUSH] Fetched ${tokens.length} push tokens`)
                
                // Log token details for debugging
                tokens.forEach((token, index) => {
                    logger.debug(`[PUSH] Using token ${index + 1}: id=${token.id}`)
                })

                if (tokens.length === 0) {
                    logger.debug('No push tokens found for user')
                    return
                }

                // Create messages for all tokens
                const messages: ExpoPushMessage[] = tokens.map((token, index) => {
                    logger.debug(`[PUSH] Creating message ${index + 1} for token`)
                    return {
                        to: token.token,
                        title,
                        body: body && body.length > 0 ? body : undefined,
                        data,
                        // TODO: For brutalist session artwork, attach rich media via a public HTTPS image URL.
                        // Bundled app asset paths / require(...) / local file paths will not work in push payloads.
                        // iOS also needs a Notification Service Extension to render richContent.image reliably.
                        sound: 'default',
                        priority: 'high'
                    }
                })

                // Send notifications
                logger.debug(`[PUSH] Sending ${messages.length} push notifications...`)
                await this.sendPushNotifications(messages)
                logger.debug('[PUSH] Push notifications sent successfully')
            } catch (error) {
                logger.debug('[PUSH] Error sending to all devices:', error)
            }
        })()
    }

    /**
     * Routes session-event pushes through the server so it can apply
     * presence-based suppression (active desktop/web, mobile foreground).
     * Falls back to direct Expo send when sessionId is missing, and for any
     * kind the route's schema does not know — see `serverPushEventKinds`.
     */
    sendSessionNotification(params: {
        kind: SessionNotificationKind
        metadata: Metadata | null | undefined
        data?: Record<string, any>
    }): void {
        const { title, body } = getSessionNotificationCopy(params.kind, params.metadata)
        const sessionTitle = getSessionNotificationBody(params.metadata)
        const url = getSessionNotificationUrl(params.data)
        const payloadData = {
            ...params.data,
            kind: params.kind,
            sessionTitle,
            ...(url ? { url } : {}),
        }

        const sessionId = typeof params.data?.sessionId === 'string' ? params.data.sessionId : null
        if (!sessionId) {
            logger.debug('[PUSH] sendSessionNotification: missing sessionId, falling back to direct send')
            this.sendToAllDevices(title, body, payloadData)
            return
        }
        // A kind the route will refuse never gets handed to it (DROVE-70). It
        // is not a soft failure there: the body schema rejects the whole
        // request with a 400, so the push does not merely arrive mislabelled,
        // it does not arrive at all. `drover needs` raised a to-do on
        // 2026-08-31 00:04 BST and the one card that means "Clay must DO
        // something" was the one card that could never buzz his phone.
        if (!serverPushEventKinds.has(params.kind)) {
            logger.debug(`[PUSH] kind=${params.kind} is not on the push-event route; sending direct to Expo`)
            this.sendToAllDevices(title, body, payloadData)
            return
        }

        void (async () => {
            try {
                const response = await axios.post<{
                    result?: string
                    tokens?: number
                    delivered?: number
                    reason?: string
                }>(
                    `${this.baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/push-event`,
                    {
                        kind: params.kind,
                        title,
                        body,
                        data: payloadData,
                    },
                    {
                        headers: {
                            'Authorization': `Bearer ${this.token}`,
                            'Content-Type': 'application/json',
                            'X-Happy-Client': `cli-daemon/${configuration.currentCliVersion}`,
                        },
                        timeout: 15000,
                    }
                )
                // Report what the server actually did. Older servers return no
                // `result`, so fall back to acknowledging the request only.
                const { result, tokens, delivered, reason } = response.data ?? {}
                const detail = [
                    tokens !== undefined ? `tokens=${tokens}` : null,
                    delivered !== undefined ? `delivered=${delivered}` : null,
                    reason ? `reason=${reason}` : null,
                ].filter(Boolean).join(' ')
                logger.debug(
                    result
                        ? `[PUSH] sendSessionNotification ${result} (kind=${params.kind})${detail ? ` ${detail}` : ''}`
                        : `[PUSH] sendSessionNotification accepted by server (kind=${params.kind})`
                )
            } catch (error) {
                // The RESPONSE BODY, not just the stack (DROVE-70). The 400
                // that killed the first live to-do push logged a bare
                // AxiosError, and the one thing that would have named the
                // rejected field in seconds — the server's own validation
                // message — was the one thing never written down.
                logger.debug(`[PUSH] sendSessionNotification failed (kind=${params.kind}): ${describePushError(error)}`)
            }
        })()
    }

    /**
     * Nudge every registered device to run its JS, without showing the user
     * anything.
     *
     * Call this whenever the set of things waiting on a human CHANGED: raised,
     * answered, canceled, expired. A dismiss gets a wake and no alert. You do
     * not buzz somebody to tell them a question went away, but the wrist still
     * has to hear about it, and a silent push is the only carrier that reaches
     * a suspended app. See buildWakeMessages for why this is the only shape
     * that works.
     *
     * It goes DIRECT to Expo instead of through
     * `/v1/sessions/:id/push-event`, which cannot express it two ways over:
     * that route's body schema demands a non-empty title AND body, and the
     * server's own PushMessage type has no `_contentAvailable` field, so a
     * silent push is unrepresentable on that path. It would also be
     * presence-suppressed, and an open web tab on the desktop is not the phone.
     * Measured on 2026-08-29 against packages/happy-server: pushRoutes.ts
     * `title: z.string().min(1)`, pushSend.ts `interface PushMessage`,
     * pushDispatch.ts `isUserActive` → `{ result: 'suppressed' }`.
     *
     * Degrades to nothing on purpose. No credentials, no network, no registered
     * device: this logs and returns, and the session that raised the gate never
     * learns it happened. Adding a surface must never add a dependency.
     */
    sendBackgroundWake(reason: string): void {
        this.pendingWakeReason = reason
        const waited = Date.now() - this.lastWakeAt
        if (waited >= WAKE_THROTTLE_MS) {
            this.flushWake()
            return
        }
        // Throttle with a TRAILING edge, never a plain debounce. The last
        // change is the one that has to reach the wrist, and a debounce that
        // keeps getting reset by a busy bus never delivers it at all.
        if (this.wakeTimer) return
        this.wakeTimer = setTimeout(() => {
            this.wakeTimer = null
            this.flushWake()
        }, WAKE_THROTTLE_MS - waited)
        // A pending wake must never be the reason a short-lived `happy`
        // invocation refuses to exit.
        this.wakeTimer.unref()
    }

    private flushWake(): void {
        const reason = this.pendingWakeReason ?? 'drover'
        this.pendingWakeReason = null
        this.lastWakeAt = Date.now()

        void (async () => {
            try {
                const tokens = await this.fetchPushTokens()
                if (tokens.length === 0) {
                    logger.debug('[PUSH] wake skipped: no registered devices')
                    return
                }
                const outcome = await this.sendPushNotifications(
                    buildWakeMessages(tokens, reason),
                    { retryWindowMs: 0 }
                )
                // A wake that dies at Expo is indistinguishable from no wake at
                // all once you are looking at the watch, so the two cases have
                // to read differently in the log.
                logger.debug(
                    outcome.sent > 0
                        ? `[PUSH] wake sent to ${outcome.sent} device(s) (${reason})`
                        : `[PUSH] wake reached NO device (${reason}), ${outcome.failed} rejected by Expo`
                )
            } catch (error) {
                logger.debug('[PUSH] wake failed:', error)
            }
        })()
    }
}
