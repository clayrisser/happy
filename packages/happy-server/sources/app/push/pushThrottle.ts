/**
 * What the server refuses to send twice.
 *
 * Two limits, for two different failure modes.
 *
 * Per-request dedupe. The CLI mirrors a drover event onto the bridge session
 * and pushes in the same breath (packages/happy-cli/src/drover/droverBridge.ts,
 * `addCard`). Its only guard against a repeat is an in-memory Map, and the
 * comment right above `removeCard` says why that map is deliberately not
 * trusted: "a bridge restart empties that map while the session on the phone
 * still holds every card it was shown". The same restart re-mirrors every event
 * still pending, so every one of them pushes a second time — one buzz per
 * outstanding question, for questions already sitting on the wrist. Claiming
 * the request id here means the second push never leaves the server.
 *
 * Wake budget. Apple's ceiling for background (content-available) pushes is
 * "not more than two or three per hour"
 * (https://docs.expo.dev/push-notifications/what-you-need-to-know/). Past that
 * iOS stops waking the app and tells nobody. Five sessions raising questions
 * inside a minute would spend the whole hour in one go and leave the rest of
 * the day unable to wake anything, so the wake flag is rationed per user. The
 * alert half of the push still goes out when the budget is gone — that is the
 * half iOS forwards to a paired Watch, and it is unrationed.
 *
 * State is in-process on purpose. The relay Clay runs
 * (cattle-drover/libexec/drover-relay) is one standalone process, so this is
 * exact there. Upstream runs three replicas behind a load balancer, where a
 * retry landing on another pod can slip a duplicate through. That costs a
 * redundant buzz; putting the state in Redis would instead risk a real prompt
 * going missing whenever Redis blinks, and a missed prompt is the expensive
 * one.
 */

/**
 * How long a request id stays claimed. Long enough to outlive a bridge restart
 * storm, short enough that a question still unanswered an hour later may buzz
 * again — a nudge, not a bug.
 */
const REQUEST_CLAIM_TTL_MS = 60 * 60 * 1000;

const WAKE_WINDOW_MS = 60 * 60 * 1000;
const WAKE_BUDGET_PER_WINDOW = 3;

/** Hard ceiling so a client looping on new request ids cannot grow the map without bound. */
const MAX_CLAIMS = 10_000;

/** request key -> epoch ms at which the claim lapses. */
const claims = new Map<string, number>();

/** userId -> background pushes spent in the window, and when the window ends. */
const wakeWindows = new Map<string, { count: number; resetAt: number }>();

function claimKey(userId: string, requestId: string): string {
    // Account ids are alphanumeric, so "::" cannot appear in one and the
    // join stays unambiguous even though drover request ids carry a colon
    // of their own (`agentID:toolUseID`).
    return `${userId}::${requestId}`;
}

function sweep(now: number): void {
    // Walks the whole map rather than stopping at the first live entry: every
    // claim shares one TTL today, so insertion order happens to be expiry
    // order, but nothing enforces that and the map is capped at MAX_CLAIMS.
    for (const [key, expiresAt] of claims) {
        if (expiresAt <= now) {
            claims.delete(key);
        }
    }
    for (const [userId, window] of wakeWindows) {
        if (window.resetAt <= now) {
            wakeWindows.delete(userId);
        }
    }
    while (claims.size > MAX_CLAIMS) {
        const oldest = claims.keys().next();
        if (oldest.done) {
            break;
        }
        claims.delete(oldest.value);
    }
}

/**
 * Claims the right to push for one pending request. Returns false when this
 * request already got its push, in which case the caller must send nothing.
 */
export function pushThrottleClaimRequest(userId: string, requestId: string, now: number = Date.now()): boolean {
    sweep(now);
    const key = claimKey(userId, requestId);
    if (claims.has(key)) {
        return false;
    }
    claims.set(key, now + REQUEST_CLAIM_TTL_MS);
    return true;
}

/**
 * Hands the claim back. Called when the send failed outright, so a later retry
 * for the same still-pending request is not eaten by the dedupe.
 */
export function pushThrottleReleaseRequest(userId: string, requestId: string): void {
    claims.delete(claimKey(userId, requestId));
}

/**
 * Spends one background-wake slot. Returns false when the user's hourly budget
 * is gone; the caller should still send the alert, just without the wake flag.
 */
export function pushThrottleClaimWake(userId: string, now: number = Date.now()): boolean {
    const window = wakeWindows.get(userId);
    if (!window || window.resetAt <= now) {
        wakeWindows.set(userId, { count: 1, resetAt: now + WAKE_WINDOW_MS });
        return true;
    }
    if (window.count >= WAKE_BUDGET_PER_WINDOW) {
        return false;
    }
    window.count++;
    return true;
}

/** Clears both limits. Exists so tests start from a known state; nothing in the server calls it. */
export function pushThrottleReset(): void {
    claims.clear();
    wakeWindows.clear();
}
