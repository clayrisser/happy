/**
 * Which gates auto-accept is allowed to answer, and what it stamps on the
 * answer (DROVE-277).
 *
 * Clay, by voice: "whenever there's a boolean as a true false prompt that
 * comes in ... you essentially always say yes to it". The word doing the work
 * is BOOLEAN. A gate whose yes is not simply "allow" is not this feature's
 * business, and the cost of getting that wrong is not a mis-drawn card: it is
 * a login code answered with a shrug, a four-way choice collapsed to its first
 * option, a to-do acked that nobody did. DROVE-69 is that exact bug already
 * having happened once, from a generic approve reaching a card that needed a
 * named button.
 *
 * So this file is a WALL, not a router, and it is pure so the wall can be
 * measured without a store, a socket or a phone. Every reason to refuse is
 * named, because "auto-accept did nothing" with no reason is indistinguishable
 * from auto-accept being broken.
 *
 * THE RULE: present unless every condition for a boolean allow is met. Doubt
 * presents. That is the ticket's "fail closed on doubt" and it is also the
 * only safe default, because the set of gate shapes grows and this file does
 * not learn about the new ones on its own.
 */

import { sessionGateAction } from '@/components/sessionGateAction';
import type { DroverGateEntry } from './droverGates';

/**
 * The `by` an auto-answer wears on the bus ledger.
 *
 * NEVER 'phone'. DROVE-239's whole finding is that the ledger's `by` field is
 * how a real auto-allow incident was discovered at all — an answer that
 * impersonates a thumb makes the next incident undiscoverable. The bus takes
 * any string here (`by: String(body.by || "unknown")`, server.js), so this
 * needs no bus change, and it reads in the log as
 * `event <id> resolved: allow by auto-accept over visual`.
 */
export const AUTO_ACCEPT_BY = 'auto-accept';

/**
 * What travels on the answer so the bridge can stamp the ledger.
 *
 * `via` is the key happy-cli's `answererOf` reads to decide `by`; the wrist
 * has stamped `via: 'watch'` and the push `via: 'push'` since DROVE-72, and
 * this is the third surface in that vocabulary. `channel` stays 'visual'
 * because visual is the floor of answer that no setting removes — auto-accept
 * is not a microphone, and an 'audio' stamp would be refused 403 on an event
 * whose delivery does not offer it.
 */
export function autoAcceptInput(): Record<string, unknown> {
    return { via: AUTO_ACCEPT_BY, channel: 'visual' };
}

/** Answer it, or present it and say why. */
export type AutoAcceptVerdict =
    | { answer: true }
    | { answer: false; reason: string };

const present = (reason: string): AutoAcceptVerdict => ({ answer: false, reason });

/**
 * Whether auto-accept may answer this gate, assuming the session's toggle is
 * already on. The toggle is NOT checked here: this file answers "is this gate
 * the right SHAPE", and the runtime answers "is this session opted in", so a
 * test can pin either without the other.
 *
 * The five refusals, each with the incident behind it:
 *
 * 1. NOT OFF THE BUS. A rig or remote session's own permission never came off
 *    the drover bus, so there is no ledger to write `by` to and no bridge to
 *    intercept the answer — `updatedInput` on a native permission is the
 *    TOOL's replacement input, and a stray `via` key there would be typed into
 *    the tool call (the same reason droverWatchFeed only stamps a mirrored
 *    card). An auto-answer that cannot be audited is exactly the thing
 *    DROVE-239 says must not exist, so it is not sent at all.
 * 2. A TO-DO. It owes nobody a decision and never expires; a spurious ack is
 *    pure loss (DROVE-69). Auto-accept answers gates that are HOLDING WORK UP,
 *    and a to-do holds nothing up.
 * 3. A QUESTION, answerable or not. Its yes is an option id or a sentence, not
 *    an allow — the bus answers a bare allow on a question with 409, and an
 *    older one took it and lost the answer.
 * 4. AN ACCOUNT LOGIN. Its yes is a code typed back (DROVE-212). There is no
 *    version of "always say yes" that produces an OAuth code.
 * 5. ANYTHING WHOSE KIND IS NOT 'permission'. Belt to the braces above: the
 *    action classifier reads the tool and the card, this reads the kind the
 *    bus stamped, and a card that carries one without the other is ambiguous
 *    by definition and therefore presents.
 */
export function autoAcceptVerdict(entry: DroverGateEntry): AutoAcceptVerdict {
    if (!entry.event) return present('not a bus gate: nothing would record who answered');
    if (entry.todo) return present('a to-do is a job, not a gate holding work up');
    if (entry.gate.kind !== 'permission') return present(`kind ${entry.gate.kind} is not a boolean allow`);
    // A permission that arrived carrying its own option list is a CHOICE
    // wearing a permission's kind. The bridge renders it with Allow and Deny
    // anyway, but "which yes" is a decision and this feature only makes one.
    if (entry.gate.options?.length) return present('a permission with options is a choice, not a boolean');
    const action = sessionGateAction(entry.gate.kind, entry.args, entry.tool);
    if (action !== 'allow-deny') return present(`the card renders as ${action}, not allow / deny`);
    return { answer: true };
}

/** Convenience for the runtime and for reading a test's intent. */
export function isAutoAcceptable(entry: DroverGateEntry): boolean {
    return autoAcceptVerdict(entry).answer;
}
