/**
 * Who carries an event to the wrist, and whether it has been carried already
 * (DROVE-224).
 *
 * THE PROBLEM Clay worked out himself. iOS does not forward a push to the
 * watch while the app that owns it is frontmost — it hands the notification to
 * the running app instead — and the watch mirrors the PHONE's notifications.
 * So having the Drover app open silences his wrist as a side effect, exactly
 * when he is most engaged. The eyes-free surface goes quiet the moment he
 * starts using the eyes-on one.
 *
 * THE RULE. There are two ways a cue reaches the wrist and only one of them
 * can be live at a time:
 *
 *   MIRROR   iOS forwards the push to the watch. Possible ONLY while this app
 *            is not frontmost, and unreliable even then — WristCue.swift
 *            records 21 of 888 `sendSessionNotification` verdicts delivered on
 *            2026-08-30, the rest InvalidCredentials or presence-suppressed.
 *   DIRECT   the phone publishes the snapshot over WatchConnectivity and, when
 *            the watch app is not already frontmost, spends one background
 *            wake to launch it. WristCueDiff on the watch reads the change and
 *            WristBuzzer plays the cue's own pattern (DROVE-62, DROVE-174).
 *
 * With the app foregrounded the mirror is structurally incapable, so the
 * direct path is the ONLY path and must always fire. That is the whole of this
 * ticket. Nothing new is invented for it: the cue vocabulary is DROVE-174's,
 * the patterns are DROVE-190's, and a directly delivered event is
 * indistinguishable on the wrist from one that arrived by push, because it IS
 * the same snapshot diff either way.
 *
 * EXACTLY ONCE, and this is what the ledger below is for. Two phone-side
 * paths can carry the same cue — the foreground feed (droverWatchFeed) and the
 * background task the silent wake push launches (droverBackgroundNotification)
 * — and they run in different JS contexts, so an in-memory guard would not see
 * across them. A headless background launch starts with an empty module, which
 * is precisely why WristBuzzer persists its own `played` list on the watch.
 * This is that idea on the phone: a cue id is claimed at most once, on disk,
 * and the second path to reach it spends no wake.
 *
 * The two transitions the ticket names both fall out of that:
 *
 *   FOREGROUND -> BACKGROUND   the gate lands while the app is active, the
 *                              feed carries and claims it; the silent wake
 *                              push then runs the background task, which finds
 *                              the cue claimed and publishes without waking.
 *                              ONE buzz.
 *   BACKGROUND -> FOREGROUND   the background task carried and claimed it; the
 *                              app comes forward and the feed sees a gate that
 *                              is new against its in-memory `lastGates`, but
 *                              the ledger says carried, so no second wake.
 *                              ONE buzz.
 *
 * WHAT THIS CANNOT ARBITRATE. iOS never tells an app that a notification was
 * forwarded to the watch, so a cue carried directly in the BACKGROUND can in
 * principle also arrive as a mirror, and the phone has no lever on that half.
 * It is left carrying rather than left silent on purpose: silence is the
 * complaint that filed this ticket, and the mirror is measured at 21/888. It
 * needs Clay's wrist to say whether the doubled background alert is real.
 *
 * Cue ids are the WATCH's, not a second naming: a gate's bus id, or
 * `finished:<sessionId>` for a session that was running and stopped. Same
 * strings WristCueEvent.id carries, so the two ledgers agree by construction.
 *
 * WHAT REACHES THE WRIST, plainly, because a rule nobody wrote down is a rule
 * nobody can check:
 *
 *   ALWAYS      a gate the phone did not have — permission, question, todo —
 *               and a session that was running and has stopped. Each with the
 *               pattern DROVE-174 and DROVE-190 already gave it, because the
 *               watch derives the cue from the snapshot either way. A directly
 *               delivered event is indistinguishable from a pushed one.
 *   NEVER       `expiry`. The wire kind exists on the watch, but the phone
 *               publishes no expiry gate; an account running out reaches the
 *               wall as an account row, without a cue. Named here so its
 *               silence reads as a decision rather than a bug.
 *   COALESCED   several gates landing in one store change are ONE publish and
 *               ONE wake, and the watch plays the loudest by WristCue.rank.
 *               That is deliberate: a wrist cannot tell three taps from one
 *               long pattern, and it keeps a burst of bus events off a budget
 *               that is finite.
 *   REFUSED     no wakes left, or the Drover complication on no watch face
 *               (two causes, told apart since DROVE-391). The claim is given
 *               BACK so the cue stays carryable, the shared record is not
 *               advanced, and the reason is written where a screen reads it:
 *               the session info screen's Wrist row. Never a silent drop —
 *               that is the complaint this ticket was filed about.
 *   NOT WOKEN   a `finished:` cue, and a second gate inside one unreachable
 *               stretch (DROVE-391). Both are carried: the reachable watch
 *               diffs the stop off the publish, and the second gate rides the
 *               application context the first wake's launch reads. The rule
 *               and the per-day ledger are droverWakeLedger.ts.
 *
 * The synced haptic switch still rules (droverChannels, DROVE-72): with
 * `announceHaptic` off, Clay has said the wrist should not buzz, and it does
 * not. PHONE haptics are a different switch entirely (DROVE-190) and stay off
 * by default; nothing here touches them.
 */

import { MMKV } from 'react-native-mmkv';

const mmkv = new MMKV();
const CARRIED_KEY = 'drover-wrist-carried-v1';
const STATE_KEY = 'drover-wrist-state-v1';
const NOTES_KEY = 'drover-wrist-notes-v1';

/**
 * How many cue ids to remember. The same 200 WristBuzzer keeps, and for the
 * same reason: enough to cover a long stretch of gates without growing
 * forever, oldest dropped first. A cue that old cannot arrive again.
 */
const CARRIED_LIMIT = 200;

/** How many refusals to keep for a screen to read back. */
const NOTES_LIMIT = 10;

/** Which path can reach the wrist for an event observed in this app state. */
export type WristCarrier = 'direct' | 'mirror';

/**
 * `direct` whenever this app is frontmost, because iOS cannot forward a push
 * to the watch then. Anything else — background, inactive, a locked screen,
 * an unknown state off a platform without AppState — leaves the mirror
 * possible, so the carrier is reported as `mirror`.
 *
 * It says what is POSSIBLE, not what will happen. The phone still carries in
 * the background; the value is what makes a refusal readable ("the wrist could
 * not be reached and nothing else could have reached it either").
 */
export function wristCarrierFor(appState: string | null | undefined): WristCarrier {
    return appState === 'active' ? 'direct' : 'mirror';
}

/** What the wrist has last been told about, in the terms cues are derived from. */
export interface WristCueState {
    /** Gate ids on the wall. */
    gates: string[];
    /** Session ids that were RUNNING. A stop is what makes a `finished` cue. */
    running: string[];
}

/** The shape both callers hand in; only the fields a cue is derived from. */
export interface WristCueSource {
    gates: { id: string }[];
    sessions: { id: string; active: boolean }[];
}

export function wristCueStateOf(source: WristCueSource): WristCueState {
    return {
        gates: source.gates.map((g) => g.id),
        running: source.sessions.filter((s) => s.active).map((s) => s.id),
    };
}

/**
 * The cue ids this change raises on the wrist, in WristCueDiff's own terms.
 *
 * A gate `after` has that `before` did not, and a session that was running and
 * is now not. Deliberately WITHOUT the watch's 150s freshness window: the
 * watch applies that itself against its own persisted snapshot, and a phone
 * that filtered too would refuse to carry a gate the watch would have played.
 */
export function wristCueIds(before: WristCueState, after: WristCueSource): string[] {
    const known = new Set(before.gates);
    const wasRunning = new Set(before.running);
    return [
        ...after.gates.filter((g) => !known.has(g.id)).map((g) => g.id),
        ...after.sessions.filter((s) => !s.active && wasRunning.has(s.id)).map((s) => `${FINISHED_PREFIX}${s.id}`),
    ];
}

/** The cue id a session that was running and stopped carries: `finished:<sessionId>`. */
export const FINISHED_PREFIX = 'finished:';

/**
 * The cues in `ids` that are GATES needing an answer, which are the only cues
 * a background wake is spent on (DROVE-391). A `finished:` cue is still
 * carried to a reachable watch, which diffs it off the publish; it never
 * launches a sleeping one. 300 dead sessions going quiet overnight is up to
 * 300 launches nobody felt, and that is where the day's 50 went.
 */
export function gateCueIds(ids: string[]): string[] {
    return ids.filter((id) => !id.startsWith(FINISHED_PREFIX));
}

function readList(key: string): string[] {
    try {
        const raw = mmkv.getString(key);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
    } catch {
        return [];
    }
}

function writeList(key: string, value: unknown): void {
    try {
        mmkv.set(key, JSON.stringify(value));
    } catch {
        // A wrist ledger that cannot be written is a wrist that buzzes twice,
        // never one that crashes the app on the way to a gate.
    }
}

/** Whether this cue has already been carried to the wrist by some path. */
export function wristCueCarried(id: string): boolean {
    return readList(CARRIED_KEY).includes(id);
}

/**
 * Take ownership of the cues nobody has carried yet, and return those.
 *
 * The caller buzzes for what comes back and for nothing else. An empty result
 * means every cue in `ids` was already carried, which is the answer that makes
 * both transitions exactly one buzz.
 */
export function claimWristCues(ids: string[]): string[] {
    if (ids.length === 0) return [];
    const carried = readList(CARRIED_KEY);
    const known = new Set(carried);
    const mine = ids.filter((id) => !known.has(id));
    if (mine.length === 0) return [];
    const next = [...carried, ...mine];
    writeList(CARRIED_KEY, next.slice(Math.max(0, next.length - CARRIED_LIMIT)));
    return mine;
}

/**
 * Give a claim back, because the carry did not happen.
 *
 * A claim is taken BEFORE the wake is spent, and the wake can still be refused
 * — no budget left, or the native call downgraded to a plain transfer. Keeping
 * the claim there would mark a cue carried that nobody ever felt, and no later
 * path would try again: a permanently silent gate, which is worse than the
 * double this ledger exists to prevent.
 */
export function releaseWristCues(ids: string[]): void {
    if (ids.length === 0) return;
    const drop = new Set(ids);
    writeList(CARRIED_KEY, readList(CARRIED_KEY).filter((id) => !drop.has(id)));
}

/**
 * Mark cues carried without owning a buzz for them.
 *
 * For the feed's FIRST publish of a run, which has nothing to compare against
 * and so reads the whole wall as new. Waking there would spend the budget on
 * work that was already up, and the wrist filters it out anyway
 * (WristCueDiff.freshWindow). Seeding rather than skipping matters because the
 * background task has no such first-publish guard: an unseeded wall would be
 * carried by the next background wake instead.
 */
export function seedWristCues(ids: string[]): void {
    claimWristCues(ids);
}

/** What the wrist was last told, shared by the feed and the background task. */
export function wristRelayState(): WristCueState {
    try {
        const raw = mmkv.getString(STATE_KEY);
        if (!raw) return { gates: [], running: [] };
        const parsed = JSON.parse(raw);
        const gates = Array.isArray(parsed?.gates) ? parsed.gates.filter((v: unknown) => typeof v === 'string') : [];
        const running = Array.isArray(parsed?.running) ? parsed.running.filter((v: unknown) => typeof v === 'string') : [];
        return { gates, running };
    } catch {
        return { gates: [], running: [] };
    }
}

/**
 * Record what was just published, so the next reader diffs against it.
 *
 * Written by BOTH paths against one key on purpose: the background task has no
 * previous snapshot of its own, and giving it a second one would be a second
 * answer to "what has the wrist seen". Identical state is not rewritten — the
 * feed republishes on a 60s heartbeat and every store change, and none of
 * those move the gate set.
 */
export function rememberWristRelayState(source: WristCueSource): void {
    const next = wristCueStateOf(source);
    const current = wristRelayState();
    if (
        current.gates.length === next.gates.length
        && current.running.length === next.running.length
        && current.gates.every((id, i) => id === next.gates[i])
        && current.running.every((id, i) => id === next.running[i])
    ) return;
    writeList(STATE_KEY, next);
}

/** One reason the wrist stayed silent, kept where a screen can read it back. */
export interface WristRelayNote {
    at: number;
    text: string;
}

/**
 * Say why a cue did not reach the wrist, somewhere Clay can find it.
 *
 * Console alone is what the wake budget had before this (DROVE-86), and a
 * refusal only Console knows is indistinguishable from nothing having
 * happened — the exact complaint that filed DROVE-224. Persisted, because the
 * refusal that matters most happens in a background launch whose JS context is
 * gone by the time anyone looks.
 */
export function noteWristRelay(text: string): void {
    console.log(`[drover-wrist] ${text}`);
    const notes = wristRelayNotes();
    const next = [...notes, { at: Date.now(), text }];
    writeList(NOTES_KEY, next.slice(Math.max(0, next.length - NOTES_LIMIT)));
}

export function wristRelayNotes(): WristRelayNote[] {
    try {
        const raw = mmkv.getString(NOTES_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(
            (n): n is WristRelayNote =>
                !!n && typeof n === 'object' && typeof n.at === 'number' && typeof n.text === 'string',
        );
    } catch {
        return [];
    }
}

/** The newest refusal, for a one-line surface. Null when nothing was refused. */
export function wristRelayLine(): string | null {
    const notes = wristRelayNotes();
    return notes.length ? notes[notes.length - 1].text : null;
}

/**
 * Why a wake could not be spent, in words that name the carrier.
 *
 * The distinction is the point. With the app frontmost nothing else could have
 * carried the cue, so the wrist is definitely silent; backgrounded, the push
 * may still land, so the same skipped wake is a weaker claim and must not read
 * as a certainty.
 */
export function wristRefusal(cues: string[], carrier: WristCarrier, budget: string): string {
    const what = cues.length === 1 ? cues[0] : `${cues.length} cues`;
    const consequence = carrier === 'direct'
        ? 'the app is open, so no push can reach the wrist either'
        : 'a push may still reach the wrist';
    return `wake skipped for ${what}: ${budget}, ${consequence}`;
}

/** Drop everything. Tests, and a signed-out app that should carry nothing. */
export function resetWristRelay(): void {
    try {
        mmkv.delete(CARRIED_KEY);
        mmkv.delete(STATE_KEY);
        mmkv.delete(NOTES_KEY);
    } catch {
        // Nothing to do; a ledger that will not clear is not worth a crash.
    }
}
