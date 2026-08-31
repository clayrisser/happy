import { describe, expect, it } from 'vitest';
import {
    getRouteFromNotificationResponse,
    getSessionRouteFromNotificationData,
    getSessionRouteFromNotificationResponse,
    isGatePushData,
    parsePushRoute,
    routeForGatePush,
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

describe('routeForGatePush', () => {
    // DROVE-94. The bridge's push named the ONE session every gate is mirrored
    // into, so a tap opened that mirror thread and not the gate. The push now
    // carries the gate and, when the bridge knows it, the session that raised
    // it.
    it('opens the raising session with the gate focused when the push names both', () => {
        expect(routeForGatePush({ kind: 'permission', gateId: 'ev-1', sessionId: 'happy-a' }))
            .toBe('/session/happy-a?gate=ev-1');
    });

    it('opens the inbox with the gate focused when the raising session is unknown', () => {
        expect(routeForGatePush({ kind: 'todo', gateId: 'ev-1' })).toBe('/gates?focus=ev-1');
    });

    it('keeps the old session route for a push that is not a gate', () => {
        expect(routeForGatePush({ kind: 'done', sessionId: 'happy-a' })).toBe('/session/happy-a');
        expect(routeForGatePush({ url: '/session/happy-b' })).toBe('/session/happy-b');
    });

    it('routes nowhere for a wake or an empty payload', () => {
        expect(routeForGatePush({ type: 'drover_wake', reason: 'gate-raised' })).toBeNull();
        expect(routeForGatePush(undefined)).toBeNull();
        expect(routeForGatePush('not json')).toBeNull();
    });

    it('encodes ids and ignores a blank gate id', () => {
        expect(routeForGatePush({ gateId: 'a b', sessionId: 's 1' })).toBe('/session/s%201?gate=a%20b');
        expect(routeForGatePush({ gateId: '   ', sessionId: 'happy-a' })).toBe('/session/happy-a');
    });

    it('accepts the JSON-string form Android hands over', () => {
        expect(routeForGatePush(JSON.stringify({ gateId: 'ev-1', sessionId: 'happy-a' })))
            .toBe('/session/happy-a?gate=ev-1');
    });
});

describe('getRouteFromNotificationResponse', () => {
    // The same decision for a tap while running and for a cold start read
    // back through getLastNotificationResponseAsync: both hand over this shape.
    it('reads the gate route off a response', () => {
        expect(getRouteFromNotificationResponse({
            notification: { request: { content: { data: { gateId: 'ev-1', sessionId: 'happy-a' } } } },
        })).toBe('/session/happy-a?gate=ev-1');
        expect(getRouteFromNotificationResponse({
            notification: { request: { content: { data: { gateId: 'ev-1' } } } },
        })).toBe('/gates?focus=ev-1');
    });

    it('returns null when content data is missing', () => {
        expect(getRouteFromNotificationResponse({ notification: { request: { content: {} } } })).toBeNull();
        expect(getRouteFromNotificationResponse(null)).toBeNull();
    });
});

describe('parsePushRoute', () => {
    it('takes a route back apart into what the navigator needs', () => {
        expect(parsePushRoute('/session/s%201?gate=a%20b')).toEqual({ kind: 'session', sessionId: 's 1', gateId: 'a b' });
        expect(parsePushRoute('/session/happy-a')).toEqual({ kind: 'session', sessionId: 'happy-a', gateId: null });
        expect(parsePushRoute('/gates?focus=ev-1')).toEqual({ kind: 'inbox', gateId: 'ev-1' });
    });

    it('round-trips what routeForGatePush builds', () => {
        const route = routeForGatePush({ gateId: 'bridge:ev/1', sessionId: 'happy-a' });
        expect(route && parsePushRoute(route)).toEqual({ kind: 'session', sessionId: 'happy-a', gateId: 'bridge:ev/1' });
    });
});
