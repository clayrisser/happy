/**
 * Firing a wrist cue from the phone's channel demo (DROVE-75, DROVE-222).
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
 *
 * NOTHING HERE EVER BUZZES THE PHONE INSTEAD (DROVE-222). Every failure comes
 * back as `{ ok: false, why }` for the row to print. A fallback tap in the
 * hand holding the phone is indistinguishable from one on the wrist at arm's
 * length, so a silent one is how "the watch is broken" and "the watch was
 * asleep" came to look identical.
 */

import {
    getDroverWatchStatus,
    isDroverWatchAvailable,
    publishDroverSnapshot,
    wakeDroverWatch,
    type DroverGate,
    type DroverSession,
    type DroverSnapshot,
    type DroverWatchStatus,
} from 'drover-watch';

import { demoLog } from './droverDemo';
import { noteWakeSpent } from './droverWakeLedger';
import {
    collectAccountRows,
    collectAccounts,
    collectGates,
    collectSessions,
    collectTranscript,
} from './droverWatchFeed';
import { storage } from './storage';
import { describeDroverWakeRefusal } from '@/utils/droverWatchStatus';
import { demoFinishSession, demoBuzzGate, wristCueIsGate, type WristCueSpec } from '@/utils/wristCues';

/** How long the demo card stays on the wall before the phone withdraws it. */
export const demoBuzzLingerMs = 4000;

/**
 * How long the staged demo session RUNS before the phone stops it (DROVE-222).
 *
 * Long enough that the two publishes are two deliveries rather than one: the
 * watch has to hold the first as `previous` before the second can read as a
 * change. Short enough that a tap still feels like a tap.
 */
export const demoFinishStageMs = 700;

export type DemoBuzzOutcome =
    | { ok: true; how: 'reachable' | 'wake' }
    | { ok: false; why: string };

/**
 * What the row says after a tap (DROVE-222).
 *
 * Here rather than inline in the screen's JSX because "an unreachable watch is
 * reported on the row" is the whole of this lane, and a string built inside a
 * component is a string no test can pin. Every unhappy path prints the
 * refusal verbatim: there is no wording that could be mistaken for a buzz
 * having happened.
 */
export function demoBuzzLine(outcome: DemoBuzzOutcome): string {
    if (!outcome.ok) return outcome.why;
    return outcome.how === 'wake' ? 'Sent with a background wake' : 'Sent; the watch app was open';
}

function snapshotNow(extraGates: DroverGate[], extraSessions: DroverSession[] = []): DroverSnapshot {
    const sessions = [...collectSessions(), ...extraSessions];
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
    holdWithdraw();
    const status = getDroverWatchStatus();
    if (!status.paired || !status.installed) return { ok: false, why: 'no watch with Drover installed is paired' };
    if (!wristCueIsGate(spec)) return finishOnWatch(spec, status);

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
        // Two causes, two lines (DROVE-391). The complication on no face is
        // fixed on the watch; the day's budget spent is fixed by tomorrow.
        // One sentence for both is what this row said, and Clay could not
        // tell which he had.
        const refusal = describeDroverWakeRefusal(status);
        if (refusal) {
            withdrawLater();
            return { ok: false, why: refusal };
        }
        const spent = await wakeDroverWatch(withDemo);
        if (!spent) {
            withdrawLater();
            return { ok: false, why: 'the wake was not spent as a background launch; open the watch app and try again' };
        }
        // On the ledger like a real one, so "N of 50 used today" counts what
        // was spent here; without a stretch, because a Playground test must
        // not silence the next real gate behind it.
        noteWakeSpent('demo');
        how = 'wake';
    }
    withdrawLater();
    return { ok: true, how };
}

/**
 * "Session finished" on the wrist, by the one path the wrist has for it
 * (DROVE-222).
 *
 * It is not a gate kind, so there is nothing to put on the wall. WristCueDiff
 * derives it from a session that was `active` in the previous snapshot and is
 * not in the next, so the phone stages exactly that: publish one demo session
 * running, then publish the same id stopped. The wrist plays it through the
 * identical diff a real session ending goes through, which is the whole point
 * of doing it this way rather than sending the watch a "play this" command.
 *
 * REACHABLE ONLY, and it says so rather than pretending. Two publishes are two
 * deliveries only while the watch app is open: `publish` sends a reachable
 * watch the snapshot immediately, but a sleeping one is fed by
 * `updateApplicationContext`, which keeps only the LATEST context and would
 * hand the watch the stopped session with no running one before it. Nothing
 * is lost by the restriction — a closed watch app cannot play a per-kind
 * pattern at all, it gets watchOS's own single tap.
 */
async function finishOnWatch(spec: WristCueSpec, status: DroverWatchStatus): Promise<DemoBuzzOutcome> {
    if (!status.reachable) {
        return {
            ok: false,
            why: 'open the Drover watch app for this one: a finished session is the change between two snapshots, and a closed watch is only handed the last of them',
        };
    }
    const now = Date.now();
    const running = demoFinishSession(true, now);
    demoLog(`watch buzz ${spec.cue} (${spec.beats.join(' ')}) as ${running.id}; staging a session that stops`);
    if (!await publishDroverSnapshot(snapshotNow([], [running]))) {
        return { ok: false, why: 'the phone could not publish to the watch' };
    }
    await new Promise<void>((resolve) => setTimeout(resolve, demoFinishStageMs));
    const stopped = demoFinishSession(false, now);
    const published = await publishDroverSnapshot(snapshotNow([], [stopped]));
    withdrawLater();
    if (!published) return { ok: false, why: 'the phone published the session but could not publish the stop' };
    return { ok: true, how: 'reachable' };
}

/**
 * The withdraw scheduled by the last tap, cancelled by the next one.
 *
 * ONE timer, not one per tap. "Play all, back to back" fires five cues inside
 * the linger, so with a timer each, an earlier withdraw lands mid-way through
 * a later cue — harmless for a gate, which has already buzzed, but fatal for
 * the staged session, whose two publishes are a pair: an empty snapshot
 * between them makes the session VANISH rather than stop, and a vanished
 * session is not a cue at all.
 */
let pendingWithdraw: ReturnType<typeof setTimeout> | null = null;

/** Hold off the last tap's withdraw while this one publishes. */
function holdWithdraw(): void {
    if (pendingWithdraw === null) return;
    clearTimeout(pendingWithdraw);
    pendingWithdraw = null;
}

/** Publish again without the demo gate or session once the wrist has played. */
function withdrawLater(): void {
    holdWithdraw();
    pendingWithdraw = setTimeout(() => {
        pendingWithdraw = null;
        demoLog('watch buzz withdrawn from the wall');
        void publishDroverSnapshot(snapshotNow([]));
    }, demoBuzzLingerMs);
}
