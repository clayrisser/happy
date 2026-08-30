/**
 * The usage strip on a pane session, decided (DROVE-47).
 *
 * A pane session has no agentState.usageLimits, so what the strip shows
 * comes out of metadata.droverUsage alone. These pin the choice between the
 * two feeds, the gate on the week figure, and every row of the popup down to
 * the label — the part the mapping tests in utils/droverUsage.spec.ts stop
 * short of.
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

import { resolveUsageStrip } from './agentInputUsage';

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
        const [mine] = resolveUsageStrip({ ...pane, showRemaining: true }).usageMenuGroups;
        expect(mine.key).toBe('usage');
        expect(mine.title).toBe('jamrizzi · 51% left');
        expect(mine.options.map((o) => o.label)).toEqual([
            `Session · 51%\nResets ${formatUsageLimitResetTime(sessionReset)}`,
            `Week · 77%\nResets ${formatUsageLimitResetTime(sep5)}`,
            `Fable week · 61%\nResets ${formatUsageLimitResetTime(sep5)}`,
        ]);
    });

    it('folds every other account under its own heading, with the figures the picker prints', () => {
        const [, others] = resolveUsageStrip(pane).usageMenuGroups;
        expect(others.key).toBe('accounts');
        expect(others.title).toBe('Other accounts');
        expect(others.options).toEqual([
            { key: 'account:main', label: `main · 100% used\nBack ${formatUsageLimitResetTime(sep3)}`, disabled: false },
            { key: 'account:bitspur.com', label: `bitspur.com · 100% used\nFable back ${formatUsageLimitResetTime(sep4)}`, disabled: false },
            { key: 'account:spare', label: 'spare · no login', disabled: true },
        ]);
    });

    it('falls back to the droverAccount stamp when the snapshot marks nothing current', () => {
        const unmarked: DroverUsageLike = {
            capturedAt: 1_000,
            accounts: paneUsage!.accounts.map((a) => ({ ...a, current: false })),
        };
        const strip = resolveUsageStrip({ ...pane, droverUsage: unmarked });
        expect(strip.weekPercent).toBe(23);
        expect(strip.usageMenuGroups[0].title).toBe('jamrizzi · 49% used');
        expect(strip.usageMenuGroups[1].options.map((o) => o.key)).toEqual(['account:main', 'account:bitspur.com', 'account:spare']);
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
        expect(shown.usageMenuGroups[0].options.map((o) => o.label.split('\n')[0])).toEqual([
            'Session · 10%',
            'Week · 60%',
            'Fable week · 39%',
        ]);
    });

    it('still folds the other accounts in beside the SDK figures', () => {
        const strip = resolveUsageStrip({ ...pane, usageLimits: sdkLimits, contextShown: true });
        expect(strip.usageMenuGroups.map((g) => g.key)).toEqual(['usage', 'accounts']);
    });
});

describe('resolveUsageStrip with nothing to show', () => {
    it('hides the figure and offers no popup', () => {
        const strip = resolveUsageStrip({ usageLimits: null, droverUsage: null, showRemaining: false, contextShown: true });
        expect(strip).toEqual({ weekPercent: null, usageFromDrover: false, usageMenuGroups: [] });
    });

    it('does not read a snapshot of other accounts as this session\'s own usage', () => {
        // The session is on an account the registry does not know: nothing
        // is current, nothing is stamped, so no figure and no heading for it,
        // but the others are still reachable.
        const strip = resolveUsageStrip({ usageLimits: null, droverUsage: { capturedAt: 1, accounts: paneUsage!.accounts.map((a) => ({ ...a, current: false })) }, droverAccount: null, showRemaining: false, contextShown: false });
        expect(strip.weekPercent).toBeNull();
        expect(strip.usageMenuGroups.map((g) => g.key)).toEqual(['accounts']);
        expect(strip.usageMenuGroups[0].options).toHaveLength(4);
    });
});
