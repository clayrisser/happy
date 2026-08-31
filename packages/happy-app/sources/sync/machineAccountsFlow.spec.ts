/**
 * The add-an-account flow, as a state machine (DROVE-165).
 *
 * What is pinned here is the honesty of it: every move forward is caused by
 * something the phone genuinely observed, and the one thing it cannot observe —
 * a browser login — never advances anything on its own. In particular a watch
 * that runs out says "stopped watching", not "failed", because those are
 * different facts and only one of them is true.
 */

import { describe, expect, it } from 'vitest';

import {
    addAccountBusy,
    addAccountIdle,
    addAccountStatus,
    addAccountWatchMs,
    advanceAddAccount,
    pendingAccountLoginFor,
    pendingAccountLogins,
    accountHeadroomLabel,
    accountSubtitle,
    type AddAccountPhase,
    type MachineAccount,
} from './machineAccountsFlow';

const before = ['main', 'jamrizzi'];

function waiting(overrides: Partial<Extract<AddAccountPhase, { kind: 'waiting' }>> = {}) {
    return {
        kind: 'waiting' as const,
        startedAt: 1_000,
        before,
        requested: null,
        linkReady: false,
        ...overrides,
    };
}

describe('advanceAddAccount', () => {
    it('starts, then waits once the machine says the login is running', () => {
        const starting = advanceAddAccount(addAccountIdle, { type: 'start' });
        expect(starting).toEqual({ kind: 'starting' });
        const next = advanceAddAccount(starting, {
            type: 'started', at: 1_000, before, requested: 'bitspur.com',
        });
        expect(next).toEqual(waiting({ requested: 'bitspur.com' }));
    });

    it('ignores a second tap while one login is already running', () => {
        // `drover account login` takes the next free ~/.claude-accounts/account-N,
        // so two taps really are two logins — two cards, two URLs, and no way to
        // tell which code belongs to which.
        const phase = waiting();
        expect(advanceAddAccount(phase, { type: 'start' })).toBe(phase);
        expect(advanceAddAccount({ kind: 'starting' }, { type: 'start' })).toEqual({ kind: 'starting' });
    });

    it('starts again after it finished or failed', () => {
        expect(advanceAddAccount({ kind: 'added', name: 'x' }, { type: 'start' })).toEqual({ kind: 'starting' });
        expect(advanceAddAccount({ kind: 'failed', reason: 'no' }, { type: 'start' })).toEqual({ kind: 'starting' });
        expect(advanceAddAccount({ kind: 'stoppedWatching' }, { type: 'start' })).toEqual({ kind: 'starting' });
    });

    it('fails when the RPC itself was refused', () => {
        const phase = advanceAddAccount({ kind: 'starting' }, {
            type: 'startFailed', reason: 'the drover wrapper was not found',
        });
        expect(phase).toEqual({ kind: 'failed', reason: 'the drover wrapper was not found' });
    });

    it('records the link arriving, and does not churn when it has not changed', () => {
        const phase = waiting();
        const ready = advanceAddAccount(phase, { type: 'link', ready: true });
        expect(ready).toEqual(waiting({ linkReady: true }));
        // Identity, not equality: a new object every poll would re-render the
        // screen for nothing.
        expect(advanceAddAccount(ready, { type: 'link', ready: true })).toBe(ready);
    });

    it('adds the account when a NEW name appears in that machine list', () => {
        // The registry row is written by the shell only after Claude Code says
        // it is logged in, so a name that was not there before IS the success.
        const phase = waiting({ linkReady: true });
        const next = advanceAddAccount(phase, {
            type: 'accounts', at: 2_000, names: ['main', 'jamrizzi', 'bitspur.com'],
        });
        expect(next).toEqual({ kind: 'added', name: 'bitspur.com' });
    });

    it('keeps waiting while the list is unchanged', () => {
        const phase = waiting();
        expect(advanceAddAccount(phase, { type: 'accounts', at: 2_000, names: before })).toBe(phase);
    });

    it('does not mistake a REMOVED account for a new one', () => {
        const phase = waiting();
        expect(advanceAddAccount(phase, { type: 'accounts', at: 2_000, names: ['main'] })).toBe(phase);
    });

    it('stops watching, and never calls it a failure', () => {
        // The phone cannot see a browser. It has no idea whether the login is
        // still going, so it says only what it knows: it stopped looking.
        const phase = waiting({ linkReady: true });
        const next = advanceAddAccount(phase, {
            type: 'accounts', at: 1_000 + addAccountWatchMs, names: before,
        });
        expect(next).toEqual({ kind: 'stoppedWatching' });
    });

    it('takes a late success over the timeout when both land together', () => {
        const phase = waiting();
        const next = advanceAddAccount(phase, {
            type: 'accounts', at: 1_000 + addAccountWatchMs, names: [...before, 'late'],
        });
        expect(next).toEqual({ kind: 'added', name: 'late' });
    });

    it('ignores an account list that arrives when nothing is being added', () => {
        for (const phase of [addAccountIdle, { kind: 'starting' } as const, { kind: 'added', name: 'x' } as const]) {
            expect(advanceAddAccount(phase, { type: 'accounts', at: 9_000, names: ['brand-new'] })).toBe(phase);
        }
    });

    it('ignores a started or a link that arrives out of order', () => {
        expect(advanceAddAccount(addAccountIdle, { type: 'started', at: 1, before: [], requested: null }))
            .toBe(addAccountIdle);
        expect(advanceAddAccount(addAccountIdle, { type: 'link', ready: true })).toBe(addAccountIdle);
        expect(advanceAddAccount(addAccountIdle, { type: 'startFailed', reason: 'x' })).toBe(addAccountIdle);
    });

    it('dismisses back to idle from anywhere', () => {
        expect(advanceAddAccount({ kind: 'added', name: 'x' }, { type: 'dismiss' })).toEqual(addAccountIdle);
        expect(advanceAddAccount(waiting(), { type: 'dismiss' })).toEqual(addAccountIdle);
    });

    it('runs a whole successful login end to end', () => {
        let phase: AddAccountPhase = addAccountIdle;
        phase = advanceAddAccount(phase, { type: 'start' });
        phase = advanceAddAccount(phase, { type: 'started', at: 0, before, requested: null });
        phase = advanceAddAccount(phase, { type: 'accounts', at: 5_000, names: before });
        phase = advanceAddAccount(phase, { type: 'link', ready: true });
        expect(addAccountStatus(phase)?.hasLink).toBe(true);
        phase = advanceAddAccount(phase, { type: 'accounts', at: 60_000, names: [...before, 'new@x.com'] });
        expect(phase).toEqual({ kind: 'added', name: 'new@x.com' });
        expect(addAccountBusy(phase)).toBe(false);
    });
});

describe('addAccountBusy', () => {
    it('is true exactly while a login is in flight', () => {
        expect(addAccountBusy(addAccountIdle)).toBe(false);
        expect(addAccountBusy({ kind: 'starting' })).toBe(true);
        expect(addAccountBusy(waiting())).toBe(true);
        expect(addAccountBusy({ kind: 'added', name: 'x' })).toBe(false);
        expect(addAccountBusy({ kind: 'stoppedWatching' })).toBe(false);
    });
});

describe('addAccountStatus', () => {
    it('says nothing at all when nothing is happening', () => {
        expect(addAccountStatus(addAccountIdle)).toBeNull();
    });

    it('does not promise a link before there is one', () => {
        const early = addAccountStatus(waiting())!;
        expect(early.hasLink).toBe(false);
        expect(early.watching).toBe(true);
        expect(early.title).toContain('link');
    });

    it('tells him the three steps once the link is there', () => {
        const ready = addAccountStatus(waiting({ linkReady: true }))!;
        expect(ready.hasLink).toBe(true);
        expect(ready.detail).toContain('sign in');
        expect(ready.detail).toContain('code');
    });

    it('carries the machine’s own refusal, rather than a generic apology', () => {
        const failed = addAccountStatus({ kind: 'failed', reason: 'DROVER_BIN is not set' })!;
        expect(failed.detail).toBe('DROVER_BIN is not set');
    });

    it('never says the login failed when it only stopped watching', () => {
        const stopped = addAccountStatus({ kind: 'stoppedWatching' })!;
        expect(stopped.title).toBe('Stopped watching');
        expect(stopped.detail).toContain('may still be running');
        expect(stopped.detail.toLowerCase()).not.toContain('failed');
    });
});

describe('pendingAccountLogins', () => {
    const card = (url: string | null) => ({
        tool: 'DroverAccountLogin',
        arguments: url === null ? {} : { url },
    });

    it('finds the card and the machine whose login raised it', () => {
        const found = pendingAccountLogins({
            bridgeA: {
                metadata: { machineId: 'mac-1' },
                agentState: { requests: { r1: card('https://claude.com/cai/oauth/authorize?x=1') } },
            },
        });
        expect(found).toEqual([{
            sessionId: 'bridgeA',
            machineId: 'mac-1',
            url: 'https://claude.com/cai/oauth/authorize?x=1',
        }]);
    });

    it('keeps a card whose url has not arrived yet, with url null', () => {
        // The bridge raises the same gate for the FAILURE notice, whose preview
        // is a sentence and not a link. The row still belongs to the machine;
        // it just has nothing to open.
        const found = pendingAccountLogins({
            b: { metadata: { machineId: 'mac-1' }, agentState: { requests: { r: card(null) } } },
        });
        expect(found[0].url).toBeNull();
    });

    it('drops a card whose session names no machine rather than guessing one', () => {
        expect(pendingAccountLogins({
            b: { metadata: {}, agentState: { requests: { r: card('https://x/oauth/authorize') } } },
        })).toEqual([]);
    });

    it('ignores every other kind of pending request', () => {
        expect(pendingAccountLogins({
            b: {
                metadata: { machineId: 'mac-1' },
                agentState: { requests: { r: { tool: 'Bash', arguments: { command: 'ls' } } } },
            },
            c: { metadata: { machineId: 'mac-1' }, agentState: { requests: null } },
            d: { metadata: { machineId: 'mac-1' } },
        })).toEqual([]);
    });

    it('picks the card for one machine and leaves the other machine alone', () => {
        const sessions = {
            a: {
                metadata: { machineId: 'mac-1' },
                agentState: { requests: { r: card('https://a/oauth/authorize') } },
            },
            b: {
                metadata: { machineId: 'mac-2' },
                agentState: { requests: { r: card('https://b/oauth/authorize') } },
            },
        };
        expect(pendingAccountLoginFor(sessions, 'mac-2')?.url).toBe('https://b/oauth/authorize');
        expect(pendingAccountLoginFor(sessions, 'mac-3')).toBeNull();
    });
});

function account(overrides: Partial<MachineAccount> = {}): MachineAccount {
    return {
        name: 'jamrizzi',
        configDir: '/Users/clay/.claude-accounts/jamrizzi',
        ambient: false,
        loggedIn: true,
        login: 'jamrizzi@gmail.com',
        sameLoginAs: null,
        headroom: 43,
        cooling: null,
        limits: [],
        fetchedAt: null,
        ...overrides,
    };
}

describe('accountHeadroomLabel', () => {
    it('prints the measured figure', () => {
        expect(accountHeadroomLabel(account({ headroom: 43.4 }))).toBe('43% left');
    });

    it('says an account has never been logged in, rather than showing zero', () => {
        // A row with no login is not an account with no headroom: a flip onto
        // it lands in Claude Code's first-run wizard, which a wrapped session
        // cannot answer. The two must not read the same.
        expect(accountHeadroomLabel(account({ loggedIn: false, headroom: null }))).toBe('no login yet');
    });

    it('says nothing has measured it, rather than inventing a number', () => {
        expect(accountHeadroomLabel(account({ headroom: null }))).toBe('not measured yet');
    });

    it('says out of headroom while it is cooling, whatever the cache last read', () => {
        expect(accountHeadroomLabel(account({ headroom: 12, cooling: { until: 1, reason: 'limit' } })))
            .toBe('out of headroom');
    });
});

describe('accountSubtitle', () => {
    it('leads with the address, because that is what Clay recognises', () => {
        expect(accountSubtitle(account())).toBe('jamrizzi@gmail.com · 43% left');
    });

    it('names the row it shares a quota with', () => {
        // DROVE-21: two names, one claude.ai login. Without this the two rows
        // show identical bars and read as a bug.
        expect(accountSubtitle(account({ name: 'risserproperties', sameLoginAs: 'main' })))
            .toContain('same login as main');
    });

    it('marks the ambient login, which is the one that cannot be removed here', () => {
        expect(accountSubtitle(account({ ambient: true }))).toContain('main login');
    });

    it('drops the address when there is none rather than printing an empty field', () => {
        expect(accountSubtitle(account({ login: null, loggedIn: false, headroom: null })))
            .toBe('no login yet');
    });
});
