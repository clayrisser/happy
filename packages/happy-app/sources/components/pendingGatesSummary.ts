import type { DroverGate } from 'drover-watch';

export interface PendingGatesSummary {
    title: string;
    subtitle: string;
}

/**
 * What the pending-gates banner says, split out so the wording is testable
 * without mounting a component (BASED-98).
 *
 * A question and a permission read differently on purpose: a question is
 * something only a person can answer, a permission is something the agent
 * would rather you said yes to. Calling both "requests" is how the original
 * status dot managed to say nothing.
 */
export function describePendingGates(gates: DroverGate[]): PendingGatesSummary | null {
    if (gates.length === 0) return null;

    const questions = gates.filter((gate) => gate.kind === 'question').length;
    const permissions = gates.length - questions;

    const parts: string[] = [];
    if (questions > 0) parts.push(`${questions} question${questions === 1 ? '' : 's'}`);
    if (permissions > 0) parts.push(`${permissions} permission${permissions === 1 ? '' : 's'}`);

    const first = gates[0];
    // The gate's own words, not a count. `preview` is already truncated to the
    // wrist's limit, and Item clips what is left to two lines.
    const detail = first.preview?.trim() || first.title;

    return {
        title: `${parts.join(' and ')} waiting`,
        subtitle: gates.length === 1 ? detail : `${first.title} — ${detail}`,
    };
}
