/**
 * "Buzz the watch" from the phone's channel demo (DROVE-75).
 *
 * The wrist decides its own buzz from a snapshot diff (WristCueDiff, DROVE-62):
 * a fresh gate of kind `todo` plays the needs-you pattern, `question` the
 * question one, and so on. So the phone can make the real pattern play, on
 * the real path, without a native change: publish the current snapshot plus
 * ONE demo gate of that kind, then publish it again without the gate a few
 * seconds later so the wall does not keep a card nobody can act on. The 60s
 * heartbeat in droverWatchFeed would clear it anyway; the second publish is
 * so the card is gone before Clay looks.
 *
 * The gate id is `demo:`-namespaced. If the wrist answers it, droverWatchFeed
 * drops the answer as a demo and the Mac's bridge refuses it too, so nothing
 * here can reach the bus. And it is one gate on one watch, never fanned out.
 *
 * With the watch app not frontmost, the application context is read on next
 * launch and nothing buzzes. A background wake (one of ~50 a day) is what
 * makes a sleeping wrist play; `spendWake` asks for one, and the row says so.
 */

import {
    getDroverWatchStatus,
    isDroverWatchAvailable,
    publishDroverSnapshot,
    wakeDroverWatch,
    type DroverGate,
    type DroverSnapshot,
} from 'drover-watch';

import { demoLog } from './droverDemo';
import {
    collectAccountRows,
    collectAccounts,
    collectGates,
    collectSessions,
    collectTranscript,
} from './droverWatchFeed';
import { storage } from './storage';
import { canBuzzWatch, demoBuzzGate, type WristCueSpec } from '@/utils/wristCues';

/** How long the demo card stays on the wall before the phone withdraws it. */
export const demoBuzzLingerMs = 4000;

export type DemoBuzzOutcome =
    | { ok: true; how: 'reachable' | 'wake' }
    | { ok: false; why: string };

function snapshotNow(extraGates: DroverGate[]): DroverSnapshot {
    const sessions = collectSessions();
    const accountRows = collectAccountRows(storage.getState().sessions ?? {});
    const status = getDroverWatchStatus();
    const transcript = collectTranscript();
    return {
        gates: [...collectGates(), ...extraGates],
        sessions,
        accounts: collectAccounts(sessions, accountRows),
        ...(accountRows.length ? { accountRows } : {}),
        ...(transcript ? { transcript } : {}),
        updatedAt: new Date().toISOString(),
        connected: !!status.activated && status.paired && status.installed,
    };
}

export async function buzzDroverWatch(spec: WristCueSpec, spendWake = false): Promise<DemoBuzzOutcome> {
    if (!isDroverWatchAvailable()) return { ok: false, why: 'no watch module on this build' };
    if (!canBuzzWatch(spec)) return { ok: false, why: `${spec.headline} is not a gate; the wrist plays it when a session stops` };
    const status = getDroverWatchStatus();
    if (!status.paired || !status.installed) return { ok: false, why: 'no watch with Drover installed is paired' };

    // The kind is the wire kind, which is wider than the phone's own gate
    // type (`expiry` is a watch kind the phone never mirrors). The watch
    // decodes kind as a string and falls back to permission for one it does
    // not know, so nothing here can blank the wall.
    const gate = demoBuzzGate(spec) as unknown as DroverGate;
    demoLog(`watch buzz ${spec.cue} (${spec.beats.join(' ')}) as ${gate.id}; ${status.reachable ? 'watch reachable' : spendWake ? 'spending a wake' : 'watch not reachable, no wake'}`);

    const withDemo = snapshotNow([gate]);
    const published = await publishDroverSnapshot(withDemo);
    if (!published) return { ok: false, why: 'the phone could not publish to the watch' };

    let how: 'reachable' | 'wake' = 'reachable';
    if (!status.reachable) {
        if (!spendWake) {
            withdrawLater();
            return { ok: false, why: 'the watch app is not open; tap again to spend one background wake' };
        }
        if (status.wakes === 0) {
            withdrawLater();
            return { ok: false, why: 'no wakes left today, or the Drover complication is on no watch face' };
        }
        const spent = await wakeDroverWatch(withDemo);
        if (!spent) {
            withdrawLater();
            return { ok: false, why: 'the wake was not spent as a background launch; open the watch app and try again' };
        }
        how = 'wake';
    }
    withdrawLater();
    return { ok: true, how };
}

/** Publish again without the demo gate once the wrist has had time to play. */
function withdrawLater(): void {
    setTimeout(() => {
        demoLog('watch buzz withdrawn from the wall');
        void publishDroverSnapshot(snapshotNow([]));
    }, demoBuzzLingerMs);
}
