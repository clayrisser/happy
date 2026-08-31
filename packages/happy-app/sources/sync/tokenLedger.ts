/**
 * EVERY TOKEN THIS PHONE HAS EVER SEEN SPENT, SPLIT BY MODEL (DROVE-241).
 *
 * Clay: "Just for fun on the home page keep track of all tokens ever used. Of
 * course you can long press it to reset that counter. Have it breakdown when
 * single pressing by model."
 *
 * WHAT IT IS KEYED TO, WHICH IS THE PART THAT MATTERS. Not the Claude
 * account. Clay's session flipped twice in one evening, `main` ->
 * `jamrizzi` -> `account-2`, and a total keyed to whichever account was
 * current would appear to zero itself at each flip. That is the same
 * complaint this ticket opened with — "why does my counter in my session keep
 * resetting?" — wearing a different hat, and it is the worst way to fail here.
 *
 * So the ledger is keyed to THE DEVICE, and it lives in its own MMKV instance
 * (see tokenLedgerStore.ts) rather than the default one a logout clears. The
 * only thing that resets it is the long press. Nothing else may.
 *
 * The MARKS below are keyed to the DROVER session id, which a flip does not
 * change: a flip is a message into the same drover session, and it is
 * `metadata.droverAccount` that moves, not `session.id`.
 *
 * THE CREDIT RULE IS ONE LINE AND IT IS WHAT SURVIVES THE FLIP.
 *
 *     credit = max(0, next - mark);  mark = next
 *
 * `liveStatus.tokens.session` grows all evening and then DROPS, twice over,
 * for reasons that are not a session ending: a flip carries the transcript
 * into another account's config dir and Claude Code rewrites its tail, so the
 * CLI's reader re-seeds from the last 2MB and republishes a smaller number
 * (`readNewLines` in happy-cli's liveStatus.ts says so in as many words). A
 * counter that credited the new figure whole would count that tail twice; one
 * that treated the drop as an ending would lose the evening. `max(0, …)`
 * does neither. The mark falls to the re-seeded figure, nothing is credited
 * for the fall, and growth past it is credited exactly once.
 *
 * Which is why the home page's number can only go up while the strip's number
 * legitimately goes down. They are answering different questions.
 *
 * WHAT IT CANNOT SEE. `liveStatus` is published while a session is working
 * and nulled the moment it goes idle, so this banks what the phone WAS
 * CONNECTED FOR. Spend while the app is dead is not in it. That is a floor on
 * a device-side ledger rather than a bug to fix here; the server's own
 * `/v1/usage/query` (sync/apiUsage.ts, already returns `tokensByModel`) is
 * where an authoritative all-time figure would come from if this one is ever
 * not enough.
 *
 * Pure. No MMKV, no store, no clock except what a caller passes.
 */
import { shortModelName } from '@/components/sessionPillLabel';

/** One session's published totals, as the ledger is asked to bank them. */
export interface TokenLedgerSighting {
    /** The DROVER session id. Not the Claude session, not the account. */
    sessionId: string;
    /** `liveStatus.tokens.session`: main plus every subagent, this session. */
    session: number;
    /**
     * `liveStatus.tokens.sessionByModel`. Absent on a CLI older than
     * DROVE-241, and absent on a session that has not relaunched since
     * (DROVE-220). The parts may be SHORT of `session` and never exceed it.
     */
    byModel?: Record<string, number>;
}

/** The last figures credited for one session, so growth can be told from noise. */
export interface TokenLedgerMark {
    session: number;
    byModel: Record<string, number>;
    /** Last touched, for the eviction below. Nothing on screen reads it. */
    at: number;
}

export interface TokenLedger {
    /** All time, by Claude Code's own model id. */
    byModel: Record<string, number>;
    /**
     * All time that named no model: an older CLI, or Claude Code's own
     * `<synthetic>` records. Kept SEPARATE and shown as its own row, so the
     * breakdown's parts always add to the headline number.
     */
    unattributed: number;
    /** Per drover session. Bounded; see `markCap`. */
    marks: Record<string, TokenLedgerMark>;
    /** When the long press last zeroed it. Null means it never has. */
    resetAt: number | null;
}

export const emptyTokenLedger: TokenLedger = {
    byModel: {},
    unattributed: 0,
    marks: {},
    resetAt: null,
};

/**
 * How many sessions keep a mark.
 *
 * A session that has gone idle publishes `liveStatus: null` and stops
 * reporting, so an evicted mark only matters if that session wakes up again.
 * When it does, it relaunches Claude Code and its `session` figure genuinely
 * restarts from zero, so crediting it whole is right rather than a double
 * count. The cap is generous so that stays true in practice.
 */
export const markCap = 512;

/** The headline: every model, plus what named none. */
export function tokenLedgerTotal(ledger: TokenLedger): number {
    return Object.values(ledger.byModel).reduce((sum, n) => sum + n, 0) + ledger.unattributed;
}

/** What one mark says was already banked for a model. */
function markOf(ledger: TokenLedger, sessionId: string): TokenLedgerMark {
    return ledger.marks[sessionId] ?? { session: 0, byModel: {}, at: 0 };
}

/** The rule. Growth is credited; a fall re-baselines and credits nothing. */
function grown(next: number, mark: number): number {
    return Math.max(0, next - mark);
}

/**
 * Bank what these sessions have published since they were last seen.
 *
 * Idempotent on a repeat: a sighting identical to the mark credits nothing,
 * which is what lets this run on every `applySessions` without counting the
 * same tokens on every socket frame.
 */
export function creditTokenLedger(
    ledger: TokenLedger,
    sightings: readonly TokenLedgerSighting[],
    now: number,
): TokenLedger {
    if (sightings.length === 0) return ledger;
    let moved = false;
    const byModel = { ...ledger.byModel };
    const marks = { ...ledger.marks };
    let unattributed = ledger.unattributed;

    for (const sighting of sightings) {
        if (!sighting.sessionId) continue;
        if (!Number.isFinite(sighting.session) || sighting.session < 0) continue;
        const mark = markOf(ledger, sighting.sessionId);
        const next = Math.round(sighting.session);
        const nextByModel = sighting.byModel ?? {};

        // Per model first, so what is left over is what named no model.
        let nextAttributed = 0;
        for (const [model, raw] of Object.entries(nextByModel)) {
            if (!Number.isFinite(raw) || raw <= 0) continue;
            const value = Math.round(raw);
            nextAttributed += value;
            const credit = grown(value, mark.byModel[model] ?? 0);
            if (credit > 0) {
                byModel[model] = (byModel[model] ?? 0) + credit;
                moved = true;
            }
        }
        // The WHOLE mark's attributed share, including a model this sighting
        // no longer names. Counting only the models in common would treat the
        // dropped model's share as leftover and credit it a second time.
        const markAttributed = Object.values(mark.byModel).reduce((sum, n) => sum + n, 0);

        // The leftover. The split can be short of the total and must never
        // exceed it, so this is clamped rather than trusted.
        const credit = grown(
            Math.max(0, next - nextAttributed),
            Math.max(0, mark.session - markAttributed),
        );
        if (credit > 0) {
            unattributed += credit;
            moved = true;
        }

        const cleaned: Record<string, number> = {};
        for (const [model, raw] of Object.entries(nextByModel)) {
            if (Number.isFinite(raw) && raw > 0) cleaned[model] = Math.round(raw);
        }
        const same = mark.session === next
            && JSON.stringify(cleaned) === JSON.stringify(mark.byModel);
        if (!same) {
            marks[sighting.sessionId] = { session: next, byModel: cleaned, at: now };
            moved = true;
        }
    }

    if (!moved) return ledger;
    return { ...ledger, byModel, unattributed, marks: evict(marks) };
}

/** Oldest-touched marks out, once there are more than `markCap`. */
function evict(marks: Record<string, TokenLedgerMark>): Record<string, TokenLedgerMark> {
    const ids = Object.keys(marks);
    if (ids.length <= markCap) return marks;
    const kept = ids
        .sort((a, b) => marks[b].at - marks[a].at)
        .slice(0, markCap);
    const next: Record<string, TokenLedgerMark> = {};
    for (const id of kept) next[id] = marks[id];
    return next;
}

/**
 * The long press, after the confirm.
 *
 * The MARKS SURVIVE. Zeroing them too would re-credit every live session's
 * whole running total on the next socket frame, so the number would bounce
 * straight back off zero and the reset would read as broken. Resetting means
 * "count from here", and the marks are where here is.
 */
export function resetTokenLedger(ledger: TokenLedger, now: number): TokenLedger {
    return { byModel: {}, unattributed: 0, marks: ledger.marks, resetAt: now };
}

/** One line of the breakdown. */
export interface TokenLedgerRow {
    /** The model id, or the empty string for the unattributed row. */
    model: string;
    /** `Opus 5`, `Haiku 4.5`, or the raw id when this build cannot name it. */
    label: string;
    tokens: number;
}

/**
 * The breakdown a single press opens: biggest first, unattributed last.
 *
 * Names come from `shortModelName`, the same function the composer's session
 * pill uses, so `claude-haiku-4-5-20251001` reads `Haiku 4.5` on both surfaces
 * and a new model id cannot be pretty in one place and raw in the other. An id
 * this build has never heard of keeps its id: a cosmetic miss, never lost
 * spend.
 */
export function tokenLedgerRows(ledger: TokenLedger, unattributedLabel: string): TokenLedgerRow[] {
    const rows: TokenLedgerRow[] = Object.entries(ledger.byModel)
        .filter(([, tokens]) => tokens > 0)
        .map(([model, tokens]) => ({
            model,
            label: shortModelName({ modelId: model }) ?? model,
            tokens,
        }))
        .sort((a, b) => b.tokens - a.tokens || a.label.localeCompare(b.label));
    if (ledger.unattributed > 0) {
        rows.push({ model: '', label: unattributedLabel, tokens: ledger.unattributed });
    }
    return rows;
}
