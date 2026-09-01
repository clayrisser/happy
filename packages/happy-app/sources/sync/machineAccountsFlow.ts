/**
 * Adding a Claude account to a MACHINE, from the phone (DROVE-165).
 *
 * Clay, unprompted, and it is the constraint the whole thing hangs on: "I think
 * Claude accounts we add are specific to a machine because that's where they're
 * logged in." So the phone is not storing an account. It is asking a machine to
 * add one, and the account belongs to that machine afterwards.
 *
 * WHAT THE PHONE CAN ACTUALLY DRIVE, which is the honest half of this file.
 * Claude Code's login is a browser round trip. The phone cannot perform it and
 * this app must never pretend it did. Four things are genuinely observable from
 * here, and the state machine below moves on those four and nothing else:
 *
 *   1. The RPC returned          — the login process really started over there.
 *   2. A login CARD appeared     — `drover account login` got a URL out of
 *                                  `claude auth login` and put it on the bus.
 *                                  Until this, there is nothing to open yet.
 *   3. A NEW NAME appeared in    — the registry row is written by the shell
 *      that machine's registry     ONLY after Claude Code reports itself logged
 *                                  in, so a new row IS the success signal. It is
 *                                  not inferred from anything the phone did.
 *   4. Too long went by          — which ends the WATCH, not the login. The
 *                                  wording says so; claiming a failure we did
 *                                  not see would be the same lie in reverse.
 *
 * The step in the middle is Clay's, and no part of it is automatable here: he
 * signs in and sends the code back on the card. What IS automatable is getting
 * him there, and DROVE-212 is what happened when it was not — the link sat two
 * taps away behind a share sheet, so from a phone Start login looked like a
 * button that did nothing. The page now opens in his browser by itself
 * (`autoOpenLoginUrl`). No agent, and nothing in this app, ever holds that code
 * or the token it buys — the card hands the code straight to the waiting
 * `claude auth login` on the Mac, which is the only process that writes a
 * credential.
 *
 * NOTHING IS ASKED FIRST, and this is settled (DROVE-212). Clay: "I told you
 * the account gets named after you login based on what you logged in with." So
 * there is no name to collect and no phase field holding one. `drover account
 * login` names the account after the address Claude Code reports once the login
 * succeeds. Renaming an account afterwards is a different feature and is not
 * this one.
 */

import {
    accountHarness,
    cursorAccountLabel,
    cursorAccountUsable,
    cursorRenewLabel,
    isCursorAccount,
} from '@/utils/droverAccounts';
import { harnessName } from '@/utils/harnessName';

/** A pending login card, as the Accounts screen needs to see it. */
export interface PendingAccountLogin {
    /** The session HOLDING the card. Never navigated to; an answer is
     *  addressed to it (DROVE-238). */
    sessionId: string;
    /** The key of the request inside that session's `agentState.requests`.
     *  With `sessionId` it is the whole address `sessionAllow` needs, and it is
     *  what lets the Accounts screen answer the card in place instead of
     *  sending Clay into a thread to find it. */
    requestId: string;
    /** The mirrored request's arguments, verbatim. `DroverAccountLoginBody`
     *  reads them itself — the URL, the heading, the reason and the cancel
     *  label — so they are carried whole rather than unpicked here and
     *  reassembled there. */
    args: unknown;
    /** The machine the login is running on, from the holding session. */
    machineId: string;
    /** The authorize URL, when the card carries one. */
    url: string | null;
    /** When the machine raised it, so the newest card beats a stale one. */
    createdAt: number | null;
}

/** The narrow slice of a session this file reads. */
export interface AccountFlowSession {
    agentState?: { requests?: Record<string, unknown> | null } | null;
    metadata?: { machineId?: string } | null;
}

/**
 * Every account-login card currently waiting for an answer, keyed to the
 * machine whose login raised it.
 *
 * The card is a pending request on the drover BRIDGE session, and the bridge
 * holds one session per machine — so the holding session's `machineId` is the
 * machine the login is running on. That join is the only one available: the
 * card itself carries an authorize URL and a heading, not a machine.
 *
 * A card with no `machineId` on its session is dropped rather than guessed
 * onto a machine. Showing "finish your login" under the wrong Mac would send
 * Clay to a card that is not there.
 */
export function pendingAccountLogins(
    sessions: Record<string, AccountFlowSession | undefined>,
): PendingAccountLogin[] {
    const found: PendingAccountLogin[] = [];
    for (const [sessionId, session] of Object.entries(sessions)) {
        const machineId = session?.metadata?.machineId;
        if (!machineId) continue;
        const requests = session?.agentState?.requests;
        if (!requests) continue;
        // The KEY as well as the value (DROVE-238). It used to iterate
        // `Object.values`, which threw away the one thing an answer needs: the
        // request id. That is why the screen could only offer to navigate into
        // the holding session — it knew a login was waiting and had no way to
        // reply to it.
        for (const [requestId, request] of Object.entries(requests)) {
            const row = request as { tool?: string; arguments?: unknown; createdAt?: unknown } | null;
            if (row?.tool !== 'DroverAccountLogin') continue;
            const args = row.arguments as { url?: unknown } | null;
            const url = typeof args?.url === 'string' && args.url.startsWith('https://') ? args.url : null;
            const createdAt = typeof row.createdAt === 'number' ? row.createdAt : null;
            found.push({ sessionId, requestId, args: row.arguments, machineId, url, createdAt });
        }
    }
    return found;
}

/**
 * The card for one machine, or null. NEWEST wins.
 *
 * A retry mints a fresh URL and a fresh card, and an abandoned login leaves its
 * old card behind. Taking the first would hand back a URL whose login is gone,
 * which on a phone is a sign-in page that cannot be finished. Both timestamps
 * come off the same Mac, so comparing them is safe in a way comparing one to
 * the phone's clock would not be.
 */
export function pendingAccountLoginFor(
    sessions: Record<string, AccountFlowSession | undefined>,
    machineId: string,
): PendingAccountLogin | null {
    const mine = pendingAccountLogins(sessions).filter((c) => c.machineId === machineId);
    if (mine.length === 0) return null;
    return mine.reduce((best, c) => ((c.createdAt ?? 0) > (best.createdAt ?? 0) ? c : best));
}

export type AddAccountPhase =
    | { kind: 'idle' }
    /**
     * The RPC is in flight. Nothing has happened on the Mac yet.
     *
     * `harness` rides every non-idle phase because the SENTENCES differ
     * (DROVE-270), and getting them wrong is worse here than anywhere else on
     * the screen: the Claude flow ends with Clay pasting a code back, and the
     * cursor flow has no code at all — cursor-agent polls its own API until a
     * browser approves. Telling him to paste a code that will never appear is
     * exactly the dead end DROVE-238 was filed about, in a new coat.
     */
    | { kind: 'starting'; harness: AccountHarness }
    /**
     * The login is running over there and we are watching the registry.
     * `before` is the set of account names that machine had BEFORE the start,
     * which is what makes "a new one appeared" a fact rather than a guess.
     */
    | {
        kind: 'waiting';
        harness: AccountHarness;
        startedAt: number;
        before: string[];
        /**
         * THE CURSOR ROWS THAT WERE DUE A RENEWAL when this started
         * (DROVE-270), which is the second way a cursor login succeeds.
         *
         * A repeat cursor login writes no new registry row: the existing row
         * STANDS and only the stored token is replaced, because a cursor
         * account has no config dir and logging in again produces a newer token
         * for the same account and nothing else. So "a new name appeared" — the
         * only evidence this flow had — never fires on a renewal, and the exact
         * repair the countdown asks for would have looked like a failure.
         *
         * What IS observable is the token getting NEWER: a row inside its last
         * seven days, or already dead, that is now live again. Nothing but a
         * login can do that, so it is evidence of the same quality.
         */
        stale: string[];
        /** A card with a URL is on the bus, so there is something to open. */
        linkReady: boolean;
        /**
         * Long enough went by with no card that the screen says so.
         *
         * The login runs detached on a Mac nobody is watching, so a Mac-side
         * failure reaches the phone as nothing at all: the FAILED card the
         * shell raises carries a sentence and no URL, which this flow cannot
         * tell from any other pending question. Silence is the one thing the
         * phone CAN see, so silence is what gets said. Still watching, because
         * a late link is still a link.
         */
        linkLate: boolean;
    }
    /** `renewed` means the row already existed and its token was replaced,
     *  which is the whole of a repeat cursor login (DROVE-270). */
    | { kind: 'added'; harness: AccountHarness; name: string; renewed?: boolean }
    | { kind: 'failed'; harness: AccountHarness; reason: string }
    /** The watch gave up. NOT a failure: we simply stopped looking. */
    | { kind: 'stoppedWatching'; harness: AccountHarness };

export type AddAccountEvent =
    | { type: 'start'; harness: AccountHarness }
    | { type: 'started'; at: number; before: string[]; stale?: string[] }
    | { type: 'startFailed'; reason: string }
    | { type: 'link'; ready: boolean }
    /** `fresh` is the cursor rows whose token is usable AND not due a renewal.
     *  Optional, so a caller that does not read tokens behaves as it did. */
    | { type: 'accounts'; at: number; names: string[]; fresh?: string[] }
    /**
     * Wall clock, and nothing else (DROVE-212).
     *
     * The two deadlines below used to ride on `accounts`, which is dispatched
     * only when a `drover-accounts` round trip SUCCEEDS. So the clock stopped
     * whenever the read did: a backgrounded phone, a socket still
     * reconnecting, a machine that stopped answering — `machineRPC` throws
     * "Not connected to the server" and `machineDroverAccounts` hands back
     * `{ ok: false }`, no event is dispatched, and the sixty-second sentence
     * never arrives. That is a spinner with no upper bound, which is what Clay
     * was looking at well past the minute it was supposed to give up at.
     */
    | { type: 'tick'; at: number }
    | { type: 'dismiss' };

/**
 * How long the phone keeps watching before it says so.
 *
 * `drover account login` defaults to a 900s prompt and `--tries 2`, so a
 * refused code buys a second 900s card. Thirty minutes covers both attempts
 * plus the browser round trip. Erring long is deliberate: the cost of watching
 * too long is a spinner, and the cost of stopping too early is telling Clay a
 * login failed while he is still typing his password.
 */
export const addAccountWatchMs = 30 * 60_000;

/**
 * How long the phone waits for the sign-in link before it says there is none.
 *
 * The Mac prints the URL within a second or two of `claude auth login`
 * starting, so a minute of nothing is not slowness. It is the login having
 * died over there, and DROVE-212 is what that looked like: Clay tapped Start
 * login and the screen would have kept the spinner for half an hour. Saying so
 * is not calling it failed, because it may still arrive.
 */
export const addAccountLinkWaitMs = 60_000;

export const addAccountIdle: AddAccountPhase = { kind: 'idle' };

/**
 * Which harness this phase belongs to, or null when nothing is happening.
 *
 * Every non-idle phase carries one (DROVE-270) so the screen can draw the
 * status row, the login card and the "stopped watching" sentence under the
 * group that started them. A failure shown under the wrong heading is a
 * failure attributed to the wrong subscription.
 */
export function phaseHarness(phase: AddAccountPhase): AccountHarness | null {
    return phase.kind === 'idle' ? null : phase.harness;
}

/**
 * The two deadlines, on time alone.
 *
 * Shared by `accounts` and `tick` so there is one place that decides when the
 * screen stops saying "waiting" — the bug this splits out of was two clocks
 * where one of them only ran on a successful read.
 */
function elapsed(
    phase: Extract<AddAccountPhase, { kind: 'waiting' }>,
    at: number,
    watchMs: number,
    linkWaitMs: number,
): AddAccountPhase {
    if (at - phase.startedAt >= watchMs) return { kind: 'stoppedWatching', harness: phase.harness };
    if (!phase.linkReady && !phase.linkLate && at - phase.startedAt >= linkWaitMs) {
        return { ...phase, linkLate: true };
    }
    return phase;
}

/**
 * One transition. Pure, so the flow can be tested without a machine, a bus or
 * a browser — which is the only way any of it can be tested at all.
 */
export function advanceAddAccount(
    phase: AddAccountPhase,
    event: AddAccountEvent,
    watchMs: number = addAccountWatchMs,
    linkWaitMs: number = addAccountLinkWaitMs,
): AddAccountPhase {
    switch (event.type) {
        case 'start':
            // A second tap while one login is already running is ignored, not
            // queued. `drover account login` would happily take the next free
            // ~/.claude-accounts/account-N, so two taps really do make two
            // logins — two cards, two URLs, and no way to tell which code goes
            // with which. One at a time per machine.
            //
            // ONE AT A TIME ACROSS BOTH HARNESSES, not one of each (DROVE-270).
            // The two logins share a private tmux server and the session name
            // IS the lock, so the machine can only run one anyway — and the
            // card is joined to a machine, not to a harness, so two in flight
            // would leave this screen unable to say which link belongs to
            // which. Both add rows go quiet while either is running.
            if (phase.kind === 'starting' || phase.kind === 'waiting') return phase;
            return { kind: 'starting', harness: event.harness };

        case 'started':
            if (phase.kind !== 'starting') return phase;
            return {
                kind: 'waiting',
                harness: phase.harness,
                startedAt: event.at,
                before: [...event.before],
                stale: [...(event.stale ?? [])],
                linkReady: false,
                linkLate: false,
            };

        case 'startFailed':
            if (phase.kind !== 'starting') return phase;
            return { kind: 'failed', harness: phase.harness, reason: event.reason };

        case 'link':
            if (phase.kind !== 'waiting') return phase;
            if (phase.linkReady === event.ready) return phase;
            // A link that turns up after the screen said there was none takes
            // the sentence with it. Leaving it up beside a live link would be
            // the screen contradicting itself.
            return { ...phase, linkReady: event.ready, linkLate: event.ready ? false : phase.linkLate };

        case 'accounts': {
            if (phase.kind !== 'waiting') return phase;
            // The registry row is written by the shell only after the account
            // passes a real check — first run settled, and `claude auth status`
            // reading it as signed in (DROVE-246) — so a name that was not
            // there before the start IS a usable account having appeared.
            // Nothing here infers it from the code being typed, from the card
            // closing, or from time passing.
            //
            // The caller also filters the names to the rows that can RUN, so a
            // row that somehow reached the registry without passing does not
            // announce itself as added. Two gates for one fact, because
            // "it says it added but it did not work" is the whole ticket.
            const added = event.names.find((name) => !phase.before.includes(name));
            if (added !== undefined) return { kind: 'added', harness: phase.harness, name: added };
            // A RENEWAL IS THE SECOND SUCCESS (DROVE-270), and without it the
            // exact repair the countdown asks for would run, work, and then be
            // reported as "stopped watching". A repeat cursor login replaces
            // the token under a row that already exists, so no name appears —
            // what appears is a row that was inside its last week, or dead,
            // reading live again. Only a login can move a token that way.
            const renewed = (phase.stale ?? []).find((name) => (event.fresh ?? []).includes(name));
            if (renewed !== undefined) {
                return { kind: 'added', harness: phase.harness, name: renewed, renewed: true };
            }
            return elapsed(phase, event.at, watchMs, linkWaitMs);
        }

        case 'tick':
            if (phase.kind !== 'waiting') return phase;
            return elapsed(phase, event.at, watchMs, linkWaitMs);

        case 'dismiss':
            return { kind: 'idle' };
    }
}

/**
 * The sign-in page to hand the phone's browser by itself, or null.
 *
 * DROVE-212, Clay on the phone: "Happen when I did this I should've opened my
 * browser". He was right and nothing did. The URL lived one screen and two taps
 * away, on a card in the Cattle Drover thread, behind a button that raises the
 * iOS SHARE SHEET rather than a browser. From a phone that is a Start login
 * that appears to do nothing.
 *
 * So the link opens itself the moment it exists, only while a login this screen
 * started is in flight, and only once per URL. `opened` is the last URL handed
 * to the browser, so a re-render, a poll tick or a second card cannot throw Clay
 * back out to Safari over and over.
 */
export function autoOpenLoginUrl(input: {
    phase: AddAccountPhase;
    url: string | null | undefined;
    /** The URL this screen has already opened for that machine. */
    opened: string | null;
}): string | null {
    if (input.phase.kind !== 'waiting') return null;
    const url = typeof input.url === 'string' ? input.url : null;
    if (!url || !url.startsWith('https://')) return null;
    if (url === input.opened) return null;
    return url;
}

/** Is a login in flight for this machine? Used to disable the add row. */
export function addAccountBusy(phase: AddAccountPhase): boolean {
    return phase.kind === 'starting' || phase.kind === 'waiting';
}

export interface AddAccountStatus {
    title: string;
    /** What Clay has to do next, in one sentence, or '' when it is nothing. */
    detail: string;
    /** True while the screen should keep polling that machine's account list. */
    watching: boolean;
    /** True when there is a card to open. */
    hasLink: boolean;
    /**
     * Show a spinner. Separate from `watching` because the screen goes on
     * watching after it has said no link came back, and a spinner next to that
     * sentence would be the row disagreeing with itself.
     */
    spinner: boolean;
}

/**
 * The command that runs this login at the keyboard, named exactly (DROVE-270).
 *
 * Told to Clay when the phone gives up, so it has to be the line he can paste.
 * `drover account login` on its own adds a CLAUDE account — the wrapper execs
 * a sibling script only when `--harness cursor` is on the line — so leaving the
 * flag off a cursor failure would send him to diagnose the wrong login.
 */
export function loginCommand(harness: AccountHarness): string {
    return harness === 'cursor' ? 'drover account login --harness cursor' : 'drover account login';
}

/** Whose login is being started, for the sentence while it starts. */
function loginSubject(harness: AccountHarness): string {
    return harness === 'cursor' ? 'Cursor’s' : 'Claude Code’s';
}

/**
 * The words. Kept here rather than in the screen so the specs pin what Clay is
 * told at each step, which is the part of this ticket that can actually be got
 * wrong: every sentence has to describe something that really happened.
 */
export function addAccountStatus(phase: AddAccountPhase): AddAccountStatus | null {
    switch (phase.kind) {
        case 'idle':
            return null;
        case 'starting':
            return {
                title: `Starting the ${harnessName(phase.harness)} login on that machine…`,
                detail: '',
                watching: false,
                hasLink: false,
                spinner: true,
            };
        case 'waiting':
            if (phase.linkReady) {
                // THERE IS NO CODE IN A CURSOR LOGIN (DROVE-270), and this is
                // the sentence that must not be copied across. `claude auth
                // login` prints a URL and then BLOCKS on a code typed back in;
                // `cursor-agent login` prints a URL and then polls its own API
                // until a browser approves, so approving IS the whole of the
                // second half. Telling Clay to paste a code that never appears
                // would strand him exactly as DROVE-238 did.
                if (phase.harness === 'cursor') {
                    return {
                        title: 'Approve the sign-in in your browser',
                        detail: 'The sign-in page is open in your browser. Approve it there and the account '
                            + 'appears in this list — there is no code to send back.',
                        watching: true,
                        hasLink: true,
                        spinner: false,
                    };
                }
                return {
                    // The code box is on THIS screen now (DROVE-238), so the
                    // sentence stops pointing at a row that used to navigate
                    // into the bridge thread to find one.
                    title: 'Sign in, then paste the code below',
                    detail: 'The sign-in page is open in your browser. Sign in, then paste the code it '
                        + 'gives you into the box below and send it.',
                    watching: true,
                    hasLink: true,
                    spinner: false,
                };
            }
            if (phase.linkLate) {
                // Not "the login failed": nothing here saw it fail. What is
                // true is that no link came, and that the Mac is where the
                // reason for that is.
                return {
                    title: 'No sign-in link came back',
                    detail: 'That machine started the login but has sent no link, so it may have failed '
                        + `over there. Try again, or run ${loginCommand(phase.harness)} on that machine to see why.`,
                    watching: true,
                    hasLink: false,
                    spinner: false,
                };
            }
            return {
                title: 'Waiting for the sign-in link…',
                detail: `That machine is starting ${loginSubject(phase.harness)} login. Your browser opens as `
                    + 'soon as the link arrives.',
                watching: true,
                hasLink: false,
                spinner: true,
            };
        case 'added':
            if (phase.renewed) {
                return {
                    title: `Renewed ${phase.name}`,
                    detail: 'That machine holds a fresh token for it now, good for another 60 days. '
                        + 'The account kept its name and every session on it carries on.',
                    watching: false,
                    hasLink: false,
                    spinner: false,
                };
            }
            return {
                title: `Added ${phase.name}`,
                // "so a session can flip onto it" is a CLAUDE sentence. A
                // cursor account is never flipped onto: it carries a token, so
                // a session simply starts on it (DROVE-270).
                detail: phase.harness === 'cursor'
                    ? 'It is in that machine’s registry now, so a cursor session can start on it. '
                        + 'No flip is involved — a cursor account is a token, not a login to take turns with.'
                    : 'It is in that machine’s registry now, so a session can flip onto it.',
                watching: false,
                hasLink: false,
                spinner: false,
            };
        case 'failed':
            return {
                title: 'The login did not start',
                detail: phase.reason,
                watching: false,
                hasLink: false,
                spinner: false,
            };
        case 'stoppedWatching':
            // NOT "the login failed". The phone cannot see a browser, so it has
            // no idea whether the login is still going. Say only what is true:
            // we stopped looking.
            return {
                title: 'Stopped watching',
                detail: 'The login may still be running on that machine. Pull to refresh — if it '
                    + `finished, the account is in the list. At the keyboard: ${loginCommand(phase.harness)}.`,
                watching: false,
                hasLink: false,
                spinner: false,
            };
    }
}

/** One limit Claude Code last measured, as the daemon reports it. */
export interface MachineAccountLimit {
    kind: string;
    /** Percent USED. */
    percent: number;
    resetsAt: number | null;
    scope: string | null;
    family: string | null;
}

/**
 * One account on one machine.
 *
 * Deliberately NO `current`: which account a session runs on is a session fact,
 * and the daemon is not a session. The composer's quota sheet is where "the one
 * you are on" belongs, because that sheet has a session behind it.
 */
export interface MachineAccount {
    name: string;
    /**
     * WHICH SUBSCRIPTION this is — 'claude' or 'cursor' (DROVE-270).
     *
     * Absent means claude, so a machine whose daemon predates the field lists
     * exactly what it always did. It decides three things on this screen: which
     * group the row sits in, that the row is UNMEASURED for a structural reason
     * rather than a missing reading, and that no flip is offered onto it.
     */
    harness?: string | null;
    /**
     * HOW THE CURSOR TOKEN IS DOING, null on a Claude row, absent from a
     * machine whose daemon predates the field (DROVE-270).
     *
     * A cursor login is a JWT with a sixty-day life and no refresh flow, so its
     * expiry is a date rather than a thing to retry — and the only repair is
     * Clay at a browser. Absent and `missing` are kept apart on purpose: the
     * first is "nobody looked", the second is "the store holds nothing".
     */
    tokenState?: string | null;
    /** Whole days until that token dies, rounded down. Null when there is no
     *  date to count to. */
    expiresInDays?: number | null;
    /** Where the login lives. EMPTY for a cursor account, which has no
     *  directory anywhere: it carries a token instead. */
    configDir: string;
    /** The ambient login (~/.claude) — the one the phone must not replace. */
    ambient: boolean;
    /** There is a credential. NOT the same as "a session can start here". */
    loggedIn: boolean;
    /**
     * Claude Code's one-time first run is settled for that config dir
     * (DROVE-246). A brand-new dir opens on the theme picker before it does
     * anything, whatever its login says, and a flip cannot answer that — so a
     * row with this false is as dead as one with no login, and needs a
     * different fix. Optional because an older machine does not send it, and
     * an absent answer must not turn every account red.
     */
    onboarded?: boolean;
    /** The address it is logged in as, which is the identity Clay recognises. */
    login: string | null;
    /** Another row on the same claude.ai login, so the two share one quota. */
    sameLoginAs: string | null;
    /** Percent LEFT on the fullest limit, or null when nothing measured it. */
    headroom: number | null;
    cooling: { until: number; reason: string; family?: string } | null;
    limits: MachineAccountLimit[];
    fetchedAt: number | null;
}

/**
 * Can a session actually start on this account?
 *
 * The predicate every "may this be flipped to" question should ask.
 * `loggedIn` was being read as this and only ever meant "there is a
 * credential" (DROVE-246). `onboarded === false` is the failure; absent is
 * treated as fine, so an older machine that does not report it behaves exactly
 * as it did before.
 */
export function accountCanRun(account: MachineAccount): boolean {
    // A CURSOR ACCOUNT HAS NO ONBOARDING TO SETTLE (DROVE-270). Claude Code's
    // one-time first run belongs to a config dir, and a cursor account has no
    // dir — cursor-agent opens on no wizard at all. What decides it instead is
    // the TOKEN: an expired one is a row that will refuse work, and a `renew`
    // one is a row that runs perfectly well today and simply has a deadline.
    // `loggedIn` alone is not enough, because an expired token IS a login that
    // happened.
    if (isCursorAccount(account)) return account.loggedIn && cursorAccountUsable(account);
    return account.loggedIn && account.onboarded !== false;
}

/** "43% left", or the reason there is no figure. Never an invented number. */
export function accountHeadroomLabel(account: MachineAccount): string {
    // A CURSOR ACCOUNT IS PERMANENTLY UNMEASURED, and that is a different
    // sentence from every other nothing on this screen (DROVE-270). "not
    // measured yet" promises a figure that is coming; there is none coming.
    // Cursor publishes no quota anywhere — its accounting is server-side — so
    // the row shows the reason where a percentage would go, and never a
    // healthy-looking 100%.
    //
    // Ahead of the `loggedIn` test, because "no login yet" is the wrong words
    // for every way a cursor credential goes wrong: an expired token is a login
    // that HAPPENED, a tombstone is a deliberate sign-out, and each wants its
    // own repair rather than the Claude one. It is also where the sixty-day
    // countdown surfaces — `renew in 3d` — while the account still works.
    if (isCursorAccount(account)) return cursorAccountLabel(account);
    if (!account.loggedIn) return 'no login yet';
    // Said in the words of what is WRONG and what fixes it. "Not set up" would
    // read as "still finishing", which is the sentence DROVE-237 already had to
    // remove once; and "no login" would be a lie about an account that is
    // logged in, which is what cost Clay a day.
    if (account.onboarded === false) return 'setup unfinished — run drover trust';
    if (account.cooling) return 'out of headroom';
    if (account.headroom == null) return 'not measured yet';
    return `${Math.round(account.headroom)}% left`;
}

/** The line under an account name: the address, and who it shares a quota with. */
export function accountSubtitle(account: MachineAccount): string {
    const parts: string[] = [];
    if (account.login) parts.push(account.login);
    parts.push(accountHeadroomLabel(account));
    if (account.sameLoginAs) parts.push(`same login as ${account.sameLoginAs}`);
    if (account.ambient) parts.push('this Mac’s main login');
    return parts.join(' · ');
}

/* ------------------------------------------------------------------------- *
 * TWO KINDS OF ACCOUNT, ON ONE PAGE (DROVE-270).
 *
 * Clay, with the Accounts page in front of him: "Why doesn't it have an option
 * to add a cursor account Or a cursor agent whatever thing". It did not, and
 * the page was already the right shape for it — the group heading has read
 * `<machine> · CLAUDE` since DROVE-165, because an account belongs to one
 * harness. What was missing was the second group and the row that starts it.
 *
 * The two are not the same thing wearing different names, and the copy has to
 * say so, because the Claude explanation is WRONG for a cursor account:
 *
 *   CLAUDE — a login in a CLAUDE_CONFIG_DIR. On a Mac the credential is a
 *     Keychain item keyed to that directory's path, so nothing about it is
 *     copied between machines, and only one of them is in use at a time. That
 *     last part is why a flip exists: it is a config-dir swap and a respawn.
 *   CURSOR — a token. cursor-agent takes CURSOR_AUTH_TOKEN and it outranks
 *     both an API key and the machine's own stored login (measured: a bogus
 *     token FAILS even with a valid stored login present, which is what proves
 *     the per-account token is authoritative and never falls back). So drover
 *     hands each session its own, two cursor accounts run side by side, and
 *     there is no flip and no swap because there is nothing to take turns over.
 *
 * Both are still PER MACHINE, which is why the page's shape does not change:
 * the token is stored on the machine that logged in, exactly as the Keychain
 * item is.
 * ------------------------------------------------------------------------- */

/**
 * The cursor rows that need Clay at a browser, or will within the week.
 *
 * Captured BEFORE a login starts and compared with `freshCursorAccounts` after,
 * because that transition is the only thing a renewal changes: the registry
 * name set is identical on both sides of it (DROVE-270).
 */
export function staleCursorAccounts(accounts: MachineAccount[]): string[] {
    return accounts
        .filter((a) => isCursorAccount(a)
            && (!cursorAccountUsable(a) || cursorRenewLabel(a) !== null))
        .map((a) => a.name);
}

/** The cursor rows whose token is usable and not due a renewal. */
export function freshCursorAccounts(accounts: MachineAccount[]): string[] {
    return accounts
        .filter((a) => isCursorAccount(a)
            && cursorAccountUsable(a) && cursorRenewLabel(a) === null)
        .map((a) => a.name);
}

/** The harnesses this page draws a group for, in the order it draws them. */
export const accountHarnessOrder = ['claude', 'cursor'] as const;
export type AccountHarness = (typeof accountHarnessOrder)[number];

/**
 * One machine's accounts split by harness, INCLUDING the empty groups.
 *
 * Empty on purpose: a machine with no cursor account still gets a Cursor
 * group, because that group is the only place the add row can live and a row
 * nobody can find is the whole of this ticket. The Claude group is drawn
 * whether or not it is empty for the same reason it always was.
 */
export function accountsByHarness(
    accounts: MachineAccount[],
): { harness: AccountHarness; accounts: MachineAccount[] }[] {
    return accountHarnessOrder.map((harness) => ({
        harness,
        accounts: accounts.filter((a) => accountHarness(a) === harness),
    }));
}

/** What the group heading says: `studio.234.bitspur.com · Cursor`. */
export function accountGroupTitle(machine: string, harness: AccountHarness): string {
    return `${machine} · ${harnessName(harness)}`;
}

/**
 * The sentence under a group, which is where the two kinds actually differ.
 *
 * Offline first for both, because a list that cannot be read or changed is the
 * fact that matters and neither explanation applies while it is true.
 */
export function accountGroupFooter(harness: AccountHarness, online: boolean): string {
    if (!online) return 'This machine is offline, so its account list cannot be read or changed.';
    if (harness === 'cursor') {
        return 'Each of these is a TOKEN this machine holds, not a login it takes turns with — so two '
            + 'cursor sessions run side by side and there is nothing to flip. Cursor publishes no quota, '
            + 'so no account here shows a percentage.';
    }
    return 'These accounts are logged in on this machine and only exist here.';
}

/* ------------------------------------------------------------------------- *
 * Getting INTO this flow from the quota sheet (DROVE-208).
 *
 * Clay, with the quota sheet open on five accounts: "Where is the button for
 * me to add an account." DROVE-165 built adding one, but only on Settings →
 * Accounts, and the sheet is where he actually compares accounts and notices
 * one is missing. A list of accounts with no way to add one is a dead end.
 *
 * The row does NOT run a second copy of the flow. It cannot: the first step is
 * a system prompt, and DROVE-183 says a sheet closes before it raises one, so
 * by the time the prompt could appear the sheet that would show "waiting for
 * the sign-in link" is gone. Everything after the prompt lives on the Accounts
 * screen and has to stay there: the poll, the card link, and the watch that
 * says it stopped watching rather than that it failed. So the row closes the
 * sheet and lands on that screen with the machine already chosen, which is
 * one flow reached from two places rather than two flows.
 *
 * WHICH MACHINE, without asking. An account belongs to a machine (Clay's own
 * constraint, at the top of this file). A quota sheet is scoped to a session
 * and a session runs on exactly one machine, so the machine is known and
 * asking would be a tap spent on a question with one answer. Wanting a
 * different one is served by where the tap already goes: Settings → Accounts
 * lists every machine, so a picker inside a quota sheet would be a third way
 * to say the same thing.
 * ------------------------------------------------------------------------- */

/** The query param naming the machine to start on. */
export const addAccountMachineParam = 'addMachineId';

/** Settings → Accounts, already aimed at one machine. */
export function addAccountHref(machineId: string): string {
    return `/settings/accounts?${addAccountMachineParam}=${encodeURIComponent(machineId)}`;
}

/** What the quota sheet's add row needs to draw itself and to go somewhere. */
export interface AddAccountEntry {
    machineId: string;
    /** Named on the row, because a target that is only implied is a guess. */
    machineName: string;
    href: string;
}

/**
 * The add row for a session, or null.
 *
 * Null when the session has no machine stamped on it. There is then nothing
 * true to put on the row: an add row that cannot say where it is adding is the
 * flat-pool lie DROVE-165 refused, and Settings → Accounts is still there.
 */
export function addAccountEntry(input: {
    machineId: string | null | undefined;
    /** The machine's display name or host, when the store has one. */
    machineName?: string | null;
}): AddAccountEntry | null {
    const machineId = input.machineId?.trim();
    if (!machineId) return null;
    return {
        machineId,
        // The same fallback the Accounts screen uses, so one machine is not
        // called two things on two screens.
        machineName: input.machineName?.trim() || machineId.substring(0, 8),
        href: addAccountHref(machineId),
    };
}

/**
 * May the Accounts screen start that login by ITSELF, and with what `before`?
 *
 * Returns the account names to treat as "already there", or null for not yet.
 *
 * The wait matters. `before` is the whole basis of "a new name appeared, so
 * the login worked": start on an empty list and the first account ever read
 * back looks like the one just added, and the screen would announce a success
 * Clay never had. So the list has to have been read first, and read OK.
 *
 * Offline is also a no. That machine cannot run `claude auth login`, and the
 * screen already says so under its group; prompting for a name first would be
 * a question asked before the refusal.
 */
export function autoStartAddAccount(input: {
    /** The machine named in the route, or null when we came here plainly. */
    requested: string | null;
    /** Already fired once. This never fires twice for one arrival. */
    started: boolean;
    online: boolean;
    /** That machine's accounts once read, null while it is still being read. */
    accounts: string[] | null;
}): string[] | null {
    if (!input.requested || input.started || !input.online) return null;
    if (input.accounts === null) return null;
    return [...input.accounts];
}
