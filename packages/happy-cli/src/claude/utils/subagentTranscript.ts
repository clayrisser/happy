/**
 * A subagent's transcript, served to the phone on demand (DROVE-93).
 *
 * Tapping an agent in the live task tree opened a screen with the agent's
 * name and a green check and nothing else. The transcript is on disk the whole
 * time; this reads it and hands it over the session RPC channel so the phone
 * never touches the Mac's filesystem itself.
 *
 * WHERE IT IS, measured on Clay's Mac against a live session (the same rule is
 * on the ticket):
 *
 *   <projectDir>/<sessionId>/subagents/agent-<agentId>.jsonl
 *       the agent the pane launched directly. `projectDir` is the dir the
 *       scanner already tails, so a flip into another account's config dir is
 *       followed for free.
 *   <projectDir>/<sessionId>/subagents/workflows/wf_<id>/agent-<agentId>.jsonl
 *       an agent a workflow launched.
 *   <projectDir>/<sessionId>/subagents/agent-<agentId>.meta.json
 *       `{agentType, description, toolUseId, spawnDepth}`.
 *
 * The scratch path `/private/tmp/claude-<uid>/<slug>/<sessionId>/tasks/
 * <agentId>.output` is a SYMLINK to the projects file (every one of the 75
 * agent entries in the live session resolved there), so it is never read.
 *
 * THE FORMAT is the session transcript's own: `user` and `assistant` records,
 * one content block per assistant record, `isSidechain: true` on all of them,
 * `attachment` records interleaved. Record one is the prompt. There is no
 * result record; the result is the last assistant text.
 *
 * DONE OR FAILED comes from the PARENT transcript: when an async agent stops,
 * Claude Code appends a `user` record whose string content is a
 * `<task-notification>` block naming the `<task-id>`, a `<status>` and the
 * `<result>`. A synchronous Task's tool_result carries its result the same
 * way. Both are read incrementally off the parent, because that file is 13MB
 * on Clay's machine and re-reading it on every 2s poll is the mistake
 * liveStatus.ts was written to avoid.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { parseAgentNotifications } from './agentNotification'
import { readNewLines, parseTimestamp, type Tail } from './liveStatus'

export type SubagentState = 'running' | 'done' | 'failed'

export interface SubagentTranscriptRequest {
    agentId: string
    /** Byte offset returned as `cursor` by the previous call. 0 or absent reads from the top. */
    since?: number
    /** Accepted and ignored: the RPC is already addressed to the session. */
    sessionId?: string
}

export interface SubagentTranscriptAgent {
    id: string
    /** The Task's description, else the agent type, else the id. */
    label: string
    agentType?: string
    /** The Agent tool_use that launched it. */
    toolId?: string
    state: SubagentState
    /** mtime of the transcript, epoch ms. */
    updatedAt: number
    /** When the parent saw it stop, epoch ms. Only with a notification. */
    endedAt?: number
    /** The result text the parent received, when it has stopped. */
    result?: string
}

export type SubagentTranscriptResponse = {
    ok: true
    /** Raw transcript records, `isSidechain` cleared, conversation records only. */
    rows: Record<string, unknown>[]
    /** Byte offset after the last complete line; pass back as `since`. */
    cursor: number
    agent: SubagentTranscriptAgent
} | {
    ok: false
    reason: string
    cursor: 0
    /** What the parent knows even when the file is gone. */
    agent?: Partial<SubagentTranscriptAgent>
}

/** Claude Code's ids are short hex; anything else is not a filename we open. */
const agentIdPattern = /^[A-Za-z0-9_-]{1,64}$/

/** Per-record cap on a stored result, so a chatty agent cannot pin memory. */
const maxResultChars = 20_000

const asyncLaunchPrefix = 'Async agent launched'

interface Notification {
    status: string
    /** Whether the status means it went WELL, per agentNotification.ts. */
    succeeded: boolean
    result?: string
    at: number
}

interface ParentState {
    key: string
    tail: Tail
    /** task-id -> notification. */
    byAgent: Map<string, Notification>
    /** tool_use id -> result, for synchronous Task calls. */
    byTool: Map<string, Notification>
    /** tool_use ids that are Agent/Task calls, so only their results are kept. */
    agentTools: Set<string>
}

function readMeta(path: string): { label?: string, agentType?: string, toolId?: string } {
    try {
        const meta = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
        const description = typeof meta.description === 'string' ? meta.description.trim() : ''
        const agentType = typeof meta.agentType === 'string' ? meta.agentType.trim() : ''
        return {
            ...(description || agentType ? { label: description || agentType } : {}),
            ...(agentType ? { agentType } : {}),
            ...(typeof meta.toolUseId === 'string' ? { toolId: meta.toolUseId } : {}),
        }
    } catch {
        return {}
    }
}

/**
 * The agent's transcript, wherever Claude Code put it: beside the session's
 * other direct agents, or inside one of its workflows.
 */
export function findSubagentTranscript(projectDir: string, sessionId: string, agentId: string): string | null {
    if (!agentIdPattern.test(agentId)) return null
    const sessionDir = join(projectDir, sessionId)
    const direct = join(sessionDir, 'subagents', `agent-${agentId}.jsonl`)
    if (exists(direct)) return direct
    const workflows = join(sessionDir, 'subagents', 'workflows')
    let runs: string[]
    try {
        runs = readdirSync(workflows)
    } catch {
        return null
    }
    for (const run of runs) {
        const candidate = join(workflows, run, `agent-${agentId}.jsonl`)
        if (exists(candidate)) return candidate
    }
    return null
}

function exists(path: string): boolean {
    try {
        statSync(path)
        return true
    } catch {
        return false
    }
}

function clip(text: string): string {
    return text.length > maxResultChars ? text.slice(0, maxResultChars) : text
}

function blocksOf(record: Record<string, unknown>): Record<string, unknown>[] | string | null {
    const message = record.message
    if (!message || typeof message !== 'object') return null
    const content = (message as Record<string, unknown>).content
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return null
    return content.filter((b): b is Record<string, unknown> => !!b && typeof b === 'object')
}

function resultText(content: unknown): string {
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return ''
    return content
        .map((b) => (b && typeof b === 'object' && typeof (b as Record<string, unknown>).text === 'string'
            ? (b as Record<string, string>).text
            : ''))
        .filter((t) => t.length > 0)
        .join('\n')
}

/** Fold the parent transcript's new lines into what we know about stopped agents. */
function pumpParent(state: ParentState, path: string): void {
    const lines = readNewLines(path, state.tail, 0)
    if (!lines) return
    for (const line of lines) {
        if (line.length === 0) continue
        let record: Record<string, unknown>
        try {
            record = JSON.parse(line) as Record<string, unknown>
        } catch {
            continue
        }
        if (record.isSidechain === true) continue
        if (record.type !== 'user' && record.type !== 'assistant') continue
        const at = parseTimestamp(record.timestamp)
        const content = blocksOf(record)
        if (content === null) continue
        if (typeof content === 'string') {
            // One parser for the whole CLI (DROVE-115), so the agent screen's
            // done/failed and the terminal tool-call-end the phone's card keys
            // off cannot read the same notification two different ways.
            for (const notification of parseAgentNotifications(record)) {
                if (!notification.terminal) continue
                state.byAgent.set(notification.agentId, {
                    status: notification.status,
                    succeeded: notification.succeeded,
                    at,
                    ...(notification.result ? { result: clip(notification.result) } : {}),
                })
            }
            continue
        }
        for (const block of content) {
            if (block.type === 'tool_use' && typeof block.id === 'string') {
                if (block.name === 'Agent' || block.name === 'Task') state.agentTools.add(block.id)
            } else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
                if (!state.agentTools.has(block.tool_use_id)) continue
                const text = resultText(block.content)
                // The async launch acknowledgement is not a result.
                if (text.startsWith(asyncLaunchPrefix)) continue
                state.byTool.set(block.tool_use_id, {
                    status: block.is_error === true ? 'failed' : 'completed',
                    succeeded: block.is_error !== true,
                    at,
                    ...(text ? { result: clip(text) } : {}),
                })
            }
        }
    }
}

function stateOf(notification: Notification | undefined): SubagentState {
    if (!notification) return 'running'
    return notification.succeeded ? 'done' : 'failed'
}

export interface SubagentTranscriptReader {
    read: (request: SubagentTranscriptRequest) => SubagentTranscriptResponse
}

/**
 * One reader per scanner: it remembers where it is in the parent transcript,
 * and forgets when the scanner moves to another dir or session.
 */
export function createSubagentTranscriptReader(opts: {
    getProjectDir: () => string
    getSessionId: () => string | null
}): SubagentTranscriptReader {
    let parent: ParentState | null = null

    const parentFor = (projectDir: string, sessionId: string): ParentState => {
        const key = join(projectDir, `${sessionId}.jsonl`)
        if (!parent || parent.key !== key) {
            parent = { key, tail: { offset: 0, carry: '' }, byAgent: new Map(), byTool: new Map(), agentTools: new Set() }
        }
        pumpParent(parent, key)
        return parent
    }

    return {
        read: (request) => {
            const agentId = typeof request?.agentId === 'string' ? request.agentId : ''
            if (!agentIdPattern.test(agentId)) {
                return { ok: false, reason: 'No such agent', cursor: 0 }
            }
            const projectDir = opts.getProjectDir()
            const sessionId = opts.getSessionId()
            if (!sessionId) {
                return { ok: false, reason: 'The session has no transcript yet', cursor: 0 }
            }
            const path = findSubagentTranscript(projectDir, sessionId, agentId)
            const known = parentFor(projectDir, sessionId)
            const meta = path ? readMeta(path.replace(/\.jsonl$/, '.meta.json')) : {}
            const notification = known.byAgent.get(agentId)
                ?? (meta.toolId ? known.byTool.get(meta.toolId) : undefined)
            const stopped = notification
                ? {
                    state: stateOf(notification),
                    endedAt: notification.at,
                    ...(notification.result ? { result: notification.result } : {}),
                }
                : { state: 'running' as const }

            if (!path) {
                return {
                    ok: false,
                    reason: 'No transcript on disk for this agent',
                    cursor: 0,
                    agent: { id: agentId, ...meta, ...stopped },
                }
            }

            let updatedAt = 0
            try {
                updatedAt = statSync(path).mtimeMs
            } catch {
                return { ok: false, reason: 'The transcript disappeared while reading it', cursor: 0 }
            }
            const since = typeof request.since === 'number' && Number.isFinite(request.since) && request.since > 0
                ? Math.floor(request.since)
                : 0
            const tail: Tail = { offset: since, carry: '' }
            const lines = readNewLines(path, tail, 0) ?? []
            const rows: Record<string, unknown>[] = []
            for (const line of lines) {
                if (line.length === 0) continue
                let record: Record<string, unknown>
                try {
                    record = JSON.parse(line) as Record<string, unknown>
                } catch {
                    continue
                }
                // Only conversation records travel. Attachments are skill
                // listings and tool deltas the app has no card for.
                if (record.type !== 'user' && record.type !== 'assistant') continue
                rows.push(stripForWire(record))
            }
            return {
                ok: true,
                rows,
                // The carry is a line still being written. It is re-read next
                // time, from the offset it starts at.
                cursor: tail.offset - Buffer.byteLength(tail.carry, 'utf8'),
                agent: {
                    id: agentId,
                    label: meta.label ?? agentId,
                    ...(meta.agentType ? { agentType: meta.agentType } : {}),
                    ...(meta.toolId ? { toolId: meta.toolId } : {}),
                    updatedAt: Math.floor(updatedAt),
                    ...stopped,
                },
            }
        },
    }
}

/**
 * The record as the phone wants it: `isSidechain` off, because the app's
 * reducer files sidechain records under a Task card rather than showing them
 * as a conversation, and this IS the conversation. Thinking signatures go
 * too; they are a kilobyte each and nothing on the phone reads them.
 */
function stripForWire(record: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = { ...record, isSidechain: false }
    const message = record.message
    if (message && typeof message === 'object') {
        const content = (message as Record<string, unknown>).content
        if (Array.isArray(content)) {
            out.message = {
                ...(message as Record<string, unknown>),
                content: content.map((block) => {
                    if (block && typeof block === 'object' && (block as Record<string, unknown>).type === 'thinking') {
                        const { signature: _signature, ...rest } = block as Record<string, unknown>
                        return rest
                    }
                    return block
                }),
            }
        }
    }
    return out
}
