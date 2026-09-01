/**
 * WHO WRITES THE PHONE WIDGET, AND HOW OFTEN (DROVE-260).
 *
 * `droverWidgetFace.ts` decides what the widget SAYS. This file decides when
 * the widget is TOLD, which is a different question with a different failure:
 * WidgetKit hands out roughly 40 to 70 timeline reloads a day and promises
 * none of them, so a writer that reloads on every publish burns the budget
 * inside an hour and then the widget is frozen for the rest of it — over a
 * gate that was raised in the meantime.
 *
 * So the write and the reload are split. The BLOB is written on every publish,
 * because it costs nothing and it is what a system-scheduled refresh reads;
 * the RELOAD is spent only when `shouldReloadWidget` says the change earned
 * one. Two writers call in here — the foreground feed and the background wake
 * task — and both go through this one function so the budget has a single
 * accountant.
 *
 * THE MEMORY IS PER JS CONTEXT, and that is correct rather than a compromise.
 * A background launch runs a fresh context with no memory, so it always
 * reloads; a background launch only happens when the CLI's silent push says
 * the gate set CHANGED, which is exactly the change worth a reload. The
 * foreground feed keeps its memory for as long as it runs, which is exactly
 * the span over which churn needs damping. Nothing here belongs on disk.
 */

import { isDroverWidgetAvailable, writeDroverWidgetFace, type DroverGate, type DroverSession } from 'drover-watch';

import {
    shouldReloadWidget,
    widgetFaceForSnapshot,
    type DroverWidgetFace,
} from './droverWidgetFace';

/** What the widget was last TOLD, not what it was last written. */
let lastReloaded: DroverWidgetFace | null = null;
let lastReloadAt: number | null = null;

/**
 * Forget what the widget has been told.
 *
 * Called when the feed stops, so a restarted feed reloads once on its first
 * publish rather than inheriting a budget decision from a run that is over —
 * the same reason `startDroverWatchFeed` clears `publishedOnce`.
 */
export function resetDroverWidgetMemory(): void {
    lastReloaded = null;
    lastReloadAt = null;
}

/** What happened, so a caller can log it without asking a second question. */
export type WidgetPublishResult =
    /** No widget on this build: every binary before the extension shipped. */
    | 'unavailable'
    /** The blob is current and the widget was told. A reload was spent. */
    | 'reloaded'
    /** The blob is current and the widget was not told. No reload spent. */
    | 'written'
    /** The app group refused the write — an entitlement that never arrived. */
    | 'failed';

/**
 * Write the widget's face for these gates and sessions.
 *
 * `updatedAt` goes over as ISO-8601, not as the epoch milliseconds the face
 * carries internally. `DroverWidgetFace.swift` decodes through
 * `DroverSnapshot.decoder`, which is pinned to `.iso8601` because that is what
 * the wrist's own blob has always used — and a JSONDecoder handed a number
 * where it expects that string fails the WHOLE face silently, which on this
 * surface reads as a widget that never updates again. One conversion, here,
 * where both ends are in view.
 */
export async function publishDroverWidgetFace(input: {
    gates: Pick<DroverGate, 'id' | 'title' | 'createdAt'>[];
    sessions: Pick<DroverSession, 'id' | 'dotState' | 'subagents'>[];
    now?: number;
}): Promise<WidgetPublishResult> {
    if (!isDroverWidgetAvailable()) return 'unavailable';
    const now = input.now ?? Date.now();
    const face = widgetFaceForSnapshot({ gates: input.gates, sessions: input.sessions, now });
    const reload = shouldReloadWidget({ previous: lastReloaded, next: face, lastReloadAt });
    const wrote = await writeDroverWidgetFace(
        { ...face, updatedAt: new Date(face.updatedAt).toISOString() },
        reload,
    );
    // A refused write means the widget is still holding whatever it had, so
    // the memory must not move: recording this as "told" would let the floor
    // suppress the retry that finally lands.
    if (!wrote) return 'failed';
    if (reload) {
        lastReloaded = face;
        lastReloadAt = now;
    }
    return reload ? 'reloaded' : 'written';
}
