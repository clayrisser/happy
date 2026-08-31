/**
 * The usage strip on a pane session, decided (DROVE-47).
 *
 * A pane session has no agentState.usageLimits, so what the strip shows
 * comes out of metadata.droverUsage alone. These pin the choice between the
 * two feeds, the gate on the week figure, and every row of the popup down to
 * its bar, the part the mapping tests in utils/droverUsage.spec.ts stop short
 * of. The bar rows are DROVE-107: one line per measure, filled to the headroom
 * left, coloured by that and not by which account it is.
 *
 * DROVE-148 gave EVERY account the same measures. Before it, the current
 * account had Session, Week and Fable week and every other account had a
 * single bar for its fullest limit, which cannot answer where to flip to: main
 * below is 4% into its session and 100% through its week, and the one figure
 * said only "0% left". So these now pin one block shape for all of them, the
 * dash a missing measure renders, and the five-account case.
 */
import { describe, expect, it, vi } from 'vitest';
import { formatUsageLimitResetTime, type UsageLimitsLike } from '@/utils/sessionStatusBar';
import type { DroverUsageLike } from '@/utils/droverUsage';

// The real English strings, without expo-localization behind them.
vi.mock('@/text', async () => {
    const { en } = await import('@/text/_default');
    return {
        t: (key: string, params?: Record<string, unknown>) => {
            const value = key.split('.').reduce<any>((node, part) => node?.[part], en);
            if (typeof value === 'function') return value(params);
            if (typeof value === 'string') return value;
            throw new Error(`no translation for ${key}`);
        },
    };
});

import {
    droverBindingLimit,
    holdUsageGroupOrder,
    resolveUsageStrip,
    truncateUsageName,
    usageBarFraction,
    usageBarFooterText,
    usageBarNameLimit,
    usageBarTone,
    usageBarTrailingFits,
    usageFill,
    usageSkippedFamilyWindows,
    usageSnapshotAgeText,
    type UsageBarGroup,
} from './agentInputUsage';

// What the CLI stamps for Clay's registry as measured 2026-08-30: on jamrizzi,
// main dead for the week, bitspur.com out for Fable only, spare never logged in.
const sessionReset = Date.parse('2026-08-30T20:20:00Z');
const sep5 = Date.parse('2026-09-05T19:00:00Z');
const sep3 = Date.parse('2026-09-03T20:00:00Z');
const sep4 = Date.parse('2026-09-04T05:00:00Z');
const paneUsage: DroverUsageLike = {
    capturedAt: 1_000,
    accounts: [
        {
            name: 'main', current: false, loggedIn: true, fetchedAt: 900, headroom: 0,
            cooling: { until: sep3, reason: 'weekly limit at 100%' },
            limits: [
                { kind: 'session', percent: 4, resetsAt: 1_500, scope: null, family: null },
                { kind: 'weekly_all', percent: 100, resetsAt: sep3, scope: null, family: null },
            ],
        },
        {
            name: 'jamrizzi', current: true, loggedIn: true, fetchedAt: 950, headroom: 51,
            cooling: null,
            limits: [
                { kind: 'session', percent: 49, resetsAt: sessionReset, scope: null, family: null },
                { kind: 'weekly_all', percent: 23, resetsAt: sep5, scope: null, family: null },
                { kind: 'weekly_scoped', percent: 39, resetsAt: sep5, scope: 'Fable', family: 'fable' },
            ],
        },
        {
            name: 'bitspur.com', current: false, loggedIn: true, fetchedAt: 800, headroom: 0,
            cooling: { until: sep4, reason: "You've reached your Fable 5 limit.", family: 'fable' },
            limits: [
                { kind: 'weekly_all', percent: 60, resetsAt: sep3, scope: null, family: null },
                { kind: 'weekly_scoped', percent: 100, resetsAt: sep4, scope: 'Fable', family: 'fable' },
            ],
        },
        { name: 'spare', current: false, loggedIn: false, fetchedAt: null, headroom: null, cooling: null, limits: [] },
    ],
};

/** A remote session's feed: the SDK stream, which a pane never has. */
const sdkLimits: UsageLimitsLike = {
    capturedAt: 2_000,
    windows: [
        { id: 'five_hour', utilization: 10, resetsAt: sessionReset },
        { id: 'seven_day', utilization: 60, resetsAt: sep5 },
    ],
};

const pane = { usageLimits: null, droverUsage: paneUsage, droverAccount: 'jamrizzi' };

describe('resolveUsageStrip on a pane session', () => {
    it('shows the week figure from the snapshot with no SDK stream and no context gauge', () => {
        const strip = resolveUsageStrip(pane);
        expect(strip.usageFromDrover).toBe(true);
        // weekly_all at 23% used: the number `drover accounts` has for the week.
        expect(strip.weekPercent).toBe(23);
    });

    it('has no setting that could flip the figure the other way', () => {
        // DROVE-230. `showRemaining` used to reverse this and the bars with
        // it. A preference that reverses a mark is a preference that makes the
        // mark unreadable, and the input no longer carries one.
        expect(resolveUsageStrip({ ...pane, ...({ showRemaining: true } as object) }).weekPercent).toBe(23);
    });

    it('heads the current account\'s block with the picker\'s own number and lists session, week and the Fable row', () => {
        const [mine] = resolveUsageStrip(pane).usageBarGroups;
        expect(mine.key).toBe('account:jamrizzi');
        // The block the session is on comes first and says so, which is the
        // only thing that tells it apart now the row shape is shared.
        expect(mine.active).toBe(true);
        // The heading counts DOWN and says the word, and names the window it
        // came off (DROVE-230). Session at 49% used is the fullest of
        // jamrizzi's three, so 51% left is about Session.
        expect(mine.title).toBe('jamrizzi \u00b7 51% left on Session');
        expect(mine.rows.map((r) => [r.name, r.percentText, r.trailing])).toEqual([
            ['Session', '49%', `Resets ${formatUsageLimitResetTime(sessionReset)}`],
            ['Week', '23%', `Resets ${formatUsageLimitResetTime(sep5)}`],
            ['Fable week', '39%', `Resets ${formatUsageLimitResetTime(sep5)}`],
        ]);
        // Exactly one row is marked as the one the heading quoted, so the
        // heading and the bars stop reading as a contradiction (DROVE-230).
        expect(mine.rows.filter((r) => r.binding).map((r) => r.name)).toEqual(['Session']);
        // One line each: nothing in a row may carry the newline that used to
        // stack the reset time under the name.
        expect(mine.rows.every((r) => !`${r.name}${r.percentText}${r.trailing}`.includes('\n'))).toBe(true);
    });

    // DROVE-230. Clay, who owns this app and specified these bars, read a
    // verified-correct sheet and asked "Oh so 0% means nothing left?". They
    // EMPTIED as usage was consumed, against every other progress bar he
    // meets. He decided it: "They should fill up instead so it's consistent."
    it('fills every bar as usage is consumed, and the number says the same', () => {
        const mine = resolveUsageStrip(pane).usageBarGroups[0];
        expect(mine.rows.map((r) => r.fraction)).toEqual([0.49, 0.23, 0.39]);
        expect(mine.rows.map((r) => r.percentText)).toEqual(['49%', '23%', '39%']);
        // Nothing in the input turns it round any more.
        const flipped = resolveUsageStrip({ ...pane, ...({ showRemaining: true } as object) }).usageBarGroups[0];
        expect(flipped.rows.map((r) => r.fraction)).toEqual([0.49, 0.23, 0.39]);
        // The colour is still read off what is LEFT, so the fill WARMS as it
        // grows: a spent window is a full red bar and needs no number read.
        expect(mine.rows.map((r) => r.tone)).toEqual(['ample', 'ample', 'ample']);
    });

    // The row Clay screenshotted, and the proof the direction is the fix.
    // Under the old convention risserproperties read `Session 100%` beside
    // `Week 0%` - correct, and nonsense. Filled as used it reads `Session 0%`
    // beside `Week 100%`, which is exactly what it is.
    it('reads risserproperties as a fresh session window on a spent week', () => {
        const rp: DroverUsageLike = {
            capturedAt: 1_000,
            accounts: [{
                name: 'risserproperties', current: true, loggedIn: true, fetchedAt: 950,
                headroom: 0, cooling: null,
                limits: [
                    { kind: 'session', percent: 0, resetsAt: sessionReset, scope: null, family: null },
                    { kind: 'weekly_all', percent: 100, resetsAt: sep5, scope: null, family: null },
                ],
            }],
        };
        const [block] = resolveUsageStrip({ ...pane, droverUsage: rp, droverAccount: 'risserproperties' })
            .usageBarGroups;
        expect(block.rows.map((r) => [r.name, r.percentText])).toEqual([
            ['Session', '0%'],
            ['Week', '100%'],
        ]);
        expect(block.rows.map((r) => r.fraction)).toEqual([0, 1]);
        // Both are MEASURED. A 0% session is a reading, not a blank, and the
        // flag is what stops it drawing as the bare track of a row nobody read.
        expect(block.rows.every((r) => r.measured)).toBe(true);
        expect(block.title).toBe('risserproperties \u00b7 0% left on Week');
    });

    it('gives every other account the same three measures, headed by its own name', () => {
        const groups = resolveUsageStrip(pane).usageBarGroups;
        // One shape for all of them, current first, registry order after it
        // (DROVE-148). No heading over the LIST (DROVE-117): each block is
        // headed by the account, which is the name being chosen between.
        expect(groups.map((g) => [g.key, g.title, g.active === true])).toEqual([
            ['account:jamrizzi', 'jamrizzi \u00b7 51% left on Session', true],
            ['account:main', 'main \u00b7 0% left on Week', false],
            ['account:bitspur.com', 'bitspur.com \u00b7 0% left on Fable week', false],
            ['account:spare', 'spare \u00b7 no login', false],
        ]);
        // main: burnt for the week, barely touched on the session. That split
        // is the whole reason for three bars instead of one headroom figure.
        expect(groups[1].rows.map((r) => [r.name, r.percentText, r.trailing, r.tone])).toEqual([
            ['Session', '4%', `Resets ${formatUsageLimitResetTime(1_500)}`, 'ample'],
            ['Week', '100%', `Resets ${formatUsageLimitResetTime(sep3)}`, 'critical'],
            // Never scoped a Fable limit. The row is drawn honestly rather
            // than dropped, so the measures stay level down the sheet.
            ['Fable week', null, '', 'unknown'],
        ]);
        // bitspur.com: out for Fable only, which one number could not say.
        expect(groups[2].rows.map((r) => [r.name, r.percentText, r.tone])).toEqual([
            ['Session', null, 'unknown'],
            ['Week', '60%', 'ample'],
            ['Fable week', '100%', 'critical'],
        ]);
        // A logged-out account keeps its three rows and dims all of them.
        expect(groups[3].rows.map((r) => [r.name, r.percentText, r.disabled])).toEqual([
            ['Session', null, true],
            ['Week', null, true],
            ['Fable week', null, true],
        ]);
    });

    it('keeps five accounts to the same three rows, so the sheet stays comparable', () => {
        const five: DroverUsageLike = {
            capturedAt: 1_000,
            accounts: [
                ...paneUsage!.accounts,
                {
                    name: 'risserproperties', current: false, loggedIn: true, fetchedAt: 900, headroom: 43, cooling: null,
                    limits: [{ kind: 'session', percent: 57, resetsAt: sessionReset, scope: null, family: null }],
                },
            ],
        };
        const groups = resolveUsageStrip({ ...pane, droverUsage: five }).usageBarGroups;
        expect(groups).toHaveLength(5);
        // Same three rows in the same order in every block. Nothing dropped,
        // nothing added, so the bars line up across accounts.
        for (const group of groups) {
            expect(group.rows.map((r) => r.name)).toEqual(['Session', 'Week', 'Fable week']);
        }
        // Exactly one block is the one the session is on.
        expect(groups.filter((g) => g.active)).toHaveLength(1);
        // Fifteen rows, fifteen keys: the list renders by them.
        const keys = groups.flatMap((g) => g.rows.map((r) => r.key));
        expect(new Set(keys).size).toBe(15);
    });

    it('keeps a never-measured account as a block of empty tracks with the reason on its name', () => {
        const unmeasured: DroverUsageLike = {
            capturedAt: 1_000,
            accounts: [
                ...paneUsage!.accounts,
                { name: 'fresh', current: false, loggedIn: true, fetchedAt: null, headroom: null, cooling: null, limits: [] },
            ],
        };
        const fresh = resolveUsageStrip({ ...pane, droverUsage: unmeasured }).usageBarGroups
            .find((g) => g.key === 'account:fresh')!;
        expect(fresh.title).toBe('fresh · not measured');
        expect(fresh.rows.map((r) => [r.name, r.fraction, r.percentText, r.tone])).toEqual([
            ['Session', 0, null, 'unknown'],
            ['Week', 0, null, 'unknown'],
            ['Fable week', 0, null, 'unknown'],
        ]);
    });

    it('says when an account is back on its name, when no row of it can', () => {
        const cooling: DroverUsageLike = {
            capturedAt: 1_000,
            accounts: [
                ...paneUsage!.accounts,
                { name: 'cooling', current: false, loggedIn: true, fetchedAt: 900, headroom: 0, cooling: { until: sep4, reason: null, family: 'fable' }, limits: [] },
            ],
        };
        const groups = resolveUsageStrip({ ...pane, droverUsage: cooling }).usageBarGroups;
        // Cooling with nothing measured: the return time is the only fact
        // there is, so it goes on the name rather than nowhere.
        // No limit rows at all, so no window to name the headroom against.
        expect(groups.find((g) => g.key === 'account:cooling')!.title)
            .toBe(`cooling \u00b7 0% left \u00b7 Fable back ${formatUsageLimitResetTime(sep4)}`);
        // main is back Sep 3 too, but its Week row already prints that, so it
        // is not said twice.
        expect(groups.find((g) => g.key === 'account:main')!.title).toBe('main \u00b7 0% left on Week');
    });

    it('keeps a long account name on its heading and off the bars', () => {
        const long: DroverUsageLike = {
            capturedAt: 1_000,
            accounts: [
                ...paneUsage!.accounts,
                { name: 'promanagerdevteam@gmail.com', current: false, loggedIn: true, fetchedAt: 900, headroom: 43, cooling: null, limits: [] },
            ],
        };
        const group = resolveUsageStrip({ ...pane, droverUsage: long }).usageBarGroups
            .find((g) => g.title.startsWith('promanagerdevteam'))!;
        // The name heads the block now instead of sitting in the name column,
        // so it stays whole and the row names are the measures, which always
        // fit. The heading is one line in the component; nothing wraps it.
        // No limit rows, so no window to name the headroom against: the
        // heading keeps its bare `left` rather than inventing one.
        expect(group.title).toBe('promanagerdevteam@gmail.com \u00b7 43% left');
        expect(group.rows.every((r) => !r.nameTruncated)).toBe(true);
        expect(group.rows.every((r) => r.name.length <= usageBarNameLimit)).toBe(true);
    });
    it('falls back to the droverAccount stamp when the snapshot marks nothing current', () => {
        const unmarked: DroverUsageLike = {
            capturedAt: 1_000,
            accounts: paneUsage!.accounts.map((a) => ({ ...a, current: false })),
        };
        const strip = resolveUsageStrip({ ...pane, droverUsage: unmarked });
        expect(strip.weekPercent).toBe(23);
        expect(strip.usageBarGroups[0].title).toBe('jamrizzi \u00b7 51% left on Session');
        expect(strip.usageBarGroups.map((g) => g.key))
            .toEqual(['account:jamrizzi', 'account:main', 'account:bitspur.com', 'account:spare']);
    });
    it('marks which blocks can take the session and which cannot (DROVE-160)', () => {
        const groups = resolveUsageStrip(pane).usageBarGroups;
        expect(groups.map((g) => [g.account, g.active === true, g.switchable])).toEqual([
            // The one in use is not a target: switching to where you already
            // are is a teardown for nothing.
            ['jamrizzi', true, false],
            ['main', false, true],
            ['bitspur.com', false, true],
            // No login means the account cannot take the session, so the tap
            // is refused here rather than by a switch that bounces a minute
            // later on the Mac.
            ['spare', false, false],
        ]);
    });
});

/**
 * WHICH ACCOUNT TO MOVE TO, BEST FIRST (DROVE-248).
 *
 * The order after the current account used to be the registry's, which
 * answers nothing: in the sheet Clay photographed the second row was `main` at
 * 0% left and the best account he had was fifth. These pin the rule -
 * headroom on the binding window, tiers before headroom, the registry only as
 * the last tie-break - and pin that the order does NOT move while the sheet is
 * open.
 */
describe('the order the accounts are listed in', () => {
    /** Clay's five, in the arbitrary registry order his screenshot showed. */
    const five: DroverUsageLike = {
        capturedAt: 1_000,
        accounts: [
            { name: 'main', current: false, loggedIn: true, fetchedAt: 950, headroom: 0, cooling: null,
                limits: [{ kind: 'weekly_all', percent: 100, resetsAt: sep5, scope: null, family: null }] },
            { name: 'jam@codejam.ninja', current: true, loggedIn: true, fetchedAt: 950, headroom: 25, cooling: null,
                limits: [{ kind: 'weekly_all', percent: 75, resetsAt: sep5, scope: null, family: null }] },
            { name: 'jamrizzi', current: false, loggedIn: true, fetchedAt: 950, headroom: 34, cooling: null,
                limits: [{ kind: 'weekly_all', percent: 66, resetsAt: sep5, scope: null, family: null }] },
            { name: 'promanagerdevteam', current: false, loggedIn: true, fetchedAt: 950, headroom: 22, cooling: null,
                limits: [{ kind: 'weekly_all', percent: 78, resetsAt: sep5, scope: null, family: null }] },
            { name: 'bitspur.com', current: false, loggedIn: true, fetchedAt: 950, headroom: 42, cooling: null,
                limits: [{ kind: 'weekly_all', percent: 58, resetsAt: sep5, scope: null, family: null }] },
            { name: 'clayrisser24', current: false, loggedIn: true, fetchedAt: 950, headroom: 0, cooling: null,
                limits: [{ kind: 'weekly_all', percent: 100, resetsAt: sep5, scope: null, family: null }] },
        ],
    };
    const order = (usage: DroverUsageLike, account: string) =>
        resolveUsageStrip({ usageLimits: null, droverUsage: usage, droverAccount: account })
            .usageBarGroups.map((group) => group.account);

    it('puts the current account first and the rest by headroom, best to worst', () => {
        // The screenshot, fixed. It read current, main at 0%, jamrizzi 34,
        // promanagerdevteam 22, bitspur.com 42, clayrisser24 0.
        expect(order(five, 'jam@codejam.ninja')).toEqual([
            'jam@codejam.ninja',
            'bitspur.com',
            'jamrizzi',
            'promanagerdevteam',
            'main',
            'clayrisser24',
        ]);
    });

    it('never puts an exhausted account second', () => {
        const groups = resolveUsageStrip({ usageLimits: null, droverUsage: five, droverAccount: 'jam@codejam.ninja' })
            .usageBarGroups;
        // The bug in one line. `main` is at 0% and had the row under the
        // account in use.
        expect(groups[1].account).toBe('bitspur.com');
        // And generally: every account with room is above every spent one.
        const headroom = groups.slice(1).map((group) => Number(/(\d+)% left/.exec(group.title)![1]));
        expect(headroom).toEqual([...headroom].sort((a, b) => b - a));
        expect(headroom.filter((left) => left === 0)).toEqual([0, 0]);
    });

    it('keeps the current account first even when it is the emptiest of them', () => {
        // It is not a place to move TO, so it is never ranked. It is the thing
        // the rest are being compared against.
        const spentCurrent = {
            ...five!,
            accounts: five!.accounts.map((a) => ({ ...a, headroom: a.name === 'jam@codejam.ninja' ? 0 : a.headroom })),
        };
        expect(order(spentCurrent, 'jam@codejam.ninja')[0]).toBe('jam@codejam.ninja');
    });

    it('sinks an account that cannot take the session, whatever its figure says', () => {
        const mixed: DroverUsageLike = {
            capturedAt: 1_000,
            accounts: [
                { name: 'out', current: false, loggedIn: true, fetchedAt: 950, headroom: 90,
                    cooling: { until: sep3, reason: 'weekly limit at 100%' }, limits: [] },
                { name: 'gone', current: false, loggedIn: false, fetchedAt: null, headroom: null, cooling: null, limits: [] },
                { name: 'unread', current: false, loggedIn: true, fetchedAt: null, headroom: null, cooling: null, limits: [] },
                { name: 'thin', current: false, loggedIn: true, fetchedAt: 950, headroom: 3, cooling: null,
                    limits: [{ kind: 'weekly_all', percent: 97, resetsAt: sep5, scope: null, family: null }] },
                { name: 'here', current: true, loggedIn: true, fetchedAt: 950, headroom: 12, cooling: null, limits: [] },
            ],
        };
        // `out` is cooling with no family named, so the WHOLE account is out
        // until Thursday and its 90% cannot be spent now. It goes under
        // `unread`, which nobody has measured and which could be full: a fact
        // beats a guess, and an unread account beats one known to be shut.
        // `gone` has no login at all and cannot be switched to, so it is last.
        expect(order(mixed, 'here')).toEqual(['here', 'thin', 'unread', 'out', 'gone']);
    });

    it('breaks a tie on which window comes back soonest, then on the registry', () => {
        const tied: DroverUsageLike = {
            capturedAt: 1_000,
            accounts: [
                { name: 'here', current: true, loggedIn: true, fetchedAt: 950, headroom: 5, cooling: null, limits: [] },
                { name: 'saturday', current: false, loggedIn: true, fetchedAt: 950, headroom: 20, cooling: null,
                    limits: [{ kind: 'weekly_all', percent: 80, resetsAt: sep5, scope: null, family: null }] },
                { name: 'in-an-hour', current: false, loggedIn: true, fetchedAt: 950, headroom: 20, cooling: null,
                    limits: [{ kind: 'session', percent: 80, resetsAt: sessionReset, scope: null, family: null }] },
            ],
        };
        // 20% either way, so the one whose window refills first is the better
        // move. This is the ONLY place the reset time ranks anything: as a
        // weight it would order two visible percentages in an order neither
        // percentage explains, and it would drift with the clock.
        expect(order(tied, 'here')).toEqual(['here', 'in-an-hour', 'saturday']);
    });

    it('holds the order while the sheet is open, so a sweep cannot move a tap target', () => {
        const opened = resolveUsageStrip({ usageLimits: null, droverUsage: five, droverAccount: 'jam@codejam.ninja' })
            .usageBarGroups;
        const held = opened.map((group) => group.key);
        // Ten minutes later bitspur.com is spent and main has reset. The
        // ranking flips; the sheet under his thumb must not.
        const swept: DroverUsageLike = {
            ...five!,
            accounts: five!.accounts.map((a) => ({
                ...a,
                headroom: a.name === 'bitspur.com' ? 0 : a.name === 'main' ? 100 : a.headroom,
            })),
        };
        const fresh = resolveUsageStrip({ usageLimits: null, droverUsage: swept, droverAccount: 'jam@codejam.ninja' })
            .usageBarGroups;
        expect(fresh.map((group) => group.account)[1]).toBe('main');
        expect(holdUsageGroupOrder(fresh, held).map((group) => group.key)).toEqual(held);
        // The FIGURES are not held, only the order. main still reads its new
        // number in the row it already occupied.
        expect(holdUsageGroupOrder(fresh, held).find((group) => group.account === 'main')!.title)
            .toContain('100% left');
    });

    it('lands an account that appears mid-sweep at the tail rather than mid-list', () => {
        const held = ['account:a', 'account:b'];
        const groups = [
            { key: 'account:new' }, { key: 'account:b' }, { key: 'account:a' },
        ] as UsageBarGroup[];
        expect(holdUsageGroupOrder(groups, held).map((g) => g.key))
            .toEqual(['account:a', 'account:b', 'account:new']);
        // Nothing held means nothing to hold to: the sheet is shut and the
        // ranking passes through.
        expect(holdUsageGroupOrder(groups, []).map((g) => g.key))
            .toEqual(['account:new', 'account:b', 'account:a']);
    });
});

describe('the trailing column at 320, 375 and 393', () => {
    it('fits every reset label the sheet can print', () => {
        // The column is a fixed 88pt at all three widths, so this is one
        // assertion and not three: the TRACK absorbs the difference between
        // phones, and this slot does not move. Which is also why the fix for
        // `Resets Wed, Se…` was a shorter label rather than a wider column -
        // at 320 the track is already down to 49pt against a 40pt floor.
        const now = Date.UTC(2026, 7, 31, 12, 0);
        const labels = [
            // Every day of the coming week, so no one weekday name is the one
            // that overflows, plus the two other things sharing the slot.
            ...[1, 2, 3, 4, 5, 6].map((day) => `Resets ${formatUsageLimitResetTime(now + day * 86_400_000, now)}`),
            `Resets ${formatUsageLimitResetTime(now + 3 * 3_600_000, now)}`,
            `Fable back ${formatUsageLimitResetTime(now + 4 * 86_400_000, now)}`,
            `Back ${formatUsageLimitResetTime(now + 3 * 3_600_000, now)}`,
            'window reset',
            'not measured',
        ];
        for (const label of labels) {
            expect(usageBarTrailingFits(label), label).toBe(true);
        }
    });

    it('is what the old label overran, which is why the month went', () => {
        // The exact string off Clay's screenshot. Kept as the regression: it
        // does NOT fit, and nothing this function can now build looks like it.
        expect(usageBarTrailingFits('Resets Wed, Sep 3')).toBe(false);
        expect(usageBarTrailingFits('Fable back Wed, Sep 3')).toBe(false);
    });
});

describe('resolveUsageStrip on a remote session', () => {
    it('prefers the SDK stream and prints its week figure with no context gauge (DROVE-194)', () => {
        const strip = resolveUsageStrip({ ...pane, usageLimits: sdkLimits });
        expect(strip.usageFromDrover).toBe(false);
        // The regression: this used to be null unless the context gauge was
        // already drawn, and the account rides in the same segment, so a
        // remote session lost its account and its quota together.
        expect(strip.weekPercent).toBe(60);
        // 60 from the SDK, not 23 from the snapshot.
        expect(strip.usageBarGroups[0].rows.map((r) => `${r.name} ${r.percentText}`)).toEqual([
            'Session 10%',
            'Week 60%',
            'Fable week 39%',
        ]);
    });

    it('still hides the figure when nothing measured a week, gauge or no gauge', () => {
        const strip = resolveUsageStrip({
            ...pane,
            usageLimits: { capturedAt: 1, windows: [{ id: 'five_hour', utilization: 10, resetsAt: sep5 }] },
            droverUsage: null,
        });
        expect(strip.weekPercent).toBeNull();
    });

    it('still lists the other accounts, at three bars each, beside the SDK figures', () => {
        const strip = resolveUsageStrip({ ...pane, usageLimits: sdkLimits });
        expect(strip.usageBarGroups.map((g) => g.key))
            .toEqual(['account:jamrizzi', 'account:main', 'account:bitspur.com', 'account:spare']);
        // The live stream overrides only the account it belongs to; the rest
        // are still read from the snapshot.
        expect(strip.usageBarGroups[1].rows.map((r) => r.percentText)).toEqual(['4%', '100%', null]);
    });
});

describe('resolveUsageStrip with nothing to show', () => {
    it('hides the figure and offers no popup', () => {
        const strip = resolveUsageStrip({ usageLimits: null, droverUsage: null });
        expect(strip).toMatchObject({ weekPercent: null, usageFromDrover: false, usageBarGroups: [] });
    });

    it('does not read a snapshot of other accounts as this session\'s own usage', () => {
        // The session is on an account the registry does not know: nothing
        // is current, nothing is stamped, so no figure and no heading for it,
        // but the others are still reachable.
        const strip = resolveUsageStrip({ usageLimits: null, droverUsage: { capturedAt: 1, accounts: paneUsage!.accounts.map((a) => ({ ...a, current: false })) }, droverAccount: null });
        expect(strip.weekPercent).toBeNull();
        // Every account is listed and none is marked as this session's.
        expect(strip.usageBarGroups).toHaveLength(4);
        expect(strip.usageBarGroups.some((g) => g.active)).toBe(false);
    });
});

/**
 * The one figure a wrist has room for (DROVE-131).
 *
 * The phone shows Session, Week and every family week side by side and lets
 * Clay rank them. A watch cannot, so the ranking is decided here and SENT, and
 * these pin that it agrees with `headroom` — which the CLI writes as `100 -
 * max(percent)` over the same rows — because two numbers for one fact drifting
 * apart is the whole of DROVE-129.
 */
describe('droverBindingLimit', () => {
    const account = (name: string) => paneUsage!.accounts.find((a) => a.name === name)!;

    it('picks the window with the least left, and agrees with the account headroom', () => {
        // jamrizzi: session 49% used, week 23%, Fable week 39%. The session is
        // the one that bites, and 100 - 49 is the 51 the picker prints.
        const binding = droverBindingLimit(account('jamrizzi'));
        expect(binding).toEqual({
            id: 'five_hour',
            label: 'Session',
            percentLeft: 51,
            resetsAt: sessionReset,
            tone: 'ample',
        });
        expect(binding!.percentLeft).toBe(account('jamrizzi').headroom);
    });

    // DROVE-173. Clay was on Opus; the wrist said bitspur.com's binding limit
    // was the Fable week, at 0% left, so an account with a 40%-free week read
    // as dead. A family window binds only a session in that family.
    it('ignores a family window the session is not running', () => {
        expect(droverBindingLimit(account('bitspur.com'), 'opus')).toEqual({
            id: 'seven_day',
            label: 'Week',
            percentLeft: 40,
            resetsAt: sep3,
            tone: 'ample',
        });
    });

    it('lets a family window bind a session that IS in that family', () => {
        expect(droverBindingLimit(account('bitspur.com'), 'fable')).toMatchObject({
            id: 'seven_day_fable',
            label: 'Fable week',
            percentLeft: 0,
        });
    });

    it('still lets an unscoped window bind whatever the model is', () => {
        expect(droverBindingLimit(account('main'), 'opus')).toMatchObject({
            id: 'seven_day',
            percentLeft: 0,
        });
    });

    it('names a family window with the family, the same word the sheet prints', () => {
        // bitspur.com is out for Fable only: the scoped row at 100% binds,
        // not the account-wide week at 60%.
        expect(droverBindingLimit(account('bitspur.com'))).toEqual({
            id: 'seven_day_fable',
            label: 'Fable week',
            percentLeft: 0,
            resetsAt: sep4,
            tone: 'critical',
        });
    });

    it('names the week when the week is what is dead', () => {
        expect(droverBindingLimit(account('main'))).toMatchObject({
            id: 'seven_day',
            label: 'Week',
            percentLeft: 0,
            resetsAt: sep3,
        });
    });

    // An account never measured shows no figure rather than a 0 that reads as
    // "out" and would hide the one account with room.
    it('says nothing about an account with no limit rows', () => {
        expect(droverBindingLimit(account('spare'))).toBeNull();
        expect(droverBindingLimit(null)).toBeNull();
        expect(droverBindingLimit(undefined)).toBeNull();
        expect(droverBindingLimit({ name: 'x', limits: null })).toBeNull();
    });

    it('keeps the shorter window on a tie, because it bites first', () => {
        expect(droverBindingLimit({
            name: 'tied',
            limits: [
                { kind: 'session', percent: 80, resetsAt: 1_000, scope: null, family: null },
                { kind: 'weekly_all', percent: 80, resetsAt: 2_000, scope: null, family: null },
            ],
        })).toMatchObject({ label: 'Session', percentLeft: 20 });
    });

    it('prints a window it cannot name as itself rather than calling it Week', () => {
        // `headroom` is computed over EVERY row including the
        // provider-internal ones, so one of those really can be the binding
        // limit, and naming the wrong window is worse than an ugly word.
        expect(droverBindingLimit({
            name: 'odd',
            limits: [{ kind: 'nimbus_quill', percent: 95, resetsAt: null, scope: null, family: null }],
        })).toMatchObject({ id: 'nimbus_quill', label: 'nimbus_quill', percentLeft: 5, tone: 'critical' });
    });

    it('clamps a cache that overshoots and ignores a row with no number', () => {
        expect(droverBindingLimit({
            name: 'over',
            limits: [
                { kind: 'session', percent: 120, resetsAt: null, scope: null, family: null },
                { kind: 'weekly_all', percent: Number.NaN, resetsAt: null, scope: null, family: null },
            ],
        })).toMatchObject({ percentLeft: 0, resetsAt: null, tone: 'critical' });
    });
});

describe('the bar model', () => {
    // The argument is percent LEFT because that is what the CLI's `headroom`
    // is; the fill is percent USED, one direction, no parameter (DROVE-230).
    it('turns a percentage into a track fraction and clamps what is out of range', () => {
        expect(usageBarFraction(43)).toBeCloseTo(0.57);
        expect(usageBarFraction(100)).toBe(0);
        expect(usageBarFraction(140)).toBe(0);
        expect(usageBarFraction(-5)).toBe(1);
    });

    it('draws a full track at zero left, and an empty one when nothing is used', () => {
        expect(usageBarFraction(0)).toBe(1);
        expect(usageBarFraction(100)).toBe(0);
        expect(usageBarTone(0)).toBe('critical');
    });

    it('reads a not-measured figure as empty and grey, never as full', () => {
        // Empty rather than full: no figure must never look like a spent
        // window, which under a filling bar is the alarming end.
        expect(usageBarFraction(null)).toBe(0);
        expect(usageBarFraction(undefined)).toBe(0);
        expect(usageBarFraction(Number.NaN)).toBe(0);
        expect(usageBarTone(null)).toBe('unknown');
        expect(usageBarTone(Number.NaN)).toBe('unknown');
    });

    // DROVE-230. The one derivation every quota mark in the product runs
    // through: the sheet's bars, the composer strip (DROVE-231) and the
    // wrist's rows (DROVE-228). Three surfaces, one direction, one ramp.
    describe('usageFill', () => {
        it('turns headroom into a fill, a figure and a spoken figure at once', () => {
            expect(usageFill(51)).toEqual({
                measured: true,
                percentUsed: 49,
                fraction: 0.49,
                percentText: '49%',
                percentSpoken: '49% used',
                tone: 'ample',
            });
        });

        it('keeps a measured ZERO apart from nothing measured', () => {
            // The distinction the sheet could not draw. Filling as used, a
            // window read at 0% used and a window nobody read both sit at the
            // empty end of the track, and they are opposite facts: one is a
            // fresh window, the other is no reading at all.
            expect(usageFill(100)).toMatchObject({ measured: true, percentUsed: 0, fraction: 0 });
            expect(usageFill(null)).toMatchObject({ measured: false, percentUsed: null, fraction: 0 });
            expect(usageFill(Number.NaN)).toMatchObject({ measured: false, percentText: null });
            expect(usageFill(null).percentSpoken).toBeNull();
        });

        it('says the direction out loud, because a screen reader never sees a fill', () => {
            expect(usageFill(0).percentSpoken).toBe('100% used');
            expect(usageFill(0).percentText).toBe('100%');
        });
    });

    // The ramp, and DROVE-231 and DROVE-228 read it off this same function
    // rather than each picking bands. Reading it off what is LEFT means the
    // colour warms as the bar fills, which is the second carrier of the one
    // fact the sheet exists to show. No new hue: the three bands are the
    // theme's existing success / amber / warningCritical. DROVE-215's
    // white-unless-active rule governs the composer's control GLYPHS and
    // DROVE-176's palette is that row's vocabulary; a data mark is neither.
    it('colours by headroom left, in three bands', () => {
        expect(usageBarTone(9)).toBe('critical');
        expect(usageBarTone(10)).toBe('low');
        expect(usageBarTone(34)).toBe('low');
        expect(usageBarTone(35)).toBe('ample');
        expect(usageBarTone(100)).toBe('ample');
    });

    it('leaves a name that fits alone and ends a long one in an ellipsis', () => {
        expect(truncateUsageName('main')).toEqual({ name: 'main', truncated: false });
        expect(truncateUsageName('bitspur.com')).toEqual({ name: 'bitspur.com', truncated: false });
        expect(truncateUsageName('risserproperties')).toEqual({ name: 'risserpropert\u2026', truncated: true });
        expect(truncateUsageName('risserproperties', 6)).toEqual({ name: 'risse\u2026', truncated: true });
    });
});

/**
 * The caption under the bars, and it is NO LONGER LOAD-BEARING (DROVE-230).
 *
 * It used to open with `Bars show left`. That was the sheet's only statement
 * of its own direction, in small secondary text at the bottom of something you
 * scroll, which is where a rule goes to be missed - and it was missed by the
 * person who specified the bars. A caption cannot repair a backwards
 * affordance, so the mark carries the direction now and the caption carries
 * only what a mark cannot.
 *
 * What it does carry: the timezone, because Clay saw "Resets 7:49 AM" beside
 * /usage's "Resets 1:49pm (Europe/London)" and they are the SAME minute; how
 * old the reading is; and which measured window the headroom skipped.
 */
describe('usageBarFooterText', () => {
    it('says nothing about how to read a bar', () => {
        const line = usageBarFooterText({ modelFamily: 'opus' });
        expect(line).not.toMatch(/Bars show/);
        expect(line).toMatch(/^Times in \S+$/);
    });

    it('names the window the headroom SKIPPED, not a model the API returns nothing for', () => {
        // `headroom for Opus` promised a number the data does not contain:
        // seven_day_opus and seven_day_sonnet both come back null and the only
        // model-scoped window the API returns is Fable's. What is true is the
        // opposite, and it is now what the line says.
        expect(usageBarFooterText({ modelFamily: 'opus', skipped: ['Fable week'] }))
            .toMatch(/Fable week not counted for Opus$/);
    });

    it('drops the clause when there is no model, rather than guessing one', () => {
        expect(usageBarFooterText({ modelFamily: null, skipped: ['Fable week'] }))
            .toMatch(/^Times in \S+$/);
        expect(usageBarFooterText({})).toMatch(/^Times in \S+$/);
    });

    it('rides the strip so the sheet gets it, with the capture stamp beside it', () => {
        const strip = resolveUsageStrip({ ...pane, droverUsage: { ...paneUsage!, modelFamily: 'opus' } });
        expect(strip.usageBarFooter).toMatch(/^Times in \S+ \u00b7 Fable week not counted for Opus$/);
        // The AGE is not in the string. It changes while nothing else on this
        // object does, so a memo built here would still read "just now" an
        // hour after the sweep stopped; the component holds the clock instead.
        expect(strip.usageBarFooter).not.toMatch(/Read /);
        expect(strip.usageBarCapturedAt).toBe(1_000);
    });

    it('has no capture stamp when there is no snapshot behind the bars', () => {
        expect(resolveUsageStrip({ usageLimits: null, droverUsage: null }).usageBarCapturedAt).toBeNull();
    });
});

/**
 * How old the reading is, said out loud (DROVE-230).
 *
 * Clay: "When are you going to fix these to make them accurate?" They were
 * accurate. The CLI sweeps every ten minutes with a five-minute floor, so
 * minutes-old is the NORMAL case, and it has to be legible rather than hidden.
 */
describe('usageSnapshotAgeText', () => {
    const at = 1_700_000_000_000;

    it('words the age at every scale', () => {
        expect(usageSnapshotAgeText(at, at)).toBe('Read just now');
        expect(usageSnapshotAgeText(at, at + 3 * 60_000)).toBe('Read 3m ago');
        expect(usageSnapshotAgeText(at, at + 90 * 60_000)).toBe('Read 1h ago, overdue');
        expect(usageSnapshotAgeText(at, at + 50 * 3600_000)).toBe('Read 2d ago, overdue');
    });

    it('says overdue once the sweep that should have refreshed it has not', () => {
        expect(usageSnapshotAgeText(at, at + 9 * 60_000)).toBe('Read 9m ago');
        expect(usageSnapshotAgeText(at, at + 10 * 60_000)).toBe('Read 10m ago, overdue');
    });

    it('reads a clock disagreement as just now rather than a negative age', () => {
        expect(usageSnapshotAgeText(at, at - 60_000)).toBe('Read just now');
    });

    it('says nothing at all when there is no snapshot to age', () => {
        expect(usageSnapshotAgeText(null, at)).toBe('');
        expect(usageSnapshotAgeText(undefined, at)).toBe('');
    });
});

describe('usageSkippedFamilyWindows', () => {
    it('names the measured family window the headroom left out', () => {
        expect(usageSkippedFamilyWindows({ ...paneUsage!, modelFamily: 'opus' })).toEqual(['Fable week']);
    });

    it('names nothing when the window DOES bind the session', () => {
        expect(usageSkippedFamilyWindows({ ...paneUsage!, modelFamily: 'fable' })).toEqual([]);
    });

    it('names nothing when the model is unknown, because then everything binds', () => {
        expect(usageSkippedFamilyWindows(paneUsage)).toEqual([]);
        expect(usageSkippedFamilyWindows(null)).toEqual([]);
    });
});

/**
 * A reading nobody has refreshed says so (DROVE-173).
 *
 * The five-hour session window means a cache one window old prints LAST
 * window's reset as if it were the next one. Rather than show it as current,
 * the block's heading says stale.
 */
describe('a stale account block', () => {
    const stale: DroverUsageLike = {
        capturedAt: sep5,
        accounts: [{
            name: 'risserproperties',
            current: true,
            loggedIn: true,
            // 34 hours before the snapshot, and its session window reset long ago.
            fetchedAt: sep5 - 34 * 3600_000,
            headroom: 11,
            cooling: null,
            limits: [{ kind: 'session', percent: 89, resetsAt: sep3, scope: null, family: null }],
        }],
    };

    it('marks the heading rather than passing the numbers off as current', () => {
        const [block] = resolveUsageStrip({ ...pane, droverUsage: stale, droverAccount: 'risserproperties' })
            .usageBarGroups;
        // The one applying window has already reset, so there IS no binding
        // limit and the heading has nothing honest to quote. Under a filling
        // bar that matters more than it did: a window whose reading describes
        // something that no longer exists must not draw as 0% used, because
        // 0% used is what a brand new window looks like (DROVE-230).
        expect(block.title).toBe('risserproperties \u00b7 headroom unknown \u00b7 stale');
        // The CLI stamped headroom 11 on this account. The one window it was
        // read from had already reset, so the sheet refuses to quote it: a
        // number over a bar with no reading is the "correct but broken" the
        // whole ticket is about.
        expect(block.rows[0].measured).toBe(false);
        expect(block.rows[0].trailing).toBe('window reset');
    });

    it('leaves a fresh account heading alone', () => {
        const [block] = resolveUsageStrip(pane).usageBarGroups;
        expect(block.title).toBe('jamrizzi \u00b7 51% left on Session');
    });
});

/**
 * No bar and no number for a window that has already reset (DROVE-204).
 *
 * Clay, at the sheet: "I know for a fact it was expired on most of these, so
 * what is wrong with your graphs." The arithmetic was right and the input was
 * a reading of a window that no longer existed. DROVE-173 labelled it `stale`,
 * which is the right instinct and not enough — a bar and a percentage next to
 * the word `stale` still reads as data. The honest answer is unknown, and
 * unknown has no bar.
 */
describe('an expired window on the sheet', () => {
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
                { kind: 'session', percent: 1, resetsAt: captured - 1, scope: null, family: null, usable: false },
                { kind: 'weekly_all', percent: 58, resetsAt: captured + 1, scope: null, family: null, usable: true },
            ],
        }],
    };

    it('draws the row with a bare track, no figure, and the reason', () => {
        const strip = resolveUsageStrip({ usageLimits: null, droverUsage: expired });
        const [session, week] = strip.usageBarGroups[0].rows;
        // 99% left on a window that reset is the screenshot. Now: nothing.
        expect(session.percentText).toBeNull();
        expect(session.fraction).toBe(0);
        expect(session.tone).toBe('unknown');
        expect(session.trailing).toBe('window reset');
        // And UNMEASURED, which is what stops the component drawing it as a
        // fresh window (DROVE-230). Fill-as-used put "nothing used" and
        // "nothing known" at the same end of the track; this flag is the only
        // thing between them, so an expired row must never claim to be
        // measured.
        expect(session.measured).toBe(false);
        expect(session.percentSpoken).toBeNull();
        // The window that is still open keeps its bar, its number and its flag.
        expect(week.percentText).toBe('58%');
        expect(week.measured).toBe(true);
    });

    it('heads the account with headroom unknown, not with "not measured"', () => {
        const strip = resolveUsageStrip({ usageLimits: null, droverUsage: expired });
        // Two different nothings. "not measured" means nobody ever asked.
        expect(strip.usageBarGroups[0].title).toContain('headroom unknown');
        expect(strip.usageBarGroups[0].title).not.toContain('not measured');
    });

    it('leaves the composer strip without a week figure rather than a stale one', () => {
        const stale: DroverUsageLike = {
            capturedAt: captured,
            modelFamily: null,
            accounts: [{
                name: 'main', current: true, loggedIn: true, fetchedAt: captured - 1,
                headroom: null, cooling: null,
                limits: [
                    { kind: 'weekly_all', percent: 58, resetsAt: captured - 1, scope: null, family: null, usable: false },
                ],
            }],
        };
        expect(resolveUsageStrip({ usageLimits: null, droverUsage: stale }).weekPercent).toBeNull();
    });

    it('gives the wrist no binding limit at all, because it has room for only one', () => {
        // The wrist shows one figure and cannot qualify it. The window nobody
        // has measured is exactly the one that could be full, so there is no
        // honest single answer (DROVE-129: it must agree with headroom, and
        // headroom is null here).
        expect(droverBindingLimit(expired.accounts[0], null, captured)).toBeNull();
    });

    it('still answers when every applying window is inside its own reset', () => {
        const fresh = {
            name: 'jamrizzi',
            limits: [
                { kind: 'session', percent: 1, resetsAt: captured + 1, scope: null, family: null, usable: true },
                { kind: 'weekly_all', percent: 58, resetsAt: captured + 1, scope: null, family: null, usable: true },
            ],
        };
        expect(droverBindingLimit(fresh, null, captured)).toMatchObject({ id: 'seven_day', percentLeft: 42 });
    });
});
