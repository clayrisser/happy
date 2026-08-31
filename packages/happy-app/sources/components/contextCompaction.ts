/**
 * When the next compaction happens, said honestly (DROVE-231).
 *
 * Clay: "Also should show something for context or something so we know when
 * compaction happens next."
 *
 * WHAT IS ACTUALLY KNOWABLE, because that is the whole constraint here. The
 * phone has two numbers and they are both real:
 *
 *   - `usage.contextSize`, the assistant turn's own input footprint:
 *     `cache_creation_input_tokens + cache_read_input_tokens + input_tokens`,
 *     assembled in sync/reducer/reducer.ts from the API's `usage` block on the
 *     latest assistant message.
 *   - `usage.context_window`, the model's window, published on the same block
 *     and carried through as `contextWindow`.
 *
 * Both already flow to the app. NO CLI CHANGE IS NEEDED for this reading,
 * which matters: DROVE-220 means a CLI change does not reach a session that is
 * already running, so anything that needed one would be invisible on every
 * session Clay currently has open.
 *
 * WHAT IS NOT KNOWABLE, and is therefore not drawn. Not turns, not minutes,
 * not "3 messages until compaction". The next turn can add two hundred tokens
 * or two hundred thousand depending on what it reads, so any count of turns is
 * a number made up on the spot, and a countdown that lies is worse than
 * nothing. Nor can the phone see a compaction HAPPEN: happy-cli drops the
 * compaction summary out of the transcript (`isCompactSummary` returns no
 * envelopes in sessionProtocolMapper.ts) and the live snapshot has no field
 * for one. Making that exact is a CLI change, and it is not made here.
 *
 * SO THE RING IS THE COUNTDOWN. It fills toward the compaction point rather
 * than toward the raw window, so a full ring means compaction now and the
 * fraction in between is the one honest answer to "when next". A tap prints
 * the sentence with its source in it.
 */
import { formatTokens } from '@/utils/liveStatus';

/**
 * The share of the window at which the agent compacts.
 *
 * 92, which is Claude Code's own auto-compact point: it is the figure its
 * `Context left until auto-compact` readout counts down to, with the last
 * slice of the window held back so the compaction pass itself has room to run.
 * It is NOT published on the wire, which is why it is a constant here with its
 * provenance written next to it rather than a number read off a message.
 *
 * The drawn thing is deliberately insensitive to getting this slightly wrong.
 * If the real point is 90 or 95 the ring fills a few percent fast or slow near
 * the very top and nothing else on the strip changes: no turn count moves, no
 * clock runs down, and the tap still prints the two real numbers. That is the
 * property worth having. A design that put a countdown on this constant would
 * be wrong by however wrong the constant is, which is exactly the failure this
 * is written to avoid.
 */
export const CONTEXT_COMPACTION_PERCENT = 92;

export interface ContextReading {
    /** The turn's input footprint, in tokens. */
    usedTokens: number;
    /** The model's window, in tokens. */
    windowTokens: number;
    /** Used as a share of the WINDOW, 0-100. Exactly true. */
    usedPercent: number;
    /** Where the compaction pass fires, in tokens. */
    compactionAtTokens: number;
    /**
     * How full the ring is: used against the COMPACTION point, 0-1. One means
     * compaction now, not "window full".
     */
    fraction: number;
    /** The compaction point has been reached. */
    atCompaction: boolean;
    /** `84.0k of 200.0k context, compacts near 184.0k`. The tap's sentence. */
    detail: string;
}

/**
 * The reading, or null when there is no honest denominator.
 *
 * Null until the session reports its window, which is `getContextStatus`'s
 * existing rule and the right one: a percentage against a guessed window
 * corrects itself upward later, and a context gauge that goes DOWN reads as
 * the context refilling.
 */
export function contextReading(
    contextSize: number | null | undefined,
    contextWindow: number | null | undefined,
): ContextReading | null {
    if (typeof contextWindow !== 'number' || !Number.isFinite(contextWindow) || contextWindow <= 0) {
        return null;
    }
    if (typeof contextSize !== 'number' || !Number.isFinite(contextSize) || contextSize < 0) {
        return null;
    }
    const compactionAtTokens = Math.round(contextWindow * (CONTEXT_COMPACTION_PERCENT / 100));
    const usedPercent = Math.min(100, Math.max(0, (contextSize / contextWindow) * 100));
    const fraction = Math.min(1, Math.max(0, contextSize / compactionAtTokens));
    return {
        usedTokens: contextSize,
        windowTokens: contextWindow,
        usedPercent,
        compactionAtTokens,
        fraction,
        atCompaction: contextSize >= compactionAtTokens,
        detail: `${formatTokens(contextSize)} of ${formatTokens(contextWindow)} context, compacts near ${formatTokens(compactionAtTokens)}`,
    };
}

/**
 * The percent the strip prints when it has room for text.
 *
 * The share of the way to COMPACTION, not of the window, so it agrees with the
 * ring beside it. A row at the compaction point reads 100% and compacts; a row
 * at 100% of the window is a state that does not occur, because the agent
 * compacts first.
 */
export function contextCompactionPercent(reading: ContextReading): number {
    return Math.round(reading.fraction * 100);
}
