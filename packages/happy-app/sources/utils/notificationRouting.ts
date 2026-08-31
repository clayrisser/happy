function getObjectValue(value: unknown, key: string): unknown {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    return (value as Record<string, unknown>)[key];
}

function parseJson(value: string): unknown {
    try {
        return JSON.parse(value);
    } catch {
        return value;
    }
}

function normalizeNotificationData(data: unknown): unknown {
    if (typeof data === 'string') {
        return parseJson(data);
    }
    return data;
}

function getSessionRouteFromUrl(url: string): `/session/${string}` | null {
    const trimmedUrl = url.trim();
    if (!trimmedUrl) {
        return null;
    }

    const match = trimmedUrl.match(/(?:^|\/)session\/([^/?#]+)/);
    if (!match) {
        return null;
    }

    const encodedSessionId = match[1];
    const sessionId = (() => {
        try {
            return decodeURIComponent(encodedSessionId);
        } catch {
            return encodedSessionId;
        }
    })();

    const trimmedSessionId = sessionId.trim();
    if (!trimmedSessionId) {
        return null;
    }

    return `/session/${encodeURIComponent(trimmedSessionId)}`;
}

export function getSessionRouteFromNotificationData(data: unknown): `/session/${string}` | null {
    const normalizedData = normalizeNotificationData(data);
    if (!normalizedData || typeof normalizedData !== 'object' || Array.isArray(normalizedData)) {
        return null;
    }

    const url = getObjectValue(normalizedData, 'url');
    if (typeof url === 'string') {
        const routeFromUrl = getSessionRouteFromUrl(url);
        if (routeFromUrl) {
            return routeFromUrl;
        }
    }

    const sessionId = getObjectValue(normalizedData, 'sessionId');
    if (typeof sessionId !== 'string') {
        return null;
    }

    const trimmedSessionId = sessionId.trim();
    if (!trimmedSessionId) {
        return null;
    }

    return `/session/${encodeURIComponent(trimmedSessionId)}`;
}

export function getSessionRouteFromNotificationResponse(response: unknown): `/session/${string}` | null {
    const contentData = getObjectValue(getObjectValue(getObjectValue(response, 'notification'), 'request'), 'content');
    return getSessionRouteFromNotificationData(getObjectValue(contentData, 'data'));
}

/**
 * A gate push is the one kind of push that must SHOW while the app is in the
 * foreground (DROVE-85).
 *
 * Upstream's handler hid every push while the app was active, on the theory
 * that you are already looking at it. For a "done" that is right. For a
 * permission, a question or a to-do it is the bug: Clay tests with the app
 * open, the bridge logs "accepted by Expo", and the phone shows nothing,
 * because iOS presents a foreground push only if this handler asks it to.
 * The kind travels in `data.kind`, set by happy-cli's sendSessionNotification
 * on both the server path and the direct-to-Expo one.
 */
const foregroundPushKinds = new Set(['permission', 'question', 'todo']);

export function isGatePushData(data: unknown): boolean {
    const normalizedData = normalizeNotificationData(data);
    const kind = getObjectValue(normalizedData, 'kind');
    return typeof kind === 'string' && foregroundPushKinds.has(kind);
}

/**
 * Where a tap on a push lands (DROVE-94).
 *
 * A GATE push (one that carries `gateId`) opens the gate that raised it, not
 * the thread it was mirrored into. The bridge's push used to name the ONE
 * bridge session every gate on a machine is mirrored into, so a tap opened
 * that mirror and neither the agent that stopped nor the prompt itself. Now
 * the push names the RAISING session when the bridge's registry knows it, and
 * leaves `sessionId` off when it does not, and this reads that:
 *
 * - `sessionId` + `gateId`: the raising session, with that gate focused in
 *   the overlay (`?gate=`).
 * - `gateId` alone: the inbox, scrolled to that gate (`?focus=`).
 * - no `gateId`: whatever the push always did, which is the session route
 *   for a done / turn-finished push and nothing for a wake.
 *
 * The same function serves a tap while running and a cold start
 * (getLastNotificationResponseAsync), so the two cannot drift.
 */
export type PushRoute =
    | `/session/${string}?gate=${string}`
    | `/gates?focus=${string}`
    | `/session/${string}`;

export function routeForGatePush(data: unknown): PushRoute | null {
    const normalizedData = normalizeNotificationData(data);
    const gateId = getObjectValue(normalizedData, 'gateId');
    const trimmedGateId = typeof gateId === 'string' ? gateId.trim() : '';
    if (!trimmedGateId) {
        return getSessionRouteFromNotificationData(normalizedData);
    }
    const sessionRoute = getSessionRouteFromNotificationData(normalizedData);
    if (sessionRoute) {
        return `${sessionRoute}?gate=${encodeURIComponent(trimmedGateId)}`;
    }
    return `/gates?focus=${encodeURIComponent(trimmedGateId)}`;
}

export function getRouteFromNotificationResponse(response: unknown): PushRoute | null {
    const contentData = getObjectValue(getObjectValue(getObjectValue(response, 'notification'), 'request'), 'content');
    return routeForGatePush(getObjectValue(contentData, 'data'));
}

/** The pieces of a PushRoute, for a caller that navigates by session id. */
export type PushDestination =
    | { kind: 'session'; sessionId: string; gateId: string | null }
    | { kind: 'inbox'; gateId: string };

export function parsePushRoute(route: PushRoute): PushDestination | null {
    const decode = (value: string) => {
        try {
            return decodeURIComponent(value);
        } catch {
            return value;
        }
    };
    const inbox = route.match(/^\/gates\?focus=([^&#]+)$/);
    if (inbox) {
        return { kind: 'inbox', gateId: decode(inbox[1]) };
    }
    const session = route.match(/^\/session\/([^/?#]+)(?:\?gate=([^&#]+))?$/);
    if (!session) {
        return null;
    }
    return { kind: 'session', sessionId: decode(session[1]), gateId: session[2] ? decode(session[2]) : null };
}
