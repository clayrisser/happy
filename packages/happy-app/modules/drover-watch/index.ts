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
    /**
     * The question takes more than one of its options (DROVE-53 Part A).
     * Omitted rather than sent false: the watch reads a missing key as
     * single-select, which is what every question was until this.
     */
    multiSelect?: boolean;
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
    /**
     * One line of what the session is doing right now — "thinking", "3
     * subagents out" (DROVE-54). The app showed a green dot and the word
     * online while the terminal showed a live task tree.
     *
     * No elapsed time in the string, on purpose: the feed republishes on any
     * session change, so a baked-in timer would mean a publish a second. The
     * wrist counts up from `statusSince` itself.
     */
    status?: string;
    /** ISO-8601; when `status` began. */
    statusSince?: string;
}

/**
 * An account the wrist may flip a session ONTO, with the figure that decides
 * which (DROVE-28's watch half).
 *
 * `accounts` carries the same names as bare strings and always will: a watch
 * binary that predates this reads only that key, and the watch cannot be
 * updated OTA. These are the same list with the numbers attached.
 */
export interface DroverAccountRow {
    name: string;
    /** Percent LEFT on the fullest limit; omitted when never measured. */
    headroom?: number;
    /** False when the account is not logged in and cannot take a session. */
    loggedIn?: boolean;
    /** ISO-8601; when a cooling account is back. Omitted when it is not out. */
    backAt?: string;
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
    /**
     * The same accounts with their headroom, most first. Read by a watch that
     * knows the key; the bare `accounts` list is what an older one falls back
     * to, which is why both are sent.
     */
    accountRows?: DroverAccountRow[];
}

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
        (eventName: 'onRefresh', listener: () => void): EventSubscription;
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
 * The wrist asking for a fresh snapshot (DROVE-22).
 *
 * Wrapped in a try/catch, and that is the reason `runtimeVersion` stays "21".
 * A watch-to-phone message launches this app in the background, which is what
 * makes the wrist current with the phone locked in a pocket — but the event is
 * declared in Swift, so a binary built before this one does not emit it, and
 * subscribing to an event a native module never declared throws. Caught here,
 * an older binary running this bundle simply gets a listener that never fires,
 * which is exactly its behaviour today. Bumping the runtime instead would
 * orphan builds 6 and 7 from every OTA for a guard rail that buys nothing.
 */
export function addDroverRefreshListener(listener: () => void) {
    if (!native) return { remove: () => {} };
    try {
        return native.addListener('onRefresh', listener);
    } catch {
        return { remove: () => {} };
    }
}
