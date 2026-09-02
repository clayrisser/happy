/**
 * Reading the phone's WatchConnectivity status honestly (DROVE-391).
 *
 * The native module hands JS a handful of booleans and one number, and the
 * number used to carry two facts at once. `wakes` is WCSession's
 * `remainingComplicationUserInfoTransfers`, and Apple pins it at 0 whenever
 * the Drover complication is on no active watch face. So "wakes === 0" was
 * read as one thing and said as two: "no wakes left today, or the Drover
 * complication is on no watch face". The phone could not tell, so Clay could
 * not either, and the fix for one is not the fix for the other.
 *
 * `complicationEnabled` (WCSession.isComplicationEnabled, build 22) is what
 * tells them apart. False means the complication is on no face and no amount
 * of waiting fixes that; true with 0 left means the day's budget is spent and
 * tomorrow fixes it. Every surface that reads the status draws them as two
 * rows, and the helpers below are the one place the words come from.
 *
 * Both keys are ABSENT until WCSession has activated: before that the native
 * side reports 0 and false, and neither is a fact yet. The module drops them
 * (getDroverWatchStatus) and the helpers say "unknown" for the gap rather
 * than picking a side. A binary older than build 22 never sends
 * `complicationEnabled` at all, and that reads as unknown too.
 *
 * Lives under sources/ rather than in the module so the pure parts have a
 * spec (vitest only walks sources/).
 */

import type { DroverWatchStatus } from 'drover-watch';

/**
 * How many background wakes WatchConnectivity grants a phone per day
 * (`remainingComplicationUserInfoTransfers` starts here each morning). Apple's
 * figure, not ours; it is the denominator of every "N of 50" line.
 */
export const droverWatchWakesPerDay = 50;

/**
 * One line for the relay's refusal notes and the feed's log, so the two agree
 * on what a spent budget looks like (DROVE-86). Absent `wakes` (a native
 * module that predates the key, or a session not yet activated) is said as
 * such rather than as 0, because 0 has a specific meaning.
 */
export function describeDroverWakeBudget(status: Pick<DroverWatchStatus, 'wakes'>): string {
    if (typeof status.wakes !== 'number') return 'wake budget unknown';
    return `wake budget ${status.wakes}/${droverWatchWakesPerDay} today`;
}

/**
 * The "complication on a face" row. Yes, no, or unknown, and when no, what to
 * do about it, because with it on no face the budget is zero all day and no
 * amount of waiting fixes that.
 */
export function describeDroverComplication(
    status: Pick<DroverWatchStatus, 'activated' | 'complicationEnabled'>,
): string {
    if (status.complicationEnabled === true) return 'Yes';
    if (status.complicationEnabled === false) return 'No; add it to a face to allow wakes';
    if (status.activated === false) return 'Unknown until the watch link activates';
    return 'Unknown on this build';
}

/** The "wakes left today" row: "37 of 50", or why the number is not known. */
export function describeDroverWakesLeft(status: Pick<DroverWatchStatus, 'activated' | 'wakes'>): string {
    if (typeof status.wakes === 'number') return `${status.wakes} of ${droverWatchWakesPerDay}`;
    if (status.activated === false) return 'Unknown until the watch link activates';
    return 'Unknown on this build';
}

/**
 * Why a deliberate wake (the Playground's second tap) cannot be spent, in one
 * line, or null when it can. The two causes that used to share a sentence
 * are told apart here; the third line is for a binary that cannot tell them
 * apart, and it says so rather than guessing.
 */
export function describeDroverWakeRefusal(
    status: Pick<DroverWatchStatus, 'wakes' | 'complicationEnabled'>,
): string | null {
    if (status.complicationEnabled === false) {
        return 'the Drover complication is on no watch face; add it to a face to allow wakes';
    }
    if (status.wakes !== 0) return null;
    if (status.complicationEnabled === true) {
        return `no wakes left today; ${droverWatchWakesPerDay} a day, back tomorrow`;
    }
    return 'no wakes left today, or the Drover complication is on no watch face; this build cannot tell';
}
