/**
 * Spotting "you are out of headroom" in local mode (BASED-98).
 *
 * The fork already understands rate limits on the REMOTE path, where the Agent
 * SDK pushes a typed `rate_limit_event` (see claude/utils/usageLimits.ts).
 * Local mode has no such channel: Claude Code runs as a child process in Clay's
 * own terminal and says it in prose. So this reads the prose.
 *
 * Reading prose for a control decision deserves suspicion, so the matching is
 * deliberately narrow:
 *   - only non-user text is ever offered here by the caller, so quoting the
 *     phrase in a question does not trigger a flip;
 *   - the phrase must be limit-shaped, not merely contain the word "limit"
 *     ("the rate limit code path" must not flip a session mid-refactor);
 *   - a reset time is used when Claude gives one, and only then.
 */

/** Epoch ms, or null when the message named no reset time. */
export interface LimitHit {
    resetsAt: number | null
    /** The sentence that matched, for the ledger and the announcement. */
    quote: string
}

// Each pattern is a whole claim, not a keyword. Claude Code has phrased the
// limit several ways across versions and plans, so more than one is listed;
// they are alternatives, not a checklist.
//
// The second one is measured, not guessed. A real limit hit while this was
// being built and read, verbatim:
//
//   You've reached your Fable 5 limit. Run /usage-credits to continue or
//   switch models with /model.
//
// which an earlier, tighter pattern missed, because the limit is named after
// the MODEL rather than called a "usage limit". Hence the optional middle.
const limitPatterns: RegExp[] = [
    /\b(?:claude )?usage limit reached\b/i,
    /\byou(?:'ve| have) reached your (?:[\w.+\- ]{1,30} )?limit\b/i,
    /\b\d+\s*-?\s*hour limit reached\b/i,
    /\bapproaching (?:your )?usage limit\b/i,
    /\brate[_ ]limit[_ ]error\b/i,
    /\bout of (?:usage )?credits\b/i,
]

// "resets at 3pm", "will reset at 2026-08-28T20:00:00Z", "resets 3:30pm (PDT)"
const resetPatterns: RegExp[] = [
    /\breset(?:s|ting)?(?: at)?\s+(\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2}))/i,
    /\breset(?:s|ting)?(?: at)?\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm))/i,
    /\breset(?:s|ting)?(?: at)?\s+(\d{1,2}:\d{2})\b/i,
]

/** Turn a matched reset fragment into epoch ms, or null if it cannot be trusted. */
function parseReset(fragment: string, now: number): number | null {
    const iso = Date.parse(fragment)
    if (Number.isFinite(iso)) return iso

    const clock = fragment.trim().toLowerCase()
    const m = clock.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/)
    if (!m) return null
    let hour = parseInt(m[1], 10)
    const minute = m[2] ? parseInt(m[2], 10) : 0
    const meridiem = m[3]
    if (hour > 23 || minute > 59) return null
    if (meridiem === 'pm' && hour < 12) hour += 12
    if (meridiem === 'am' && hour === 12) hour = 0

    // A bare wall clock is in the machine's own zone, which is the zone Claude
    // printed it in. If that instant is already past, it means tomorrow.
    const at = new Date(now)
    at.setHours(hour, minute, 0, 0)
    let ms = at.getTime()
    if (ms <= now) ms += 24 * 60 * 60 * 1000
    // A "reset" more than a day out is a misparse, not a limit window.
    if (ms - now > 24 * 60 * 60 * 1000) return null
    return ms
}

export function detectLimit(text: string, now = Date.now()): LimitHit | null {
    if (!text) return null
    const hit = limitPatterns.find((p) => p.test(text))
    if (!hit) return null

    // Quote the sentence that matched rather than the whole message: a limit
    // notice can arrive appended to a long turn.
    const sentences = text.split(/(?<=[.!?])\s+/)
    const quote = (sentences.find((s) => hit.test(s)) ?? text).trim().slice(0, 300)

    for (const p of resetPatterns) {
        const m = quote.match(p) ?? text.match(p)
        if (m) {
            const resetsAt = parseReset(m[1], now)
            if (resetsAt) return { resetsAt, quote }
        }
    }
    return { resetsAt: null, quote }
}

export interface TranscriptText {
    text: string
    /**
     * Claude Code writes its own notices — including the limit one — as an
     * assistant message with `model: "<synthetic>"`. That flag is the single
     * most useful signal here: a synthetic message is the harness talking, so
     * it can never be Clay or Claude merely DISCUSSING a limit. Matching is
     * loosened when it is set and kept strict when it is not.
     */
    synthetic: boolean
}

/**
 * Pull the readable text out of a transcript entry.
 *
 * User turns are excluded on purpose: Clay pasting a limit message into a
 * question is not the session hitting a limit.
 */
export function textOfTranscriptMessage(message: unknown): TranscriptText | null {
    const m = message as {
        type?: string
        message?: { role?: string; content?: unknown; model?: string }
        content?: unknown
    }
    if (!m || typeof m !== 'object') return null
    const role = m.message?.role ?? (m.type === 'user' ? 'user' : undefined)
    if (role === 'user' || m.type === 'user') return null

    const synthetic = m.message?.model === '<synthetic>'
    const content = m.message?.content ?? m.content

    let text: string | null = null
    if (typeof content === 'string') {
        text = content
    } else if (Array.isArray(content)) {
        text = content
            .map((block) => {
                const b = block as { type?: string; text?: string }
                return b && typeof b.text === 'string' && b.type !== 'tool_result' ? b.text : ''
            })
            .filter(Boolean)
            .join('\n')
    }
    return text ? { text, synthetic } : null
}
