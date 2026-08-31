/**
 * The `/` autocomplete's source of entries (DROVE-170).
 *
 * The derivation, the fallback and the filter are in sessionInventory.ts and
 * are pure. This file is the part with a clock in it: one in-memory cache per
 * session, refreshed off the `sessionInventory` RPC.
 *
 * The cache never blocks a keystroke. A cold session answers immediately from
 * the snapshot's flat lists (or the five, when there are none) and kicks off
 * the refresh; the next keystroke has the real inventory. That keeps the
 * dropdown synchronous the way it has always been while the round trip to the
 * machine happens behind it.
 */

import { storage } from './storage';
import { sessionInventory as sessionInventoryRpc } from './ops';
import {
    commandFallback,
    inventoryFromMetadata,
    inventoryFromPayload,
    mergeInventory,
    searchInventory,
    type InventoryEntry,
    type InventoryKind,
} from './sessionInventory';

export type { InventoryEntry, InventoryKind };

export interface CommandItem {
    /** The command without its slash, e.g. "compact" or "superpowers--brainstorming". */
    command: string;
    description?: string;
    kind: InventoryKind;
    origin?: string;
}

interface SearchOptions {
    limit?: number;
}

interface SessionCache {
    entries: InventoryEntry[] | null;
    lastRefresh: number;
    inFlight: Promise<void> | null;
}

/**
 * Long enough that typing never triggers a round trip, short enough that a
 * skill added on the machine shows up without restarting the app. The RPC is
 * answered by a directory walk, so a miss costs milliseconds on the host.
 */
const refreshIntervalMs = 2 * 60 * 1000;

const caches = new Map<string, SessionCache>();

function cacheFor(sessionId: string): SessionCache {
    let cache = caches.get(sessionId);
    if (!cache) {
        cache = { entries: null, lastRefresh: 0, inFlight: null };
        caches.set(sessionId, cache);
    }
    return cache;
}

/** The snapshot's own lists, plus the five. Always available, never a round trip. */
function snapshotEntries(sessionId: string): InventoryEntry[] {
    const metadata = storage.getState().sessions[sessionId]?.metadata;
    return mergeInventory(inventoryFromMetadata(metadata), commandFallback);
}

function refresh(sessionId: string): Promise<void> {
    const cache = cacheFor(sessionId);
    if (cache.inFlight) return cache.inFlight;

    const run = (async () => {
        try {
            const response = await sessionInventoryRpc(sessionId);
            const fetched = response.success ? inventoryFromPayload(response.inventory) : [];
            if (fetched.length > 0) {
                // The snapshot's lists stay in the merge behind the scan: a
                // remote Claude session's `system.init` knows about built-ins
                // no directory walk can see, and the two together are strictly
                // more than either.
                cache.entries = mergeInventory(
                    fetched,
                    inventoryFromMetadata(storage.getState().sessions[sessionId]?.metadata),
                    commandFallback,
                );
                cache.lastRefresh = Date.now();
            } else {
                // Nothing to enumerate — an older CLI, an offline session, a
                // harness with no such handler. Hold the snapshot answer and
                // try again after the interval rather than emptying the list.
                cache.entries = null;
                cache.lastRefresh = Date.now();
            }
        } catch {
            cache.entries = null;
            cache.lastRefresh = Date.now();
        } finally {
            cache.inFlight = null;
        }
    })();

    cache.inFlight = run;
    return run;
}

function entriesFor(sessionId: string): InventoryEntry[] {
    const cache = cacheFor(sessionId);
    if (Date.now() - cache.lastRefresh > refreshIntervalMs && !cache.inFlight) {
        void refresh(sessionId);
    }
    return cache.entries ?? snapshotEntries(sessionId);
}

function toItem(entry: InventoryEntry): CommandItem {
    return {
        command: entry.name,
        description: entry.description,
        kind: entry.kind,
        origin: entry.origin,
    };
}

/** Warm a session's inventory before the user types, e.g. when a composer mounts. */
export function primeCommands(sessionId: string): void {
    const cache = cacheFor(sessionId);
    if (cache.entries === null && !cache.inFlight) void refresh(sessionId);
}

export async function searchCommands(
    sessionId: string,
    query: string,
    options: SearchOptions = {},
): Promise<CommandItem[]> {
    const { limit = 50 } = options;
    return searchInventory(entriesFor(sessionId), query, limit).map(toItem);
}

/** Everything this session offers, in the order the dropdown shows it. */
export function getAllCommands(sessionId: string): CommandItem[] {
    return entriesFor(sessionId).map(toItem);
}

/** Test seam: drop every cached inventory. */
export function resetCommandCache(): void {
    caches.clear();
}
