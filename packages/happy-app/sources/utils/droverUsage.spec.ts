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
    droverOtherAccounts,
    droverWindowId,
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
            { name: 'main', loggedIn: true, headroom: 0, back: sep3, family: null },
            { name: 'bitspur.com', loggedIn: true, headroom: 0, back: sep3, family: 'Fable' },
            { name: 'spare', loggedIn: false, headroom: null, back: null, family: null },
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
            { id: 'five_hour', family: null, utilization: 4, resetsAt: 1_500 },
            { id: 'seven_day', family: null, utilization: 100, resetsAt: sep3 },
            { id: 'seven_day_fable', family: 'Fable', utilization: 100, resetsAt: sep3 },
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
