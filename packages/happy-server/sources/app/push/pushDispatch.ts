/**
 * Push notification dispatch.
 *
 * Single entry point: dispatchSessionEventPush — rich session-event
 * ("It's ready!", permission, question) called by CLI/daemon clients.
 *
 * Generic per-message pushes were removed: the CLI streams every assistant
 * chunk, tool_use, and tool_result as a session message, so notifying on each
 * insert produced one buzz every 10s during a turn with no useful title.
 * Connected clients still receive the realtime message update over socket;
 * only the Expo push for "new message" went away.
 *
 * Suppression: if the user is demonstrably looking at a UI client
 * (`user-scoped` socket reporting `app-state: active`), suppress the push —
 * they can see in-app indicators (unread dots, tab title counter) instead.
 * Anything short of that proof sends, because a missed push is far more
 * costly than a redundant one. See eventRouter.hasActiveUiClient.
 *
 * Every path reports a PushOutcome so callers can tell "delivered" from
 * "suppressed" from "nobody has a device registered" — previously all three
 * looked identical to the CLI, which is how a total push outage stayed
 * invisible for two months.
 *
 * Waking the phone. A 'permission' or 'question' push is the only thing that
 * can get a drover prompt onto Clay's watch while the phone app is asleep. The
 * watch is fed by startDroverWatchFeed() in the phone app's JS runtime, and iOS
 * stops that runtime the moment the app is backgrounded — which is why he had
 * to hold the app in the foreground to see anything. So those two kinds carry
 * the iOS wake flag as well as the alert. Be clear about what that buys: iOS
 * does not promise to run the app for a content-available push, Apple's own
 * guidance is two or three an hour, and Expo says outright that "the OS does
 * not guarantee its delivery to your app". The alert is the reliable half — it
 * mirrors to a paired Watch when the phone is locked no matter what the wake
 * flag does. Treat the wake as an optimization that usually fires, never as
 * the mechanism the feature stands on.
 */

import { db } from "@/storage/db";
import { isUserActive } from "@/app/push/focusTracker";
import { sendPushNotifications } from "@/app/push/pushSend";
import { pushThrottleClaimRequest, pushThrottleClaimWake, pushThrottleReleaseRequest } from "@/app/push/pushThrottle";
import { log } from "@/utils/log";

/** What actually happened to a session-event push. */
export type PushOutcome =
    | { result: 'sent'; tokens: number }
    | { result: 'partial'; tokens: number; delivered: number; reason: string }
    | { result: 'suppressed'; reason: string }
    | { result: 'duplicate'; reason: string }
    | { result: 'no_tokens' }
    | { result: 'failed'; reason: string };

/** The kinds that leave an agent blocked until a human answers. */
function needsAnswer(kind: string): boolean {
    return kind === 'permission' || kind === 'question';
}

async function fetchTokensAndSend(params: {
    userId: string;
    sessionId: string;
    title: string;
    body: string;
    data: Record<string, unknown>;
    channelId: string;
    wake: boolean;
    timeSensitive: boolean;
}): Promise<PushOutcome> {
    // All push tokens are mobile — web/CLI never register Expo tokens.
    const tokens = await db.accountPushToken.findMany({
        where: { accountId: params.userId }
    });

    if (tokens.length === 0) {
        log({ module: 'push' }, `No push tokens for user ${params.userId} session ${params.sessionId} — skipped`);
        return { result: 'no_tokens' };
    }

    const tickets = await sendPushNotifications(
        tokens.map(t => ({
            to: t.token,
            title: params.title,
            body: params.body,
            data: params.data,
            sound: 'default' as const,
            channelId: params.channelId,
            priority: 'high' as const,
            ...(params.wake ? { contentAvailable: true, _contentAvailable: true } : {}),
            ...(params.timeSensitive ? { interruptionLevel: 'time-sensitive' as const } : {})
        }))
    );

    let okCount = 0;
    const errors: string[] = [];
    for (let i = 0; i < tickets.length; i++) {
        const ticket = tickets[i];
        if (ticket.status === 'ok') {
            okCount++;
            continue;
        }
        errors.push(ticket.details?.error || ticket.message || 'unknown');
        if (ticket.details?.error === 'DeviceNotRegistered') {
            void db.accountPushToken.deleteMany({
                where: { id: tokens[i].id }
            });
        }
    }

    if (errors.length === 0) {
        log({ module: 'push' }, `Push sent for user ${params.userId} session ${params.sessionId}: ${okCount} token(s)`);
        return { result: 'sent', tokens: okCount };
    }

    // Nothing got through — an Expo outage or timeout, not a per-device problem.
    if (okCount === 0) {
        log({ module: 'push', level: 'error' }, `Push failed for user ${params.userId} session ${params.sessionId}: errors=${JSON.stringify(errors)}`);
        return { result: 'failed', reason: errors.join(', ') };
    }

    log({ module: 'push', level: 'warn' }, `Push partial for user ${params.userId} session ${params.sessionId}: ok=${okCount} errors=${JSON.stringify(errors)}`);
    return { result: 'partial', tokens: tokens.length, delivered: okCount, reason: errors.join(', ') };
}

export async function dispatchSessionEventPush(params: {
    userId: string;
    sessionId: string;
    kind: string;
    title: string;
    body: string;
    data?: Record<string, unknown>;
}): Promise<PushOutcome> {
    const { userId, sessionId, kind, title, body, data } = params;
    const requestId = typeof data?.requestId === 'string' && data.requestId.length > 0
        ? data.requestId
        : null;

    try {
        try {
            if (await isUserActive(userId)) {
                log({ module: 'push' }, `Suppressed session-event push for user ${userId} session ${sessionId}: user active`);
                return { result: 'suppressed', reason: 'active-ui-client' };
            }
        } catch (presenceError) {
            // Fail open: if we cannot prove the user is watching, notify them.
            log({ module: 'push', level: 'error' }, `Presence check failed, sending push anyway: ${presenceError}`);
        }

        // Claimed after the presence check so a suppressed push does not burn
        // the request's one shot — nothing went out, so a later call for the
        // same request still deserves to.
        if (requestId && !pushThrottleClaimRequest(userId, requestId)) {
            log({ module: 'push' }, `Skipped duplicate push for user ${userId} session ${sessionId} request ${requestId}`);
            return { result: 'duplicate', reason: 'already-pushed' };
        }

        // A 'done' has nothing to answer, so it neither wakes the app nor
        // spends a slot out of the hourly wake budget.
        const wake = needsAnswer(kind) && pushThrottleClaimWake(userId);
        const outcome = await fetchTokensAndSend({
            userId,
            sessionId,
            title,
            body,
            data: { sessionId, ...(data ?? {}) },
            channelId: 'messages',
            wake,
            timeSensitive: needsAnswer(kind)
        });

        // Nothing reached Expo, so the claim would otherwise silence the retry
        // for an hour on a request still waiting for a human.
        if (requestId && (outcome.result === 'failed' || outcome.result === 'no_tokens')) {
            pushThrottleReleaseRequest(userId, requestId);
        }
        return outcome;
    } catch (error) {
        if (requestId) {
            pushThrottleReleaseRequest(userId, requestId);
        }
        log({ module: 'push', level: 'error' }, `Session-event push dispatch failed: ${error}`);
        return { result: 'failed', reason: error instanceof Error ? error.message : String(error) };
    }
}
