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

// --- the one vocabulary both sides of a limit can be reduced to ------------
//
// A usage row scoped to a model and a model id are written in DIFFERENT
// languages, and that mismatch is the whole reason this exists. Measured
// across all five of Clay's accounts:
//
//   the usage cache says   scope: {model: {id: null, display_name: "Fable"}}
//   the model catalog says {id: "claude-fable-5", display_name: "Fable 5"}
//
// `id` is null on every scoped row that has ever appeared here, so there is no
// id to join on, and the scoped display_name is not the catalog display_name —
// it is the FAMILY, capitalized. Comparing "Fable" to "Fable 5" fails. So both
// sides are reduced to a family token instead, and only families are compared.
const families = new Set(['fable', 'mythos', 'opus', 'sonnet', 'haiku'])

// Claude Code's own alias list is
// ["sonnet","opus","haiku","fable","best","sonnet[1m]","opus[1m]","fable[1m]","opusplan"],
// and only three of those name a family on their own. `best` and `opusplan`
// are resolved at RUNTIME (opusplan means Opus in plan mode and Sonnet
// outside it), and the bare `haiku` alias falls back to sonnet — its own
// qde("haiku") returns "sonnet". A guess at any of them would be a guess that
// makes an account look MORE available than it is, so they return unknown.
const staticAliases = new Set(['sonnet', 'opus', 'fable'])

/**
 * Reduce a model id or alias to its family, or undefined when it cannot be
 * known from the string alone.
 *
 * Undefined is a real answer here, not a failure: everything downstream treats
 * an unknown family as "behave exactly as this did before families existed".
 */
export function familyOf(model: unknown): string | undefined {
    if (typeof model !== 'string') return undefined
    let s = model.trim().toLowerCase()
    // `<synthetic>` is the harness talking, including in the very limit notice
    // that triggers an auto-flip. It is never a model this session ran.
    if (!s || s === '<synthetic>') return undefined
    // Claude Code's own helper is pn(e){return e.replace(/\[1m\]$/i,"")}.
    s = s.replace(/\[[12]m\]$/, '')
    // A provider prefix: us.anthropic.claude-fable-5.
    s = s.slice(s.lastIndexOf('.') + 1)
    if (!s.includes('-')) return staticAliases.has(s) ? s : undefined
    // The family is not at a fixed position — claude-opus-5 puts it second and
    // claude-3-5-sonnet puts it last — so take the first segment that IS one.
    // A trailing date in claude-haiku-4-5-20251001 falls out for free.
    for (const segment of s.split('-')) if (families.has(segment)) return segment
    return undefined
}

/**
 * Reduce a scope display name ("Fable", "Fable 5") to its family.
 *
 * First word only, and it must BE a family. That rule is inferred from one
 * observed value plus the binary's family table, so a shape nobody has seen —
 * "Claude Fable", say — returns undefined and every caller falls back to
 * blocking. Guessing wide here would unpark a genuinely exhausted account.
 */
export function familyOfDisplayName(displayName: unknown): string | undefined {
    if (typeof displayName !== 'string') return undefined
    const first = displayName.trim().toLowerCase().split(/\s+/)[0]
    return families.has(first) ? first : undefined
}

/** "fable" -> "Fable", for a sentence a human reads. */
export function familyLabel(family: string): string {
    return family.charAt(0).toUpperCase() + family.slice(1)
}

/** Epoch ms, or null when the message named no reset time. */
export interface LimitHit {
    resetsAt: number | null
    /** The sentence that matched, for the ledger and the announcement. */
    quote: string
    /**
     * The model family that ran out, when the notice named one — "fable" for
     * "You've reached your Fable 5 limit." Null when the notice was generic,
     * and null is the CONSERVATIVE answer: a cooldown with no family blocks
     * the account for every model, which is what this always did.
     */
    family: string | null
}

// Each pattern is a whole claim, not a keyword. Claude Code has phrased the
// limit several ways across versions and plans, so more than one is listed;
// they are alternatives, not a checklist.
//
// The named-model one is measured, not guessed. A real limit hit while this
// was being built and read, verbatim:
//
//   You've reached your Fable 5 limit. Run /usage-credits to continue or
//   switch models with /model.
//
// which an earlier, tighter pattern missed, because the limit is named after
// the MODEL rather than called a "usage limit". Hence the optional middle —
// and that middle is now CAPTURED rather than skipped, because it is the
// harness naming the model that actually ran out at the exact instant the
// cooldown is recorded. Nothing else on disk says it as plainly.
const namedModelLimit = /\byou(?:'ve| have) reached your (?:([\w.+\- ]{1,30}) )?limit\b/i

const limitPatterns: RegExp[] = [
    /\b(?:claude )?usage limit reached\b/i,
    namedModelLimit,
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

/**
 * The family a limit NOTICE names, read back out of its own words.
 *
 * The family belongs in a field, and detectLimit puts it there. But the notice
 * itself is the same evidence written in English, and it is the ONLY copy that
 * survives in a ledger entry recorded before that field existed:
 *
 *   {"until": …, "reason": "You've reached your Fable 5 limit.", "at": …}
 *
 * Reading it back is what stops such an entry being served as an account-wide
 * blackout. As narrow as everything else here: the sentence has to be
 * limit-shaped AND name a model that reduces to a known family, or this is
 * undefined and the caller goes on blocking everything.
 */
export function familyOfLimitText(text: unknown): string | undefined {
    if (typeof text !== 'string') return undefined
    return familyOfDisplayName(text.match(namedModelLimit)?.[1])
}

export function detectLimit(text: string, now = Date.now()): LimitHit | null {
    if (!text) return null
    const hit = limitPatterns.find((p) => p.test(text))
    if (!hit) return null

    // Quote the sentence that matched rather than the whole message: a limit
    // notice can arrive appended to a long turn.
    const sentences = text.split(/(?<=[.!?])\s+/)
    const quote = (sentences.find((s) => hit.test(s)) ?? text).trim().slice(0, 300)

    // "You've reached your Fable 5 limit." names the model that ran out.
    // "You've reached your usage limit" names nothing a family can be made of,
    // and familyOfLimitText says so by returning undefined.
    const family = familyOfLimitText(quote) ?? familyOfLimitText(text) ?? null

    for (const p of resetPatterns) {
        const m = quote.match(p) ?? text.match(p)
        if (m) {
            const resetsAt = parseReset(m[1], now)
            if (resetsAt) return { resetsAt, quote, family }
        }
    }
    return { resetsAt: null, quote, family }
}

/**
 * The model an assistant entry actually ran, or undefined.
 *
 * Read straight off the entry rather than through textOfTranscriptMessage,
 * which returns null when a turn carries no text block — a tool-use-only turn
 * would otherwise drop its model on the floor.
 *
 * Two entries are refused on purpose, both measured:
 *   - `<synthetic>`, the harness's own notices. The limit notice IS one, and
 *     it is the message that fires an auto-flip, so the triggering entry can
 *     never supply the model. It has to be kept from the last real one.
 *   - `isSidechain: true`, a subagent's turn. Two of main's 53 transcripts
 *     carry claude-haiku-4-5 and claude-opus-4-5 entries that way; those are
 *     a Task tool's model, not the session's.
 */
export function modelOfTranscriptMessage(message: unknown): string | undefined {
    const m = message as { type?: string; isSidechain?: unknown; message?: { model?: unknown } }
    if (!m || typeof m !== 'object') return undefined
    if (m.type !== 'assistant') return undefined
    if (m.isSidechain === true) return undefined
    const model = m.message?.model
    if (typeof model !== 'string' || !model || model === '<synthetic>') return undefined
    return model
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
