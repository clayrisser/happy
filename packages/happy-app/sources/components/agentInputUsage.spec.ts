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
    resolveUsageStrip,
    truncateUsageName,
    usageBarFraction,
    usageBarFooterText,
    usageBarNameLimit,
    usageBarTone,
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

const pane = { usageLimits: null, droverUsage: paneUsage, droverAccount: 'jamrizzi', showRemaining: false, contextShown: false };

describe('resolveUsageStrip on a pane session', () => {
    it('shows the week figure from the snapshot with no SDK stream and no context gauge', () => {
        const strip = resolveUsageStrip(pane);
        expect(strip.usageFromDrover).toBe(true);
        // weekly_all at 23% used: the number `drover accounts` has for the week.
        expect(strip.weekPercent).toBe(23);
    });

    it('flips the figure for the "% left" setting', () => {
        expect(resolveUsageStrip({ ...pane, showRemaining: true }).weekPercent).toBe(77);
    });

    it('heads the current account\'s block with the picker\'s own number and lists session, week and the Fable row', () => {
        const [mine] = resolveUsageStrip({ ...pane, showRemaining: true }).usageBarGroups;
        expect(mine.key).toBe('account:jamrizzi');
        // The block the session is on comes first and says so, which is the
        // only thing that tells it apart now the row shape is shared.
        expect(mine.active).toBe(true);
        expect(mine.title).toBe('jamrizzi · 51% left');
        expect(mine.rows.map((r) => [r.name, r.percentText, r.trailing])).toEqual([
            ['Session', '51%', `Resets ${formatUsageLimitResetTime(sessionReset)}`],
            ['Week', '77%', `Resets ${formatUsageLimitResetTime(sep5)}`],
            ['Fable week', '61%', `Resets ${formatUsageLimitResetTime(sep5)}`],
        ]);
        // One line each: nothing in a row may carry the newline that used to
        // stack the reset time under the name.
        expect(mine.rows.every((r) => !`${r.name}${r.percentText}${r.trailing}`.includes('\n'))).toBe(true);
    });

    // DROVE-173. Clay, with the sheet beside Claude Code's /usage: a session
    // 1% used drew a nearly full green bar, because the fill was the headroom
    // LEFT whatever the printed number said. Claude Code fills with USED, and
    // that is the default now: bar and figure say the same thing.
    it('fills every bar in the direction the number is printed in, used by default', () => {
        const used = resolveUsageStrip(pane).usageBarGroups[0];
        const left = resolveUsageStrip({ ...pane, showRemaining: true }).usageBarGroups[0];
        expect(used.rows.map((r) => r.fraction)).toEqual([0.49, 0.23, 0.39]);
        expect(used.rows.map((r) => r.percentText)).toEqual(['49%', '23%', '39%']);
        expect(left.rows.map((r) => r.fraction)).toEqual([0.51, 0.77, 0.61]);
        expect(left.rows.map((r) => r.percentText)).toEqual(['51%', '77%', '61%']);
        // The colour is still read off what is LEFT either way: it is what
        // "close to the wall" means, and it must not flip with the setting.
        expect(used.rows.map((r) => r.tone)).toEqual(left.rows.map((r) => r.tone));
    });

    it('gives every other account the same three measures, headed by its own name', () => {
        const groups = resolveUsageStrip(pane).usageBarGroups;
        // One shape for all of them, current first, registry order after it
        // (DROVE-148). No heading over the LIST (DROVE-117): each block is
        // headed by the account, which is the name being chosen between.
        expect(groups.map((g) => [g.key, g.title, g.active === true])).toEqual([
            ['account:jamrizzi', 'jamrizzi · 49% used', true],
            ['account:main', 'main · 100% used', false],
            ['account:bitspur.com', 'bitspur.com · 100% used', false],
            ['account:spare', 'spare · no login', false],
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
        expect(groups.find((g) => g.key === 'account:cooling')!.title)
            .toBe(`cooling · 100% used · Fable back ${formatUsageLimitResetTime(sep4)}`);
        // main is back Sep 3 too, but its Week row already prints that, so it
        // is not said twice.
        expect(groups.find((g) => g.key === 'account:main')!.title).toBe('main · 100% used');
    });

    it('keeps a long account name on its heading and off the bars', () => {
        const long: DroverUsageLike = {
            capturedAt: 1_000,
            accounts: [
                ...paneUsage!.accounts,
                { name: 'promanagerdevteam@gmail.com', current: false, loggedIn: true, fetchedAt: 900, headroom: 43, cooling: null, limits: [] },
            ],
        };
        const group = resolveUsageStrip({ ...pane, droverUsage: long, showRemaining: true }).usageBarGroups
            .find((g) => g.title.startsWith('promanagerdevteam'))!;
        // The name heads the block now instead of sitting in the name column,
        // so it stays whole and the row names are the measures, which always
        // fit. The heading is one line in the component; nothing wraps it.
        expect(group.title).toBe('promanagerdevteam@gmail.com · 43% left');
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
        expect(strip.usageBarGroups[0].title).toBe('jamrizzi · 49% used');
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

describe('resolveUsageStrip on a remote session', () => {
    it('prefers the SDK stream and keeps the week figure behind the context gate', () => {
        const hidden = resolveUsageStrip({ ...pane, usageLimits: sdkLimits });
        expect(hidden.usageFromDrover).toBe(false);
        expect(hidden.weekPercent).toBeNull();

        const shown = resolveUsageStrip({ ...pane, usageLimits: sdkLimits, contextShown: true });
        // 60 from the SDK, not 23 from the snapshot.
        expect(shown.weekPercent).toBe(60);
        expect(shown.usageBarGroups[0].rows.map((r) => `${r.name} ${r.percentText}`)).toEqual([
            'Session 10%',
            'Week 60%',
            'Fable week 39%',
        ]);
    });

    it('still lists the other accounts, at three bars each, beside the SDK figures', () => {
        const strip = resolveUsageStrip({ ...pane, usageLimits: sdkLimits, contextShown: true });
        expect(strip.usageBarGroups.map((g) => g.key))
            .toEqual(['account:jamrizzi', 'account:main', 'account:bitspur.com', 'account:spare']);
        // The live stream overrides only the account it belongs to; the rest
        // are still read from the snapshot.
        expect(strip.usageBarGroups[1].rows.map((r) => r.percentText)).toEqual(['4%', '100%', null]);
    });
});

describe('resolveUsageStrip with nothing to show', () => {
    it('hides the figure and offers no popup', () => {
        const strip = resolveUsageStrip({ usageLimits: null, droverUsage: null, showRemaining: false, contextShown: true });
        expect(strip).toMatchObject({ weekPercent: null, usageFromDrover: false, usageBarGroups: [] });
    });

    it('does not read a snapshot of other accounts as this session\'s own usage', () => {
        // The session is on an account the registry does not know: nothing
        // is current, nothing is stamped, so no figure and no heading for it,
        // but the others are still reachable.
        const strip = resolveUsageStrip({ usageLimits: null, droverUsage: { capturedAt: 1, accounts: paneUsage!.accounts.map((a) => ({ ...a, current: false })) }, droverAccount: null, showRemaining: false, contextShown: false });
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
    // The argument is percent LEFT; the fill is percent USED unless the
    // setting asks otherwise (DROVE-173).
    it('turns a percentage into a track fraction and clamps what is out of range', () => {
        expect(usageBarFraction(43)).toBeCloseTo(0.57);
        expect(usageBarFraction(43, true)).toBeCloseTo(0.43);
        expect(usageBarFraction(100)).toBe(0);
        expect(usageBarFraction(100, true)).toBe(1);
        expect(usageBarFraction(140, true)).toBe(1);
        expect(usageBarFraction(-5, true)).toBe(0);
        expect(usageBarFraction(140)).toBe(0);
        expect(usageBarFraction(-5)).toBe(1);
    });

    it('draws a full track at zero left, and an empty one when nothing is used', () => {
        expect(usageBarFraction(0)).toBe(1);
        expect(usageBarFraction(0, true)).toBe(0);
        expect(usageBarTone(0)).toBe('critical');
    });

    it('reads a not-measured figure as empty and grey, never as full', () => {
        // Empty in BOTH directions: no figure must never look like a full
        // tank and must never look like a spent one either.
        expect(usageBarFraction(null)).toBe(0);
        expect(usageBarFraction(undefined)).toBe(0);
        expect(usageBarFraction(Number.NaN)).toBe(0);
        expect(usageBarFraction(null, true)).toBe(0);
        expect(usageBarTone(null)).toBe('unknown');
        expect(usageBarTone(Number.NaN)).toBe('unknown');
    });

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
 * The caption under the bars (DROVE-173).
 *
 * Two facts were invisible and both made the sheet read as wrong. Clay saw
 * "Resets 7:49 AM" beside /usage's "Resets 1:49pm (Europe/London)" and they
 * are the SAME minute — his phone was five hours behind the Mac — and the
 * same instant printed "Sep 2" here and "Sep 3" there. Naming the zone is the
 * fix; converting to the Mac's would print a clock the phone never shows.
 * The model goes on the same line because headroom now ignores windows the
 * session is not in, and a number that ignores something has to say what.
 */
describe('usageBarFooterText', () => {
    it('names the direction, the zone and the model the headroom is for', () => {
        expect(usageBarFooterText('opus'))
            .toMatch(/^Bars show used \u00b7 Times in \S+ \u00b7 headroom for Opus$/);
    });

    // The measure rows print a bare "99%" in a 34pt column, so the direction
    // has to be said somewhere; it is the fact that made a session 1% used
    // read as nearly gone.
    it('follows the setting when it is turned the other way', () => {
        expect(usageBarFooterText('opus', true)).toMatch(/^Bars show left \u00b7 /);
    });

    it('says the direction and the zone when the model is unknown', () => {
        expect(usageBarFooterText(null)).toMatch(/^Bars show used \u00b7 Times in \S+$/);
        expect(usageBarFooterText(undefined)).toMatch(/^Bars show used \u00b7 Times in \S+$/);
    });

    it('rides the strip so the sheet gets it', () => {
        expect(resolveUsageStrip({ ...pane, droverUsage: { ...paneUsage!, modelFamily: 'opus' } }).usageBarFooter)
            .toMatch(/headroom for Opus$/);
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
        expect(block.title).toBe('risserproperties · 89% used · stale');
    });

    it('leaves a fresh account heading alone', () => {
        const [block] = resolveUsageStrip(pane).usageBarGroups;
        expect(block.title).toBe('jamrizzi · 49% used');
    });
});
