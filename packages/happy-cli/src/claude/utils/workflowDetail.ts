/**
 * The disk half of the wave view (DROVE-290): what this reader hands the
 * shared fold in @slopus/happy-wire, and where each piece comes from.
 *
 * Sources, measured on harness 2.1.252 (see the wire module's header for the
 * live probe):
 *
 *   <sessionDir>/workflows/<runId>.json
 *       the run record. Written when the run ENDS — completed, failed, or
 *       killed — never during. Its `workflowProgress` is the only place on
 *       disk that maps an agentId to a phase, so a live first run folds with
 *       everything unattributed, and a killed-and-resumed run (Clay's long
 *       ones) folds with the previous kill's attribution plus the resume's
 *       new agents unattributed.
 *   <sessionDir>/subagents/workflows/<runId>/journal.jsonl
 *       the live ledger: `started`/`result`/`failed`, one line each, tailed
 *       across calls the way every other file here is (the screen polls, and
 *       re-parsing a journal that can carry megabyte result payloads every
 *       two seconds is the cost liveStatus.ts exists to avoid).
 *   <sessionDir>/subagents/workflows/<runId>/agent-*.jsonl
 *       the pulse: an mtime inside the stale window is the agent running,
 *       the same rule liveStatus applies. The first record gives the label
 *       and the start time, read once per agent and cached — both are
 *       immutable.
 *   <sessionDir>/workflows/scripts/<name>-<runId>.js
 *       phase titles while the run is live and the record does not exist.
 */

import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import {
    boundWorkflowDetail,
    foldWorkflowDetail,
    type JournalAgentFact,
    type LiveAgentFact,
    type RecordAgentFact,
    type WorkflowDetailRequest,
    type WorkflowDetailResponse,
} from '@slopus/happy-wire'

import { distinguishingLabels, phaseNamesFromScript, promptHead, promptLabel, parseTimestamp, readNewLines, workflowNameFromScript, type Tail } from './liveStatus'

/** The runId as Claude Code writes it; anything else is not a path we open. */
const runIdPattern = /^wf_[A-Za-z0-9-]{1,64}$/

/** Same window liveStatus counts running with; the two must not disagree. */
const agentStaleMs = 90_000

/** Enough of a transcript to hold record one. Prompts run long (DROVE-268). */
const headBytes = 256 * 1024

/** The same trim liveStatus applies to everything a phone row holds. */
function shortenLabel(value: string, max = 64): string {
    const flat = value.replace(/\s+/g, ' ').trim()
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

interface JournalState {
    tail: Tail
    facts: Map<string, JournalAgentFact>
}

interface AgentHead {
    label?: string
    startedAt?: number
    /** The prompt's raw head, kept to tell template siblings apart (DROVE-290). */
    head?: string
}

function parseRecordAgents(record: Record<string, unknown>): RecordAgentFact[] {
    const progress = record.workflowProgress
    if (!Array.isArray(progress)) return []
    const out: RecordAgentFact[] = []
    for (const entry of progress) {
        if (!entry || typeof entry !== 'object') continue
        const fact = entry as Record<string, unknown>
        if (fact.type !== 'workflow_agent') continue
        const startedAt = typeof fact.startedAt === 'number' ? fact.startedAt : undefined
        const durationMs = typeof fact.durationMs === 'number' ? fact.durationMs : undefined
        out.push({
            ...(typeof fact.agentId === 'string' && fact.agentId.length > 0 ? { agentId: fact.agentId } : {}),
            ...(typeof fact.label === 'string' && fact.label.length > 0 ? { label: fact.label } : {}),
            ...(typeof fact.phaseIndex === 'number' ? { phaseIndex: fact.phaseIndex } : {}),
            ...(typeof fact.phaseTitle === 'string' ? { phaseTitle: fact.phaseTitle } : {}),
            ...(typeof fact.state === 'string' ? { state: fact.state } : {}),
            ...(typeof fact.queuedAt === 'number' ? { queuedAt: fact.queuedAt } : {}),
            ...(startedAt !== undefined ? { startedAt } : {}),
            ...(startedAt !== undefined && durationMs !== undefined ? { endedAt: startedAt + durationMs } : {}),
            ...(typeof fact.tokens === 'number' ? { tokens: fact.tokens } : {}),
        })
    }
    return out
}

function phaseTitlesOf(record: Record<string, unknown> | null, sessionDir: string, runId: string): string[] {
    const phases = record?.phases
    if (Array.isArray(phases)) {
        const titles = phases
            .map((phase) => (phase && typeof phase === 'object' && typeof (phase as Record<string, unknown>).title === 'string'
                ? (phase as Record<string, string>).title
                : ''))
            .filter((title) => title.length > 0)
        if (titles.length > 0) return titles
    }
    try {
        const dir = join(sessionDir, 'workflows', 'scripts')
        for (const file of readdirSync(dir)) {
            if (!file.includes(`-${runId}.`)) continue
            return phaseNamesFromScript(readFileSync(join(dir, file), 'utf8'))
        }
    } catch {
        // No scripts directory: an older Claude Code, or a run that never
        // wrote one. The waves lose their titles, not their counts.
    }
    return []
}

function nameOf(record: Record<string, unknown> | null, sessionDir: string, runId: string): string {
    if (record && typeof record.workflowName === 'string' && record.workflowName.length > 0) {
        return record.workflowName
    }
    try {
        for (const file of readdirSync(join(sessionDir, 'workflows', 'scripts'))) {
            if (file.includes(`-${runId}.`)) return workflowNameFromScript(file)
        }
    } catch {
        // The id is still a name.
    }
    return runId
}

export interface WorkflowDetailReader {
    read: (request: WorkflowDetailRequest) => WorkflowDetailResponse
}

/**
 * One reader per scanner, like the transcript reader beside it (DROVE-93):
 * it keeps a tail per journal and a head per agent, and forgets everything
 * when the scanner moves to another dir or session.
 */
export function createWorkflowDetailReader(opts: {
    getProjectDir: () => string
    getSessionId: () => string | null
}): WorkflowDetailReader {
    let scope = ''
    const journals = new Map<string, JournalState>()
    const heads = new Map<string, AgentHead>()

    const journalFor = (runDir: string): JournalState => {
        const path = join(runDir, 'journal.jsonl')
        let state = journals.get(path)
        if (!state) {
            state = { tail: { offset: 0, carry: '' }, facts: new Map() }
            journals.set(path, state)
        }
        const lines = readNewLines(path, state.tail, 0)
        if (!lines) return state
        for (const line of lines) {
            if (line.length === 0) continue
            let record: Record<string, unknown>
            try {
                record = JSON.parse(line) as Record<string, unknown>
            } catch {
                continue
            }
            const agentId = typeof record.agentId === 'string' && record.agentId.length > 0 ? record.agentId : null
            if (!agentId) continue
            const known = state.facts.get(agentId)
            if (record.type === 'started') {
                if (!known) state.facts.set(agentId, { agentId, settled: null })
            } else if (record.type === 'result') {
                state.facts.set(agentId, { agentId, settled: 'done' })
            } else if (record.type === 'failed') {
                state.facts.set(agentId, { agentId, settled: 'failed' })
            }
        }
        return state
    }

    const headOf = (path: string): AgentHead => {
        const cached = heads.get(path)
        if (cached) return cached
        // A long session accumulates heads for every agent ever asked about;
        // past a thousand, start over rather than grow without bound. They
        // are one bounded read each to rebuild.
        if (heads.size > 1024) heads.clear()
        // The head only, never the file: transcripts run to megabytes and
        // this is called on every poll for every agent of the run. Record one
        // is the prompt and carries the transcript's own clock; a first
        // record longer than the head is not a record we can parse, and the
        // fallback is the file's mtime at the call site.
        let head: AgentHead = {}
        let fd: number
        try {
            fd = openSync(path, 'r')
        } catch {
            return head
        }
        try {
            const buffer = Buffer.allocUnsafe(headBytes)
            const read = readSync(fd, buffer, 0, buffer.length, 0)
            if (read > 0) {
                const text = buffer.subarray(0, read).toString('utf8')
                const end = text.indexOf('\n')
                if (end > 0) {
                    const record = JSON.parse(text.slice(0, end)) as Record<string, unknown>
                    const startedAt = parseTimestamp(record.timestamp)
                    head = {
                        ...(promptLabel(record) !== undefined ? { label: promptLabel(record) } : {}),
                        ...(startedAt > 0 ? { startedAt } : {}),
                        ...(promptHead(record) !== undefined ? { head: promptHead(record) } : {}),
                    }
                }
            }
        } catch {
            // Unreadable or newborn: cache nothing so the next poll retries.
            return head
        } finally {
            closeSync(fd)
        }
        heads.set(path, head)
        return head
    }

    const liveAgents = (runDir: string, now: number): LiveAgentFact[] => {
        let entries: string[]
        try {
            entries = readdirSync(runDir)
        } catch {
            return []
        }
        const out: LiveAgentFact[] = []
        const headsOut: (string | undefined)[] = []
        for (const entry of entries) {
            if (!entry.startsWith('agent-') || !entry.endsWith('.jsonl')) continue
            const path = join(runDir, entry)
            let mtimeMs = 0
            try {
                mtimeMs = statSync(path).mtimeMs
            } catch {
                continue
            }
            const head = headOf(path)
            out.push({
                agentId: entry.slice('agent-'.length, -'.jsonl'.length),
                running: now - mtimeMs <= agentStaleMs,
                ...(head.startedAt !== undefined ? { startedAt: head.startedAt } : {}),
                ...(head.label !== undefined ? { label: head.label } : {}),
            })
            headsOut.push(head.head)
        }
        // The same sibling repair the status tree applies (DROVE-290): a
        // wave's item prompts are one template, so rows labelled with the
        // template's first line all read alike. Recomputed identically every
        // call — the group is every transcript in the dir and prompts are
        // immutable — so labels hold still without a cache.
        const colliding = new Map<string, number[]>()
        for (let i = 0; i < out.length; i++) {
            if (out[i].label === undefined || headsOut[i] === undefined) continue
            const rows = colliding.get(out[i].label!)
            if (rows) rows.push(i)
            else colliding.set(out[i].label!, [i])
        }
        for (const rows of colliding.values()) {
            if (rows.length < 2) continue
            const parts = distinguishingLabels(rows.map((i) => headsOut[i]!))
            for (let k = 0; k < rows.length; k++) {
                const i = rows[k]
                out[i] = {
                    ...out[i],
                    label: parts[k] !== undefined
                        ? shortenLabel(parts[k]!)
                        : `${out[i].label} #${k + 1}`,
                }
            }
        }
        return out
    }

    return {
        read: (request) => {
            const runId = typeof request?.runId === 'string' ? request.runId : ''
            if (!runIdPattern.test(runId)) {
                return { ok: false, reason: 'No such workflow run' }
            }
            const projectDir = opts.getProjectDir()
            const sessionId = opts.getSessionId()
            if (!sessionId) {
                return { ok: false, reason: 'The session has no transcript yet' }
            }
            const sessionDir = join(projectDir, sessionId)
            // A dir or session change is a different set of files entirely;
            // carrying tails across it would splice two runs together.
            if (scope !== sessionDir) {
                scope = sessionDir
                journals.clear()
                heads.clear()
            }
            let record: Record<string, unknown> | null = null
            try {
                record = JSON.parse(readFileSync(join(sessionDir, 'workflows', `${runId}.json`), 'utf8')) as Record<string, unknown>
            } catch {
                // Expected for the whole life of a live first run.
            }
            const runDir = join(sessionDir, 'subagents', 'workflows', runId)
            const journal = journalFor(runDir)
            const now = Date.now()
            const live = liveAgents(runDir, now)
            const recordAgents = record ? parseRecordAgents(record) : []
            if (recordAgents.length === 0 && journal.facts.size === 0 && live.length === 0) {
                return { ok: false, reason: 'Nothing on disk for this workflow run' }
            }
            const wave = typeof request.wave === 'number' && Number.isFinite(request.wave)
                ? Math.floor(request.wave)
                : undefined
            const detail = foldWorkflowDetail({
                runId,
                name: nameOf(record, sessionDir, runId),
                phaseTitles: phaseTitlesOf(record, sessionDir, runId),
                record: recordAgents,
                ...(record && typeof record.status === 'string' ? { status: record.status } : {}),
                journal: [...journal.facts.values()],
                live,
                now,
            }, wave)
            return boundWorkflowDetail(detail)
        },
    }
}
