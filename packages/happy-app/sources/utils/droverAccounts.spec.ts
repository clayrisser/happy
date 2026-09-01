import { describe, expect, it } from 'vitest';
import {
    accountHarness,
    collectDroverAccountsFromSessions,
    cursorAccountLabel,
    cursorAccountTrailing,
    cursorAccountUsable,
    cursorQuotaUnmeasured,
    cursorRenewLabel,
    cursorTokenState,
    droverFlipMessage,
    isClaudeAccount,
    isCursorAccount,
} from './droverAccounts';

const session = (droverAccount?: string | null) => ({ metadata: { droverAccount } });

describe('collectDroverAccountsFromSessions', () => {
    it('returns the distinct stamped accounts, sorted', () => {
        expect(collectDroverAccountsFromSessions([
            session('work'),
            session('anna'),
            session('work'),
        ])).toEqual(['anna', 'work']);
    });

    it('ignores unaccounted sessions instead of inventing an account for them', () => {
        expect(collectDroverAccountsFromSessions([
            session(null),
            session(undefined),
            { metadata: null },
            {},
            session('work'),
        ])).toEqual(['work']);
    });

    it('is empty when nothing is stamped, which is what hides the action', () => {
        expect(collectDroverAccountsFromSessions([session(null), {}])).toEqual([]);
    });
});

describe('droverFlipMessage', () => {
    it('sends bare /flip when no account is named, letting the CLI pick', () => {
        expect(droverFlipMessage()).toBe('/flip');
        expect(droverFlipMessage(null)).toBe('/flip');
        expect(droverFlipMessage('')).toBe('/flip');
        expect(droverFlipMessage('   ')).toBe('/flip');
    });

    it('names the account when one is picked', () => {
        expect(droverFlipMessage('anna')).toBe('/flip anna');
        expect(droverFlipMessage('  anna  ')).toBe('/flip anna');
    });
});

/* ------------------------------------------------------------------------- *
 * DROVE-270. Two kinds of account, and the words for the second one.
 * ------------------------------------------------------------------------- */

describe('accountHarness', () => {
    it('reads absent, blank and unknown-cased as claude', () => {
        // Every registry, snapshot and session written before the field existed
        // came off a registry that held only Claude accounts, so the default
        // is not a guess — it is what those rows meant.
        expect(accountHarness(undefined)).toBe('claude');
        expect(accountHarness(null)).toBe('claude');
        expect(accountHarness({})).toBe('claude');
        expect(accountHarness({ harness: '' })).toBe('claude');
        expect(accountHarness({ harness: '  ' })).toBe('claude');
        expect(accountHarness({ harness: 'CLAUDE' })).toBe('claude');
        expect(accountHarness({ harness: ' Cursor ' })).toBe('cursor');
    });

    it('splits the two predicates so a third harness is excluded by default', () => {
        expect(isClaudeAccount({})).toBe(true);
        expect(isCursorAccount({})).toBe(false);
        expect(isClaudeAccount({ harness: 'cursor' })).toBe(false);
        expect(isCursorAccount({ harness: 'cursor' })).toBe(true);
        // Neither, rather than "claude by elimination": a harness nobody has
        // taught this app about must not inherit Claude Code's file layout.
        expect(isClaudeAccount({ harness: 'gemini' })).toBe(false);
        expect(isCursorAccount({ harness: 'gemini' })).toBe(false);
    });
});

describe('collectDroverAccountsFromSessions, with cursor rows', () => {
    const usage = (rows: { name: string; harness?: string }[]) => ({
        metadata: { droverAccount: null, droverUsage: { accounts: rows } },
    });

    it('drops a cursor account, because this list is a flip picker', () => {
        // A flip is a CLAUDE_CONFIG_DIR swap and a respawn. A cursor account
        // carries a token and has no directory to swap to, so offering it would
        // stop a session to land it nowhere.
        expect(collectDroverAccountsFromSessions([
            session('work'),
            session('cursor-me'),
            usage([{ name: 'cursor-me', harness: 'cursor' }, { name: 'work', harness: 'claude' }]),
        ])).toEqual(['work']);
    });

    it('excludes it even when the snapshot rides a different session', () => {
        // The stamp is a bare name and cannot say which harness it is, so the
        // whole set is collected before anything is admitted.
        expect(collectDroverAccountsFromSessions([
            session('cursor-me'),
            usage([{ name: 'cursor-me', harness: 'cursor' }]),
        ])).toEqual([]);
    });

    it('keeps a stamped account no snapshot mentions', () => {
        // Unknown is not cursor. A machine whose daemon predates the field
        // reports no harness at all, and its accounts are all Claude ones.
        expect(collectDroverAccountsFromSessions([session('work'), usage([])])).toEqual(['work']);
    });
});

describe('cursorTokenState', () => {
    it('returns null for a machine that reported nothing', () => {
        // Absent is "nobody looked", which is NOT `missing` ("the store holds
        // nothing"). Collapsing the two would tell Clay to sign in again over
        // an account whose daemon simply predates the field.
        expect(cursorTokenState({ harness: 'cursor' })).toBeNull();
        expect(cursorTokenState({ harness: 'cursor', tokenState: 'nonsense' })).toBeNull();
        expect(cursorTokenState({ harness: 'cursor', tokenState: 'MISSING' })).toBe('missing');
    });
});

describe('cursorRenewLabel', () => {
    const renew = (expiresInDays: number | null) =>
        ({ harness: 'cursor', tokenState: 'renew', expiresInDays });

    it('counts the days down only inside the renew window', () => {
        expect(cursorRenewLabel(renew(3))).toBe('renew in 3d');
        expect(cursorRenewLabel(renew(6))).toBe('renew in 6d');
    });

    it('says today rather than 0d on the last day', () => {
        // `renew in 0d` reads as a rendering bug at exactly the moment it must
        // not: there is no refresh flow, so this is the last warning there is.
        expect(cursorRenewLabel(renew(0))).toBe('renew today');
    });

    it('is silent on a live token, which is fifty-three of the sixty days', () => {
        expect(cursorRenewLabel({ harness: 'cursor', tokenState: 'live', expiresInDays: 40 })).toBeNull();
    });

    it('is silent on a claude account, which has no token at all', () => {
        expect(cursorRenewLabel({ harness: 'claude', tokenState: 'renew', expiresInDays: 3 })).toBeNull();
    });

    it('still warns when the day count did not come through', () => {
        // The state is the fact; the number is the detail. A machine that sent
        // one without the other must not go quiet.
        expect(cursorRenewLabel(renew(null))).toBe('renew soon');
    });
});

describe('cursorAccountLabel', () => {
    const row = (tokenState: string | null, expiresInDays: number | null = null) =>
        ({ harness: 'cursor', tokenState, expiresInDays });

    it('names the repair for each way a credential goes wrong', () => {
        // Three different causes, and only one of them is the calendar's fault
        // — so only one of them says "expired".
        expect(cursorAccountLabel(row('missing'))).toBe('no cursor token — sign in again');
        expect(cursorAccountLabel(row('tombstone'))).toBe('signed out of Cursor — sign in again');
        expect(cursorAccountLabel(row('expired'))).toBe('login expired — sign in again');
        expect(cursorAccountLabel(row('expiring'))).toBe('login expired — sign in again');
    });

    it('puts the deadline ahead of the quota sentence', () => {
        expect(cursorAccountLabel(row('renew', 3))).toBe(`renew in 3d · ${cursorQuotaUnmeasured}`);
    });

    it('says the quota is unpublished for a healthy token, and never a percentage', () => {
        expect(cursorAccountLabel(row('live', 41))).toBe(cursorQuotaUnmeasured);
        // A machine that reported no state is healthy as far as this app knows.
        expect(cursorAccountLabel(row(null))).toBe(cursorQuotaUnmeasured);
        // A format cursor changed under us is not a reason to shout.
        expect(cursorAccountLabel(row('unreadable'))).toBe(cursorQuotaUnmeasured);
    });
});

describe('cursorAccountTrailing', () => {
    const row = (tokenState: string | null, expiresInDays: number | null = null) =>
        ({ harness: 'cursor', tokenState, expiresInDays });

    it('carries the state and not the instruction, because the slot is a few words', () => {
        // A clipped instruction is worse than none, so the bar row says WHAT
        // and the Accounts page says what to do.
        expect(cursorAccountTrailing(row('missing'))).toBe('no cursor token');
        expect(cursorAccountTrailing(row('tombstone'))).toBe('signed out');
        expect(cursorAccountTrailing(row('expired'))).toBe('login expired');
        expect(cursorAccountTrailing(row('renew', 2))).toBe('renew in 2d');
        expect(cursorAccountTrailing(row('live'))).toBe(cursorQuotaUnmeasured);
    });
});

describe('cursorAccountUsable', () => {
    it('treats renew as yes, because the token works today', () => {
        // Greying out a working account for the last week of sixty days would
        // hide it, and the warning exists precisely so work keeps running.
        expect(cursorAccountUsable({ harness: 'cursor', tokenState: 'renew', expiresInDays: 1 })).toBe(true);
        expect(cursorAccountUsable({ harness: 'cursor', tokenState: 'live' })).toBe(true);
        expect(cursorAccountUsable({ harness: 'cursor', tokenState: 'unreadable' })).toBe(true);
    });

    it('treats every dead credential as no', () => {
        expect(cursorAccountUsable({ harness: 'cursor', tokenState: 'missing' })).toBe(false);
        expect(cursorAccountUsable({ harness: 'cursor', tokenState: 'tombstone' })).toBe(false);
        expect(cursorAccountUsable({ harness: 'cursor', tokenState: 'expired' })).toBe(false);
        expect(cursorAccountUsable({ harness: 'cursor', tokenState: 'expiring' })).toBe(false);
    });

    it('says yes when the machine reported no state, so an older daemon still lists', () => {
        expect(cursorAccountUsable({ harness: 'cursor' })).toBe(true);
    });
});
