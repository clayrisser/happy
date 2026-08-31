/**
 * The two things the session info screen's Cattle Drover section decides
 * (DROVE-137): which account the session is on, and who a flip from here
 * silences.
 *
 * Both are pinned as pure functions because both have already been got wrong
 * once elsewhere. The account label drifted from the composer's (DROVE-129 is
 * the whole class of that bug), and DROVE-37's warning shipped dead in
 * production for a day because its own tests fed it a shape the real world
 * never sends. So the cases here are the awkward ones: an unmanaged session
 * with no account stamp at all, a target that equals a session's own account,
 * and a snapshot with no usage in it.
 */
import { describe, expect, it, vi } from 'vitest';

// The real English strings, without expo-localization behind them. Same shim
// agentInputUsage.spec uses; the account label is built from the same keys.
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
    ambientDroverAccount,
    droverAccountOf,
    flipRiskFooter,
    flipRiskNames,
    flipRiskSubtitle,
    flipRiskWarning,
    resolveSessionAccount,
    sessionsLosingRemoteControl,
} from './droverSessionAccount';
import type { DroverUsageLike } from './droverUsage';

const usage = (accounts: Array<Record<string, unknown>>): DroverUsageLike => ({
    capturedAt: 1_700_000_000_000,
    accounts: accounts as never,
});

describe('resolveSessionAccount', () => {
    it('names the current account and prints its headroom', () => {
        const view = resolveSessionAccount({
            droverUsage: usage([
                { name: 'jamrizzi', current: true, headroom: 51, limits: [] },
                { name: 'main', headroom: 4, limits: [] },
            ]),
            droverAccount: 'jamrizzi',
            showRemaining: true,
        });
        expect(view.name).toBe('jamrizzi');
        expect(view.headroom).toBe(51);
        expect(view.label).toBe('jamrizzi · 51% left');
        expect(view.row?.percentText).toBe('51%');
        // The track fills to what is LEFT whichever way the setting prints it.
        expect(view.row?.fraction).toBeCloseTo(0.51);
    });

    it('prints used rather than left when the setting says so, and still fills to what is left', () => {
        const view = resolveSessionAccount({
            droverUsage: usage([{ name: 'jamrizzi', current: true, headroom: 51, limits: [] }]),
            droverAccount: 'jamrizzi',
            showRemaining: false,
        });
        expect(view.label).toBe('jamrizzi · 49% used');
        expect(view.row?.percentText).toBe('49%');
        expect(view.row?.fraction).toBeCloseTo(0.51);
    });

    it('falls back to the stamp when the snapshot marks nothing current', () => {
        const view = resolveSessionAccount({
            droverUsage: usage([{ name: 'bitspur.com', headroom: 12, limits: [] }]),
            droverAccount: 'bitspur.com',
            showRemaining: true,
        });
        expect(view.name).toBe('bitspur.com');
        expect(view.label).toBe('bitspur.com · 12% left');
    });

    it('still names the account when there is no usage snapshot at all', () => {
        // The CLI stamps droverAccount long before it stamps droverUsage, so a
        // session on an older machine knows WHICH account it is on and nothing
        // about headroom. The name with no bar beats no line at all.
        const view = resolveSessionAccount({
            droverUsage: null,
            droverAccount: 'main',
            showRemaining: true,
        });
        expect(view.name).toBe('main');
        expect(view.headroom).toBeNull();
        expect(view.label).toBe('main');
        expect(view.row?.percentText).toBeNull();
        expect(view.row?.fraction).toBe(0);
    });

    it('says nothing when nothing knows the account', () => {
        const view = resolveSessionAccount({ droverUsage: null, droverAccount: null, showRemaining: true });
        expect(view.name).toBeNull();
        expect(view.label).toBe('');
        expect(view.row).toBeNull();
    });

    it('treats a nameless account as no account, because an empty name renders as a bare text node', () => {
        const view = resolveSessionAccount({
            droverUsage: usage([{ name: '', current: true, headroom: 30, limits: [] }]),
            droverAccount: null,
            showRemaining: true,
        });
        expect(view.name).toBeNull();
        expect(view.row).toBeNull();
    });

    it('marks a logged-out account rather than hiding it', () => {
        const view = resolveSessionAccount({
            droverUsage: usage([{ name: 'risserproperties', current: true, loggedIn: false, limits: [] }]),
            droverAccount: 'risserproperties',
            showRemaining: true,
        });
        expect(view.row?.disabled).toBe(true);
        expect(view.row?.trailing).toBeTruthy();
    });
});

describe('droverAccountOf', () => {
    it('reads the stamp', () => {
        expect(droverAccountOf({ id: 'a', metadata: { droverAccount: 'jamrizzi' } })).toBe('jamrizzi');
    });

    it('maps an unstamped session to the ambient login', () => {
        // This is the case Clay actually lost: `employees` was started outside
        // the drover wrapper, reports no account, and runs on main.
        expect(droverAccountOf({ id: 'a' })).toBe(ambientDroverAccount);
        expect(droverAccountOf({ id: 'a', metadata: { droverAccount: null } })).toBe('main');
        expect(droverAccountOf({ id: 'a', metadata: { droverAccount: '  ' } })).toBe('main');
    });
});

describe('sessionsLosingRemoteControl', () => {
    const sessions = [
        { id: 'self', active: true, metadata: { droverAccount: 'bitspur.com' } },
        { id: 'employees', active: true, metadata: {} },
        { id: 'lookout', active: true, metadata: { droverAccount: 'jamrizzi' } },
        { id: 'dead', active: false, metadata: { droverAccount: 'main' } },
    ];
    const nameOf = (s: { id: string }) => s.id;

    it('names other live sessions on a different account than the target', () => {
        const rows = sessionsLosingRemoteControl({ sessions, selfId: 'self', target: 'jamrizzi', nameOf });
        expect(rows).toEqual([{ id: 'employees', label: 'employees', account: 'main' }]);
    });

    it('leaves out a session already on the target, because its binding is the one being renewed', () => {
        const rows = sessionsLosingRemoteControl({ sessions, selfId: 'self', target: 'jamrizzi', nameOf });
        expect(rows.map((r) => r.id)).not.toContain('lookout');
    });

    it('never warns about the session doing the flipping, or about an ended one', () => {
        const rows = sessionsLosingRemoteControl({ sessions, selfId: 'self', target: 'main', nameOf });
        expect(rows.map((r) => r.id)).toEqual(['lookout']);
    });

    it('rules nothing safe when the target is unknown', () => {
        // A bare /flip lets the CLI pick, so the app cannot say which account
        // survives. Over-warning by one row beats calling a chat safe and then
        // silencing it.
        const rows = sessionsLosingRemoteControl({ sessions, selfId: 'self', target: null, nameOf });
        expect(rows.map((r) => r.id)).toEqual(['employees', 'lookout']);
    });

    it('treats an empty target string as unknown', () => {
        const rows = sessionsLosingRemoteControl({ sessions, selfId: 'self', target: '  ', nameOf });
        expect(rows.map((r) => r.id)).toEqual(['employees', 'lookout']);
    });

    it('is empty when nothing else is live', () => {
        const rows = sessionsLosingRemoteControl({
            sessions: [sessions[0], sessions[3]],
            selfId: 'self',
            target: null,
            nameOf,
        });
        expect(rows).toEqual([]);
    });
});

describe('the sentences', () => {
    const rows = [
        { id: 'employees', label: 'employees', account: 'main' },
        { id: 'lookout', label: 'lookout', account: 'jamrizzi' },
    ];

    it('stays silent when nothing is at risk, rather than reassuring on every flip', () => {
        expect(flipRiskWarning([], 'jamrizzi')).toBeNull();
        expect(flipRiskSubtitle([])).toBeNull();
        expect(flipRiskFooter([])).toBeUndefined();
    });

    it('names the target, the count and every session', () => {
        const text = flipRiskWarning(rows, 'jamrizzi')!;
        expect(text).toContain('Moving to jamrizzi');
        expect(text).toContain('2 other live sessions');
        expect(text).toContain('employees (main), lookout (jamrizzi)');
    });

    it('says "another account" when the CLI is picking', () => {
        expect(flipRiskWarning(rows, null)).toContain('Moving to another account');
    });

    it('agrees in number for one session', () => {
        const text = flipRiskWarning([rows[0]], 'jamrizzi')!;
        expect(text).toContain('1 other live session ');
        expect(text).toContain('it will go quiet');
        expect(flipRiskSubtitle([rows[0]])).toBe('Drops Remote Control for 1 other live session');
    });

    it('lists the names under the section so the cost is legible without a tap', () => {
        expect(flipRiskNames(rows)).toBe('employees (main), lookout (jamrizzi)');
        expect(flipRiskFooter(rows)).toBe('A flip drops Remote Control for employees (main), lookout (jamrizzi).');
    });
});
