import { beforeEach, describe, expect, it } from "vitest";
import {
    pushThrottleClaimRequest,
    pushThrottleClaimWake,
    pushThrottleReleaseRequest,
    pushThrottleReset
} from "./pushThrottle";

const USER = 'user-1';
const OTHER = 'user-2';
const HOUR_MS = 60 * 60 * 1000;

describe('pushThrottleClaimRequest', () => {
    beforeEach(() => pushThrottleReset());

    it('claims a request once', () => {
        expect(pushThrottleClaimRequest(USER, 'req-1')).toBe(true);
        expect(pushThrottleClaimRequest(USER, 'req-1')).toBe(false);
    });

    it('lets a bridge restart re-mirror without re-pushing', () => {
        // The restart replays every event still pending, not just one.
        const pending = ['req-1', 'req-2', 'req-3'];
        expect(pending.map(id => pushThrottleClaimRequest(USER, id))).toEqual([true, true, true]);
        expect(pending.map(id => pushThrottleClaimRequest(USER, id))).toEqual([false, false, false]);
    });

    it('keeps distinct requests independent', () => {
        expect(pushThrottleClaimRequest(USER, 'req-1')).toBe(true);
        expect(pushThrottleClaimRequest(USER, 'req-2')).toBe(true);
    });

    it('scopes a claim to one user', () => {
        expect(pushThrottleClaimRequest(USER, 'req-1')).toBe(true);
        expect(pushThrottleClaimRequest(OTHER, 'req-1')).toBe(true);
    });

    it('does not confuse ids that share a colon', () => {
        // Drover request ids are `agentID:toolUseID`.
        expect(pushThrottleClaimRequest(USER, 'agent:tool')).toBe(true);
        expect(pushThrottleClaimRequest(USER, 'agent:tool2')).toBe(true);
        expect(pushThrottleClaimRequest(USER, 'agent:tool')).toBe(false);
    });

    it('re-opens a claim after the TTL so a stale question can nudge again', () => {
        const now = Date.now();
        expect(pushThrottleClaimRequest(USER, 'req-1', now)).toBe(true);
        expect(pushThrottleClaimRequest(USER, 'req-1', now + HOUR_MS - 1)).toBe(false);
        expect(pushThrottleClaimRequest(USER, 'req-1', now + HOUR_MS + 1)).toBe(true);
    });

    it('re-opens a released claim immediately', () => {
        expect(pushThrottleClaimRequest(USER, 'req-1')).toBe(true);
        pushThrottleReleaseRequest(USER, 'req-1');
        expect(pushThrottleClaimRequest(USER, 'req-1')).toBe(true);
    });
});

describe('pushThrottleClaimWake', () => {
    beforeEach(() => pushThrottleReset());

    it('spends three wakes an hour, then stops', () => {
        const now = Date.now();
        expect(pushThrottleClaimWake(USER, now)).toBe(true);
        expect(pushThrottleClaimWake(USER, now)).toBe(true);
        expect(pushThrottleClaimWake(USER, now)).toBe(true);
        expect(pushThrottleClaimWake(USER, now)).toBe(false);
    });

    it('refills on the next window', () => {
        const now = Date.now();
        for (let i = 0; i < 4; i++) {
            pushThrottleClaimWake(USER, now);
        }
        expect(pushThrottleClaimWake(USER, now + HOUR_MS + 1)).toBe(true);
    });

    it('budgets per user', () => {
        const now = Date.now();
        for (let i = 0; i < 4; i++) {
            pushThrottleClaimWake(USER, now);
        }
        expect(pushThrottleClaimWake(OTHER, now)).toBe(true);
    });
});
