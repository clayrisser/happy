import { requireOptionalNativeModule, type EventSubscription } from 'expo-modules-core';

/**
 * Phone-side WatchConnectivity bridge for the Cattle Drover wrist surface
 * (BASED-98). iOS only; every export degrades to a no-op elsewhere so callers
 * never need a Platform check.
 */

export interface DroverWatchStatus {
    supported: boolean;
    activated?: boolean;
    paired: boolean;
    /** The watch has the drover watch app installed. */
    installed: boolean;
    reachable: boolean;
}

export interface DroverAnswerEvent {
    /** The gate id — for Happy sessions, `${sessionId}:${requestId}`. */
    id: string;
    allow: boolean;
    optionId?: string;
    /**
     * A typed or dictated answer, from watchOS's own input sheet.
     *
     * Kept apart from `optionId` so the phone can tell a pick from a typed
     * answer; both leave the phone on the same `updatedInput.optionId` key,
     * because happy-cli decides action=option vs action=text by matching the
     * string against the question's options (see droverWatchFeed's onAnswer).
     */
    text?: string;
}

/**
 * One pickable answer on a question gate.
 *
 * `id` is optional because the two producers disagree and both are real. The
 * bus enforces `{id, label}` (schema/event.json), but happy-cli's
 * requestForEvent flattens a mirrored question to `{label, description}` so it
 * can render through the phone's own AskUserQuestion card, and Claude's native
 * cards never carried an id at all. Nothing is lost by sending the label
 * instead: happy-cli matches an answer with `o.id === candidate || o.label ===
 * candidate` (src/drover/droverBridge.ts), so a label comes back to the right
 * option.
 */
export interface DroverGateOption {
    id?: string;
    label: string;
    description?: string;
}

/** One gate waiting on a human, as the watch renders it. */
export interface DroverGate {
    id: string;
    title: string;
    reason: string;
    preview: string;
    kind: 'permission' | 'question';
    /** ISO-8601; Swift's JSONDecoder reads these with .iso8601. */
    createdAt: string;
    account?: string | null;
    /**
     * What a question can be answered WITH. Absent on a permission, and absent
     * on a question whose card carried none — those are answered by typing or
     * dictating instead (GateDetailView's TextFieldLink), not punted to the
     * phone.
     *
     * A question that reaches the watch WITHOUT these is a black hole: the
     * wrist can only send a bare allow, the bus refuses it ("a question needs
     * an option or text", 409) or an older one takes it with no answer at all,
     * and the event stays pending while every surface dismisses. The watch drew
     * these before this field existed, which is why it is here.
     */
    options?: DroverGateOption[];
}

/** A session the wrist may flip onto another account. */
export interface DroverSession {
    id: string;
    title: string;
    account?: string | null;
    active: boolean;
    /** Working directory, shown under the title on the wrist. */
    path?: string;
    /** Subagents running right now; omitted when the session never said. */
    subagents?: number;
}

export interface DroverSnapshot {
    gates: DroverGate[];
    /**
     * ISO-8601, stamped at publish. The wrist's ONLY liveness signal, which is
     * why the feed heartbeats rather than publishing on change alone.
     */
    updatedAt: string;
    /**
     * The wrist is being FED: this phone has an activated WatchConnectivity
     * session, a paired watch, and the drover app installed on it.
     *
     * It is NOT "the bridge is connected to the bus", which is what this used
     * to claim on the watch side. The flag is only ever written BY a publish,
     * so the one failure it was written for — the phone stops feeding the
     * wrist — is precisely the one it can never report: no publish, no false.
     * That failure is caught by comparing `updatedAt` against the watch's own
     * clock (DroverSnapshot.isStale on the watch), not by this.
     */
    connected: boolean;
    sessions: DroverSession[];
    /**
     * Account names the wrist can offer by name. Gathered from the sessions
     * themselves, not from the drover registry: the phone only ever sees an
     * account because the CLI stamped `metadata.droverAccount` on a session,
     * so an account with nothing running on it cannot appear here.
     */
    accounts: string[];
}

/**
 * The wrist asking for a current snapshot (DROVE-22).
 *
 * Carries nothing: there is one thing to ask for. It arrives as a
 * WatchConnectivity `sendMessage`, which is the one call on that wire that
 * wakes this app in the background — everything else has to be initiated by a
 * phone app that is already running, and iOS suspends a backgrounded app within
 * seconds, which is why the wrist's snapshot was stale by definition every time
 * Clay raised his wrist. The native side holds the watch's reply open until the
 * next `publishDroverSnapshot`, so answering this promptly is what makes the
 * wall read fresh.
 */
export interface DroverRefreshEvent {}

/** The wrist asking for an account flip (BASED-98). */
export interface DroverFlipEvent {
    sessionId: string;
    /** Omitted for "next account with headroom". */
    account?: string;
}

// The emitter members are declared explicitly rather than by extending
// NativeModule<…>: that generic resolves to a stub without them under this
// project's moduleResolution, and an inaccurate type is worse than a written
// one.
type DroverWatchModuleType = {
    status: () => DroverWatchStatus;
    publish: (json: string) => Promise<boolean>;
    addListener: {
        (eventName: 'onAnswer', listener: (event: DroverAnswerEvent) => void): EventSubscription;
        (eventName: 'onFlip', listener: (event: DroverFlipEvent) => void): EventSubscription;
        (eventName: 'onRefresh', listener: (event: DroverRefreshEvent) => void): EventSubscription;
    };
};

// Optional: Android, web and any build without the module still import this
// file. A missing native module is not an error, it is "no wrist here".
const native = requireOptionalNativeModule<DroverWatchModuleType>('DroverWatch');

export const isDroverWatchAvailable = () => native !== null;

export function getDroverWatchStatus(): DroverWatchStatus {
    if (!native) return { supported: false, paired: false, installed: false, reachable: false };
    try {
        return native.status();
    } catch {
        return { supported: false, paired: false, installed: false, reachable: false };
    }
}

export async function publishDroverSnapshot(snapshot: DroverSnapshot): Promise<boolean> {
    if (!native) return false;
    try {
        return await native.publish(JSON.stringify(snapshot));
    } catch {
        // A failed publish must never take the app down: the wrist is a
        // convenience surface and the phone UI still shows every gate.
        return false;
    }
}

export function addDroverAnswerListener(listener: (event: DroverAnswerEvent) => void) {
    if (!native) return { remove: () => {} };
    return native.addListener('onAnswer', listener);
}

export function addDroverFlipListener(listener: (event: DroverFlipEvent) => void) {
    if (!native) return { remove: () => {} };
    return native.addListener('onFlip', listener);
}

/**
 * The wrist asking for a snapshot (DROVE-22). The listener must publish one:
 * the native side is holding the watch's reply open, and it falls back to the
 * last snapshot this phone published — timestamp and all — once its deadline
 * runs out.
 */
export function addDroverRefreshListener(listener: (event: DroverRefreshEvent) => void) {
    if (!native) return { remove: () => {} };
    try {
        return native.addListener('onRefresh', listener);
    } catch {
        // Build 7's binary declares onAnswer and onFlip and nothing else, and
        // this file can reach that binary as an OTA update — the JS ships in a
        // minute, the Swift beside it cannot ship at all (docs/wrist-install.md).
        // Subscribing to an event a module never declared must therefore cost
        // nothing: the wrist on that build simply never asks, which is exactly
        // what it did before DROVE-22.
        return { remove: () => {} };
    }
}
