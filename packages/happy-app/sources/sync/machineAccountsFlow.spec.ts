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
    addAccountEntry,
    addAccountHref,
    addAccountIdle,
    addAccountLinkWaitMs,
    addAccountMachineParam,
    addAccountStatus,
    addAccountWatchMs,
    advanceAddAccount,
    autoOpenLoginUrl,
    autoStartAddAccount,
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
        linkReady: false,
        linkLate: false,
        ...overrides,
    };
}

describe('advanceAddAccount', () => {
    it('starts, then waits once the machine says the login is running', () => {
        const starting = advanceAddAccount(addAccountIdle, { type: 'start' });
        expect(starting).toEqual({ kind: 'starting' });
        const next = advanceAddAccount(starting, { type: 'started', at: 1_000, before });
        expect(next).toEqual(waiting());
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
        expect(advanceAddAccount(addAccountIdle, { type: 'started', at: 1, before: [] }))
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
        phase = advanceAddAccount(phase, { type: 'started', at: 0, before });
        phase = advanceAddAccount(phase, { type: 'accounts', at: 5_000, names: before });
        phase = advanceAddAccount(phase, { type: 'link', ready: true });
        expect(addAccountStatus(phase)?.hasLink).toBe(true);
        phase = advanceAddAccount(phase, { type: 'accounts', at: 60_000, names: [...before, 'new@x.com'] });
        expect(phase).toEqual({ kind: 'added', name: 'new@x.com' });
        expect(addAccountBusy(phase)).toBe(false);
    });

    it('says so when no link came back, and keeps watching', () => {
        // DROVE-212. The login runs detached on a Mac nobody is looking at, so
        // its failure reaches the phone as silence. Silence is what gets said.
        const phase = waiting();
        const late = advanceAddAccount(phase, {
            type: 'accounts', at: 1_000 + addAccountLinkWaitMs, names: before,
        });
        expect(late).toEqual(waiting({ linkLate: true }));
        expect(addAccountBusy(late)).toBe(true);
    });

    it('does not call it late one tick early', () => {
        const phase = waiting();
        expect(advanceAddAccount(phase, {
            type: 'accounts', at: 1_000 + addAccountLinkWaitMs - 1, names: before,
        })).toBe(phase);
    });

    it('a link that turns up late takes the sentence saying there was none with it', () => {
        const late = waiting({ linkLate: true });
        expect(advanceAddAccount(late, { type: 'link', ready: true }))
            .toEqual(waiting({ linkReady: true, linkLate: false }));
    });

    it('never calls it late once the link is already there', () => {
        const ready = waiting({ linkReady: true });
        expect(advanceAddAccount(ready, {
            type: 'accounts', at: 1_000 + addAccountLinkWaitMs, names: before,
        })).toBe(ready);
    });

    it('a new account still wins over the link being late', () => {
        expect(advanceAddAccount(waiting(), {
            type: 'accounts', at: 1_000 + addAccountLinkWaitMs, names: [...before, 'added@example.com'],
        })).toEqual({ kind: 'added', name: 'added@example.com' });
    });

    // DROVE-212, the second time. The deadlines used to ride on `accounts`,
    // which is dispatched only when a `drover-accounts` read comes back OK. A
    // phone that is backgrounded or reconnecting reads nothing, so the clock
    // stopped and the spinner had no upper bound at all. Time alone has to be
    // enough to end it.
    it('says no link came back on time alone, with no account list at all', () => {
        const late = advanceAddAccount(waiting(), {
            type: 'tick', at: 1_000 + addAccountLinkWaitMs,
        });
        expect(late).toEqual(waiting({ linkLate: true }));
        expect(addAccountBusy(late)).toBe(true);
    });

    it('does not call a tick late one millisecond early', () => {
        const phase = waiting();
        expect(advanceAddAccount(phase, { type: 'tick', at: 1_000 + addAccountLinkWaitMs - 1 }))
            .toBe(phase);
    });

    it('stops watching on time alone', () => {
        expect(advanceAddAccount(waiting(), { type: 'tick', at: 1_000 + addAccountWatchMs }))
            .toEqual({ kind: 'stoppedWatching' });
    });

    it('never calls a tick late once the link is already there', () => {
        const ready = waiting({ linkReady: true });
        expect(advanceAddAccount(ready, { type: 'tick', at: 1_000 + addAccountLinkWaitMs }))
            .toBe(ready);
    });

    it('ignores a tick outside the wait', () => {
        const added = { kind: 'added' as const, name: 'added@example.com' };
        expect(advanceAddAccount(added, { type: 'tick', at: 9_000_000 })).toBe(added);
    });
});

describe('autoOpenLoginUrl (DROVE-212)', () => {
    const url = 'https://claude.com/cai/oauth/authorize?code=true';

    it('opens the sign-in page the moment the machine sends it', () => {
        expect(autoOpenLoginUrl({ phase: waiting({ linkReady: true }), url, opened: null })).toBe(url);
    });

    it('opens one link exactly once, however often the screen re-renders', () => {
        expect(autoOpenLoginUrl({ phase: waiting({ linkReady: true }), url, opened: url })).toBeNull();
    });

    it('opens a second, different link after a retry', () => {
        const retry = 'https://claude.com/cai/oauth/authorize?code=true&try=2';
        expect(autoOpenLoginUrl({ phase: waiting({ linkReady: true }), url: retry, opened: url })).toBe(retry);
    });

    it('opens nothing when no login of ours is in flight', () => {
        // A card the bridge never cleaned up outlives its login. Opening it on
        // arrival at this screen would throw Clay into a dead sign-in page he
        // never asked for.
        expect(autoOpenLoginUrl({ phase: addAccountIdle, url, opened: null })).toBeNull();
        expect(autoOpenLoginUrl({ phase: { kind: 'starting' }, url, opened: null })).toBeNull();
        expect(autoOpenLoginUrl({ phase: { kind: 'added', name: 'x' }, url, opened: null })).toBeNull();
    });

    it('opens nothing when there is no link, or the link is not https', () => {
        expect(autoOpenLoginUrl({ phase: waiting(), url: null, opened: null })).toBeNull();
        expect(autoOpenLoginUrl({ phase: waiting(), url: undefined, opened: null })).toBeNull();
        expect(autoOpenLoginUrl({ phase: waiting(), url: 'claude://x', opened: null })).toBeNull();
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
        expect(ready.detail).toContain('Sign in');
        expect(ready.detail).toContain('code');
    });

    it('points at his browser rather than naming a card to go and find', () => {
        // DROVE-212: the link used to be two taps away behind a share sheet,
        // so the words pointed at a card. They point at his browser now.
        expect(addAccountStatus(waiting())!.detail).toContain('browser');
        expect(addAccountStatus(waiting({ linkReady: true }))!.detail).toContain('browser');
    });

    it('says no link came back without calling the login failed', () => {
        const late = addAccountStatus(waiting({ linkLate: true }))!;
        expect(late.hasLink).toBe(false);
        expect(late.watching).toBe(true);
        // Still watching, but the spinner stops: a spinner beside "no link came
        // back" would be the row disagreeing with itself.
        expect(late.spinner).toBe(false);
        expect(addAccountStatus(waiting())!.spinner).toBe(true);
        expect(late.title).toBe('No sign-in link came back');
        expect(late.detail).toContain('may have failed');
        expect(late.title.toLowerCase()).not.toContain('failed');
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
    const card = (url: string | null, createdAt?: number) => ({
        tool: 'DroverAccountLogin',
        arguments: url === null ? {} : { url },
        ...(createdAt === undefined ? {} : { createdAt }),
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
            requestId: 'r1',
            args: { url: 'https://claude.com/cai/oauth/authorize?x=1' },
            machineId: 'mac-1',
            url: 'https://claude.com/cai/oauth/authorize?x=1',
            createdAt: null,
        }]);
    });

    it('carries the request id and the raw arguments, so Accounts can answer in place (DROVE-238)', () => {
        // Clay: "Why did it make me enter the code in a question prompt instead
        // of in the same accounts page where we clicked the link." It did that
        // because this walked Object.values and threw the key away, so the
        // screen knew a login was waiting and had no address to reply to — all
        // it could offer was a push into the session holding the card. The id
        // and the arguments are what let the code box live on the row.
        const found = pendingAccountLogins({
            bridge: {
                metadata: { machineId: 'mac-1' },
                agentState: {
                    requests: {
                        'req-7': {
                            tool: 'DroverAccountLogin',
                            arguments: {
                                url: 'https://claude.com/cai/oauth/authorize?x=1',
                                header: 'Log in to Claude for ~/.claude-accounts/account-2',
                                reason: 'Open this in a browser, sign in, then send back the code it shows.',
                                cancelLabel: 'Cancel the login',
                            },
                        },
                    },
                },
            },
        });
        expect(found[0].requestId).toBe('req-7');
        // Whole, not unpicked: DroverAccountLoginBody reads the heading, the
        // reason and the cancel label itself.
        expect(found[0].args).toEqual({
            url: 'https://claude.com/cai/oauth/authorize?x=1',
            header: 'Log in to Claude for ~/.claude-accounts/account-2',
            reason: 'Open this in a browser, sign in, then send back the code it shows.',
            cancelLabel: 'Cancel the login',
        });
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

    it('carries when the machine raised the card', () => {
        const found = pendingAccountLogins({
            b: {
                metadata: { machineId: 'mac-1' },
                agentState: { requests: { r: card('https://a/oauth/authorize', 7_000) } },
            },
        });
        expect(found[0].createdAt).toBe(7_000);
    });

    it('takes the newest card, so an abandoned login does not win (DROVE-212)', () => {
        const sessions = {
            b: {
                metadata: { machineId: 'mac-1' },
                agentState: {
                    requests: {
                        old: card('https://old/oauth/authorize', 1_000),
                        fresh: card('https://fresh/oauth/authorize', 9_000),
                    },
                },
            },
        };
        expect(pendingAccountLoginFor(sessions, 'mac-1')?.url).toBe('https://fresh/oauth/authorize');
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

/**
 * Getting into the flow from the quota sheet (DROVE-208).
 *
 * The sheet is scoped to a session and a session runs on exactly one machine,
 * so the add row targets that machine and asks nothing. What has to hold is
 * that it never targets a machine it does not have, and that arriving here
 * cannot start a login before the list it will be measured against is read.
 */
describe('the quota sheet\'s way into the flow (DROVE-208)', () => {
    it('targets the session\'s machine and names it, so the target is never implied', () => {
        const entry = addAccountEntry({ machineId: 'm-drogon', machineName: 'drogon' });
        expect(entry).toEqual({
            machineId: 'm-drogon',
            machineName: 'drogon',
            href: `/settings/accounts?${addAccountMachineParam}=m-drogon`,
        });
    });

    it('falls back to the same short id the Accounts screen shows, not to two names', () => {
        // One machine called two things on two screens is how "which Mac did
        // that land on" becomes unanswerable.
        expect(addAccountEntry({ machineId: 'abcdef0123456789' })?.machineName).toBe('abcdef01');
        expect(addAccountEntry({ machineId: 'abcdef0123456789', machineName: '  ' })?.machineName)
            .toBe('abcdef01');
    });

    it('draws no row at all when the session has no machine stamped on it', () => {
        // An add row that cannot say where it is adding is the flat-pool lie
        // DROVE-165 refused. Settings → Accounts is still there.
        expect(addAccountEntry({ machineId: null })).toBeNull();
        expect(addAccountEntry({ machineId: undefined })).toBeNull();
        expect(addAccountEntry({ machineId: '   ' })).toBeNull();
    });

    it('escapes the id it puts in the route', () => {
        expect(addAccountHref('a b&c')).toBe(`/settings/accounts?${addAccountMachineParam}=a%20b%26c`);
    });

    it('waits for that machine\'s account list before starting anything', () => {
        // `before` is the whole basis of "a new name appeared, so it worked".
        // Started on an empty list, the first account ever read back would
        // look like the one just added.
        expect(autoStartAddAccount({
            requested: 'm-drogon', started: false, online: true, accounts: null,
        })).toBeNull();
        expect(autoStartAddAccount({
            requested: 'm-drogon', started: false, online: true, accounts: ['main', 'jamrizzi'],
        })).toEqual(['main', 'jamrizzi']);
    });

    it('starts once per arrival, never twice', () => {
        expect(autoStartAddAccount({
            requested: 'm-drogon', started: true, online: true, accounts: ['main'],
        })).toBeNull();
    });

    it('does nothing when nobody named a machine, which is the plain visit', () => {
        expect(autoStartAddAccount({
            requested: null, started: false, online: true, accounts: ['main'],
        })).toBeNull();
    });

    it('does not prompt in front of a refusal when that machine is offline', () => {
        expect(autoStartAddAccount({
            requested: 'm-drogon', started: false, online: false, accounts: ['main'],
        })).toBeNull();
    });

    it('carries an empty list through, because a machine with no accounts is the point', () => {
        expect(autoStartAddAccount({
            requested: 'm-drogon', started: false, online: true, accounts: [],
        })).toEqual([]);
    });
});
