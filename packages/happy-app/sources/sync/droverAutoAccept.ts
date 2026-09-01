/**
 * The runtime that answers a session's boolean gates while its auto-accept
 * toggle is on (DROVE-277).
 *
 * Watches the store the way droverAnnounce does, and for every session in
 * `autoAcceptSessions` reads that session's own gates — its native ones and
 * the ones the drover bridge mirrored, which is what `gatesForSession` joins
 * on the Claude session uuid. Each gate goes through `autoAcceptVerdict`, and
 * only a plain allow / deny permission off the bus is answered. Everything
 * else is left alone, which means it presents exactly as it would have.
 *
 * IT RUNS ABOVE THE SCREEN, not inside the overlay. A gate arrives whether or
 * not Clay is looking at that session, and a runtime that only fired while the
 * card was on screen would make "auto-accept" mean "auto-accept the ones you
 * were already watching". Mounted once from the app layout, like
 * startDroverAnnounce.
 *
 * NO SEEDING, unlike droverAnnounce. That file skips the first read because a
 * wall of gates waiting at launch is not news; here there is nothing to skip,
 * because the toggle is off at launch by construction (autoAcceptSessions is
 * in memory) and so no session can be opted in before Clay opts it in. A gate
 * already pending when he flips the switch IS answered, which is what "always
 * say yes" means.
 *
 * ONE ANSWER PER GATE. The store does not update the instant the RPC is sent,
 * so a second store change a few milliseconds later would see the same gate
 * still pending and send a second allow. The bus arbitrates (the loser gets
 * 409) but the log would carry a phantom double-answer, and the ledger is the
 * one artefact this feature must not muddy.
 *
 * IT CANNOT DENY, EVER. There is no path from here to `sessionDeny` and none
 * to `sessionDismissGate`. Auto-accept says yes to things it recognises and is
 * silent about everything else; a runtime that could also say no would be able
 * to end a gate it had misread.
 */

import { storage } from './storage';
import { collectGateEntries, gatesForSession, type DroverGateEntry } from './droverGates';
import { autoAcceptSessions } from './autoAcceptSessions';
import { autoAcceptInput, autoAcceptVerdict } from './autoAcceptGate';
import { sessionAllow } from './ops';

let started = false;

/**
 * Gate ids this process has already answered.
 *
 * Never cleared while the app runs. A gate id is `${sessionId}:${requestId}`
 * and both halves are minted per request, so an id is not reused; the only
 * growth is one string per auto-answered gate, and pruning it against the live
 * set would re-arm exactly the double-answer it exists to stop (a gate is
 * absent from the live set the moment it resolves).
 */
const answered = new Set<string>();

/** What one pass decided, so a test can read the decision without a socket. */
export interface AutoAcceptPass {
    /** Gate ids answered on this pass. */
    answered: string[];
    /** Gate ids left to present, each with the reason it was not the right shape. */
    presented: Array<{ id: string; reason: string }>;
}

/**
 * The gates one pass would answer, given the store's sessions and which
 * sessions are on. Pure: it sends nothing.
 *
 * Collecting per opted-in session rather than over the whole map is deliberate
 * and is the "other sessions unaffected" criterion in one line: a gate reaches
 * this list only through `gatesForSession`, which matches on an exact Claude
 * session uuid and never on cwd, because several lanes share one checkout here
 * and a cwd match would answer the neighbouring lane's prompts.
 */
export function autoAcceptPass(
    sessions: Parameters<typeof collectGateEntries>[0],
    on: ReadonlySet<string>,
    alreadyAnswered: ReadonlySet<string> = answered,
): AutoAcceptPass {
    const pass: AutoAcceptPass = { answered: [], presented: [] };
    if (on.size === 0) return pass;
    const seen = new Set<string>();
    for (const sessionId of on) {
        for (const entry of gatesForSession(sessions ?? {}, sessionId)) {
            const id = entry.gate.id;
            if (seen.has(id)) continue;
            seen.add(id);
            if (alreadyAnswered.has(id)) continue;
            const verdict = autoAcceptVerdict(entry);
            if (verdict.answer) pass.answered.push(id);
            else pass.presented.push({ id, reason: verdict.reason });
        }
    }
    return pass;
}

/** The entry behind one id, so the sender has the routing keys. */
function entryFor(
    sessions: Parameters<typeof collectGateEntries>[0],
    on: ReadonlySet<string>,
    id: string,
): DroverGateEntry | null {
    for (const sessionId of on) {
        for (const entry of gatesForSession(sessions ?? {}, sessionId)) {
            if (entry.gate.id === id) return entry;
        }
    }
    return null;
}

/**
 * Start auto-accepting. Idempotent, and returns the stop the layout unmounts
 * with, exactly like startDroverAnnounce.
 */
export function startDroverAutoAccept(): () => void {
    if (started) return () => {};
    started = true;

    const check = () => {
        const state = storage.getState();
        if (!state.isDataReady) return;
        const on = autoAcceptSessions.get();
        if (on.size === 0) return;
        const sessions = state.sessions ?? {};
        const pass = autoAcceptPass(sessions, on);
        for (const { id, reason } of pass.presented) {
            // Logged once each pass rather than once ever: a reason is cheap
            // and "auto-accept is on and this card is still sitting there" is
            // the question the log has to be able to answer.
            console.log(`[drover-auto-accept] presenting ${id}: ${reason}`);
        }
        for (const id of pass.answered) {
            const entry = entryFor(sessions, on, id);
            if (!entry) continue;
            // Marked BEFORE the send, not after. Marking on success would let
            // a second store change during the round trip send the same allow
            // twice, which is the one thing that would put a phantom answer on
            // the ledger.
            answered.add(id);
            console.log(`[drover-auto-accept] allowing ${id} as ${entry.tool}, by auto-accept`);
            // `entry.sessionId` is who HOLDS the card, which for a mirrored
            // gate is the bridge session and not the session Clay switched
            // this on for. Answering the session on screen would reach an
            // agent that never asked anything.
            void Promise.resolve(
                sessionAllow(entry.sessionId, entry.requestId, undefined, undefined, undefined, autoAcceptInput()),
            ).catch((error) => {
                // The gate simply stays pending and every other surface can
                // still answer it. It is NOT retried: a retry loop against a
                // bus that is refusing is how one gate becomes a hundred lines
                // of ledger.
                console.log(`[drover-auto-accept] ${id} did not send: ${String(error)}`);
            });
        }
    };

    const unsubscribeStore = storage.subscribe(check);
    const unsubscribeToggle = autoAcceptSessions.subscribe(check);
    check();
    return () => {
        unsubscribeStore();
        unsubscribeToggle();
        started = false;
    };
}

/** Testing only: forget what this process has answered, as a relaunch would. */
export function resetAutoAcceptAnswered(): void {
    answered.clear();
    started = false;
}
