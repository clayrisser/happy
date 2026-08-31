/**
 * The compaction the session is running RIGHT NOW (DROVE-257).
 *
 * Clay, holding his phone up next to the terminal: "It's compacting but it's
 * not pulsing purple." The terminal read `Compacting conversation… (1m 55s,
 * 2.3k tokens)` over `100% context used`; the phone's strip drew a flat GREEN
 * dot with three workers, which is the app's word for connected and idle. The
 * session was doing the single most disruptive thing it can do and the strip
 * said nothing was happening.
 *
 * THE DOT WAS INNOCENT. DROVE-231 gave `compacting` a hue (#AF52DE) and put it
 * in the blink set, and `statusDotState` has resolved it since the day it was
 * written. The state simply never arrived, which is the same shape as the
 * thinking bug DROVE-244 fixed: the vocabulary was right and nothing upstream
 * ever spoke the word.
 *
 * WHY IT NEVER ARRIVED, measured rather than guessed. DROVE-231 could not see
 * the event so it INFERRED one — main thread working, no tool open, context at
 * the compaction point — and the first of those three is false for the whole
 * compaction. Claude Code writes NOTHING to the transcript while it compacts.
 * On Clay's own 2026-08-29 session the last `tool_result` lands at 21:30:59 and
 * the `compact_boundary` at 21:33:11, with `compactMetadata.durationMs` of
 * 126552 in between and not one record: `lastRecordAt` goes stale after the
 * 10s idle grace, no tool is open, and the fd 3 fetch counter is no help
 * either because `fetch()` resolves at the response HEADERS while the summary
 * streams for another two minutes. So `mainWorking` is false, `main` is
 * omitted, and the app draws the idle colour. Three subagents were still out,
 * which is why the snapshot existed at all and the strip could say `3`.
 *
 * SO IT IS OBSERVED INSTEAD OF INFERRED, from the two signals Claude Code
 * actually emits around the pass:
 *
 *   - `PreCompact`, a first-class hook event with a `manual`/`auto` trigger,
 *     fired before the summary call. That is the START, and it is exact.
 *   - `compact_boundary`, the `system` record written into the transcript when
 *     it lands, carrying `compactMetadata` with the trigger, both token counts
 *     and the true duration. That is the END, and it is exact too.
 *
 * `SessionStart` with `source: "compact"` fires after the boundary as well and
 * is wired as a second end, because a manual `/compact` mints a new session id
 * and the reader may be pointed at the new transcript before it has read the
 * old one's boundary line.
 *
 * THE FAILSAFE IS THE POINT OF THE CEILING. Every end signal is a message from
 * a process that can die mid-compaction, and a latch nobody clears leaves a
 * purple blinking dot on an idle session forever — worse than the green one
 * this replaces, because it is a lie that never corrects itself. So the latch
 * expires on its own. Ten minutes is far past any compaction observed here
 * (the longest on this machine is 2m 07s at a 1M-token context) and far short
 * of a working day.
 *
 * A PROCESS SINGLETON, deliberately. One happy-cli process drives one Claude
 * pane, and the hook server, the launcher and the live status reader are all
 * inside it; threading a latch from the hook server (built in runClaude before
 * the loop starts) down through the launcher into the scanner would be four
 * new parameters to carry one boolean. The factory is exported anyway so the
 * tests can hold their own.
 */

/** A compaction pass in flight. Absolute epoch ms, like every other time on the wire. */
export interface CompactionState {
    /** When `PreCompact` fired, epoch ms. */
    startedAt: number
    /** `auto` when the context filled, `manual` when someone typed `/compact`. */
    trigger?: 'auto' | 'manual'
    /**
     * How far along, 0-100 — and NOTHING FILLS THIS IN TODAY.
     *
     * Clay asked for the 38% his terminal was showing, so this is what was
     * looked for and what was found. Claude Code has no compaction progress
     * figure to give: `compact_start` sets the spinner to `Compacting
     * conversation…` with an optional hint STRING and no number, the only
     * counts anywhere (`preTokens`, `postTokens`, `durationMs`) are written
     * after the pass is over, and the `compact_progress` events that do carry
     * stages go to the SDK's status channel, which the TUI path this CLI
     * drives does not emit. The bar at 38% sits beside the spinner for every
     * long call, not only a compaction; publishing it as "compaction 38% done"
     * would be inventing a denominator.
     *
     * What IS real and is carried instead is the ELAPSED time, off
     * `startedAt` — the half of the terminal's `(1m 55s, 2.3k tokens)` that
     * means what it appears to mean.
     *
     * The field stays because the app already draws it where present and it
     * costs one optional number on the wire, so a real source can be wired to
     * `progress()` later without touching the app. It must not be filled from
     * a guess.
     */
    percent?: number
}

export interface CompactionLatch {
    /** `PreCompact` fired. */
    begin(trigger: 'auto' | 'manual' | undefined, at?: number): void
    /** The boundary landed, or the session restarted on the compacted transcript. */
    end(at?: number): void
    /** Best-effort progress, from whoever can see it. Ignored when nothing is latched. */
    progress(percent: number): void
    /** The pass in flight, or null. Expired latches read as null. */
    read(now?: number): CompactionState | null
}

/**
 * How long a latch may stand with no end signal before it lets go.
 *
 * See the header: this is the guard against a purple dot outliving the process
 * that set it, not a timeout on compaction itself.
 */
export const compactionMaxMs = 10 * 60_000

export function createCompactionLatch(maxMs: number = compactionMaxMs): CompactionLatch {
    let state: CompactionState | null = null
    return {
        begin(trigger, at = Date.now()) {
            // A second `PreCompact` without an end is one compaction, not two:
            // keep the first start so the clock the app draws is the real one.
            if (state) {
                if (trigger && !state.trigger) state.trigger = trigger
                return
            }
            state = { startedAt: at, ...(trigger ? { trigger } : {}) }
        },
        end() {
            state = null
        },
        progress(percent) {
            if (!state) return
            if (!Number.isFinite(percent)) return
            state.percent = Math.min(100, Math.max(0, Math.round(percent)))
        },
        read(now = Date.now()) {
            if (!state) return null
            if (now - state.startedAt > maxMs) {
                state = null
                return null
            }
            return state
        },
    }
}

/** The one latch this process's hook server writes and its live status reads. */
export const compactionLatch = createCompactionLatch()
