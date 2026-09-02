/**
 * What a background wake of the watch is spent on, and the record of every
 * one (DROVE-391).
 *
 * WHAT CLAY SAW. The watch Playground said "no wakes left today, or the
 * Drover complication is on no watch face" and nothing on the wrist worked.
 * The budget behind that line is WatchConnectivity's ~50 launches a day, and
 * two things had been spending it on nothing:
 *
 *   - the feed raised a `finished:<id>` cue for every session that left
 *     `running`, and each store change that flipped one was one wake. 300
 *     dead sessions going quiet overnight is up to 300 launches nobody felt,
 *     and the day's 50 were gone before the first real question;
 *   - the background task the silent push launches woke for any unclaimed
 *     cue, with no reachability check and no budget check.
 *
 * THE RULE, in one place, for both paths. A wake is spent only when
 *
 *   1. some claimed cue is a GATE needing an answer. A session stopping is
 *      still a cue for a reachable watch, which diffs it off the publish; it
 *      never launches a sleeping one;
 *   2. the watch app is NOT reachable. Reachable means frontmost, and
 *      publish's own sendMessage has already reached it;
 *   3. the gate is announced on haptic and this phone's switch is on
 *      (droverChannels.wakeDeserved, DROVE-72). With haptic off the watch
 *      would not buzz on arrival either, so the launch buys nothing;
 *   4. the session has activated, the Drover complication is on a face, and
 *      the budget is not 0. Each of those is said as itself, because the fix
 *      for one is not the fix for another;
 *   5. no wake went out inside the current unreachable STRETCH. A stretch
 *      opens with a wake and closes when the watch is next seen reachable or
 *      after `wakeStretchMs`; a second gate inside it rides the application
 *      context, which the watch reads when the first wake's launch (or Clay)
 *      opens it. The watch's own 150s freshness window means a late launch
 *      for an old gate would not buzz anyway, so nothing is lost.
 *
 * Never for a snapshot refresh: the heartbeat and the wrist's own refresh ask
 * raise no cue, so they never reach this file.
 *
 * THE LEDGER. Every spend and refusal is written to disk with a reason and a
 * time, per local day, because the wake that matters most is spent in a
 * background launch whose JS context is gone before anyone looks. Watch
 * settings reads it back as "N of 50 used today" with the last reason. Local
 * day, because that is the day Clay reads it in; Apple's own reset is per
 * day too and the exact boundary is not documented, so the two may disagree
 * by a night.
 *
 * The demo (droverDemoBuzz) spends on purpose, on a tap, and does not open a
 * stretch: a Playground test must not silence the next real gate.
 */

import { MMKV } from 'react-native-mmkv';

import { droverWatchWakesPerDay } from '@/utils/droverWatchStatus';
import { gateCueIds } from './droverWristRelay';

const mmkv = new MMKV();
const LEDGER_KEY = 'drover-wake-ledger-v1';

/**
 * One wake per unreachable stretch. Five minutes coalesces a burst from
 * parallel agents into one launch, and at one wake per five minutes the
 * day's 50 cover more than four hours of unbroken gates, which no real day
 * produces once session stops no longer count.
 */
export const wakeStretchMs = 5 * 60_000;

/** Why a wake went out. */
export type WakeSpentReason = 'gate' | 'demo';

/** Why a wake that a gate asked for did not go out. */
export type WakeRefusedReason = 'link' | 'haptic-off' | 'no-face' | 'budget' | 'stretch' | 'downgraded';

export interface WakeLedgerEntry {
    at: number;
    reason: WakeSpentReason | WakeRefusedReason;
}

export interface WakeLedger {
    /** Local calendar day, `YYYY-MM-DD`. A ledger from another day is empty. */
    day: string;
    /** Wakes this phone spent today. */
    used: number;
    /** Wakes a gate asked for and did not get. */
    refused: number;
    lastSpent?: WakeLedgerEntry;
    lastRefused?: WakeLedgerEntry;
    /** When the open stretch's wake went out. Absent when no stretch is open. */
    stretchAt?: number;
}

/** The status fields a wake decision reads; the rest of the struct is not its business. */
export interface WristWakeStatus {
    activated?: boolean;
    reachable: boolean;
    wakes?: number;
    complicationEnabled?: boolean;
}

export interface WristWakeAsk {
    status: WristWakeStatus;
    /** The cue ids this path claimed, in the watch's own names. */
    cues: string[];
    /** Whether a claimed gate is announced on haptic with this phone's switch on. */
    deserving: boolean;
    now?: number;
}

/**
 * The verdict, and what the caller does with the claim.
 *
 * `carried: true` means the cue counts as delivered without a wake and the
 * shared record advances: the watch app was open, or the cue was a stop, or
 * the arrival rides the application context inside a stretch. `carried:
 * false` means nobody felt it and the claim must be given back, so a later
 * path can try again once the cause is gone.
 */
export type WristWakeVerdict =
    | { spend: true }
    | { spend: false; carried: true; why: 'none' | 'session-stop' | 'reachable'; line: string }
    | { spend: false; carried: boolean; why: WakeRefusedReason; line: string };

function dayOf(now: number): string {
    const d = new Date(now);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${mm}-${dd}`;
}

function empty(now: number): WakeLedger {
    return { day: dayOf(now), used: 0, refused: 0 };
}

function entryOf(value: unknown): WakeLedgerEntry | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const at = (value as { at?: unknown }).at;
    const reason = (value as { reason?: unknown }).reason;
    if (typeof at !== 'number' || typeof reason !== 'string') return undefined;
    return { at, reason: reason as WakeLedgerEntry['reason'] };
}

/** Today's ledger. Yesterday's, or anything unreadable, is a fresh one. */
export function wakeLedger(now: number = Date.now()): WakeLedger {
    try {
        const raw = mmkv.getString(LEDGER_KEY);
        if (!raw) return empty(now);
        const parsed = JSON.parse(raw) as Partial<WakeLedger> | null;
        if (!parsed || parsed.day !== dayOf(now)) return empty(now);
        return {
            day: parsed.day,
            used: typeof parsed.used === 'number' ? parsed.used : 0,
            refused: typeof parsed.refused === 'number' ? parsed.refused : 0,
            ...(entryOf(parsed.lastSpent) ? { lastSpent: entryOf(parsed.lastSpent) } : {}),
            ...(entryOf(parsed.lastRefused) ? { lastRefused: entryOf(parsed.lastRefused) } : {}),
            ...(typeof parsed.stretchAt === 'number' ? { stretchAt: parsed.stretchAt } : {}),
        };
    } catch {
        return empty(now);
    }
}

function write(ledger: WakeLedger): void {
    try {
        mmkv.set(LEDGER_KEY, JSON.stringify(ledger));
    } catch {
        // A ledger that cannot be written is a count that is short by one,
        // never a crash on the way to a gate.
    }
}

/** Whether a wake went out inside the current stretch. */
export function wakeStretchOpen(now: number = Date.now()): boolean {
    const { stretchAt } = wakeLedger(now);
    return typeof stretchAt === 'number' && now - stretchAt < wakeStretchMs;
}

/**
 * The watch was seen reachable, so whatever stretch was open is over: the
 * wrist has been raised and read the wall, and the next gate that lands
 * after it goes away is news again.
 */
export function endWakeStretch(now: number = Date.now()): void {
    const ledger = wakeLedger(now);
    if (typeof ledger.stretchAt !== 'number') return;
    const { stretchAt: _stretchAt, ...rest } = ledger;
    write(rest);
}

/**
 * A wake went out as a background launch.
 *
 * `stretch` is false for the demo, which spends on a tap and must not
 * silence the next real gate behind it.
 */
export function noteWakeSpent(reason: WakeSpentReason, now: number = Date.now(), stretch = reason === 'gate'): void {
    const ledger = wakeLedger(now);
    write({
        ...ledger,
        used: ledger.used + 1,
        lastSpent: { at: now, reason },
        ...(stretch ? { stretchAt: now } : {}),
    });
}

/** A gate asked for a wake and did not get one, for the reason given. */
export function noteWakeRefused(reason: WakeRefusedReason, now: number = Date.now()): void {
    const ledger = wakeLedger(now);
    // A launch the native side downgraded closes the stretch the attempt
    // opened: no wake went out, so nothing is being coalesced into.
    const { stretchAt, ...rest } = ledger;
    write({
        ...rest,
        ...(reason === 'downgraded' || typeof stretchAt !== 'number' ? {} : { stretchAt }),
        refused: ledger.refused + 1,
        lastRefused: { at: now, reason },
    });
}

function minutesAgo(since: number, now: number): string {
    const minutes = Math.max(0, Math.round((now - since) / 60_000));
    return minutes === 1 ? '1 min ago' : `${minutes} min ago`;
}

/**
 * Whether to spend a wake for these cues, by the rule at the top of the file.
 *
 * A `spend` verdict OPENS the stretch on the spot, before the native call
 * returns, because two store changes can land inside one tick and the
 * second must see the first's attempt. The caller then settles it:
 * `noteWakeSpent` when the launch was real, `noteWakeRefused('downgraded')`
 * when the native side turned it into a plain transfer. A refusal for a
 * ledger reason is written here, so both carriers keep one record.
 */
export function decideWristWake(ask: WristWakeAsk): WristWakeVerdict {
    const now = ask.now ?? Date.now();
    const { status } = ask;
    if (ask.cues.length === 0) return { spend: false, carried: true, why: 'none', line: 'nothing to carry' };
    if (gateCueIds(ask.cues).length === 0) {
        return { spend: false, carried: true, why: 'session-stop', line: 'a session stopping is not woken for' };
    }
    if (status.reachable) {
        // Seen reachable, so whatever stretch was open is over: the wrist
        // has read the wall. Builds before 22 never send the reachability
        // event, and this is how they close a stretch early all the same.
        endWakeStretch(now);
        return { spend: false, carried: true, why: 'reachable', line: 'the watch app is open' };
    }
    if (!ask.deserving) {
        noteWakeRefused('haptic-off', now);
        return { spend: false, carried: true, why: 'haptic-off', line: 'haptic is off, so a launch would not buzz' };
    }
    if (status.activated === false) {
        noteWakeRefused('link', now);
        return { spend: false, carried: false, why: 'link', line: 'the watch link has not activated yet' };
    }
    if (status.complicationEnabled === false) {
        noteWakeRefused('no-face', now);
        return { spend: false, carried: false, why: 'no-face', line: 'the Drover complication is on no watch face' };
    }
    if (status.wakes === 0) {
        noteWakeRefused('budget', now);
        return { spend: false, carried: false, why: 'budget', line: `wake budget 0/${droverWatchWakesPerDay} today` };
    }
    const { stretchAt } = wakeLedger(now);
    if (typeof stretchAt === 'number' && now - stretchAt < wakeStretchMs) {
        noteWakeRefused('stretch', now);
        return {
            spend: false,
            carried: true,
            why: 'stretch',
            line: `one wake already spent ${minutesAgo(stretchAt, now)} this stretch`,
        };
    }
    write({ ...wakeLedger(now), stretchAt: now });
    return { spend: true };
}

const reasonWords: Record<WakeSpentReason | WakeRefusedReason, string> = {
    gate: 'a gate',
    demo: 'the Playground',
    link: 'link not active',
    'haptic-off': 'haptic off',
    'no-face': 'complication on no face',
    budget: 'budget spent',
    stretch: 'folded into the last wake',
    downgraded: 'not spent as a launch',
};

function clockTime(at: number): string {
    return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * The ledger as the "Wakes used today" row prints it: one short fragment a
 * line, the row's title carrying the rest (DROVE-346).
 *
 *   3 of 50
 *   last: a gate, 09:41
 *   refused: complication on no face, 09:50
 */
export function wakeLedgerLines(ledger: WakeLedger, clock: (at: number) => string = clockTime): string[] {
    const lines = [`${ledger.used} of ${droverWatchWakesPerDay}`];
    if (ledger.lastSpent) lines.push(`last: ${reasonWords[ledger.lastSpent.reason]}, ${clock(ledger.lastSpent.at)}`);
    if (ledger.lastRefused) {
        lines.push(`refused: ${reasonWords[ledger.lastRefused.reason]}, ${clock(ledger.lastRefused.at)}`);
    }
    return lines;
}

/** Drop the record. Tests, and a signed-out app. */
export function resetWakeLedger(): void {
    try {
        mmkv.delete(LEDGER_KEY);
    } catch {
        // Nothing to do; a ledger that will not clear is not worth a crash.
    }
}
