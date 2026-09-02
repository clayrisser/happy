/**
 * The corner timestamp on a flat session row, formatted the way a chat list
 * does it: the clock for the last 24 hours, the weekday for the week behind
 * you, and a date once the weekday stops naming a single day. Using elapsed
 * time for the first boundary keeps a Sunday-night session from turning into
 * "Sun" a few minutes after midnight on Monday.
 *
 * The value passed in is the same `lastActivityAt` the list sorts on, so the
 * column reads top to bottom in the order the stamps say it should.
 */
export function formatSessionListTimestamp(
    timestamp: number | null | undefined,
    now: number = Date.now(),
): string | null {
    // No stamp draws nothing (DROVE-398): the row leaves its edge empty rather
    // than printing the epoch, and never grows a mark in the time's place.
    if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp <= 0) return null;
    const date = new Date(timestamp);
    const age = now - timestamp;
    const dayMs = 24 * 60 * 60 * 1000;

    // A clock skewed a little into the future is still "just now" to the
    // person reading it.
    if (age < dayMs) {
        return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    }
    if (age < 7 * dayMs) {
        return date.toLocaleDateString(undefined, { weekday: 'short' });
    }

    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const thisYear = new Date(now).getFullYear();
    if (date.getFullYear() === thisYear) {
        return `${month}/${day}`;
    }
    return `${month}/${day}/${String(date.getFullYear() % 100).padStart(2, '0')}`;
}

/**
 * The widest stamp the formatter produces for a clock reading `now`, and a
 * timestamp that produces it (DROVE-398).
 *
 * For the specs that hold the time label to its natural width: every minute
 * of the last day (the clock form), every day of the week behind it (the
 * weekday form), and one date in each of the two date forms, measured by
 * character count in the running locale. "12:25 PM" is what it comes to in
 * en-US, and that string cut to "12:25…" is the defect this exists to pin.
 */
export function widestSessionListTimestamp(now: number = Date.now()): { at: number; text: string } {
    const minuteMs = 60 * 1000;
    const dayMs = 24 * 60 * minuteMs;
    const candidates: number[] = [];
    for (let minutes = 1; minutes < 24 * 60; minutes += 1) candidates.push(now - minutes * minuteMs);
    for (let days = 1; days < 7; days += 1) candidates.push(now - days * dayMs);
    candidates.push(now - 30 * dayMs, now - 400 * dayMs);

    let widest = { at: now - minuteMs, text: formatSessionListTimestamp(now - minuteMs, now) ?? '' };
    for (const at of candidates) {
        const text = formatSessionListTimestamp(at, now);
        if (text !== null && text.length > widest.text.length) widest = { at, text };
    }
    return widest;
}
