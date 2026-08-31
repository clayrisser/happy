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

/** A pending login card, as the Accounts screen needs to see it. */
export interface PendingAccountLogin {
    /** The session holding the card — where a tap has to land to answer it. */
    sessionId: string;
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
        for (const request of Object.values(requests)) {
            const row = request as { tool?: string; arguments?: unknown; createdAt?: unknown } | null;
            if (row?.tool !== 'DroverAccountLogin') continue;
            const args = row.arguments as { url?: unknown } | null;
            const url = typeof args?.url === 'string' && args.url.startsWith('https://') ? args.url : null;
            const createdAt = typeof row.createdAt === 'number' ? row.createdAt : null;
            found.push({ sessionId, machineId, url, createdAt });
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
    /** The RPC is in flight. Nothing has happened on the Mac yet. */
    | { kind: 'starting' }
    /**
     * The login is running over there and we are watching the registry.
     * `before` is the set of account names that machine had BEFORE the start,
     * which is what makes "a new one appeared" a fact rather than a guess.
     */
    | {
        kind: 'waiting';
        startedAt: number;
        before: string[];
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
    | { kind: 'added'; name: string }
    | { kind: 'failed'; reason: string }
    /** The watch gave up. NOT a failure: we simply stopped looking. */
    | { kind: 'stoppedWatching' };

export type AddAccountEvent =
    | { type: 'start' }
    | { type: 'started'; at: number; before: string[] }
    | { type: 'startFailed'; reason: string }
    | { type: 'link'; ready: boolean }
    | { type: 'accounts'; at: number; names: string[] }
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
    if (at - phase.startedAt >= watchMs) return { kind: 'stoppedWatching' };
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
            if (phase.kind === 'starting' || phase.kind === 'waiting') return phase;
            return { kind: 'starting' };

        case 'started':
            if (phase.kind !== 'starting') return phase;
            return {
                kind: 'waiting',
                startedAt: event.at,
                before: [...event.before],
                linkReady: false,
                linkLate: false,
            };

        case 'startFailed':
            if (phase.kind !== 'starting') return phase;
            return { kind: 'failed', reason: event.reason };

        case 'link':
            if (phase.kind !== 'waiting') return phase;
            if (phase.linkReady === event.ready) return phase;
            // A link that turns up after the screen said there was none takes
            // the sentence with it. Leaving it up beside a live link would be
            // the screen contradicting itself.
            return { ...phase, linkReady: event.ready, linkLate: event.ready ? false : phase.linkLate };

        case 'accounts': {
            if (phase.kind !== 'waiting') return phase;
            // The registry row is written by the shell only after Claude Code
            // reports itself logged in, so a name that was not there before the
            // start IS the login having succeeded. Nothing here infers it from
            // the code being typed, from the card closing, or from time passing.
            const added = event.names.find((name) => !phase.before.includes(name));
            if (added !== undefined) return { kind: 'added', name: added };
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
                title: 'Starting the login on that machine…',
                detail: '',
                watching: false,
                hasLink: false,
                spinner: true,
            };
        case 'waiting':
            if (phase.linkReady) {
                return {
                    title: 'Sign in, then bring the code back',
                    detail: 'The sign-in page is open in your browser. Sign in, then paste the code it '
                        + 'gives you into Enter the code below.',
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
                        + 'over there. Try again, or run drover account login on that machine to see why.',
                    watching: true,
                    hasLink: false,
                    spinner: false,
                };
            }
            return {
                title: 'Waiting for the sign-in link…',
                detail: 'That machine is starting Claude Code’s login. Your browser opens as soon as '
                    + 'the link arrives.',
                watching: true,
                hasLink: false,
                spinner: true,
            };
        case 'added':
            return {
                title: `Added ${phase.name}`,
                detail: 'It is in that machine’s registry now, so a session can flip onto it.',
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
                    + 'finished, the account is in the list.',
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
    configDir: string;
    /** The ambient login (~/.claude) — the one the phone must not replace. */
    ambient: boolean;
    loggedIn: boolean;
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

/** "43% left", or the reason there is no figure. Never an invented number. */
export function accountHeadroomLabel(account: MachineAccount): string {
    if (!account.loggedIn) return 'no login yet';
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
