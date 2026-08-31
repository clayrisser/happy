import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Expo } from 'expo-server-sdk';
import { logger } from '@/ui/logger';
import type { Metadata } from './types';
import {
    PushNotificationClient,
    RECEIPT_DELAY_MS,
    buildWakeMessages,
    describePushError,
    formatReceiptLine,
    getSessionNotificationBody,
    getSessionNotificationCopy,
    getSessionNotificationTitle,
} from './pushNotifications';

function makeMetadata(overrides: Partial<Metadata> = {}): Metadata {
    return {
        path: '/Users/test/projects/happy',
        host: 'test-host',
        homeDir: '/Users/test',
        happyHomeDir: '/Users/test/.happy',
        happyLibDir: '/Users/test/.happy/lib',
        happyToolsDir: '/Users/test/.happy/tools',
        ...overrides,
    };
}

describe('getSessionNotificationTitle', () => {
    it('maps done notifications to a ready title', () => {
        expect(getSessionNotificationTitle('done')).toBe("It's ready!");
    });

    it('maps permission notifications to a permission title', () => {
        expect(getSessionNotificationTitle('permission')).toBe('Permission request');
    });

    it('maps question notifications to a clarification title', () => {
        expect(getSessionNotificationTitle('question')).toBe('Clarification needed');
    });
});

describe('getSessionNotificationBody', () => {
    it('uses the session summary when available', () => {
        const metadata = makeMetadata({
            summary: {
                text: 'Fix push notifications',
                updatedAt: 1,
            }
        });

        expect(getSessionNotificationBody(metadata)).toBe('Fix push notifications');
    });

    it('falls back to the last path segment', () => {
        const metadata = makeMetadata({
            path: '/Users/test/projects/happy-cli',
        });

        expect(getSessionNotificationBody(metadata)).toBe('happy-cli');
    });

    it('falls back to a generic label when metadata is missing', () => {
        expect(getSessionNotificationBody(null)).toBe('Session');
    });
});

describe('getSessionNotificationCopy', () => {
    it('returns the fixed title and session title body', () => {
        const metadata = makeMetadata({
            summary: {
                text: 'Fix push notifications',
                updatedAt: 1,
            }
        });

        expect(getSessionNotificationCopy('done', metadata)).toEqual({
            title: "It's ready!",
            body: 'Fix push notifications',
        });
    });
});

describe('buildWakeMessages', () => {
    const tokens = [
        { id: '1', token: 'ExponentPushToken[a]', createdAt: 0, updatedAt: 0 },
        { id: '2', token: 'ExponentPushToken[b]', createdAt: 0, updatedAt: 0 },
    ];

    it('carries nothing the user can see', () => {
        // A title, a body or a sound turns the wake into a second banner for a
        // gate the alert push already announced.
        for (const message of buildWakeMessages(tokens, 'gate-raised', 1000)) {
            expect(message.title).toBeUndefined();
            expect(message.body).toBeUndefined();
            expect(message.sound).toBeUndefined();
            expect(message.badge).toBeUndefined();
        }
    });

    it('is a background push at the priority Apple accepts', () => {
        const [message] = buildWakeMessages(tokens, 'gate-raised', 1000);
        expect(message._contentAvailable).toBe(true);
        // priority 10 with content-available is answered BadPriority by APNs.
        expect(message.priority).toBe('normal');
        expect(message.ttl).toBe(120);
    });

    it('addresses every registered device and names why it woke', () => {
        const messages = buildWakeMessages(tokens, 'gate-resolved', 1000);
        expect(messages.map((m) => m.to)).toEqual([
            'ExponentPushToken[a]',
            'ExponentPushToken[b]',
        ]);
        expect(messages[0].data).toEqual({ type: 'drover_wake', reason: 'gate-resolved', at: 1000 });
    });

    it('sends nothing when no device is registered', () => {
        expect(buildWakeMessages([], 'gate-raised')).toEqual([]);
    });
});

describe('sendBackgroundWake', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    function makeClient(tokens = [{ id: '1', token: 'ExponentPushToken[a]', createdAt: 0, updatedAt: 0 }]) {
        const client = new PushNotificationClient('bearer', 'https://example.test');
        const fetchPushTokens = vi.spyOn(client, 'fetchPushTokens').mockResolvedValue(tokens);
        const sendPushNotifications = vi.spyOn(client, 'sendPushNotifications').mockResolvedValue({ sent: 1, failed: 0 });
        return { client, fetchPushTokens, sendPushNotifications };
    }

    it('wakes immediately on the first change', async () => {
        const { client, sendPushNotifications } = makeClient();
        client.sendBackgroundWake('gate-raised');
        await vi.advanceTimersByTimeAsync(0);
        expect(sendPushNotifications).toHaveBeenCalledTimes(1);
    });

    it('collapses a burst into one wake and still delivers the last change', async () => {
        // iOS drops surplus background pushes silently, so a busy bus must not
        // become a burst. The trailing edge is what makes the FINAL state
        // reach the wrist. A plain debounce reset by each event never fires.
        const { client, sendPushNotifications } = makeClient();
        client.sendBackgroundWake('gate-raised');
        await vi.advanceTimersByTimeAsync(0);
        client.sendBackgroundWake('gate-raised-2');
        client.sendBackgroundWake('gate-resolved');
        await vi.advanceTimersByTimeAsync(10);
        expect(sendPushNotifications).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(3000);
        expect(sendPushNotifications).toHaveBeenCalledTimes(2);
        const messages = sendPushNotifications.mock.calls[1][0];
        expect((messages[0].data as { reason: string }).reason).toBe('gate-resolved');
    });

    it('does not retry a wake it could not deliver', async () => {
        // A wake that lands five minutes late describes a world that moved on.
        const { client, sendPushNotifications } = makeClient();
        client.sendBackgroundWake('gate-raised');
        await vi.advanceTimersByTimeAsync(0);
        expect(sendPushNotifications.mock.calls[0][1]).toEqual({ retryWindowMs: 0 });
    });

    it('sends nothing when no device is registered', async () => {
        const { client, sendPushNotifications } = makeClient([]);
        client.sendBackgroundWake('gate-raised');
        await vi.advanceTimersByTimeAsync(0);
        expect(sendPushNotifications).not.toHaveBeenCalled();
    });

    it('leaves the caller alone when the token fetch fails', async () => {
        // No credentials, no network, no server: the session that raised the
        // gate must never learn the wake happened.
        const client = new PushNotificationClient('bearer', 'https://example.test');
        vi.spyOn(client, 'fetchPushTokens').mockRejectedValue(new Error('offline'));
        const sendPushNotifications = vi.spyOn(client, 'sendPushNotifications').mockResolvedValue({ sent: 1, failed: 0 });
        expect(() => client.sendBackgroundWake('gate-raised')).not.toThrow();
        await vi.advanceTimersByTimeAsync(0);
        expect(sendPushNotifications).not.toHaveBeenCalled();
    });
});

describe('sendPushNotifications', () => {
    it('reports a token Expo would never accept as failed, not sent', async () => {
        // A push rejected before it leaves the machine used to return the same
        // `void` as a delivered one, which is how a fork whose Expo project has
        // no key for its bundle id looked identical to a quiet day.
        const client = new PushNotificationClient('bearer', 'https://example.test');
        const outcome = await client.sendPushNotifications([{ to: 'not-a-push-token' }]);
        expect(outcome).toEqual({ sent: 0, failed: 1 });
    });
});

describe('sendSessionNotification', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    function makeClient() {
        const client = new PushNotificationClient('bearer', 'https://example.test');
        const sendToAllDevices = vi.spyOn(client, 'sendToAllDevices').mockReturnValue(undefined);
        const post = vi.spyOn(axios, 'post').mockResolvedValue({ data: { success: true, result: 'sent' } });
        return { client, sendToAllDevices, post };
    }

    it('never posts a todo to the route that refuses the kind', async () => {
        // DROVE-70. happy-server's pushRoutes.ts validates
        // `kind: z.enum(['done','permission','question'])`, so a todo is a 400
        // and the push simply does not happen. Measured on the live server on
        // 2026-08-31 with the first `drover needs`.
        const { client, sendToAllDevices, post } = makeClient();
        client.sendSessionNotification({
            kind: 'todo',
            metadata: makeMetadata(),
            data: { sessionId: 'sess-1' },
        });
        await Promise.resolve();
        expect(post).not.toHaveBeenCalled();
        expect(sendToAllDevices).toHaveBeenCalledTimes(1);
        expect(sendToAllDevices.mock.calls[0][0]).toBe('Needs you');
        expect((sendToAllDevices.mock.calls[0][2] as { kind: string }).kind).toBe('todo');
    });

    it('still routes a permission through the server so presence can suppress it', async () => {
        const { client, sendToAllDevices, post } = makeClient();
        client.sendSessionNotification({
            kind: 'permission',
            metadata: makeMetadata(),
            data: { sessionId: 'sess-1' },
        });
        await Promise.resolve();
        expect(sendToAllDevices).not.toHaveBeenCalled();
        expect(post).toHaveBeenCalledTimes(1);
        expect(post.mock.calls[0][0]).toContain('/v1/sessions/sess-1/push-event');
        expect((post.mock.calls[0][1] as { kind: string }).kind).toBe('permission');
    });
});

describe('describePushError', () => {
    it('reports the status and the body the server sent back', () => {
        // The 400 that killed the first live to-do push logged a bare
        // AxiosError stack, so the field the server objected to was never
        // written down (DROVE-70).
        const error = new axios.AxiosError('Request failed with status code 400');
        error.response = {
            status: 400,
            statusText: 'Bad Request',
            headers: {},
            config: {} as never,
            data: { message: 'body/kind must be equal to one of the allowed values' },
        };
        expect(describePushError(error)).toBe(
            'HTTP 400 {"message":"body/kind must be equal to one of the allowed values"}',
        );
    });

    it('says so when the response carried no body at all', () => {
        const error = new axios.AxiosError('boom');
        error.response = { status: 502, statusText: 'Bad Gateway', headers: {}, config: {} as never, data: undefined };
        expect(describePushError(error)).toBe('HTTP 502 (empty body)');
    });

    it('falls back to the message for an error that never reached the server', () => {
        expect(describePushError(new Error('offline'))).toBe('Error: offline');
    });
});

describe('receipts', () => {
    // "Accepted by Expo" is a ticket, not a delivery (DROVE-85). These drive
    // the whole path from a send through the detached receipt check with the
    // three bodies Expo actually returns, mocked at the SDK's HTTP boundary.
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    function makeClient(receipts: Record<string, unknown>) {
        const client = new PushNotificationClient('bearer', 'https://example.test');
        const expo = (client as unknown as { expo: Expo }).expo;
        vi.spyOn(expo, 'sendPushNotificationsAsync').mockResolvedValue([{ status: 'ok', id: 'ticket-1' }]);
        const getReceipts = vi.spyOn(expo, 'getPushNotificationReceiptsAsync')
            .mockResolvedValue(receipts as never);
        const lines: string[] = [];
        vi.spyOn(logger, 'debug').mockImplementation((message: string) => {
            lines.push(message);
        });
        return { client, getReceipts, lines };
    }

    async function sendOne(client: PushNotificationClient) {
        await client.sendPushNotifications([{ to: 'ExponentPushToken[a]', title: 'Needs you' }]);
    }

    it('logs the ticket at send and the ok receipt fifteen seconds later, without delaying the send', async () => {
        const { client, getReceipts, lines } = makeClient({ 'ticket-1': { status: 'ok' } });
        await sendOne(client);
        expect(lines).toContain('[PUSH] ticket ticket-1 accepted');
        // The send returned before any receipt was asked for.
        expect(getReceipts).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(RECEIPT_DELAY_MS - 1);
        expect(getReceipts).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(getReceipts).toHaveBeenCalledWith(['ticket-1']);
        expect(lines).toContain('[PUSH] receipt ticket-1 ok');
    });

    it('names DeviceNotRegistered and the token it belongs to', async () => {
        const { client, lines } = makeClient({
            'ticket-1': {
                status: 'error',
                message: 'The recipient device is not registered with FCM/APNs.',
                details: { error: 'DeviceNotRegistered', expoPushToken: 'ExponentPushToken[a]' },
            },
        });
        await sendOne(client);
        await vi.advanceTimersByTimeAsync(RECEIPT_DELAY_MS);
        expect(lines).toContain(
            '[PUSH] receipt ticket-1 DeviceNotRegistered The recipient device is not registered with FCM/APNs. token=ExponentPushToken[a]',
        );
    });

    it('names InvalidCredentials, the missing-APNs-key failure this was written for', async () => {
        const { client, lines } = makeClient({
            'ticket-1': {
                status: 'error',
                message: 'Unable to retrieve the APNs credentials for this app.',
                details: { error: 'InvalidCredentials' },
            },
        });
        await sendOne(client);
        await vi.advanceTimersByTimeAsync(RECEIPT_DELAY_MS);
        expect(lines).toContain(
            '[PUSH] receipt ticket-1 InvalidCredentials Unable to retrieve the APNs credentials for this app.',
        );
    });

    it('says when Expo has no receipt yet rather than dropping the ticket', async () => {
        const { client, lines } = makeClient({});
        await sendOne(client);
        await vi.advanceTimersByTimeAsync(RECEIPT_DELAY_MS);
        expect(lines).toContain('[PUSH] receipt ticket-1 pending (Expo has no receipt for it yet)');
    });

    it('never lets a failed receipt fetch reach the send', async () => {
        const { client, lines } = makeClient({});
        const expo = (client as unknown as { expo: Expo }).expo;
        vi.spyOn(expo, 'getPushNotificationReceiptsAsync').mockRejectedValue(new Error('offline'));
        await expect(sendOne(client)).resolves.toBeUndefined();
        await vi.advanceTimersByTimeAsync(RECEIPT_DELAY_MS);
        expect(lines.some((line) => line.startsWith('[PUSH] receipts unavailable for 1 ticket(s): Error: offline'))).toBe(true);
        expect(lines.some((line) => line.startsWith('[PUSH] receipt ticket-1'))).toBe(false);
    });

    it('schedules nothing when Expo issued no ticket', () => {
        const client = new PushNotificationClient('bearer', 'https://example.test');
        const spy = vi.spyOn(global, 'setTimeout');
        client.scheduleReceiptCheck([]);
        expect(spy).not.toHaveBeenCalled();
    });
});

describe('formatReceiptLine', () => {
    it('falls back to a bare error word when Expo names none', () => {
        expect(formatReceiptLine('t', { status: 'error', message: 'boom' })).toBe('[PUSH] receipt t error boom');
    });
});

describe('sendToAllDevices', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('does not claim success when Expo accepted nothing', async () => {
        // `drover status` reads the success line as a verdict, so it must be
        // written only when something was accepted (DROVE-85).
        const client = new PushNotificationClient('bearer', 'https://example.test');
        vi.spyOn(client, 'fetchPushTokens').mockResolvedValue([{ id: '1', token: 'ExponentPushToken[a]', createdAt: 0, updatedAt: 0 }]);
        vi.spyOn(client, 'sendPushNotifications').mockResolvedValue({ sent: 0, failed: 1 });
        const lines: string[] = [];
        vi.spyOn(logger, 'debug').mockImplementation((message: string) => { lines.push(message); });
        client.sendToAllDevices('Needs you', 'body');
        await vi.waitFor(() => expect(lines).toContain('[PUSH] Push notifications reached NO device, 1 rejected by Expo'));
        expect(lines).not.toContain('[PUSH] Push notifications sent successfully');
    });
});
