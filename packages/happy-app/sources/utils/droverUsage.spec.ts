/**
 * The usage strip on a pane session (DROVE-47).
 *
 * A pane session has no agentState.usageLimits — no SDK stream ever wrote
 * one — so everything the strip shows has to come out of metadata.droverUsage.
 * These pin the mapping: the same ids the strip already renders, the family
 * rows the cache scopes, and every other account folded in with the picker's
 * own figures.
 */
import { describe, expect, it } from 'vitest';
import {
    currentDroverUsageAccount,
    droverAccountsUsage,
    droverAccountWindows,
    droverFamilyRows,
    droverAccountStale,
    droverOtherAccounts,
    droverMootingWindow,
    droverRowApplies,
    droverRowUsable,
    droverStaleAfterMs,
    droverUsageForHarness,
    droverWindowCovers,
    droverWindowId,
    droverWindowSpan,
    droverWindowSpent,
    usageLimitsFromDroverUsage,
    type DroverUsageLike,
    type DroverUsageRowLike,
} from './droverUsage';
import { getUsageLimitRows } from './sessionStatusBar';

// What the CLI stamps for Clay's registry as measured 2026-08-30: on jamrizzi,
// main dead for the week, bitspur.com out for Fable only, spare never measured.
const sep5 = Date.parse('2026-09-05T19:00:00Z');
const sep3 = Date.parse('2026-09-03T20:00:00Z');
const usage: DroverUsageLike = {
    capturedAt: 1_000,
    accounts: [
        {
            name: 'main', current: false, loggedIn: true, fetchedAt: 900, headroom: 0,
            cooling: { until: sep3, reason: 'weekly limit at 100%' },
            limits: [
                { kind: 'session', percent: 4, resetsAt: 1_500, scope: null, family: null },
                { kind: 'weekly_all', percent: 100, resetsAt: sep3, scope: null, family: null },
                { kind: 'weekly_scoped', percent: 100, resetsAt: sep3, scope: 'Fable', family: 'fable' },
            ],
        },
        {
            name: 'jamrizzi', current: true, loggedIn: true, fetchedAt: 950, headroom: 51,
            cooling: null,
            limits: [
                { kind: 'session', percent: 49, resetsAt: 1_200, scope: null, family: null },
                { kind: 'weekly_all', percent: 23, resetsAt: sep5, scope: null, family: null },
                { kind: 'weekly_scoped', percent: 39, resetsAt: sep5, scope: 'Fable', family: 'fable' },
            ],
        },
        {
            name: 'bitspur.com', current: false, loggedIn: true, fetchedAt: 800, headroom: 0,
            cooling: { until: sep3, reason: 'Fable weekly limit at 100%', family: 'fable' },
            limits: [
                { kind: 'session', percent: 0, resetsAt: 1_100, scope: null, family: null },
                { kind: 'weekly_all', percent: 57, resetsAt: sep3, scope: null, family: null },
                { kind: 'weekly_scoped', percent: 100, resetsAt: sep3, scope: 'Fable', family: 'fable' },
            ],
        },
        { name: 'spare', current: false, loggedIn: false, fetchedAt: null, headroom: null, cooling: null, limits: [] },
    ],
};

describe('usageLimitsFromDroverUsage', () => {
    it('feeds the existing strip with the current account, under the ids it already renders', () => {
        const limits = usageLimitsFromDroverUsage(usage, null);
        expect(limits?.capturedAt).toBe(1_000);
        const rows = getUsageLimitRows(limits);
        expect(rows.find((r) => r.id === 'five_hour')).toMatchObject({ utilization: 49, resetsAt: 1_200, status: 'allowed' });
        expect(rows.find((r) => r.id === 'seven_day')).toMatchObject({ utilization: 23, resetsAt: sep5, status: 'allowed' });
        // The scoped row rides along under its family, labelled for the popup.
        expect(rows.find((r) => r.id === 'seven_day_fable')).toMatchObject({ label: 'Fable', utilization: 39, resetsAt: sep5 });
    });

    it('is nothing when there is no snapshot, so agent state stays the only source it ever was', () => {
        expect(usageLimitsFromDroverUsage(null, 'jamrizzi')).toBeNull();
        expect(usageLimitsFromDroverUsage(undefined, null)).toBeNull();
        expect(usageLimitsFromDroverUsage({ capturedAt: 1, accounts: [] }, 'jamrizzi')).toBeNull();
    });

    it('falls back to the droverAccount stamp when the snapshot marks nothing current', () => {
        const unmarked: DroverUsageLike = {
            capturedAt: 1,
            accounts: usage!.accounts.map((a) => ({ ...a, current: false })),
        };
        expect(currentDroverUsageAccount(unmarked, 'main')?.name).toBe('main');
        expect(getUsageLimitRows(usageLimitsFromDroverUsage(unmarked, 'main')).find((r) => r.id === 'seven_day'))
            .toMatchObject({ utilization: 100, status: 'rejected' });
        // The flag beats the stamp: the stamp is where the session was born.
        expect(currentDroverUsageAccount(usage, 'main')?.name).toBe('jamrizzi');
    });

    it('passes a row it cannot place through under its own kind rather than dropping it', () => {
        const odd: DroverUsageLike = {
            capturedAt: 1,
            accounts: [{ name: 'x', current: true, limits: [{ kind: 'monthly_thing', percent: 12, resetsAt: null }] }],
        };
        expect(usageLimitsFromDroverUsage(odd, null)?.windows).toEqual([{ id: 'monthly_thing', utilization: 12, resetsAt: null }]);
    });
});

describe('droverFamilyRows', () => {
    it('lists the current account\'s scoped rows with the family the cache named', () => {
        expect(droverFamilyRows(usage, null)).toEqual([
            { id: 'seven_day_fable', family: 'Fable', utilization: 39, resetsAt: sep5 },
        ]);
    });

    it('capitalises a family the cache only reduced', () => {
        const reduced: DroverUsageLike = {
            capturedAt: 1,
            accounts: [{ name: 'x', current: true, limits: [{ kind: 'weekly_scoped', percent: 70, resetsAt: null, family: 'opus' }] }],
        };
        expect(droverFamilyRows(reduced, null)).toEqual([{ id: 'seven_day_opus', family: 'Opus', utilization: 70, resetsAt: null }]);
    });

    it('is empty when nothing is scoped, which is when the popup shows a single figure', () => {
        const flat: DroverUsageLike = {
            capturedAt: 1,
            accounts: [{ name: 'x', current: true, limits: [{ kind: 'weekly_all', percent: 70, resetsAt: null }] }],
        };
        expect(droverFamilyRows(flat, null)).toEqual([]);
    });
});

describe('droverOtherAccounts', () => {
    it('folds every account the session is not on, with the picker\'s own figures', () => {
        expect(droverOtherAccounts(usage, null)).toEqual([
            // `onboarded` rides beside `loggedIn` on every row (DROVE-246):
            // a credential and a config dir that has been through Claude
            // Code's first run are two different facts, and a row is only
            // switchable when both hold. Absent from the snapshot reads as
            // true, which is what these fixtures are saying.
            //
            // `harness` rides every row too (DROVE-270), and absent reads as
            // claude for the same reason: a snapshot written before the field
            // existed came off a registry that held only Claude accounts. It is
            // on the row because `headroom: null` alone cannot tell an unread
            // Claude account from a cursor one, and those want opposite
            // treatment — the first may be flipped to and will have a figure
            // later, the second may not and never will.
            //
            // `backdoor` is the CLI's verdict, not this file's (DROVE-333): the
            // ambient row and everything on its login are the account nothing
            // automatic lands on or moves off. Absent reads FALSE, the opposite
            // default from `onboarded` above and the right one — an older CLI
            // did not fail to mention a back door, it did not have one, and a
            // missing field must never label somebody's ordinary account.
            { name: 'main', harness: 'claude', tokenState: null, expiresInDays: null, loggedIn: true, onboarded: true, backdoor: false, headroom: 0, back: sep3, family: null },
            { name: 'bitspur.com', harness: 'claude', tokenState: null, expiresInDays: null, loggedIn: true, onboarded: true, backdoor: false, headroom: 0, back: sep3, family: 'Fable' },
            { name: 'spare', harness: 'claude', tokenState: null, expiresInDays: null, loggedIn: false, onboarded: true, backdoor: false, headroom: null, back: null, family: null },
        ]);
    });

    it('keeps registry order, the order drover accounts prints', () => {
        expect(droverOtherAccounts(usage, null).map((a) => a.name)).toEqual(['main', 'bitspur.com', 'spare']);
    });

    it('is empty without a snapshot', () => {
        expect(droverOtherAccounts(null, 'jamrizzi')).toEqual([]);
        expect(droverOtherAccounts({ capturedAt: 1, accounts: [] }, null)).toEqual([]);
    });
});

describe('the back door on the wire (DROVE-333)', () => {
    // The composer quota sheet is where the `Switch ›` button lives, and its
    // payload is this snapshot — which carries neither `ambient` nor `login`,
    // so it could not work out which row the machine leaves alone. The CLI
    // stamps `backdoor` and this reads it; nothing here re-derives the rule.
    const withBackdoor: DroverUsageLike = {
        capturedAt: 1_000,
        accounts: [
            { name: 'main', current: false, loggedIn: true, backdoor: true, headroom: 43, cooling: null, limits: [] },
            { name: 'jamrizzi', current: false, loggedIn: true, backdoor: true, headroom: 43, cooling: null, limits: [] },
            { name: 'alt', current: true, loggedIn: true, headroom: 12, cooling: null, limits: [] },
        ],
    };

    it('carries the flag through to the row, twins included', () => {
        const rows = droverOtherAccounts(withBackdoor, null);
        expect(rows.map((r) => [r.name, r.backdoor])).toEqual([['main', true], ['jamrizzi', true]]);
    });

    it('reads a missing flag as NOT the back door', () => {
        // An older machine never asked the question. Labelling on a gap would
        // put "manual flips only" on somebody's ordinary account, which is a
        // worse error than saying nothing.
        expect(droverAccountsUsage(withBackdoor, null).find((r) => r.name === 'alt')?.backdoor).toBe(false);
        expect(droverOtherAccounts(usage, null).every((r) => r.backdoor === false)).toBe(true);
    });
});

/**
 * One spelling of a window's id (DROVE-131). The wrist's binding-limit row
 * calls droverWindowId; the strip's bars go through droverAccountWindows. If
 * the two ever name one window two ways it looks like two limits.
 */
describe('droverAccountWindows', () => {
    it('names every kind of window with droverWindowId, scoped or not, known or not', () => {
        const limits: DroverUsageRowLike[] = [
            { kind: 'session', percent: 4, resetsAt: 1_500, scope: null, family: null },
            { kind: 'weekly_all', percent: 23, resetsAt: sep5, scope: null, family: null },
            { kind: 'weekly_scoped', percent: 39, resetsAt: sep5, scope: 'Fable', family: 'fable' },
            { kind: 'session', percent: 10, resetsAt: 1_500, scope: 'Opus 5', family: null },
            { kind: 'weekly_scoped', percent: 12, resetsAt: sep5, scope: null, family: 'sonnet' },
            { kind: 'monthly_all', percent: 1, resetsAt: null, scope: null, family: null },
        ];
        const windows = droverAccountWindows({ name: 'jamrizzi', limits });
        expect(windows.map((w) => w.id)).toEqual(limits.map(droverWindowId));
        expect(windows.map((w) => w.id)).toEqual([
            'five_hour', 'seven_day', 'seven_day_fable', 'five_hour_opus_5', 'seven_day_sonnet', 'monthly_all',
        ]);
        expect(windows.map((w) => w.family)).toEqual([null, null, 'Fable', 'Opus 5', 'Sonnet', null]);
    });
});

describe('droverAccountsUsage', () => {
    it('carries every account\'s own windows, not just the current one\'s (DROVE-148)', () => {
        const accounts = droverAccountsUsage(usage, null);
        // Current first, then registry order, so the sheet compares against
        // the account the session is on.
        expect(accounts.map((a) => [a.name, a.current]))
            .toEqual([['jamrizzi', true], ['main', false], ['bitspur.com', false], ['spare', false]]);
        // main's windows, the ones the quota sheet had no way to reach before.
        expect(accounts[1].windows).toEqual([
            { id: 'five_hour', family: null, utilization: 4, resetsAt: 1_500, usable: true },
            { id: 'seven_day', family: null, utilization: 100, resetsAt: sep3, usable: true },
            { id: 'seven_day_fable', family: 'Fable', utilization: 100, resetsAt: sep3, usable: true },
        ]);
        // An account with nothing measured is a row with no windows, not a
        // missing row.
        expect(accounts[3]).toMatchObject({ name: 'spare', loggedIn: false, headroom: null, windows: [] });
    });

    it('is empty without a snapshot, and marks nothing current when the stamp names no one', () => {
        expect(droverAccountsUsage(null, 'jamrizzi')).toEqual([]);
        const unmarked: DroverUsageLike = { capturedAt: 1_000, accounts: usage!.accounts.map((a) => ({ ...a, current: false })) };
        expect(droverAccountsUsage(unmarked, null).some((a) => a.current)).toBe(false);
        // The older stamp still names it when the snapshot marked nothing.
        expect(droverAccountsUsage(unmarked, 'bitspur.com')[0]).toMatchObject({ name: 'bitspur.com', current: true });
    });
});

/**
 * Which windows bind THIS session (DROVE-173).
 *
 * The app's copy of the CLI's `rowApplies`. Clay read "bitspur.com · 0% left"
 * on an account whose session was 1% used, because Fable's week was exhausted
 * and he was on Opus; at 3:25am the same arithmetic told the flip logic every
 * other account was out and it stayed put. These pin the rule on the app's
 * side of the wire so the sheet and the wrist cannot disagree with the number
 * the CLI computed (DROVE-129).
 */
describe('droverRowApplies', () => {
    const unscoped = { scope: null, family: null };
    const fable = { scope: 'Fable', family: 'fable' };
    const unreadable = { scope: 'surface:web', family: null };

    it('lets an unscoped window bind every model', () => {
        expect(droverRowApplies(unscoped, 'opus')).toBe(true);
        expect(droverRowApplies(unscoped, null)).toBe(true);
    });

    it('lets a family window bind only a session in that family', () => {
        expect(droverRowApplies(fable, 'fable')).toBe(true);
        expect(droverRowApplies(fable, 'opus')).toBe(false);
    });

    it('binds on everything when the model is unknown, as it did before families', () => {
        expect(droverRowApplies(fable, null)).toBe(true);
        expect(droverRowApplies(fable, undefined)).toBe(true);
        expect(droverRowApplies(fable, '')).toBe(true);
    });

    it('binds on a scope it cannot read, so a dead account never looks alive', () => {
        expect(droverRowApplies(unreadable, 'opus')).toBe(true);
    });
});

/**
 * A reading old enough to say so (DROVE-173).
 *
 * Measured against the snapshot's own capturedAt rather than the wall clock,
 * so it is the same answer on every device and testable without freezing time.
 */
describe('droverAccountStale', () => {
    const captured = 10_000_000;

    it('is not stale when the cache was read just now and nothing has reset', () => {
        expect(droverAccountStale({
            fetchedAt: captured - 1_000,
            limits: [{ kind: 'session', percent: 1, resetsAt: captured + 60_000, scope: null, family: null }],
        }, captured)).toBe(false);
    });

    // The five-hour session window: a cache one window old prints LAST
    // window's reset as if it were the next one, which is what read as a
    // wrong clock next to /usage.
    it('is stale when a window had already reset before the snapshot', () => {
        expect(droverAccountStale({
            fetchedAt: captured - 1_000,
            limits: [{ kind: 'session', percent: 1, resetsAt: captured - 1, scope: null, family: null }],
        }, captured)).toBe(true);
    });

    it('is stale when nobody has refreshed the cache in an hour', () => {
        expect(droverAccountStale({ fetchedAt: captured - droverStaleAfterMs, limits: [] }, captured)).toBe(true);
        expect(droverAccountStale({ fetchedAt: captured - droverStaleAfterMs + 1, limits: [] }, captured)).toBe(false);
    });

    it('says nothing about an account that was never fetched at all', () => {
        // "not measured" is already on the row; "stale" on top would be two
        // words for one absence.
        expect(droverAccountStale({ fetchedAt: null, limits: [] }, captured)).toBe(false);
        expect(droverAccountStale(null, captured)).toBe(false);
        expect(droverAccountStale({ fetchedAt: 1, limits: [] }, Number.NaN)).toBe(false);
    });
});

/**
 * A reading older than the window it describes is UNKNOWN (DROVE-204).
 *
 * Clay's screenshot: four of five accounts marked `stale`, several reading 99%
 * session left, on accounts he knew were exhausted. The 99% was a real row —
 * a `session` window at 1% whose five hours had ended before the snapshot was
 * taken. The label was right and not enough; a bar and a percentage beside the
 * word `stale` still reads as data.
 */
describe('droverRowUsable', () => {
    const captured = 10_000;

    it('takes the CLI at its word when the wire carries one', () => {
        // The CLI had the real clock when it read the cache; the phone has
        // only capturedAt. So the field wins wherever it exists.
        expect(droverRowUsable({ resetsAt: captured + 1, usable: false }, captured)).toBe(false);
        expect(droverRowUsable({ resetsAt: captured - 1, usable: true }, captured)).toBe(true);
    });

    it('falls back to the row\'s own reset for a snapshot from an older CLI', () => {
        expect(droverRowUsable({ resetsAt: captured - 1 }, captured)).toBe(false);
        expect(droverRowUsable({ resetsAt: captured + 1 }, captured)).toBe(true);
        // No reset says nothing either way, and a snapshot with no clock in it
        // must not turn every row into a hole.
        expect(droverRowUsable({ resetsAt: null }, captured)).toBe(true);
        expect(droverRowUsable({ resetsAt: 1 }, Number.NaN)).toBe(true);
    });
});

describe('an account carrying an expired window', () => {
    const captured = 10_000;
    const expired: DroverUsageLike = {
        capturedAt: captured,
        modelFamily: null,
        accounts: [{
            name: 'risserproperties',
            current: true,
            loggedIn: true,
            fetchedAt: captured - 41 * 60 * 60_000,
            headroom: null,
            cooling: null,
            limits: [
                // The measured shape: a session window that reset hours ago,
                // and a week that has not.
                { kind: 'session', percent: 1, resetsAt: captured - 1, scope: null, family: null, usable: false },
                { kind: 'weekly_all', percent: 58, resetsAt: captured + 1, scope: null, family: null, usable: true },
            ],
        }],
    };

    it('is marked expired, on top of stale', () => {
        const [row] = droverAccountsUsage(expired);
        expect(row.expired).toBe(true);
        expect(row.stale).toBe(true);
    });

    it('keeps the window as a row and marks it unusable, rather than dropping it', () => {
        // A limit missing from the one screen Clay is looking at is the older
        // bug. The row stays; it loses its figures.
        const [row] = droverAccountsUsage(expired);
        expect(row.windows.map((w) => [w.id, w.usable])).toEqual([
            ['five_hour', false],
            ['seven_day', true],
        ]);
    });

    it('withholds the expired window from the composer strip entirely', () => {
        // The strip has room for one figure and no room to explain itself, so
        // an expired window is not passed on with its number.
        const limits = usageLimitsFromDroverUsage(expired);
        expect(getUsageLimitRows(limits).map((r) => r.id)).toEqual(['seven_day']);
    });
});

/**
 * WHICH WINDOW SITS OVER WHICH (DROVE-255).
 *
 * The relation the sheet's mooting rule is built on, pinned on its own because
 * getting it wrong in the generous direction greys out headroom that is really
 * there — a worse bug than the one it fixes. Two halves, and the second is the
 * one "the longer window wins" would miss.
 */
describe('droverWindowSpan and droverWindowCovers', () => {
    const session = { period: 'session' as const, family: null };
    const week = { period: 'week' as const, family: null };
    const fableWeek = { period: 'week' as const, family: 'fable' };
    const fableSession = { period: 'session' as const, family: 'fable' };

    it('reads the period and the family straight off the window id', () => {
        // The one spelling both feeds share: the CLI's snapshot goes through
        // droverWindowId, and the SDK stream already speaks these two.
        expect(droverWindowSpan('five_hour')).toEqual(session);
        expect(droverWindowSpan('seven_day')).toEqual(week);
        expect(droverWindowSpan('seven_day_fable')).toEqual(fableWeek);
        expect(droverWindowSpan('five_hour_fable')).toEqual(fableSession);
        // A provider-internal kind, which `headroom` counts and the sheet does
        // not draw. No period, so it covers nothing and nothing covers it.
        expect(droverWindowSpan('nimbus_quill')).toEqual({ period: null, family: null });
    });

    it('lets a week contain a session and never the other way round', () => {
        expect(droverWindowCovers(week, session)).toBe(true);
        expect(droverWindowCovers(session, week)).toBe(false);
        // A window does not contain itself: a spent window is drawn honestly
        // by its own full bar, and hollowing it would say less, not more.
        expect(droverWindowCovers(week, week)).toBe(false);
        expect(droverWindowCovers(session, session)).toBe(false);
    });

    it('keeps a model-scoped week off a window it does not measure', () => {
        // The half that matters. The Fable week is seven days and the session
        // is five hours, and an Opus turn spends that session in full — the
        // sheet's own caption says "Fable week not counted for Opus".
        expect(droverWindowCovers(fableWeek, session)).toBe(false);
        expect(droverWindowCovers(fableWeek, week)).toBe(false);
        // It does cover a window scoped to the same family, which is what
        // makes this a scope rule rather than a blanket exemption.
        expect(droverWindowCovers(fableWeek, fableSession)).toBe(true);
        // And an unscoped week measures every model, so it covers both.
        expect(droverWindowCovers(week, fableSession)).toBe(true);
    });

    it('says nothing about a kind it cannot place', () => {
        const unknown = droverWindowSpan('nimbus_quill');
        expect(droverWindowCovers(week, unknown)).toBe(false);
        expect(droverWindowCovers(unknown, session)).toBe(false);
    });
});

describe('droverWindowSpent and droverMootingWindow', () => {
    const window = (id: string, utilization: number | null, usable = true) => ({ id, utilization, usable });

    it('reads spent the way the account heading rounds it', () => {
        // The heading prints Math.round(headroom), so `0% left on Week` and
        // "the week is spent" have to be one decision or the sheet argues
        // with itself again.
        expect(droverWindowSpent(window('seven_day', 100))).toBe(true);
        expect(droverWindowSpent(window('seven_day', 99.6))).toBe(true);
        expect(droverWindowSpent(window('seven_day', 99))).toBe(false);
        expect(droverWindowSpent(window('seven_day', null))).toBe(false);
    });

    it('will not call an EXPIRED reading spent', () => {
        // Unknown, not empty (DROVE-204): nobody knows what is in that window
        // now, and an unknown window must not moot anything.
        expect(droverWindowSpent(window('seven_day', 100, false))).toBe(false);
        const windows = [window('five_hour', 0), window('seven_day', 100, false)];
        expect(droverMootingWindow(windows[0], windows)).toBeNull();
    });

    it('names the spent week over a fresh session', () => {
        const windows = [window('five_hour', 0), window('seven_day', 100)];
        expect(droverMootingWindow(windows[0], windows)?.id).toBe('seven_day');
        expect(droverMootingWindow(windows[1], windows)).toBeNull();
    });

    it('leaves alone a window with nothing to advertise', () => {
        // No reading, so no capacity is being claimed and DROVE-204's own
        // reason keeps the trailing slot.
        const unmeasured = [window('five_hour', null), window('seven_day', 100)];
        expect(droverMootingWindow(unmeasured[0], unmeasured)).toBeNull();
        // Spent itself, so its full red bar is already the honest picture —
        // and it is the row the heading may be quoting.
        const both = [window('five_hour', 100), window('seven_day', 100)];
        expect(droverMootingWindow(both[0], both)).toBeNull();
    });

    it('does not let a spent Fable week moot the account-wide session', () => {
        const windows = [window('five_hour', 20), window('seven_day', 40), window('seven_day_fable', 100)];
        expect(droverMootingWindow(windows[0], windows)).toBeNull();
        expect(droverMootingWindow(windows[1], windows)).toBeNull();
    });
});

describe('droverUsageForHarness (DROVE-352)', () => {
    const usage: DroverUsageLike = {
        capturedAt: 1_000,
        accounts: [
            { name: 'a', harness: 'claude', current: true, loggedIn: true, fetchedAt: 900, headroom: 10, cooling: null, limits: [] },
            { name: 'b', current: false, loggedIn: true, fetchedAt: 900, headroom: 20, cooling: null, limits: [] },
            { name: 'c', harness: 'cursor', current: false, loggedIn: true, fetchedAt: null, headroom: null, cooling: null, limits: [] },
        ],
    };

    it('keeps the accounts of that harness, absent reading as claude', () => {
        expect(droverUsageForHarness(usage, 'claude')!.accounts.map((a) => a.name)).toEqual(['a', 'b']);
        // `a` survives the cursor pass ONLY because it is the current account.
        expect(droverUsageForHarness(usage, 'cursor')!.accounts.map((a) => a.name)).toEqual(['a', 'c']);
    });

    it('never drops the account the session is on, marked or stamped', () => {
        const unmarked: DroverUsageLike = {
            capturedAt: 1_000,
            accounts: usage!.accounts.map((a) => ({ ...a, current: false })),
        };
        // The `current` flag gone, the older `droverAccount` stamp answers.
        expect(droverUsageForHarness(unmarked, 'cursor', 'a')!.accounts.map((a) => a.name))
            .toEqual(['a', 'c']);
        expect(droverUsageForHarness(unmarked, 'cursor')!.accounts.map((a) => a.name))
            .toEqual(['c']);
    });

    it('returns the same object when nothing goes, so a memo does not churn', () => {
        const claudeOnly: DroverUsageLike = { capturedAt: 1_000, accounts: [usage!.accounts[0]] };
        expect(droverUsageForHarness(claudeOnly, 'claude')).toBe(claudeOnly);
        expect(droverUsageForHarness(null, 'claude')).toBeNull();
        expect(droverUsageForHarness(undefined, 'claude')).toBeUndefined();
    });
});
