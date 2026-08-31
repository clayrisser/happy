import type { DroverGate } from 'drover-watch';

export type PendingGatesKind = 'todo' | 'question' | 'permission' | 'mixed';

export interface PendingGatesSummary {
    title: string;
    subtitle: string;
    /**
     * What the whole set is, so a banner can pick its glyph: a checklist for
     * to-dos only, a hand for anything that is blocking a session.
     */
    kind: PendingGatesKind;
}

/**
 * What the pending-gates banner says, split out so the wording is testable
 * without mounting a component (BASED-98).
 *
 * A to-do, a question and a permission read differently on purpose (DROVE-89).
 * A to-do is a job for you and blocks nothing; a question is something only a
 * person can answer; a permission is something the agent would rather you said
 * yes to. Calling all three "permission waiting" put Deny/Allow under a to-do,
 * and Clay pressed Allow eight times on a card the bus could not take that
 * answer for.
 */
export function describePendingGates(gates: DroverGate[]): PendingGatesSummary | null {
    if (gates.length === 0) return null;

    const todos = gates.filter((gate) => gate.kind === 'todo').length;
    const questions = gates.filter((gate) => gate.kind === 'question').length;
    const permissions = gates.length - todos - questions;

    const parts: string[] = [];
    if (todos > 0) parts.push(`${todos} to-do${todos === 1 ? '' : 's'}`);
    if (questions > 0) parts.push(`${questions} question${questions === 1 ? '' : 's'}`);
    if (permissions > 0) parts.push(`${permissions} permission${permissions === 1 ? '' : 's'}`);

    const kind: PendingGatesKind =
        parts.length > 1 ? 'mixed'
        : todos > 0 ? 'todo'
        : questions > 0 ? 'question'
        : 'permission';

    // One kind names itself; a mix leads with the total and then lists what
    // is in it, so "2 waiting: 1 to-do, 1 permission" reads as one line on a
    // phone rather than a sentence that wraps.
    const title =
        kind === 'mixed' ? `${gates.length} waiting: ${parts.join(', ')}`
        : kind === 'todo' ? `${parts[0]} for you`
        : `${parts[0]} waiting`;

    const first = gates[0];
    // The gate's own words, not a count. `preview` is already truncated to the
    // wrist's limit, and Item clips what is left to two lines.
    const detail = first.preview?.trim() || first.title;

    return {
        title,
        subtitle: gates.length === 1 ? detail : `${first.title} · ${detail}`,
        kind,
    };
}
