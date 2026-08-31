/**
 * The usage strip on a pane session, decided (DROVE-47).
 *
 * A pane session has no agentState.usageLimits, so what the strip shows
 * comes out of metadata.droverUsage alone. These pin the choice between the
 * two feeds, the gate on the week figure, and every row of the popup down to
 * its bar, the part the mapping tests in utils/droverUsage.spec.ts stop short
 * of. The bar rows are DROVE-107: one line per account, filled to the headroom
 * left, coloured by that and not by which account it is.
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

    it('heads the popup with the picker\'s own number and lists session, week and the Fable row', () => {
        const [mine] = resolveUsageStrip({ ...pane, showRemaining: true }).usageBarGroups;
        expect(mine.key).toBe('usage');
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

    it('lists every other account with no heading over them, with the figures the picker prints', () => {
        const [, others] = resolveUsageStrip(pane).usageBarGroups;
        expect(others.key).toBe('accounts');
        // No heading (DROVE-117). The rows above are quota windows within one
        // account and earn theirs; this is just the accounts.
        expect(others.title).toBe('');
        expect(others.rows).toEqual([
            {
                key: 'account:main',
                name: 'main',
                fullName: 'main',
                nameTruncated: false,
                fraction: 0,
                percentText: '100%',
                trailing: `Back ${formatUsageLimitResetTime(sep3)}`,
                tone: 'critical',
                disabled: false,
            },
            {
                key: 'account:bitspur.com',
                name: 'bitspur.com',
                fullName: 'bitspur.com',
                nameTruncated: false,
                fraction: 0,
                percentText: '100%',
                trailing: `Fable back ${formatUsageLimitResetTime(sep4)}`,
                tone: 'critical',
                disabled: false,
            },
            {
                key: 'account:spare',
                name: 'spare',
                fullName: 'spare',
                nameTruncated: false,
                fraction: 0,
                percentText: null,
                trailing: 'no login',
                tone: 'unknown',
                disabled: true,
            },
        ]);
    });

    it('keeps a never-measured account as a row with an empty track and the reason', () => {
        const unmeasured: DroverUsageLike = {
            capturedAt: 1_000,
            accounts: [
                ...paneUsage!.accounts,
                { name: 'fresh', current: false, loggedIn: true, fetchedAt: null, headroom: null, cooling: null, limits: [] },
            ],
        };
        const [, others] = resolveUsageStrip({ ...pane, droverUsage: unmeasured }).usageBarGroups;
        const fresh = others.rows.find((r) => r.key === 'account:fresh')!;
        expect(fresh).toMatchObject({ fraction: 0, percentText: null, trailing: 'not measured', tone: 'unknown', disabled: false });
    });

    it('cuts a long account name to the row instead of wrapping it', () => {
        const long: DroverUsageLike = {
            capturedAt: 1_000,
            accounts: [
                ...paneUsage!.accounts,
                { name: 'risserproperties', current: false, loggedIn: true, fetchedAt: 900, headroom: 43, cooling: null, limits: [] },
            ],
        };
        const [, others] = resolveUsageStrip({ ...pane, droverUsage: long }).usageBarGroups;
        const row = others.rows.find((r) => r.fullName === 'risserproperties')!;
        expect(row.nameTruncated).toBe(true);
        expect(row.name).toBe('risserpropert\u2026');
        expect(row.name.length).toBe(usageBarNameLimit);
        expect(row.fraction).toBeCloseTo(0.43);
        expect(row.tone).toBe('ample');
    });

    it('falls back to the droverAccount stamp when the snapshot marks nothing current', () => {
        const unmarked: DroverUsageLike = {
            capturedAt: 1_000,
            accounts: paneUsage!.accounts.map((a) => ({ ...a, current: false })),
        };
        const strip = resolveUsageStrip({ ...pane, droverUsage: unmarked });
        expect(strip.weekPercent).toBe(23);
        expect(strip.usageBarGroups[0].title).toBe('jamrizzi · 49% used');
        expect(strip.usageBarGroups[1].rows.map((r) => r.key)).toEqual(['account:main', 'account:bitspur.com', 'account:spare']);
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

    it('still folds the other accounts in beside the SDK figures', () => {
        const strip = resolveUsageStrip({ ...pane, usageLimits: sdkLimits, contextShown: true });
        expect(strip.usageBarGroups.map((g) => g.key)).toEqual(['usage', 'accounts']);
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
        expect(strip.usageBarGroups.map((g) => g.key)).toEqual(['accounts']);
        expect(strip.usageBarGroups[0].rows).toHaveLength(4);
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
