import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Metadata } from './types';
import {
    PushNotificationClient,
    buildWakeMessages,
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
