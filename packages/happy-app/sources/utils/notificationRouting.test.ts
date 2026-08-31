import { describe, expect, it } from 'vitest';
import {
    getSessionRouteFromNotificationData,
    getSessionRouteFromNotificationResponse,
    isGatePushData,
} from './notificationRouting';

describe('getSessionRouteFromNotificationData', () => {
    it('returns a session route when sessionId exists', () => {
        expect(getSessionRouteFromNotificationData({ sessionId: 'session-123' })).toBe('/session/session-123');
    });

    it('encodes session ids that contain spaces', () => {
        expect(getSessionRouteFromNotificationData({ sessionId: 'session 123' })).toBe('/session/session%20123');
    });

    it('returns null when sessionId is missing', () => {
        expect(getSessionRouteFromNotificationData({ kind: 'done' })).toBeNull();
    });

    it('returns null for empty session ids', () => {
        expect(getSessionRouteFromNotificationData({ sessionId: '   ' })).toBeNull();
    });

    it('uses a session url when present', () => {
        expect(getSessionRouteFromNotificationData({ url: '/session/session-123' })).toBe('/session/session-123');
    });
});

describe('getSessionRouteFromNotificationResponse', () => {
    it('reads the route from content data', () => {
        expect(getSessionRouteFromNotificationResponse({
            notification: {
                request: {
                    content: {
                        data: { sessionId: 'session-123' }
                    }
                }
            }
        })).toBe('/session/session-123');
    });

    it('returns null when content data is missing', () => {
        expect(getSessionRouteFromNotificationResponse({
            notification: {
                request: {
                    content: {}
                }
            }
        })).toBeNull();
    });
});

describe('isGatePushData', () => {
    // A gate must banner in the foreground; anything else keeps upstream's
    // quiet-while-active rule (DROVE-85).
    it('recognises the three gate kinds', () => {
        expect(isGatePushData({ kind: 'permission', sessionId: 's' })).toBe(true);
        expect(isGatePushData({ kind: 'question' })).toBe(true);
        expect(isGatePushData({ kind: 'todo' })).toBe(true);
    });

    it('accepts the JSON-string form Android hands over', () => {
        expect(isGatePushData(JSON.stringify({ kind: 'todo' }))).toBe(true);
    });

    it('leaves a done, a wake and an empty payload quiet', () => {
        expect(isGatePushData({ kind: 'done' })).toBe(false);
        expect(isGatePushData({ type: 'drover_wake', reason: 'gate-raised' })).toBe(false);
        expect(isGatePushData(undefined)).toBe(false);
        expect(isGatePushData(null)).toBe(false);
    });
});
