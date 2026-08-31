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
 * opens the URL, signs in, and sends the code back on the card. No agent, and
 * nothing in this app, ever holds that code or the token it buys — the card
 * hands the code straight to the waiting `claude auth login` on the Mac, which
 * is the only process that writes a credential.
 */

/** A pending login card, as the Accounts screen needs to see it. */
export interface PendingAccountLogin {
    /** The session holding the card — where a tap has to land to answer it. */
    sessionId: string;
    /** The machine the login is running on, from the holding session. */
    machineId: string;
    /** The authorize URL, when the card carries one. */
    url: string | null;
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
            const row = request as { tool?: string; arguments?: unknown } | null;
            if (row?.tool !== 'DroverAccountLogin') continue;
            const args = row.arguments as { url?: unknown } | null;
            const url = typeof args?.url === 'string' && args.url.startsWith('https://') ? args.url : null;
            found.push({ sessionId, machineId, url });
        }
    }
    return found;
}

/** The card for one machine, or null. First wins; a second is a retry's. */
export function pendingAccountLoginFor(
    sessions: Record<string, AccountFlowSession | undefined>,
    machineId: string,
): PendingAccountLogin | null {
    return pendingAccountLogins(sessions).find((c) => c.machineId === machineId) ?? null;
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
        /** The name Clay typed, or null for "call it after the address". */
        requested: string | null;
        /** A card with a URL is on the bus, so there is something to open. */
        linkReady: boolean;
    }
    | { kind: 'added'; name: string }
    | { kind: 'failed'; reason: string }
    /** The watch gave up. NOT a failure: we simply stopped looking. */
    | { kind: 'stoppedWatching' };

export type AddAccountEvent =
    | { type: 'start' }
    | { type: 'started'; at: number; before: string[]; requested: string | null }
    | { type: 'startFailed'; reason: string }
    | { type: 'link'; ready: boolean }
    | { type: 'accounts'; at: number; names: string[] }
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

export const addAccountIdle: AddAccountPhase = { kind: 'idle' };

/**
 * One transition. Pure, so the flow can be tested without a machine, a bus or
 * a browser — which is the only way any of it can be tested at all.
 */
export function advanceAddAccount(
    phase: AddAccountPhase,
    event: AddAccountEvent,
    watchMs: number = addAccountWatchMs,
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
                requested: event.requested,
                linkReady: false,
            };

        case 'startFailed':
            if (phase.kind !== 'starting') return phase;
            return { kind: 'failed', reason: event.reason };

        case 'link':
            if (phase.kind !== 'waiting') return phase;
            if (phase.linkReady === event.ready) return phase;
            return { ...phase, linkReady: event.ready };

        case 'accounts': {
            if (phase.kind !== 'waiting') return phase;
            // The registry row is written by the shell only after Claude Code
            // reports itself logged in, so a name that was not there before the
            // start IS the login having succeeded. Nothing here infers it from
            // the code being typed, from the card closing, or from time passing.
            const added = event.names.find((name) => !phase.before.includes(name));
            if (added !== undefined) return { kind: 'added', name: added };
            if (event.at - phase.startedAt >= watchMs) return { kind: 'stoppedWatching' };
            return phase;
        }

        case 'dismiss':
            return { kind: 'idle' };
    }
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
            };
        case 'waiting':
            return phase.linkReady
                ? {
                    title: 'Waiting for you to finish the login',
                    detail: 'Open the sign-in link, sign in, then send the code back on the same card. '
                        + 'This screen adds the account as soon as that machine reports it.',
                    watching: true,
                    hasLink: true,
                }
                : {
                    title: 'Waiting for the sign-in link…',
                    detail: 'The machine is starting Claude Code’s login. The link arrives as a card.',
                    watching: true,
                    hasLink: false,
                };
        case 'added':
            return {
                title: `Added ${phase.name}`,
                detail: 'It is in that machine’s registry now, so a session can flip onto it.',
                watching: false,
                hasLink: false,
            };
        case 'failed':
            return {
                title: 'The login did not start',
                detail: phase.reason,
                watching: false,
                hasLink: false,
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
