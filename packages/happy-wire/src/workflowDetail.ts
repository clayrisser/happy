/**
 * The wave view of one workflow run, served to the phone on demand (DROVE-290).
 *
 * Clay, with the terminal's /workflows panel beside his phone: "in the mobile
 * app how do I see all of my waves?" The terminal showed `mpo-component-waves`
 * as a Phases list — Wave0 3/3, Wave1 16/16, Wave2 0/8 — with the selected
 * wave's agents beside it. The phone showed the same workflow as one line:
 * `1 running · 23 done · 22 failed / 60`. Twenty-two failures with nothing
 * saying WHERE — clustered in one wave (a broken phase) or spread (a broken
 * environment) — is the difference between a glance and opening a laptop.
 *
 * WHERE PHASE DATA ACTUALLY LIVES, measured on Clay's Mac against harness
 * 2.1.252 (a live probe run, its journal polled once a second, plus the real
 * 60-agent mpo-component-waves artifacts):
 *
 *   subagents/workflows/wf_<id>/journal.jsonl   LIVE. One line per event,
 *       `{type: started|result|failed, key, agentId}`. No phase, no label,
 *       no timestamp — the harness writes exactly those three fields.
 *   workflows/scripts/<name>-wf_<id>.js         AT LAUNCH. `meta.phases`
 *       titles. Which agent belongs to which phase is runtime state the
 *       script computes; it is not derivable from the source.
 *   workflows/wf_<id>.json                      AT END ONLY — completed,
 *       failed, or killed. Its `workflowProgress` has the whole story:
 *       per-agent `label` (the script's opts.label), `phaseIndex`,
 *       `phaseTitle`, `state`, `queuedAt`, `startedAt`, tokens. Polled at
 *       1s through a 35-second live run: the file did not exist until the
 *       run finished. The harness's own /workflows panel reads its
 *       in-memory task registry, which no other process can.
 *
 * So the fold is honest about a boundary it cannot move: an agent's wave is
 * known when the harness has written a run record naming it — which it does
 * on every end INCLUDING a kill, and Clay's long runs are kill-resume chains,
 * so the previous kill's record attributes most of a resumed run. An agent
 * no record names goes in the UNATTRIBUTED bucket, never guessed into a
 * phase: DROVE-268 ruled a guessed phase is the same class of lie as a
 * guessed agent count, and journal order cannot say where one wave ends.
 *
 * THE SHAPE CROSSES THE WIRE, so it lives here (the statusDot.ts pattern):
 * happy-cli folds it from disk and answers the session RPC, the app draws it,
 * and neither end can drift from the other.
 */

/** What one agent of the run is doing, folded from every source we have. */
export type WorkflowAgentState = 'queued' | 'running' | 'done' | 'failed' | 'quiet'

/**
 * One agent, as the wave screen draws it: a name, a state, a clock.
 *
 * No result text and no prompt body — the agent screen already serves the
 * transcript page by page (DROVE-93/211), and a result repeated here is how a
 * frame outgrows a socket. The label is the run record's `label` (the
 * script's own `opts.label`, e.g. `W2-vitest-react`) when the record names
 * the agent, else the live prompt-derived label the status tree already uses.
 */
export interface WorkflowWaveAgent {
    id: string
    label: string
    state: WorkflowAgentState
    /** Epoch ms. From the record's own clock, else the transcript's. */
    startedAt?: number
    /** Epoch ms, settled agents only, and only when a record says. */
    endedAt?: number
    tokens?: number
}

/** One wave: a title, the counts, and — when asked for — its agents. */
export interface WorkflowWave {
    /**
     * The request key for `wave`: the record's 1-based phaseIndex, and 0 for
     * the unattributed bucket. Stable across polls, unlike array position.
     */
    index: number
    /** The phase title, `Unattributed` styling is the app's call for index 0. */
    title: string
    done: number
    failed: number
    running: number
    queued: number
    /** Started, unsettled, not writing: killed with a session, or a long tool call. */
    quiet: number
    /**
     * The wave holding the run's frontier: the lowest-indexed wave with
     * unsettled agents. Absent everywhere when the run has none (all settled)
     * or nothing attributes the live agents to a wave.
     */
    current?: boolean
    /** Only on the wave the request named, and bounded. Counts never depend on it. */
    agents?: WorkflowWaveAgent[]
    /** Agents the cap or the byte bound pushed out of `agents`. Additive to its length. */
    elided?: number
}

export interface WorkflowDetailRequest {
    runId: string
    /**
     * Ask for one wave's agents by its `index`. Absent means counts only —
     * the default frame carries every wave's counts and no agent rows, so a
     * 60-agent tree never rides one frame (DROVE-211, DROVE-274).
     */
    wave?: number
    /** Accepted and ignored: the RPC is already addressed to the session. */
    sessionId?: string
}

export type WorkflowDetailResponse = {
    ok: true
    runId: string
    name: string
    /**
     * Where attribution came from. `record` when a run record maps agents to
     * waves (exact, the terminal's own numbers); `journal` when the run is
     * live and no record exists yet — waves are the script's titles with
     * every agent unattributed. The app words the gap honestly.
     */
    source: 'record' | 'journal'
    /** The run as the record last stated it, absent while it is live. */
    status?: string
    waves: WorkflowWave[]
    /** When this fold was taken, epoch ms. */
    at: number
} | {
    ok: false
    reason: string
}

/** The unattributed bucket's request index. */
export const WORKFLOW_UNATTRIBUTED_INDEX = 0

/**
 * ONE FRAME OF WAVE DETAIL.
 *
 * Two live incidents bound this number. An answer above Socket.IO's 1 MB
 * frame cap does not arrive late, it closes the socket (DROVE-211, measured:
 * 968 KB lived, 1.1 MB killed the transport). And an RPC answer above 64 KiB
 * hit a pipe truncation the same week (DROVE-274). The fold stays far under
 * the smaller of the two: counts for twelve waves are a few hundred bytes,
 * and one wave's agent page at the row cap is ~30 KB of serialized rows
 * before encryption (~4/3 growth base64'd, still ~40 KB on the frame).
 */
export const WORKFLOW_DETAIL_MAX_BYTES = 48 * 1024

/**
 * Rows one wave answer may carry. The biggest real run on this machine put
 * 60 agents in a WHOLE workflow; a single wave holding 200 is already a
 * pathology, and the elided count says how much the page left out.
 */
export const WORKFLOW_DETAIL_MAX_AGENTS = 200

/** What the journal said about one agent. The journal is the LIVE ledger. */
export interface JournalAgentFact {
    agentId: string
    settled: 'done' | 'failed' | null
}

/** What the transcripts say right now: writing, and since when. */
export interface LiveAgentFact {
    agentId: string
    /** Writing inside the stale window right now. */
    running: boolean
    /** Epoch ms, first record's clock or the file's birth. */
    startedAt?: number
    tokens?: number
    /** The label the status tree already shows for it. */
    label?: string
}

/** One `workflow_agent` entry of a run record, already picked apart. */
export interface RecordAgentFact {
    agentId?: string
    label?: string
    phaseIndex?: number
    phaseTitle?: string
    state?: string
    queuedAt?: number
    startedAt?: number
    endedAt?: number
    tokens?: number
}

export interface WorkflowDetailInput {
    runId: string
    name: string
    /** Phase titles in order: the record's `phases`, else the script's meta. */
    phaseTitles: string[]
    /** The record's per-agent entries, [] while the run is live. */
    record: RecordAgentFact[]
    /** The record's own status, absent while the run is live. */
    status?: string
    /** Every agent the journal has seen, with its settled state. */
    journal: JournalAgentFact[]
    /** The transcript dir's live view, keyed however the caller found them. */
    live: LiveAgentFact[]
    now: number
}

/**
 * The record's states, mapped without guessing. `done` and `error` are
 * settled; `progress` was running WHEN THE RECORD WAS WRITTEN, which for an
 * end-only record means the kill caught it mid-flight — the journal and the
 * transcripts, which are current, override it below. `start` with a queuedAt
 * and no startedAt is the harness's own queued shape (its panel draws queued
 * off exactly this pair).
 */
function recordState(fact: RecordAgentFact): WorkflowAgentState {
    switch (fact.state) {
        case 'done': return 'done'
        case 'error': return 'failed'
        case 'start':
            return fact.queuedAt !== undefined && fact.startedAt === undefined ? 'queued' : 'quiet'
        default:
            // `progress` and anything a newer harness invents: it was
            // unsettled when last written, and nothing current says it is
            // writing, so it is work this fold cannot see.
            return 'quiet'
    }
}

interface FoldedAgent extends WorkflowWaveAgent {
    waveIndex: number
}

/**
 * Every source folded into one agent list, each agent in exactly one bucket.
 *
 * Precedence per agent, most current source first:
 *   journal settled  → done/failed. The journal is append-only and live.
 *   transcript live  → running.
 *   record           → its state, mapped above. Only the record attributes a
 *                      wave; without it the agent is unattributed (index 0).
 *   journal started, nothing else → quiet.
 */
export function foldWorkflowAgents(input: WorkflowDetailInput): FoldedAgent[] {
    const journalById = new Map(input.journal.map((fact) => [fact.agentId, fact]))
    const liveById = new Map(input.live.map((fact) => [fact.agentId, fact]))
    const out: FoldedAgent[] = []
    const seen = new Set<string>()

    for (const fact of input.record) {
        const id = fact.agentId
        // A record entry with no agent id is a plan the run never started
        // (queued at the kill). It still counts — it is the 0/8 half of
        // `Wave2 0/8` — under a synthetic id the app must not tap into a
        // transcript fetch.
        if (!id) {
            out.push({
                id: '',
                label: fact.label ?? '',
                state: recordState(fact),
                waveIndex: fact.phaseIndex ?? WORKFLOW_UNATTRIBUTED_INDEX,
                ...(fact.startedAt !== undefined ? { startedAt: fact.startedAt } : {}),
                ...(fact.tokens !== undefined ? { tokens: fact.tokens } : {}),
            })
            continue
        }
        seen.add(id)
        const journal = journalById.get(id)
        const live = liveById.get(id)
        const state: WorkflowAgentState = journal?.settled
            ?? (live?.running ? 'running' : recordState(fact))
        out.push({
            id,
            label: fact.label ?? live?.label ?? id,
            state,
            waveIndex: fact.phaseIndex ?? WORKFLOW_UNATTRIBUTED_INDEX,
            ...(fact.startedAt !== undefined || live?.startedAt !== undefined
                ? { startedAt: fact.startedAt ?? live?.startedAt }
                : {}),
            ...(fact.endedAt !== undefined ? { endedAt: fact.endedAt } : {}),
            ...(fact.tokens !== undefined || live?.tokens !== undefined
                ? { tokens: fact.tokens ?? live?.tokens }
                : {}),
        })
    }

    for (const fact of input.journal) {
        if (seen.has(fact.agentId)) continue
        seen.add(fact.agentId)
        const live = liveById.get(fact.agentId)
        const state: WorkflowAgentState = fact.settled ?? (live?.running ? 'running' : 'quiet')
        out.push({
            id: fact.agentId,
            label: live?.label ?? fact.agentId,
            state,
            waveIndex: WORKFLOW_UNATTRIBUTED_INDEX,
            ...(live?.startedAt !== undefined ? { startedAt: live.startedAt } : {}),
            ...(live?.tokens !== undefined ? { tokens: live.tokens } : {}),
        })
    }

    // A transcript with no journal line yet: the write beat the ledger by a
    // tick. Still work, still drawn.
    for (const fact of input.live) {
        if (seen.has(fact.agentId)) continue
        out.push({
            id: fact.agentId,
            label: fact.label ?? fact.agentId,
            state: fact.running ? 'running' : 'quiet',
            waveIndex: WORKFLOW_UNATTRIBUTED_INDEX,
            ...(fact.startedAt !== undefined ? { startedAt: fact.startedAt } : {}),
            ...(fact.tokens !== undefined ? { tokens: fact.tokens } : {}),
        })
    }

    return out
}

/**
 * The whole answer: waves in phase order, counts always, one wave's agents
 * when asked. Pure — the CLI hands it what disk said, tests hand it fixtures,
 * and the real artifacts on Clay's machine hand it the mpo run.
 */
export function foldWorkflowDetail(
    input: WorkflowDetailInput,
    wave?: number,
): WorkflowDetailResponse {
    const agents = foldWorkflowAgents(input)
    const waves = new Map<number, WorkflowWave>()
    for (let i = 0; i < input.phaseTitles.length; i++) {
        waves.set(i + 1, {
            index: i + 1,
            title: input.phaseTitles[i],
            done: 0, failed: 0, running: 0, queued: 0, quiet: 0,
        })
    }
    for (const agent of agents) {
        let bucket = waves.get(agent.waveIndex)
        if (!bucket) {
            // An index past the declared titles (a script that computes
            // phases) or the unattributed 0: the bucket still exists, because
            // an agent with no wave to sit in is an agent that stops being
            // counted — DROVE-268's original bug in a new coat.
            bucket = {
                index: agent.waveIndex,
                title: agent.waveIndex === WORKFLOW_UNATTRIBUTED_INDEX
                    ? 'Unattributed'
                    : `Phase ${agent.waveIndex}`,
                done: 0, failed: 0, running: 0, queued: 0, quiet: 0,
            }
            waves.set(agent.waveIndex, bucket)
        }
        bucket[agent.state] += 1
    }
    // Ordered: the declared phases in order, then any synthetic indexes, then
    // the unattributed bucket LAST — it reads as a footnote, not a phase. An
    // empty unattributed bucket is dropped; empty declared phases stay, they
    // are the `Wave3, Wave4, Judge` tail the terminal also shows.
    const ordered = [...waves.values()].sort((a, b) => {
        const ka = a.index === WORKFLOW_UNATTRIBUTED_INDEX ? Number.MAX_SAFE_INTEGER : a.index
        const kb = b.index === WORKFLOW_UNATTRIBUTED_INDEX ? Number.MAX_SAFE_INTEGER : b.index
        return ka - kb
    }).filter((bucket) => bucket.index !== WORKFLOW_UNATTRIBUTED_INDEX
        || bucket.done + bucket.failed + bucket.running + bucket.queued + bucket.quiet > 0)

    // The frontier: the lowest-indexed ATTRIBUTED wave with unsettled agents.
    // The unattributed bucket never wears the marker — its agents' wave is
    // exactly what is not known.
    for (const bucket of ordered) {
        if (bucket.index === WORKFLOW_UNATTRIBUTED_INDEX) continue
        if (bucket.running + bucket.queued + bucket.quiet > 0) {
            bucket.current = true
            break
        }
    }

    if (wave !== undefined) {
        const bucket = ordered.find((candidate) => candidate.index === wave)
        if (bucket) {
            const mine = agents.filter((agent) => agent.waveIndex === wave)
            // Failures first, then the work in flight, then the settled rest:
            // the 22 failures are what the screen was opened to find.
            const rank: Record<WorkflowAgentState, number> = { failed: 0, running: 1, queued: 2, quiet: 3, done: 4 }
            mine.sort((a, b) => rank[a.state] - rank[b.state] || (a.startedAt ?? 0) - (b.startedAt ?? 0))
            const page = mine.slice(0, WORKFLOW_DETAIL_MAX_AGENTS)
                .map(({ waveIndex: _waveIndex, ...row }) => row)
            bucket.agents = page
            if (mine.length > page.length) bucket.elided = mine.length - page.length
        }
    }

    return {
        ok: true,
        runId: input.runId,
        name: input.name,
        source: input.record.length > 0 ? 'record' : 'journal',
        ...(input.status ? { status: input.status } : {}),
        waves: ordered,
        at: input.now,
    }
}

/**
 * UTF-8 length without Buffer, because this module is shared with the app and
 * Hermes has no Buffer global. Surrogate pairs are one 4-byte codepoint.
 */
export function utf8ByteLength(text: string): number {
    let bytes = 0
    for (const ch of text) {
        const code = ch.codePointAt(0)!
        bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4
    }
    return bytes
}

/**
 * The byte bound, enforced on the SERIALIZED answer because that is what the
 * frame is made of (DROVE-211's lesson, spelled the same way the transcript
 * pager spells it). Counts always survive; agent rows are shed from the end
 * of the page, each shed row added to `elided`, until the answer fits. A
 * response that is over budget with no rows left to shed is returned as the
 * counts-only shape, which cannot exceed the budget for any run the agent
 * cap admits.
 */
export function boundWorkflowDetail(
    response: WorkflowDetailResponse,
    maxBytes: number = WORKFLOW_DETAIL_MAX_BYTES,
): WorkflowDetailResponse {
    if (!response.ok) return response
    let current = response
    while (utf8ByteLength(JSON.stringify(current)) > maxBytes) {
        const heavy = current.waves.find((bucket) => bucket.agents !== undefined && bucket.agents.length > 0)
        if (!heavy) {
            // Nothing left to shed: strip the empty pages themselves.
            const stripped = current.waves.some((bucket) => bucket.agents !== undefined)
            if (!stripped) return current
            current = {
                ...current,
                waves: current.waves.map(({ agents: _agents, ...bucket }) => bucket),
            }
            continue
        }
        const shed = Math.max(1, Math.ceil(heavy.agents!.length / 4))
        current = {
            ...current,
            waves: current.waves.map((bucket) => bucket !== heavy ? bucket : {
                ...bucket,
                agents: bucket.agents!.slice(0, bucket.agents!.length - shed),
                elided: (bucket.elided ?? 0) + shed,
            }),
        }
    }
    return current
}
