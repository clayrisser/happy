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
    accountCanRun,
    accountGroupFooter,
    accountGroupTitle,
    accountHeadroomLabel,
    accountHarnessOrder,
    accountSubtitle,
    accountsByHarness,
    freshCursorAccounts,
    isBackdoorAccount,
    loginCommand,
    phaseHarness,
    staleCursorAccounts,
    type AddAccountPhase,
    type MachineAccount,
} from './machineAccountsFlow';

const before = ['main', 'jamrizzi'];

/**
 * The whole of what one status row says, title and detail together.
 *
 * The details are fragments now (DROVE-346, DROVE-351) and a fact that used to
 * live in the sentence often lives in the title instead. What these specs are
 * really pinning is that the row SAYS it, not which of its two lines carries
 * it, so they read both.
 */
function said(status: { title: string; detail: string }): string {
    return `${status.title} ${status.detail}`;
}

function waiting(overrides: Partial<Extract<AddAccountPhase, { kind: 'waiting' }>> = {}) {
    return {
        kind: 'waiting' as const,
        // Claude by default (DROVE-270), so every assertion written before the
        // harness existed still pins the Claude wording it was written for.
        harness: 'claude' as const,
        startedAt: 1_000,
        before,
        // Nothing was due a renewal, which is what every assertion written
        // before cursor existed assumed (DROVE-270).
        stale: [] as string[],
        linkReady: false,
        // No link has ever come back, which is what every assertion written
        // before DROVE-334 assumed. `linkReady` is whether a card is open NOW;
        // this is whether one ever was, and only this one ends the wait.
        linkSeen: false,
        linkLate: false,
        ...overrides,
    };
}

describe('advanceAddAccount', () => {
    it('starts, then waits once the machine says the login is running', () => {
        const starting = advanceAddAccount(addAccountIdle, { type: 'start', harness: 'claude' });
        expect(starting).toEqual({ kind: 'starting', harness: 'claude' });
        const next = advanceAddAccount(starting, { type: 'started', at: 1_000, before });
        expect(next).toEqual(waiting());
    });

    it('ignores a second tap while one login is already running', () => {
        // `drover account login` takes the next free ~/.claude-accounts/account-N,
        // so two taps really are two logins — two cards, two URLs, and no way to
        // tell which code belongs to which.
        const phase = waiting();
        expect(advanceAddAccount(phase, { type: 'start', harness: 'claude' })).toBe(phase);
        expect(advanceAddAccount({ kind: 'starting', harness: 'claude' }, { type: 'start', harness: 'claude' })).toEqual({ kind: 'starting', harness: 'claude' });
    });

    it('starts again after it finished or failed', () => {
        expect(advanceAddAccount({ kind: 'added', harness: 'claude', name: 'x' }, { type: 'start', harness: 'claude' })).toEqual({ kind: 'starting', harness: 'claude' });
        expect(advanceAddAccount({ kind: 'failed', harness: 'claude', reason: 'no' }, { type: 'start', harness: 'claude' })).toEqual({ kind: 'starting', harness: 'claude' });
        expect(advanceAddAccount({ kind: 'stoppedWatching', harness: 'claude' }, { type: 'start', harness: 'claude' })).toEqual({ kind: 'starting', harness: 'claude' });
    });

    it('fails when the RPC itself was refused', () => {
        const phase = advanceAddAccount({ kind: 'starting', harness: 'claude' }, {
            type: 'startFailed', reason: 'the drover wrapper was not found',
        });
        expect(phase).toEqual({ kind: 'failed', harness: 'claude', reason: 'the drover wrapper was not found' });
    });

    it('records the link arriving, and does not churn when it has not changed', () => {
        const phase = waiting();
        const ready = advanceAddAccount(phase, { type: 'link', ready: true });
        expect(ready).toEqual(waiting({ linkReady: true, linkSeen: true }));
        // Identity, not equality: a new object every poll would re-render the
        // screen for nothing.
        expect(advanceAddAccount(ready, { type: 'link', ready: true })).toBe(ready);
    });

    it('adds the account when a NEW name appears in that machine list', () => {
        // The registry row is written by the shell only after Claude Code says
        // it is logged in, so a name that was not there before IS the success.
        const phase = waiting({ linkReady: true, linkSeen: true });
        const next = advanceAddAccount(phase, {
            type: 'accounts', at: 2_000, names: ['main', 'jamrizzi', 'bitspur.com'],
        });
        expect(next).toEqual({ kind: 'added', harness: 'claude', name: 'bitspur.com' });
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
        const phase = waiting({ linkReady: true, linkSeen: true });
        const next = advanceAddAccount(phase, {
            type: 'accounts', at: 1_000 + addAccountWatchMs, names: before,
        });
        expect(next).toEqual({ kind: 'stoppedWatching', harness: 'claude' });
    });

    it('takes a late success over the timeout when both land together', () => {
        const phase = waiting();
        const next = advanceAddAccount(phase, {
            type: 'accounts', at: 1_000 + addAccountWatchMs, names: [...before, 'late'],
        });
        expect(next).toEqual({ kind: 'added', harness: 'claude', name: 'late' });
    });

    it('ignores an account list that arrives when nothing is being added', () => {
        for (const phase of [addAccountIdle, { kind: 'starting', harness: 'claude' } as const, { kind: 'added', harness: 'claude', name: 'x' } as const]) {
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
        expect(advanceAddAccount({ kind: 'added', harness: 'claude', name: 'x' }, { type: 'dismiss' })).toEqual(addAccountIdle);
        expect(advanceAddAccount(waiting(), { type: 'dismiss' })).toEqual(addAccountIdle);
    });

    it('runs a whole successful login end to end', () => {
        let phase: AddAccountPhase = addAccountIdle;
        phase = advanceAddAccount(phase, { type: 'start', harness: 'claude' });
        phase = advanceAddAccount(phase, { type: 'started', at: 0, before });
        phase = advanceAddAccount(phase, { type: 'accounts', at: 5_000, names: before });
        phase = advanceAddAccount(phase, { type: 'link', ready: true });
        expect(addAccountStatus(phase)?.hasLink).toBe(true);
        phase = advanceAddAccount(phase, { type: 'accounts', at: 60_000, names: [...before, 'new@x.com'] });
        expect(phase).toEqual({ kind: 'added', harness: 'claude', name: 'new@x.com' });
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
            .toEqual(waiting({ linkReady: true, linkSeen: true, linkLate: false }));
    });

    it('never calls it late once the link is already there', () => {
        const ready = waiting({ linkReady: true, linkSeen: true });
        expect(advanceAddAccount(ready, {
            type: 'accounts', at: 1_000 + addAccountLinkWaitMs, names: before,
        })).toBe(ready);
    });

    it('a new account still wins over the link being late', () => {
        expect(advanceAddAccount(waiting(), {
            type: 'accounts', at: 1_000 + addAccountLinkWaitMs, names: [...before, 'added@example.com'],
        })).toEqual({ kind: 'added', harness: 'claude', name: 'added@example.com' });
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
            .toEqual({ kind: 'stoppedWatching', harness: 'claude' });
    });

    it('never calls a tick late once the link is already there', () => {
        const ready = waiting({ linkReady: true, linkSeen: true });
        expect(advanceAddAccount(ready, { type: 'tick', at: 1_000 + addAccountLinkWaitMs }))
            .toBe(ready);
    });

    /**
     * DROVE-334, and it is the whole ticket. Wall-clock timings are tonight's,
     * off ~/.local/state/cattle-drover/logs/bus.log:
     *
     *   +0s   the phone's drover-account-login RPC (22:16:22Z)
     *   +10s  event 6e0a598b created — the card, with the authorize URL
     *   +32s  event 6e0a598b resolved: text by phone — Clay sent his code
     *   +60s  the link-wait deadline, which told him no link came back
     */
    it('never says no link came back once the code has been sent', () => {
        const started = advanceAddAccount(
            advanceAddAccount(addAccountIdle, { type: 'start', harness: 'claude' }),
            { type: 'started', at: 1_000, before },
        );
        // +10s: the card lands.
        const withLink = advanceAddAccount(started, { type: 'link', ready: true });
        expect(addAccountStatus(withLink)!.hasLink).toBe(true);
        // +32s: Clay answers it, so the bridge retires the request and the
        // screen's `cardFor` goes null — a link event with ready false.
        const answered = advanceAddAccount(withLink, { type: 'link', ready: false });
        expect(answered).toEqual(waiting({ linkReady: false, linkSeen: true }));
        // +60s: the deadline. It must not fire on a login that had its link.
        const atDeadline = advanceAddAccount(answered, { type: 'tick', at: 1_000 + addAccountLinkWaitMs });
        expect(atDeadline).toBe(answered);
        expect(addAccountStatus(atDeadline)!.title).not.toContain('No sign-in link');
        // And it is still watching, because the Mac is still finishing.
        expect(addAccountBusy(atDeadline)).toBe(true);
    });

    it('says the machine is finishing once the card is spent', () => {
        const spent = waiting({ linkReady: false, linkSeen: true });
        const status = addAccountStatus(spent)!;
        expect(status.title).toBe('Finishing the login on that machine\u2026');
        expect(status.hasLink).toBe(false);
        expect(status.spinner).toBe(true);
        expect(status.watching).toBe(true);
    });

    it('a link that arrives while the RPC is still in flight is not lost', () => {
        // The card can beat `started` — the RPC took 3s tonight and 4.2s an
        // hour earlier, and the shell can have the URL out in less. Dropping
        // the event left the screen with no link it would ever notice again.
        const starting = advanceAddAccount(addAccountIdle, { type: 'start', harness: 'claude' });
        const early = advanceAddAccount(starting, { type: 'link', ready: true });
        expect(early).toEqual({ kind: 'starting', harness: 'claude', linkSeen: true });
        const waitingNow = advanceAddAccount(early, { type: 'started', at: 1_000, before });
        expect(waitingNow).toEqual(waiting({ linkReady: true, linkSeen: true }));
        expect(addAccountStatus(waitingNow)!.hasLink).toBe(true);
        // ...and the deadline it used to dead-end at now passes it by.
        expect(advanceAddAccount(waitingNow, { type: 'tick', at: 1_000 + addAccountLinkWaitMs }))
            .toBe(waitingNow);
    });

    it('ignores a link that has not arrived while the RPC is in flight', () => {
        const starting = advanceAddAccount(addAccountIdle, { type: 'start', harness: 'claude' });
        expect(advanceAddAccount(starting, { type: 'link', ready: false })).toBe(starting);
    });

    it('a link arriving AFTER the deadline still flips the screen to hasLink', () => {
        const late = advanceAddAccount(waiting(), { type: 'tick', at: 1_000 + addAccountLinkWaitMs });
        expect(addAccountStatus(late)!.title).toBe('No sign-in link came back');
        const arrived = advanceAddAccount(late, { type: 'link', ready: true });
        expect(arrived).toEqual(waiting({ linkReady: true, linkSeen: true, linkLate: false }));
        expect(addAccountStatus(arrived)!.hasLink).toBe(true);
        // And once seen it stays seen: answering it cannot put the sentence back.
        const answered = advanceAddAccount(arrived, { type: 'link', ready: false });
        expect(addAccountStatus(answered)!.title).not.toContain('No sign-in link');
        expect(advanceAddAccount(answered, { type: 'tick', at: 1_000 + 2 * addAccountLinkWaitMs }))
            .toBe(answered);
    });

    it('a fresh login starts with no link seen, whatever the last one saw', () => {
        const done = advanceAddAccount(waiting({ linkReady: true, linkSeen: true }), {
            type: 'accounts', at: 2_000, names: [...before, 'added@example.com'],
        });
        const again = advanceAddAccount(done, { type: 'start', harness: 'claude' });
        expect(again).toEqual({ kind: 'starting', harness: 'claude' });
        expect(advanceAddAccount(again, { type: 'started', at: 9_000, before }))
            .toEqual(waiting({ startedAt: 9_000 }));
    });

    it('ignores a tick outside the wait', () => {
        const added = { kind: 'added' as const, harness: 'claude' as const, name: 'added@example.com' };
        expect(advanceAddAccount(added, { type: 'tick', at: 9_000_000 })).toBe(added);
    });
});

describe('autoOpenLoginUrl (DROVE-212)', () => {
    const url = 'https://claude.com/cai/oauth/authorize?code=true';

    it('opens the sign-in page the moment the machine sends it', () => {
        expect(autoOpenLoginUrl({ phase: waiting({ linkReady: true, linkSeen: true }), url, opened: null })).toBe(url);
    });

    it('opens one link exactly once, however often the screen re-renders', () => {
        expect(autoOpenLoginUrl({ phase: waiting({ linkReady: true, linkSeen: true }), url, opened: url })).toBeNull();
    });

    it('opens a second, different link after a retry', () => {
        const retry = 'https://claude.com/cai/oauth/authorize?code=true&try=2';
        expect(autoOpenLoginUrl({ phase: waiting({ linkReady: true, linkSeen: true }), url: retry, opened: url })).toBe(retry);
    });

    it('opens nothing when no login of ours is in flight', () => {
        // A card the bridge never cleaned up outlives its login. Opening it on
        // arrival at this screen would throw Clay into a dead sign-in page he
        // never asked for.
        expect(autoOpenLoginUrl({ phase: addAccountIdle, url, opened: null })).toBeNull();
        expect(autoOpenLoginUrl({ phase: { kind: 'starting', harness: 'claude' }, url, opened: null })).toBeNull();
        expect(autoOpenLoginUrl({ phase: { kind: 'added', harness: 'claude', name: 'x' }, url, opened: null })).toBeNull();
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
        expect(addAccountBusy({ kind: 'starting', harness: 'claude' })).toBe(true);
        expect(addAccountBusy(waiting())).toBe(true);
        expect(addAccountBusy({ kind: 'added', harness: 'claude', name: 'x' })).toBe(false);
        expect(addAccountBusy({ kind: 'stoppedWatching', harness: 'claude' })).toBe(false);
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
        // Title AND detail, because the detail is a fragment now (DROVE-351):
        // the step that used to be a clause in a sentence is the title, and
        // what the row has to SAY is the same either way.
        const ready = addAccountStatus(waiting({ linkReady: true, linkSeen: true }))!;
        expect(ready.hasLink).toBe(true);
        expect(said(ready)).toContain('Sign in');
        expect(said(ready)).toContain('code');
    });

    it('points at his browser rather than naming a card to go and find', () => {
        // DROVE-212: the link used to be two taps away behind a share sheet,
        // so the words pointed at a card. They point at his browser now.
        expect(said(addAccountStatus(waiting())!)).toContain('browser');
        expect(said(addAccountStatus(waiting({ linkReady: true, linkSeen: true }))!)).toContain('browser');
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
        const failed = addAccountStatus({ kind: 'failed', harness: 'claude', reason: 'DROVER_BIN is not set' })!;
        expect(failed.detail).toBe('DROVER_BIN is not set');
    });

    it('never says the login failed when it only stopped watching', () => {
        const stopped = addAccountStatus({ kind: 'stoppedWatching', harness: 'claude' })!;
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

    it('marks the ambient login as the BACK DOOR, which is what it means for a flip', () => {
        // DROVE-333. The row used to say "this Mac's main login", which is the
        // same fact without the consequence: an auto-flip will not land here
        // and will not move a session off it, so the only way on or off is by
        // hand. That is what Clay is reading this row to find out.
        expect(accountSubtitle(account({ ambient: true })))
            .toBe('jamrizzi@gmail.com · 43% left · backdoor · manual flips only');
    });

    it('marks a row on the ambient login as the back door too, given the list', () => {
        // jamrizzi is main under a second name and shares its quota, so a flip
        // there lands on the back door through a different door.
        const main = account({ name: 'main', ambient: true });
        const twin = account({ name: 'jamrizzi', sameLoginAs: 'main' });
        expect(accountSubtitle(twin, [main, twin]))
            .toBe('jamrizzi@gmail.com · 43% left · same login as main · backdoor · manual flips only');
    });

    it('does not mark an ordinary account, and does not need the list to say so', () => {
        const other = account({ name: 'desibox', login: 'desibox.food@gmail.com' });
        expect(accountSubtitle(other, [account({ name: 'main', ambient: true }), other]))
            .not.toContain('backdoor');
        expect(accountSubtitle(other)).not.toContain('backdoor');
    });

    it('recognises the ambient row itself with no list at all', () => {
        // The degradation that matters: a caller holding one account still gets
        // the ambient row right, and only the twins go unrecognised.
        expect(isBackdoorAccount(account({ ambient: true }))).toBe(true);
        expect(isBackdoorAccount(account({ name: 'jamrizzi' }))).toBe(false);
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

/* ------------------------------------------------------------------------- *
 * THE SECOND HARNESS (DROVE-270).
 *
 * Clay, with this page open: "Why doesn't it have an option to add a cursor
 * account". What is pinned here is that adding one does not turn a cursor
 * account into a Claude account wearing a different word: it is unmeasured for
 * a structural reason, it is never a flip target, its sixty-day token is
 * counted down while it still works, and every sentence it is shown is its own.
 * ------------------------------------------------------------------------- */

function cursor(overrides: Partial<MachineAccount> = {}): MachineAccount {
    return account({
        name: 'clay@bitspur.com',
        harness: 'cursor',
        // A cursor account has NO directory anywhere: cursor-agent keeps one
        // machine-wide credential and drover hands each session its own token.
        configDir: '',
        // And therefore no `.claude.json`, so no address to read off one. It is
        // NAMED after the address it signed in as instead.
        login: null,
        headroom: null,
        tokenState: 'live',
        expiresInDays: 41,
        ...overrides,
    });
}

describe('accountsByHarness', () => {
    it('draws the cursor group even when it is empty, because the add row lives there', () => {
        // A row nobody can find is the whole of this ticket.
        const groups = accountsByHarness([account()]);
        expect(groups.map((g) => g.harness)).toEqual([...accountHarnessOrder]);
        expect(groups[1].accounts).toEqual([]);
    });

    it('files an account with no harness under claude', () => {
        // A machine whose daemon predates the field lists exactly what it
        // always did.
        const groups = accountsByHarness([account({ harness: undefined }), cursor()]);
        expect(groups[0].accounts.map((a) => a.name)).toEqual(['jamrizzi']);
        expect(groups[1].accounts.map((a) => a.name)).toEqual(['clay@bitspur.com']);
    });
});

describe('accountGroupTitle and accountGroupFooter', () => {
    it('names the harness on the heading, so a cursor row is never under · Claude', () => {
        expect(accountGroupTitle('studio.234.bitspur.com', 'claude'))
            .toBe('studio.234.bitspur.com · Claude');
        expect(accountGroupTitle('studio.234.bitspur.com', 'cursor'))
            .toBe('studio.234.bitspur.com · Cursor');
    });

    it('does not tell the Keychain story over a token', () => {
        // The Claude explanation is WRONG for cursor, and copying it across is
        // the bug this ticket exists to avoid: a cursor account is a token,
        // which is exactly why two of them run side by side with no flip.
        //
        // DROVE-346 cut the footer from four lines to one, so this asserts the
        // two CLAIMS rather than the sentences that used to carry them. It is
        // the same bar: shouting TOKEN in capitals was the old prose's way of
        // marking the distinction, and `tokens` plus `never flip` is the new
        // one. Nothing here got easier to pass.
        const cursorFooter = accountGroupFooter('cursor', true);
        expect(cursorFooter).toContain('tokens');
        expect(cursorFooter).toContain('never flip');
        expect(cursorFooter).not.toContain('Keychain');
    });

    it('leads with offline for both, because that outranks either explanation', () => {
        for (const harness of accountHarnessOrder) {
            // Case-insensitive since DROVE-346: the one-line footer opens on
            // the word, so it is `Offline, ...` rather than mid-sentence.
            expect(accountGroupFooter(harness, false)).toMatch(/offline/i);
        }
    });
});

describe('a cursor account on the accounts screen', () => {
    it('is unmeasured and never a healthy percentage', () => {
        // Cursor publishes no quota anywhere — its accounting is server-side —
        // so there is no figure late, there is no figure at all. Guessing
        // either end of the scale would put it in a ranking by headroom.
        expect(accountHeadroomLabel(cursor())).toBe('no quota published');
        expect(accountHeadroomLabel(cursor())).not.toContain('%');
    });

    it('counts the sixty-day token down while it still works', () => {
        // There is NO refresh flow, so the repair needs Clay at a browser and a
        // warning that arrives after the token dies has arrived too late.
        expect(accountHeadroomLabel(cursor({ tokenState: 'renew', expiresInDays: 3 })))
            .toBe('renew in 3d · no quota published');
        expect(accountSubtitle(cursor({ tokenState: 'renew', expiresInDays: 3 })))
            .toBe('renew in 3d · no quota published');
    });

    it('still runs work while it is counting down', () => {
        // `renew` is a WORKING token with a deadline. Marking it unusable would
        // park six perfectly good days.
        expect(accountCanRun(cursor({ tokenState: 'renew', expiresInDays: 1 }))).toBe(true);
    });

    it('refuses work on a dead token, and says which death it was', () => {
        // Three causes, three repairs. Only one of them is the calendar's.
        expect(accountCanRun(cursor({ tokenState: 'expired' }))).toBe(false);
        expect(accountHeadroomLabel(cursor({ tokenState: 'expired' })))
            .toBe('login expired — sign in again');
        expect(accountHeadroomLabel(cursor({ tokenState: 'tombstone' })))
            .toBe('signed out of Cursor — sign in again');
        expect(accountHeadroomLabel(cursor({ tokenState: 'missing', loggedIn: false })))
            .toBe('no cursor token — sign in again');
    });

    it('never says "no login yet", which is the Claude sentence', () => {
        // An expired token is a login that HAPPENED. Sending Clay to log in an
        // account that is already logged in is what cost him a day on DROVE-246.
        expect(accountHeadroomLabel(cursor({ tokenState: 'missing', loggedIn: false })))
            .not.toContain('no login yet');
    });

    it('never advises drover trust, which would do nothing here', () => {
        // The first-run theme picker is a Claude Code thing; cursor-agent opens
        // on no wizard at all.
        expect(accountHeadroomLabel(cursor({ onboarded: false }))).not.toContain('drover trust');
    });
});

describe('the harness on the phase', () => {
    it('rides every non-idle phase, so a failure lands under the right heading', () => {
        expect(phaseHarness(addAccountIdle)).toBeNull();
        expect(phaseHarness({ kind: 'starting', harness: 'cursor' })).toBe('cursor');
        expect(phaseHarness(waiting({ harness: 'cursor' }))).toBe('cursor');
        expect(phaseHarness({ kind: 'added', harness: 'cursor', name: 'x' })).toBe('cursor');
        expect(phaseHarness({ kind: 'failed', harness: 'cursor', reason: 'x' })).toBe('cursor');
        expect(phaseHarness({ kind: 'stoppedWatching', harness: 'cursor' })).toBe('cursor');
    });

    it('carries the harness from start to every phase after it', () => {
        let phase = advanceAddAccount(addAccountIdle, { type: 'start', harness: 'cursor' });
        expect(phase).toEqual({ kind: 'starting', harness: 'cursor' });
        phase = advanceAddAccount(phase, { type: 'started', at: 10, before });
        expect(phaseHarness(phase)).toBe('cursor');
        phase = advanceAddAccount(phase, { type: 'accounts', at: 20, names: [...before, 'new@x.com'] });
        expect(phase).toEqual({ kind: 'added', harness: 'cursor', name: 'new@x.com' });
    });

    it('refuses a second login while either harness is running', () => {
        // The two share a private tmux server and the session name IS the lock,
        // so the machine can only run one — and the card is joined to a machine
        // rather than to a harness, so two would leave the screen unable to say
        // which link belongs to which.
        const started = advanceAddAccount(addAccountIdle, { type: 'start', harness: 'claude' });
        expect(advanceAddAccount(started, { type: 'start', harness: 'cursor' })).toBe(started);
    });
});

describe('what a cursor login is told', () => {
    it('never mentions a code, because a cursor login has none', () => {
        // `claude auth login` prints a URL and BLOCKS on a code typed back in.
        // `cursor-agent login` prints a URL and polls its own API until a
        // browser approves. Telling Clay to paste a code that never appears is
        // exactly the dead end DROVE-238 was filed about.
        const status = addAccountStatus(waiting({ harness: 'cursor', linkReady: true }))!;
        // The row no longer has to SAY there is no code, because the card under
        // it no longer offers one to send (DROVE-351: `loginControls('cursor')`
        // is Cancel alone). So the bar moves from naming the absence to the
        // thing that actually matters — never asking for one.
        expect(said(status)).not.toMatch(/\bcodes?\b/i);
        expect(said(status)).not.toMatch(/\bpaste\b/i);
        expect(status.detail).toContain('nothing to send back');
        expect(status.hasLink).toBe(true);
        expect(status.title).toBe('Approve the sign-in in your browser');
    });

    it('still asks for the code on a claude login', () => {
        expect(said(addAccountStatus(waiting({ linkReady: true, linkSeen: true }))!)).toContain('code');
    });

    it('names the harness while it starts', () => {
        expect(addAccountStatus({ kind: 'starting', harness: 'cursor' })!.title)
            .toContain('Cursor');
        expect(addAccountStatus({ kind: 'starting', harness: 'claude' })!.title)
            .toContain('Claude');
    });

    it('does not promise a flip after a cursor account is added', () => {
        // A cursor account is never flipped onto: it carries a token, so a
        // session simply starts on it.
        const detail = addAccountStatus({ kind: 'added', harness: 'cursor', name: 'x' })!.detail;
        expect(detail).toContain('No flip');
        expect(addAccountStatus({ kind: 'added', harness: 'claude', name: 'x' })!.detail)
            .toContain('flip onto it');
    });

    it('gives the exact line to run at the keyboard, with the flag', () => {
        // `drover account login` on its own adds a CLAUDE account, so leaving
        // the flag off a cursor failure sends him to diagnose the wrong login.
        expect(loginCommand('claude')).toBe('drover account login');
        expect(loginCommand('cursor')).toBe('drover account login --harness cursor');
        expect(addAccountStatus({ kind: 'stoppedWatching', harness: 'cursor' })!.detail)
            .toContain('drover account login --harness cursor');
    });
});

describe('renewing a cursor account, which writes no new name (DROVE-270)', () => {
    const stale = cursor({ name: 'clay@bitspur.com', tokenState: 'renew', expiresInDays: 2 });
    const dead = cursor({ name: 'ops@bitspur.com', tokenState: 'expired', loggedIn: true });
    const fine = cursor({ name: 'spare@bitspur.com', tokenState: 'live', expiresInDays: 41 });

    it('picks out the rows that need Clay at a browser, now or within the week', () => {
        expect(staleCursorAccounts([account(), stale, dead, fine]))
            .toEqual(['clay@bitspur.com', 'ops@bitspur.com']);
        expect(freshCursorAccounts([account(), stale, dead, fine]))
            .toEqual(['spare@bitspur.com']);
    });

    it('calls a token going from due to fresh a success, not a stopped watch', () => {
        // A repeat cursor login leaves the registry row STANDING and replaces
        // only the stored token, so the name set is identical either side of
        // it. Without this the exact repair the countdown asks for would run,
        // work, and be reported as "the login may still be running".
        let phase = advanceAddAccount(addAccountIdle, { type: 'start', harness: 'cursor' });
        phase = advanceAddAccount(phase, {
            type: 'started',
            at: 1_000,
            before: ['clay@bitspur.com'],
            stale: ['clay@bitspur.com'],
        });
        phase = advanceAddAccount(phase, {
            type: 'accounts',
            at: 2_000,
            names: ['clay@bitspur.com'],
            fresh: ['clay@bitspur.com'],
        });
        expect(phase).toEqual({
            kind: 'added',
            harness: 'cursor',
            name: 'clay@bitspur.com',
            renewed: true,
        });
        const status = addAccountStatus(phase)!;
        expect(status.title).toBe('Renewed clay@bitspur.com');
        expect(status.detail).toContain('60 days');
    });

    it('keeps waiting while the token is still the old one', () => {
        // The row is there and the name has not changed; only the token would.
        let phase = advanceAddAccount(addAccountIdle, { type: 'start', harness: 'cursor' });
        phase = advanceAddAccount(phase, {
            type: 'started', at: 1_000, before: ['clay@bitspur.com'], stale: ['clay@bitspur.com'],
        });
        phase = advanceAddAccount(phase, {
            type: 'accounts', at: 2_000, names: ['clay@bitspur.com'], fresh: [],
        });
        expect(phase.kind).toBe('waiting');
    });

    it('does not call a healthy account a renewal just because it is listed', () => {
        // Only a row that was DUE and is now fresh counts. An account nobody
        // touched must not announce itself.
        let phase = advanceAddAccount(addAccountIdle, { type: 'start', harness: 'cursor' });
        phase = advanceAddAccount(phase, {
            type: 'started', at: 1_000, before: ['spare@bitspur.com'], stale: [],
        });
        phase = advanceAddAccount(phase, {
            type: 'accounts', at: 2_000, names: ['spare@bitspur.com'], fresh: ['spare@bitspur.com'],
        });
        expect(phase.kind).toBe('waiting');
    });

    it('still prefers a genuinely new name when one appears', () => {
        let phase = advanceAddAccount(addAccountIdle, { type: 'start', harness: 'cursor' });
        phase = advanceAddAccount(phase, {
            type: 'started', at: 1_000, before: ['clay@bitspur.com'], stale: ['clay@bitspur.com'],
        });
        phase = advanceAddAccount(phase, {
            type: 'accounts',
            at: 2_000,
            names: ['clay@bitspur.com', 'ops@bitspur.com'],
            fresh: ['clay@bitspur.com', 'ops@bitspur.com'],
        });
        expect(phase).toEqual({ kind: 'added', harness: 'cursor', name: 'ops@bitspur.com' });
        expect(addAccountStatus(phase)!.title).toBe('Added ops@bitspur.com');
    });

    it('behaves exactly as before for a caller that sends neither field', () => {
        // A screen that does not read tokens — and every Claude login — keeps
        // the single "a new name appeared" gate it always had.
        let phase = advanceAddAccount(addAccountIdle, { type: 'start', harness: 'claude' });
        phase = advanceAddAccount(phase, { type: 'started', at: 1_000, before });
        phase = advanceAddAccount(phase, { type: 'accounts', at: 2_000, names: before });
        expect(phase.kind).toBe('waiting');
    });
});
