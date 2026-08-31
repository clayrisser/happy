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
    resolveUsageStrip,
    truncateUsageName,
    usageBarFraction,
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

    it('fills every bar to the headroom LEFT, whichever number the setting prints', () => {
        const used = resolveUsageStrip(pane).usageBarGroups[0];
        const left = resolveUsageStrip({ ...pane, showRemaining: true }).usageBarGroups[0];
        // 49% used and 51% left are the same bar; only the text flips.
        expect(used.rows.map((r) => r.fraction)).toEqual([0.51, 0.77, 0.61]);
        expect(left.rows.map((r) => r.fraction)).toEqual([0.51, 0.77, 0.61]);
        expect(used.rows.map((r) => r.percentText)).toEqual(['49%', '23%', '39%']);
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
        expect(strip).toEqual({ weekPercent: null, usageFromDrover: false, usageBarGroups: [] });
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

describe('the bar model', () => {
    it('turns a percentage into a track fraction and clamps what is out of range', () => {
        expect(usageBarFraction(43)).toBeCloseTo(0.43);
        expect(usageBarFraction(100)).toBe(1);
        expect(usageBarFraction(140)).toBe(1);
        expect(usageBarFraction(-5)).toBe(0);
    });

    it('draws an empty track at zero rather than no track', () => {
        expect(usageBarFraction(0)).toBe(0);
        expect(usageBarTone(0)).toBe('critical');
    });

    it('reads a not-measured figure as empty and grey, never as full', () => {
        expect(usageBarFraction(null)).toBe(0);
        expect(usageBarFraction(undefined)).toBe(0);
        expect(usageBarFraction(Number.NaN)).toBe(0);
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
