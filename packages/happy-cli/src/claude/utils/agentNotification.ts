/**
 * When a background agent stops, and which tool call it belongs to (DROVE-115).
 *
 * An async Agent tool call ENDS AT LAUNCH. Its `toolUseResult` is
 * `{isAsync: true, status: 'async_launched', agentId, outputFile, …}` and that
 * is the only result the phone's Agent card will ever be handed. The agent's
 * real outcome arrives minutes later by a different route: a
 * `<task-notification>` block naming the `<task-id>`, the `<tool-use-id>`, a
 * `<status>` and the `<result>`. DROVE-110 made the card read the launch
 * receipt as "running" instead of "Failed", which was right, so a FINISHED
 * agent then sat on `Running, quiet for 40m` forever.
 *
 * The fix chosen on DROVE-115 is to emit a proper terminal `tool-call-end` for
 * that call once the notification lands, rather than teach the app to scrape
 * prose out of a transcript it cannot fully see. This module is the parsing
 * half: one place that knows what a launch looks like, what a notification
 * looks like, and which statuses are terminal.
 *
 * WHY THE APP COULD NOT DO IT ITSELF. Claude Code writes the notification
 * three ways, and only one of them reaches the phone at all:
 *
 *   queue-operation  the enqueue record. In the scanner's
 *                    INTERNAL_CLAUDE_EVENT_TYPES, skipped outright.
 *   attachment       a `queued_command` injected mid-turn. Not a member of
 *                    RawJSONLinesSchema's union, so safeParse drops it.
 *   user             the notification delivered as its own turn. Forwarded,
 *                    and then dropped again by the app's own normalizer,
 *                    which treats a control-only task-notification as noise.
 *
 * Counted across every transcript on Clay's machine in BASED-135 — 1084
 * launched agents — 771 got a `user` record and 313 did not. So an app-side
 * parser would have fixed two agents in three and had no way to know which.
 *
 * `inflight.ts` (BASED-135) asks the same questions of the same records for a
 * different reason, and now asks them here.
 */

/**
 * Every status Claude Code has been observed to write, all of them terminal.
 * Counted across Clay's transcripts: completed 9567, failed 967, killed 171,
 * stopped 30. The rest are listed because a status we do not recognise is one
 * that never resolves, and an agent is not going to report "cancelled" and
 * then carry on.
 */
export const terminalAgentStatuses = new Set([
    'completed',
    'complete',
    'failed',
    'failure',
    'error',
    'killed',
    'stopped',
    'cancelled',
    'canceled',
    'aborted',
    'timeout',
    'timed_out',
])

/** The terminal statuses that mean it went well. Everything else terminal failed. */
const succeededStatuses = new Set(['completed', 'complete', 'success', 'succeeded', 'done', 'ok', 'finished'])

export const asyncLaunchBanner = 'Async agent launched successfully'

const notificationPattern = /<task-notification>([\s\S]*?)<\/task-notification>/g
const taskIdPattern = /<task-id>\s*([^<]+?)\s*<\/task-id>/
const toolUseIdPattern = /<tool-use-id>\s*([^<]+?)\s*<\/tool-use-id>/
const statusPattern = /<status>\s*([A-Za-z_]+)\s*<\/status>/
const summaryPattern = /<summary>\s*([\s\S]*?)\s*<\/summary>/
const resultPattern = /<result>\s*([\s\S]*?)\s*<\/result>/
const agentIdPattern = /\bagentId:\s*([A-Za-z0-9_-]{4,64})\b/
const outputFilePattern = /\boutput_file:\s*(\S+)/

/** Cap on a stored result, so a chatty agent cannot pin memory or blow the envelope. */
const maxResultChars = 20_000

export interface AgentNotification {
    /** Claude Code's internal agent id, e.g. `a752a2a9e89efbca8`. */
    agentId: string
    /** The Agent tool_use the launch was answered on, when the block names it. */
    toolUseId?: string
    /** Verbatim and lowercased, whatever Claude Code wrote. */
    status: string
    /** Whether that status means the agent has stopped for good. */
    terminal: boolean
    /** True only for a terminal status that reports success. */
    succeeded: boolean
    /** The agent's final report, as the parent received it. */
    result?: string
    summary?: string
    /** The record's own timestamp, epoch ms, or 0 when it had none. */
    at: number
}

export interface AsyncAgentLaunch {
    agentId: string
    /** The Agent tool_use id this launch answers, off the tool_result block. */
    toolUseId?: string
    description?: string
    /** `tasks/<id>.output` — a symlink to the subagent's own transcript. */
    outputFile?: string
    at: number
}

/**
 * Every readable string on a transcript record, whatever shape it arrived in.
 *
 * Shape-driven rather than type-driven on purpose: the same block of text is a
 * `content` string on a queue-operation, an `attachment.prompt` on an
 * attachment, a `message.content` string on a delivered user turn, and a
 * nested `text` inside a tool_result's content array. Nothing here may throw —
 * a record we do not understand is a record we ignore, never a crash inside
 * the scanner's own callback.
 */
export function readableTranscriptStrings(record: unknown): string[] {
    const out: string[] = []
    const r = record as Record<string, unknown> | null
    if (!r || typeof r !== 'object') return out

    const push = (value: unknown): void => {
        if (typeof value === 'string' && value) out.push(value)
    }

    push(r.content)
    const attachment = r.attachment as { prompt?: unknown } | undefined
    if (attachment && typeof attachment === 'object') push(attachment.prompt)

    const message = r.message as { content?: unknown } | undefined
    const content = message && typeof message === 'object' ? message.content : undefined
    push(content)
    if (Array.isArray(content)) {
        for (const block of content) {
            const b = block as { text?: unknown; content?: unknown } | null
            if (!b || typeof b !== 'object') continue
            push(b.text)
            push(b.content)
            if (Array.isArray(b.content)) {
                for (const inner of b.content) {
                    const i = inner as { text?: unknown } | null
                    if (i && typeof i === 'object') push(i.text)
                }
            }
        }
    }
    return out
}

function clip(text: string): string {
    return text.length > maxResultChars ? text.slice(0, maxResultChars) : text
}

/** A record's `timestamp`, epoch ms, or 0 when it has none we can read. */
export function recordTimestamp(record: unknown): number {
    const value = (record as { timestamp?: unknown } | null)?.timestamp
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value !== 'string') return 0
    const ms = Date.parse(value)
    return Number.isFinite(ms) ? ms : 0
}

/**
 * Every task-notification on one transcript record, terminal or not.
 *
 * Non-terminal ones are returned rather than dropped so the caller decides:
 * the flip gate counts only terminal ones, and the card must never be moved
 * off "running" by a progress note.
 */
export function parseAgentNotifications(record: unknown): AgentNotification[] {
    const at = recordTimestamp(record)
    const out: AgentNotification[] = []
    const seen = new Set<string>()
    for (const text of readableTranscriptStrings(record)) {
        if (!text.includes('<task-notification>')) continue
        notificationPattern.lastIndex = 0
        let match: RegExpExecArray | null
        while ((match = notificationPattern.exec(text)) !== null) {
            const body = match[1]
            const agentId = taskIdPattern.exec(body)?.[1]
            const status = statusPattern.exec(body)?.[1]?.toLowerCase()
            if (!agentId || !status) continue
            // One record can carry the same block twice — a tool_result whose
            // `content` is both a string and an array of blocks holding it.
            const key = `${agentId}:${status}`
            if (seen.has(key)) continue
            seen.add(key)
            const toolUseId = toolUseIdPattern.exec(body)?.[1]
            const result = resultPattern.exec(body)?.[1]
            const summary = summaryPattern.exec(body)?.[1]
            out.push({
                agentId,
                ...(toolUseId ? { toolUseId } : {}),
                status,
                terminal: terminalAgentStatuses.has(status),
                succeeded: succeededStatuses.has(status),
                ...(result ? { result: clip(result) } : {}),
                ...(summary ? { summary: clip(summary) } : {}),
                at,
            })
        }
    }
    return out
}

/**
 * The launch of an async agent, or null for every other record.
 *
 * The structured `toolUseResult` is the reliable half; the tool_use id and the
 * output path are only ever readable off the record around it, so both halves
 * are read every time.
 */
export function readAsyncAgentLaunch(record: unknown): AsyncAgentLaunch | null {
    const r = record as { type?: unknown; toolUseResult?: unknown; message?: unknown } | null
    if (!r || typeof r !== 'object') return null
    const strings = readableTranscriptStrings(record)
    const banner = strings.find((s) => s.includes(asyncLaunchBanner))

    const result = r.toolUseResult as
        | { status?: unknown; isAsync?: unknown; agentId?: unknown; description?: unknown }
        | undefined
    let agentId: string | undefined
    let description: string | undefined
    if (result && typeof result === 'object'
        && typeof result.agentId === 'string' && result.agentId
        // `async_launched` is what Claude Code writes; isAsync alone covers a
        // shape that renames the status, and neither means some other tool.
        && (result.status === 'async_launched' || result.isAsync === true)) {
        agentId = result.agentId
        if (typeof result.description === 'string' && result.description) description = result.description
    } else {
        // A launch's tool_result is written into a USER record. Reading the
        // banner off anything else would let Claude quoting its own tool
        // result invent an agent that never existed.
        if (r.type !== 'user' || !banner) return null
        agentId = agentIdPattern.exec(banner)?.[1]
    }
    if (!agentId) return null

    return {
        agentId,
        ...(toolUseIdOf(record, banner) ? { toolUseId: toolUseIdOf(record, banner) } : {}),
        ...(description ? { description } : {}),
        ...(banner ? pickOutputFile(banner) : {}),
        at: recordTimestamp(record) || Date.now(),
    }
}

function pickOutputFile(banner: string): { outputFile?: string } {
    const outputFile = outputFilePattern.exec(banner)?.[1]
    return outputFile ? { outputFile } : {}
}

/** The tool_use the launch answers: the block carrying the banner, else the only one. */
function toolUseIdOf(record: unknown, banner: string | undefined): string | undefined {
    const message = (record as { message?: unknown } | null)?.message as { content?: unknown } | undefined
    const content = message && typeof message === 'object' ? message.content : undefined
    if (!Array.isArray(content)) return undefined
    const results = content.filter((block): block is Record<string, unknown> =>
        !!block && typeof block === 'object'
        && (block as Record<string, unknown>).type === 'tool_result'
        && typeof (block as Record<string, unknown>).tool_use_id === 'string')
    if (results.length === 0) return undefined
    if (banner) {
        const carrier = results.find((block) => readableTranscriptStrings({ message: { content: [block] } })
            .some((s) => s.includes(asyncLaunchBanner)))
        if (carrier) return carrier.tool_use_id as string
    }
    return results.length === 1 ? (results[0].tool_use_id as string) : undefined
}

/**
 * Which Agent tool call each running background agent belongs to.
 *
 * The notification usually names its `<tool-use-id>`, but not every carrier
 * does, and the terminal envelope is addressed to the CALL — an agent id the
 * card cannot resolve is a card that stays wrong. So the launches are indexed
 * as they stream past, which also gives the run a start time and therefore a
 * duration the card can freeze on.
 *
 * Bounded: an entry is dropped the moment its agent reports, and the whole
 * index is capped, because a long session launches hundreds.
 */
export class AgentLaunchIndex {
    private readonly launches = new Map<string, AsyncAgentLaunch>()
    private readonly limit: number

    constructor(limit = 512) {
        this.limit = limit
    }

    /** Offer one transcript record. Never throws: it runs inside a scanner callback. */
    note(record: unknown): void {
        let launch: AsyncAgentLaunch | null = null
        try {
            launch = readAsyncAgentLaunch(record)
        } catch {
            return
        }
        if (!launch) return
        const existing = this.launches.get(launch.agentId)
        // First sighting wins on time, because that is when the run started.
        // A later record may carry the tool id or the output path the first
        // one lacked, so the rest is filled in rather than replaced.
        this.launches.set(launch.agentId, existing ? { ...launch, ...existing } : launch)
        while (this.launches.size > this.limit) {
            const oldest = this.launches.keys().next()
            if (oldest.done) break
            this.launches.delete(oldest.value)
        }
    }

    get(agentId: string): AsyncAgentLaunch | undefined {
        return this.launches.get(agentId)
    }

    /** Drop what we know about an agent that has reported. */
    forget(agentId: string): void {
        this.launches.delete(agentId)
    }

    get size(): number {
        return this.launches.size
    }
}

/**
 * The terminal `tool-call-end` an async agent's card has been waiting for.
 *
 * Deliberately the SAME shape the launch receipt has — a `toolUseResult`
 * object with a `status`, an `agentId` and a Claude content array — so the app
 * reads it through `agentRunState` in `sources/utils/agentCard.ts` the way it
 * already reads the launch, and no second source of truth appears on the
 * phone. `async_launched` is NOT reused as the status: the app tells the
 * receipt from the outcome by that word, and a second receipt would be
 * indistinguishable from the first.
 */
export function agentStopResult(notification: AgentNotification, launch?: AsyncAgentLaunch): {
    result: Record<string, unknown>
    isError: boolean
} {
    const durationMs = launch && launch.at > 0 && notification.at > launch.at
        ? notification.at - launch.at
        : undefined
    const text = notification.result ?? notification.summary
    return {
        result: {
            isAsync: true,
            status: notification.status,
            agentId: notification.agentId,
            ...(launch?.description ? { description: launch.description } : {}),
            ...(text ? { content: [{ type: 'text', text }] } : {}),
            ...(durationMs !== undefined ? { totalDurationMs: durationMs } : {}),
        },
        isError: !notification.succeeded,
    }
}
