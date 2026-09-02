import type { StatusStripContent, StatusStripZone } from './statusStripLayout';

/**
 * ONE STATUS ROW FOR EVERY HARNESS (DROVE-372).
 *
 * Clay, having just got a Codex session running: "Codex was able to start,
 * which is great, but why does it look different? The very bottom row looks
 * different than the Claude one."
 *
 * He photographed both. The Claude session:
 *
 *     ● 1m 20s 5.1k 👥9 ^        12.9M        jam@codejam.ni… 23% ^
 *
 * The Codex session, same build, same screen, one line lower down the app:
 *
 *     ●                     13% context ◌
 *
 * Two rows that share one slot, and even that one a different colour. Every
 * fact he reads the strip FOR — how long this turn has run, what it has spent,
 * how many workers are out, which account is paying — gone; and the one thing
 * Codex does put up, the context reading, is the one thing Claude does not.
 * Nothing overlaps, so it reads as a different component, which is exactly the
 * word he used.
 *
 * It was never a different component. `AgentInputStatusRow` is the only strip
 * either session mounts. The divergence is all upstream, in what reaches the
 * resolver, and each piece of it was defensible alone:
 *
 *   - `liveStatus` (the clock, the tally, the workers) is published by the CLI
 *     path Claude Code runs and not yet by Codex's, so the left zone is empty.
 *   - `usageBarGroups` is narrowed to the session's own harness (DROVE-352), so
 *     a Codex session with no codex account in the registry gets no account and
 *     no quota, and the right zone is empty.
 *   - `contextUsage` came off Codex's stream and not off Claude's, so the
 *     centre held the one and not the other.
 *
 * Three reasonable local decisions, and between them the SHAPE of the line
 * changes with the harness. That is the thing DROVE-231 laid the three zones
 * out to stop, and it is why this module exists rather than another condition
 * inside the row.
 *
 * THE RULE, AND THE NEXT HARNESS INHERITS IT:
 *
 *   the strip has ONE slot table, in ONE order, for every harness.
 *   a harness that does not publish a slot leaves it ABSENT.
 *   nothing is ever substituted into the gap, and the line is never re-shaped
 *   around what is missing.
 *
 * Absence is the ONLY difference a harness is allowed to make to this row. A
 * Codex session is a Claude session with slots missing, and when Codex starts
 * publishing a turn clock it appears where Claude's already is — not somewhere
 * the layout found room for it.
 *
 * `STATUS_ROW_SLOTS` is that order, written down once so a spec can hold four
 * harnesses against it instead of four screenshots against each other. It is
 * deliberately NOT `STATUS_ROW_GIVE_WAY`: that list is what the row drops when
 * it runs out of width, ranked by what Clay can most afford to lose, and it
 * says nothing about where a fact sits. This one is position and only
 * position, and the two are free to disagree — `contextPercent` gives way
 * first and sits eighth.
 *
 * The permission glyph in the session capsule is NOT on this table and stays
 * harness-specific on purpose (see `statusRowHarnessSpecific` below).
 */
export const STATUS_ROW_SLOTS = [
    /** The connection and what the main thread is doing. Never folds. */
    'dot',
    /** The tool the main thread is blocked on, when one is (DROVE-250). */
    'toolName',
    /** The turn's clock, `1m 20s`. */
    'elapsed',
    /** `5.1k` — what this thinking has cost (DROVE-244). */
    'thinkingTokens',
    /** The workers glyph and its count, beside the dot as Clay asked. */
    'workers',
    /** The caret that opens the agent tree. */
    'liveExpand',
    /** `1/3 tasks` (DROVE-167). */
    'tasks',
    /** The centre: the session's tally, main plus every subagent (DROVE-184). */
    'tokens',
    /** The centre: the context reading, counting down to the next compaction. */
    'context',
    /** The right: the account paying for this session (DROVE-138). */
    'account',
    /** The right: that account's quota, coloured by the sheet's ramp. */
    'quota',
    /** The caret that opens the account bars. */
    'quotaExpand',
] as const;

export type StatusRowSlot = (typeof STATUS_ROW_SLOTS)[number];

/**
 * Which zone each slot lands in.
 *
 * A fact's zone is a property of the SLOT and never of the harness, which is
 * the half of the rule a reader checks by eye: Clay's two screenshots differ
 * because the left and right zones were empty on one of them, not because
 * anything moved between zones.
 */
export const statusRowSlotZone: Record<StatusRowSlot, StatusStripZone> = {
    dot: 'left',
    toolName: 'left',
    elapsed: 'left',
    thinkingTokens: 'left',
    workers: 'left',
    liveExpand: 'left',
    tasks: 'left',
    tokens: 'centre',
    context: 'centre',
    account: 'right',
    quota: 'right',
    quotaExpand: 'right',
};

/**
 * Which slots this content fills, in the table's order and no other.
 *
 * Derived by FILTERING `STATUS_ROW_SLOTS`, not by pushing in the order the
 * fields happen to be read, so a slot cannot arrive out of position however
 * the content was assembled. That is the property the DROVE-372 spec holds
 * four harnesses to: the answer for any content is always a subsequence of the
 * one table, so two harnesses can differ in WHICH slots they fill and never in
 * where those slots are.
 *
 * `context` is one slot, not two. The ring and its percent are the same
 * reading, and whether the percent survives is a WIDTH decision the give-way
 * order makes — the same decision, on the same order, whichever harness is
 * underneath. A Codex row is not allowed to print the number because it
 * happens to have an empty right zone while a Claude row hides it because it
 * does not.
 */
export function statusRowSlots(content: StatusStripContent): StatusRowSlot[] {
    return STATUS_ROW_SLOTS.filter((slot) => statusRowSlotFilled(content, slot));
}

/** Whether one slot has a fact in it. */
export function statusRowSlotFilled(content: StatusStripContent, slot: StatusRowSlot): boolean {
    switch (slot) {
        case 'dot':
            return !!content.dot;
        case 'toolName':
            return !!content.toolName;
        case 'elapsed':
            return !!content.elapsed;
        case 'thinkingTokens':
            return !!content.thinkingTokens;
        case 'workers':
            return (content.workers ?? 0) > 0;
        case 'liveExpand':
            return !!content.liveExpands;
        case 'tasks':
            return !!content.tasks;
        case 'tokens':
            return !!content.tokens;
        case 'context':
            return !!content.contextGauge;
        case 'account':
            return !!content.account;
        case 'quota':
            return !!(content.quotaPercent || content.quotaWindow);
        case 'quotaExpand':
            return !!content.quotaExpands;
    }
}

/**
 * The ONE thing about this composer that is allowed to differ by harness, and
 * it is not on this row (DROVE-372).
 *
 * The permission glyph inside the session capsule is a lock on Claude and a
 * shield on Codex, and that is deliberate rather than a case this ticket
 * missed. They are different axes: Claude Code has a PERMISSION MODE (ask,
 * accept edits, plan, bypass) and Codex has an APPROVAL MODE (untrusted,
 * on-failure, on-request, never). The values do not correspond, so one glyph
 * standing for both would be telling the user the two sessions are set the
 * same way when they cannot be compared at all.
 *
 * Written down here, next to the rule it is the exception to, because the
 * obvious next move on reading DROVE-372 is to unify that glyph too.
 */
export const statusRowHarnessSpecific = ['capsulePermissionGlyph'] as const;
