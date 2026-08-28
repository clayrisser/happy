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
}

export interface DroverSnapshot {
    gates: DroverGate[];
    updatedAt: string;
    connected: boolean;
}

// The emitter members are declared explicitly rather than by extending
// NativeModule<…>: that generic resolves to a stub without them under this
// project's moduleResolution, and an inaccurate type is worse than a written
// one.
type DroverWatchModuleType = {
    status: () => DroverWatchStatus;
    publish: (json: string) => Promise<boolean>;
    addListener: (
        eventName: 'onAnswer',
        listener: (event: DroverAnswerEvent) => void,
    ) => EventSubscription;
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
