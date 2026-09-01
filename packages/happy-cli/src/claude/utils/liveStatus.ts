/**
 * What the pane is doing RIGHT NOW, read off disk (DROVE-54).
 *
 * The terminal shows a live task tree — six background agents each with an
 * elapsed time and a token count, a workflow's phase and how many of its
 * agents are done, the running command and its own timer — and the app for the
 * same session showed a green dot and the word "online". Clay: "I wish I could
 * see all this rich information on my mobile app as it's working. Right now it
 * just says online and I can't see what it's doing."
 *
 * None of it needs the TUI. Every fact is already on disk, in files Claude Code
 * writes as it goes:
 *
 *   <projectDir>/<session>.jsonl
 *       the conversation. An assistant `tool_use` block with no `tool_result`
 *       yet IS the running tool, and the record's own timestamp is when it
 *       started.
 *   <projectDir>/<session>/subagents/agent-<id>.jsonl
 *       one per background agent, appended to as it works. Its first record is
 *       when it started; its `message.usage` blocks are the tokens.
 *   <projectDir>/<session>/subagents/agent-<id>.meta.json
 *       `{agentType, description, toolUseId, spawnDepth, parentAgentId}` — the
 *       label the TUI shows, the tool_use id that ties the agent back to its
 *       card in the app, and WHO SPAWNED IT (DROVE-185). An agent the pane
 *       launched itself has no `parentAgentId`; one launched by another agent
 *       names it. Every agent in a session lands in this ONE flat directory
 *       whatever its depth, so nested agents were always reported — they were
 *       just indistinguishable from top-level ones without this field.
 *       Measured on a real session: 236 files at spawnDepth 1, 23 at 2, 4 at
 *       3, and `parentAgentId` present on exactly the 27 deeper than 1.
 *   <projectDir>/<session>/subagents/workflows/wf_<id>/journal.jsonl
 *       one `started` per agent the workflow launched and one `result` per
 *       agent that finished, which is the "3/5 agents done" the TUI draws.
 *   <projectDir>/<session>/workflows/wf_<id>.json
 *       the run record: workflowName, phases, workflowProgress. Read when it
 *       is there, never required — measured across 408 runs on this machine,
 *       every surviving copy is in a terminal status, so it cannot be relied
 *       on to exist while the workflow is still going. The live name comes off
 *       the script filename instead (`workflows/scripts/<name>-wf_<id>.js`),
 *       which Claude Code writes at launch.
 *
 * READING IS INCREMENTAL, because these files are not small. Clay's live
 * session transcript is 13MB and one agent's is 1.2MB; re-reading them once a
 * second is what pinned a core for five hours the last time something in here
 * read a whole transcript on a timer (see sessionScanner's stat guard). So
 * every file is tailed from a remembered byte offset, and the first read of an
 * existing transcript starts near its end rather than at byte 0.
 *
 * WHAT "BUSY" MEANS. Disk alone cannot see the model thinking: while Claude is
 * composing a reply nothing is written at all, which is exactly the
 * "Sketching… 17m 13s" state Clay photographed. So the caller passes the
 * process's own thinking flag (claudeLocal watches fd 3 for fetch-start /
 * fetch-end) and this treats the session as busy when EITHER that flag is set,
 * or a tool is open, or an agent or workflow is running, or the transcript
 * moved within the grace window. The grace window is not decoration: an
 * assistant `text` block and the `tool_use` that follows it were measured 4.1s
 * apart in Clay's session, so a stricter test flickers the strip off and on
 * mid-turn.
 */

import { closeSync, fstatSync, openSync, readSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

import type { CompactionLatch, CompactionState } from './compaction'

/** The tool the assistant is waiting on: one `tool_use` with no `tool_result`. */
export interface LiveStatusTool {
    /** The `tool_use` id, so the app can find the card this is about. */
    id: string
    name: string
    /** One short argument — the command, the file, the description. */
    arg?: string
    /** Epoch ms, from the record's own timestamp. */
    startedAt: number
}

/** One background agent, still writing to its own transcript. */
export interface LiveStatusAgent {
    /** Claude Code's agent id, e.g. `a3166e92b4779f27d`. */
    id: string
    /** The Task's description where it has one, else the agent type, else the id. */
    label: string
    startedAt: number
    /** input + output + cache-creation tokens so far. See countTokens. */
    tokens?: number
    /** The `tool_use` that launched it, from the agent's meta.json. */
    toolId?: string
    /**
     * The agent that spawned this one, absent when the pane spawned it
     * (DROVE-185).
     *
     * Absence IS "top level" — there is no separate depth field on the wire
     * and none is wanted. Claude Code writes `parentAgentId` only from
     * spawnDepth 2 down, so the two facts are the same fact and carrying both
     * invites them to disagree. The app rebuilds depth by walking these links.
     */
    parentId?: string
    /**
     * The workflow run this agent belongs to, absent when the pane launched it
     * (DROVE-268).
     *
     * A workflow's agents are in THIS array, beside the pane's own, because it
     * is the only array any surface counts. They used to be read and thrown
     * away — `readWorkflows` pumped them solely to derive a phase label and a
     * token subtotal — so five agents writing flat out published as one row
     * reading `0/5`, and on the night this was measured, as nothing at all.
     */
    runId?: string
}

/**
 * One workflow run, from its journal and its agents' transcripts.
 *
 * The counts are four buckets over the SAME set — the agents the journal says
 * were started — and they are published apart because collapsing them is how
 * the row lies. Measured over the 13 runs this session has on disk:
 *
 *   running  writing to its transcript inside the stale window. The only
 *            bucket that is evidence of work; the rest are ledger entries.
 *   done     a `result` line in the journal.
 *   failed   a `failed` line. NOT the same as done, and not rare: one run here
 *            is 5 started / 5 failed, another 21 started / 1 result / 19
 *            failed. Both drew as `0/5` and `1/21` before this, because only
 *            `result` counted, so a run that had entirely died read as a run
 *            barely under way.
 *   quiet    started, never reported, and not writing. TWO different things
 *            wear this and the count deliberately does not guess which: an
 *            agent that went down with its session (a drover restart kills
 *            them silently — one run here has ten of those), and an agent
 *            blocked on a long tool call, which writes nothing to its
 *            transcript for the length of it. Calling either one "running" is
 *            the lie; calling it "dead" is the other lie. It is work this
 *            reader cannot see, and that is what the word says.
 *
 * `quiet` is why `running` is measured off transcripts and never as
 * `total - done`: that subtraction calls those ten dead agents busy for the
 * rest of the session.
 *
 * THERE IS NO `queued`. Clay asked for running-vs-queued and the honest answer
 * is that queued is not on disk: across these runs, every journal `started`
 * line is followed by that agent's first transcript record within
 * milliseconds (83/83, 21/21 and 5/5 checked on three runs). Claude Code
 * writes `started` when an agent SPAWNS, not when it is scheduled, so a queued
 * count would be invented. The risk he named — ten agents drawn busy while
 * four really run — is real, and `quiet` is the shape it takes here.
 */
export interface LiveStatusWorkflow {
    /** The run id, e.g. `wf_f7b09017-045`. */
    id: string
    name: string
    /** The phase it is in, when the run record says; else the running agent's label. */
    phase?: string
    /** Agents that have reported a result. */
    done: number
    /** Agents that reported a failure (DROVE-268). Settled, and not `done`. */
    failed?: number
    /** Agents writing right now (DROVE-268). The length of `agentIds`. */
    running?: number
    /** Started, unsettled, and not writing (DROVE-268). Not running, not settled. */
    quiet?: number
    /** Agents it has launched so far. Not the eventual total — nothing on disk knows that. */
    total: number
    /**
     * The running agents' ids, so a surface can group this run's rows without
     * scanning every agent for a `runId` (DROVE-268). The agents themselves
     * are in `LiveStatus.agents`, once, and are never repeated here.
     */
    agentIds?: string[]
    /**
     * The phase titles the workflow SCRIPT declares, in order (DROVE-268).
     *
     * Read from `workflows/scripts/<name>-<runId>.js`, which Claude Code
     * writes at launch and which states `export const meta = { phases: [...] }`
     * near the top. It is the only statement of the plan that exists while a
     * run is going: `workflows/<runId>.json` carries `phases`, a per-agent
     * `phaseTitle` and a whole `workflowProgress`, and is written when the run
     * ENDS — 0 of the 6 live-or-killed runs on this machine have one, against
     * 7 of the 7 that finished.
     *
     * WHICH phase each agent is in is deliberately absent. Nothing live maps
     * an agentId to a phase, so `Build 4/5 · Verify 1/5` cannot be derived
     * without guessing, and a guessed phase on the row is the same class of
     * lie as a guessed agent count. The titles alone still say what the run is
     * made of.
     */
    phaseNames?: string[]
    startedAt: number
    tokens?: number
}

/**
 * The MAIN thread's own turn (DROVE-155).
 *
 * Clay: "Where is the live token counter for the main thread as it's thinking".
 * Every agent card already carried an elapsed time and a token count and the
 * main session carried neither, so the only numbers on the status row belonged
 * to the agents.
 *
 * Present only while the main thread is ACTUALLY working — blocked on a tool,
 * an API call in flight, or the transcript still moving. A fan-out of
 * background agents can outlive the turn that launched it, and this block is
 * what lets the phone tell the two apart instead of calling the pane busy
 * because something, somewhere, is running.
 */
export interface LiveStatusMain {
    /** The turn's start, epoch ms; the tool's or the newest record's when we never saw the prompt. */
    startedAt: number
    /** Tokens this turn has spent on the MAIN transcript, counted exactly as an agent's are. */
    tokens?: number
}

/**
 * What the SESSION has spent, main thread and every subagent together (DROVE-184).
 *
 * Clay: "where's my damn token counter showing tally of all tokens used across
 * main agent and all subagents". The row carried `main.tokens`, which is the
 * MAIN transcript alone, and every agent card carried its own. Nothing added
 * them up, so a night with nine agents out at 200k each read as 50k.
 *
 * Summed HERE, on the CLI, at the two places `countTokens(usageOf(record))` is
 * already called — once per main-transcript record, once per agent-transcript
 * record. It is the same addition the card and the main readout are made of,
 * folded into a second bucket as it happens, so the tally cannot disagree with
 * the numbers beside it: there is one derivation and no second accounting.
 *
 * FINISHED SUBAGENTS COUNT. The question is "what has this cost me", and a
 * finished agent's tokens are spent. `agents[]` drops an agent 90s after its
 * last write and the card goes with it, but the tokens it had already reported
 * stay in these totals, because they were added when the record was READ and
 * nothing here re-derives from the live set. The one thing missing is an agent
 * that had already gone quiet before this reader first saw the directory: its
 * transcript is never opened, so its spend is invisible. That is a floor, not
 * a drift.
 */
export interface LiveStatusTokens {
    /** Main plus every subagent since the last prompt. The row's one number. */
    turn: number
    /** The main thread's share of `turn`; the same number as `main.tokens`. */
    turnMain: number
    /** Main plus every subagent since this reader picked the session up. */
    session: number
    /** The main thread's share of `session`. */
    sessionMain: number
    /**
     * `session`, split by the model that spent it (DROVE-241).
     *
     * Clay wants the all-time counter on the home page to "breakdown when
     * single pressing by model". The split is read HERE for the same reason
     * the totals are: `message.model` sits on the very record `message.usage`
     * does, so the same `countTokens` call that feeds `session` feeds this,
     * and the parts cannot add up to something other than the whole.
     *
     * Keys are Claude Code's own model ids verbatim — `claude-opus-5`,
     * `claude-fable-5`, `claude-sonnet-5` — never a family name. A model this
     * build has never heard of still gets a bucket and the app still draws it;
     * naming it prettily is the app's job and a fallback there is a cosmetic
     * miss rather than lost spend.
     *
     * SESSION ONLY. There is no per-turn split, because nothing asks for one
     * and every field here is republished up to once a second.
     */
    sessionByModel?: Record<string, number>
    /**
     * What the MAIN thread spent THINKING since the last prompt (DROVE-244).
     *
     * A subset of `turnMain`, never an addition to it: extended thinking is
     * billed inside `output_tokens`, so this spend is already inside every
     * total above and the strip must never add the two. It is here so the
     * phone can say what the current thinking burst is costing without
     * deriving a second number from anything.
     *
     * MAIN ONLY, and per TURN, because it exists to sit beside the word
     * `thinking` on the status strip and that word is about the main thread's
     * current activity. The turn is the closest scope on disk to "this burst"
     * and it is the same scope as the clock drawn next to it (`main.startedAt`
     * is the turn's start), so the two numbers on that line agree about what
     * they are measuring.
     *
     * Absent from an older CLI, and 0 on a model that is not doing extended
     * thinking. Both mean the same thing to the strip: draw no number.
     */
    turnThinking?: number
}

/**
 * One compact snapshot, published over the metadata channel the droverAccount
 * and paneModel stamps already ride (DROVE-45, DROVE-47).
 *
 * Times are absolute epoch ms rather than pre-computed durations on purpose:
 * the app ticks its own timers from `startedAt`, so a once-a-second publish is
 * not what makes the elapsed counters move, and a snapshot that is a few
 * seconds stale still renders a correct clock.
 */
export interface LiveStatus {
    /** When this snapshot was taken, epoch ms. */
    at: number
    /** The last real user prompt, epoch ms. Absent when we never saw one. */
    turnStartedAt?: number
    /** The main thread's own clock and tokens, absent while only agents are out. */
    main?: LiveStatusMain
    /**
     * The compaction pass, while one is running (DROVE-257).
     *
     * OBSERVED, not inferred. `PreCompact` opens it and the transcript's
     * `compact_boundary` closes it, so the phone's dot no longer has to guess
     * the pass from "busy at the top of the window" — a guess that read false
     * for the whole of it, because Claude Code writes nothing to disk while it
     * compacts. See compaction.ts for the measurement.
     *
     * Absent on an older CLI and absent when nothing is compacting, which mean
     * the same thing to the app: fall back to DROVE-231's inference.
     */
    compacting?: CompactionState
    /** Main plus every subagent, this turn and this session (DROVE-184). */
    tokens?: LiveStatusTokens
    tool?: LiveStatusTool
    agents?: LiveStatusAgent[]
    workflows?: LiveStatusWorkflow[]
}

/** How long an agent transcript may go unwritten and still count as running. */
const defaultAgentStaleMs = 90_000

/** How long after the newest transcript record the turn still counts as busy. */
const defaultIdleGraceMs = 10_000

/** The same window after an assistant text block, which is what ends a turn. */
const defaultSettleGraceMs = 6_000

/** How much of an existing transcript the first read looks at. */
const defaultSeedBytes = 2 * 1024 * 1024

/** Never carry more than this much of a partial line between reads. */
const maxCarryBytes = 4 * 1024 * 1024

export interface Tail {
    offset: number
    carry: string
}

/**
 * The bytes appended to a file since the last call, split into whole lines.
 *
 * Returns `null` when the file is not there — an agent directory that does not
 * exist yet is the normal case, not an error. A file that SHRANK is treated as
 * a new file and re-seeded: a flip carries the transcript into another
 * account's config dir and Claude Code rewrites its tail, so offsets do not
 * survive the move (the same reason sessionScanner re-reads from the top).
 */
export function readNewLines(path: string, tail: Tail, seedBytes: number): string[] | null {
    let fd: number
    try {
        fd = openSync(path, 'r')
    } catch {
        return null
    }
    try {
        const size = fstatSync(fd).size
        if (size < tail.offset) {
            tail.offset = 0
            tail.carry = ''
        }
        let seeded = false
        if (tail.offset === 0 && seedBytes > 0 && size > seedBytes) {
            tail.offset = size - seedBytes
            seeded = true
        }
        if (size <= tail.offset) {
            return []
        }
        const buffer = Buffer.allocUnsafe(size - tail.offset)
        let read = 0
        while (read < buffer.length) {
            const n = readSync(fd, buffer, read, buffer.length - read, tail.offset + read)
            if (n <= 0) break
            read += n
        }
        tail.offset += read
        let text = tail.carry + buffer.subarray(0, read).toString('utf8')
        if (seeded) {
            // The seek landed mid-line. Drop everything up to the first
            // newline rather than handing a fragment to JSON.parse.
            const firstBreak = text.indexOf('\n')
            text = firstBreak >= 0 ? text.slice(firstBreak + 1) : ''
        }
        const lines = text.split('\n')
        tail.carry = lines.pop() ?? ''
        if (tail.carry.length > maxCarryBytes) {
            // A line this long is a file we do not understand. Drop it rather
            // than grow forever.
            tail.carry = ''
        }
        return lines
    } catch {
        return []
    } finally {
        closeSync(fd)
    }
}

export function parseTimestamp(value: unknown): number {
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value !== 'string') return 0
    const ms = Date.parse(value)
    return Number.isFinite(ms) ? ms : 0
}

/**
 * The tokens a run has spent, as the terminal counts them.
 *
 * input + output + cache creation, and deliberately NOT cache reads. Measured
 * over five of Clay's agent transcripts, including reads gives 1.8M–19.5M for
 * a single agent, which is the same context billed back on every turn rather
 * than work done. Excluding creation as well gives 983–12k, which is too small
 * to be the "851.9k tokens" the TUI showed for a five-agent workflow. The
 * middle reading is the one that matches what he was looking at.
 */
export function countTokens(usage: Record<string, unknown> | null | undefined): number {
    if (!usage) return 0
    const n = (key: string): number => {
        const value = usage[key]
        return typeof value === 'number' && Number.isFinite(value) ? value : 0
    }
    return n('input_tokens') + n('output_tokens') + n('cache_creation_input_tokens')
}

/**
 * The THINKING tokens in one record's usage, or 0 when nothing reports any
 * (DROVE-244).
 *
 * Clay: "When it's thinking instead of bashing on the main thread show the
 * thinking token count." Extended thinking is billed inside `output_tokens`,
 * so `countTokens` above already has this spend in its total and nothing here
 * adds to any figure — this only says how much of it was thinking.
 *
 * `usage.output_tokens_details.thinking_tokens` is a REAL field the API
 * returns and Claude Code writes into the transcript verbatim. Measured across
 * this machine's 102 transcripts: absent on every record before 2026-08-11,
 * present on 99% of them from 2026-08-13 on (31,425 records carry it), and
 * non-zero on roughly a third of those. So it is on the wire today and no
 * estimate is needed — but it is NOT universal, which is why absence and zero
 * are the same answer here and the strip draws nothing for either. A model
 * that is not doing extended thinking honestly spent no thinking tokens, and a
 * `0` on that line would be furniture.
 *
 * IT IS NOT THE NUMBER THE TUI PRINTS LIVE, and it cannot be. Claude Code's
 * own status line reads `Actualizing... (20s . 424 tokens)`, counting up off
 * the streaming response as it arrives; this reader never sees that stream. It
 * has two inputs — the transcript on disk, and fd 3, which carries only
 * `fetch-start`/`fetch-end` with a hostname and a timestamp (claudeLocal.ts)
 * and no counts at all. So the figure here lands when the assistant record
 * does, at the END of each request rather than during it.
 *
 * What that costs, exactly: through the FIRST thinking burst of a turn the
 * number is 0 and the strip draws the word alone, and from the second burst on
 * it carries the turn's thinking so far. Every other figure on the strip is
 * built the same way off the same records (DROVE-184), so this one moves when
 * they move and cannot disagree with them. A live count would mean reading
 * Claude Code's response body, which is a different and much larger change.
 */
export function thinkingTokensOf(usage: Record<string, unknown> | null | undefined): number {
    if (!usage) return 0
    const details = usage.output_tokens_details
    if (!details || typeof details !== 'object') return 0
    const value = (details as Record<string, unknown>).thinking_tokens
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

export function usageOf(record: Record<string, unknown>): Record<string, unknown> | null {
    const message = record.message
    if (!message || typeof message !== 'object') return null
    const usage = (message as Record<string, unknown>).usage
    return usage && typeof usage === 'object' ? usage as Record<string, unknown> : null
}

/**
 * Which model spent this record's tokens (DROVE-241), or null.
 *
 * `message.model`, beside `message.usage` on the same assistant record, so a
 * record can never be counted into the total under one model and the split
 * under another.
 *
 * `<synthetic>` is dropped. Claude Code writes it for assistant records IT
 * composed rather than a model, an interrupt or a refusal filled in locally.
 * Measured across a night of Clay's transcripts, 388 files: 95 `<synthetic>`
 * records carrying ZERO tokens between them, against 35287 `claude-opus-5`,
 * 5199 `claude-fable-5`, 368 `claude-sonnet-5` and 86
 * `claude-haiku-4-5-20251001`. Every record with a `usage` block named a
 * model; none was missing one. So a `<synthetic>` row in a by-model breakdown
 * would be a permanent zero and a bug report waiting to happen. Its spend, if
 * a build ever gives it any, still lands in `session`; only the attribution is
 * withheld, which is the honest thing to do with a record that names no model.
 *
 * Note the DATED id in that list. Claude Code writes both bare ids
 * (`claude-opus-5`) and pinned ones (`claude-haiku-4-5-20251001`), so the key
 * space is wider than the four family names and nothing here may assume
 * otherwise. The app names them with `shortModelName`, the same function the
 * composer's model pill uses, which already reads a date suffix as a pin and
 * drops it.
 */
export function modelOf(record: Record<string, unknown>): string | null {
    const message = record.message
    if (!message || typeof message !== 'object') return null
    const model = (message as Record<string, unknown>).model
    if (typeof model !== 'string') return null
    const trimmed = model.trim()
    if (trimmed.length === 0 || trimmed === '<synthetic>') return null
    return trimmed
}

/** Trim an argument to something a phone header can hold. */
function shorten(value: string, max = 64): string {
    const flat = value.replace(/\s+/g, ' ').trim()
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/**
 * The one argument worth showing beside a tool name.
 *
 * Ordered by what the terminal itself puts on the line: a Bash call is its
 * description or its command, a file tool is its path, a Task is its
 * description. Anything else falls back to the first short string input, which
 * covers MCP tools nothing here has ever heard of.
 */
export function describeToolArg(name: string, input: unknown): string | undefined {
    if (!input || typeof input !== 'object') return undefined
    const fields = input as Record<string, unknown>
    const pick = (key: string): string | undefined => {
        const value = fields[key]
        return typeof value === 'string' && value.trim().length > 0 ? shorten(value) : undefined
    }
    if (name === 'Bash' || name === 'BashOutput') {
        return pick('description') ?? pick('command')
    }
    if (name === 'Task' || name === 'Agent') {
        return pick('description') ?? pick('subagent_type')
    }
    if (name === 'Workflow') {
        const script = pick('scriptPath')
        return script ? workflowNameFromScript(script) : pick('args')
    }
    for (const key of ['file_path', 'path', 'pattern', 'query', 'url', 'description', 'command', 'prompt']) {
        const value = pick(key)
        if (value) return value
    }
    for (const value of Object.values(fields)) {
        if (typeof value === 'string' && value.trim().length > 0 && value.length <= 200) {
            return shorten(value)
        }
    }
    return undefined
}

/**
 * `…/scripts/drover-close-out-wf_f7b09017-045.js` -> `drover-close-out`.
 *
 * The script filename is the only place a RUNNING workflow's name is written:
 * `workflows/wf_<id>.json` carries `workflowName`, but every copy on this
 * machine is in a terminal status, so it appears too late to name a run in
 * progress.
 */
export function workflowNameFromScript(scriptPath: string): string {
    const file = basename(scriptPath).replace(/\.[cm]?js$/, '')
    const cut = file.lastIndexOf('-wf_')
    return cut > 0 ? file.slice(0, cut) : file
}

/**
 * A label for an agent whose meta.json named nothing, from its prompt
 * (DROVE-268).
 *
 * Record one of an agent transcript IS the prompt, as a plain string, and the
 * terminal previews the same text. Only the first non-empty line is taken and
 * it is shortened to the width a phone row can hold, so a 16KB brief becomes
 * `Work in ~/Projects/bitspur/cattle-drover, branch lane/DROVE-251…`. Undefined
 * when the record is not a string prompt, which leaves the caller on its
 * existing fallbacks rather than putting a fragment of JSON on the row.
 */
export function promptLabel(record: Record<string, unknown>): string | undefined {
    if (record.type !== 'user') return undefined
    const message = record.message
    if (!message || typeof message !== 'object') return undefined
    const content = (message as Record<string, unknown>).content
    if (typeof content !== 'string') return undefined
    for (const line of content.split('\n')) {
        const trimmed = line.trim()
        if (trimmed.length > 0) return shorten(trimmed)
    }
    return undefined
}

/**
 * Enough of a prompt to tell siblings apart (DROVE-290). A wave's item
 * prompts are one template with the item pasted in, and the paste can sit
 * DEEP: the real mpo-component-waves template runs 4.9 KB and writes
 * `YOUR ITEM ID: W2-password` at character 4801, measured across its 60
 * agents' transcripts. 8 KB reaches that with room, without pinning a
 * transcript's worth of prompt per agent for the life of the run.
 */
const promptHeadChars = 8192

/** The prompt's raw head, kept only for label disambiguation. */
export function promptHead(record: Record<string, unknown>): string | undefined {
    if (record.type !== 'user') return undefined
    const message = record.message
    if (!message || typeof message !== 'object') return undefined
    const content = (message as Record<string, unknown>).content
    if (typeof content !== 'string' || content.trim().length === 0) return undefined
    return content.slice(0, promptHeadChars)
}

/**
 * The DISTINGUISHING part of each prompt in a set that opens identically
 * (DROVE-290).
 *
 * Clay's screenshot: six agent rows, every one reading `You are executing ONE
 * item of…` — the shared template prefix, zero information per row. The rows
 * differ where the template pastes the item in, so the label worth drawing
 * starts at the end of the common prefix: strip the longest common prefix of
 * the set, then take the first non-empty run of text from where each prompt
 * diverges. `undefined` where a prompt does not diverge inside its head —
 * identical prompts, or a template whose variance sits past the stored head —
 * and the caller falls back to numbering rather than six equal strings.
 */
export function distinguishingLabels(heads: string[]): (string | undefined)[] {
    if (heads.length < 2) return heads.map(() => undefined)
    let lcp = heads[0].length
    for (let i = 1; i < heads.length; i++) {
        const other = heads[i]
        const max = Math.min(lcp, other.length)
        let j = 0
        while (j < max && other.charCodeAt(j) === heads[0].charCodeAt(j)) j += 1
        lcp = j
    }
    return heads.map((head) => {
        // A head the common prefix swallows whole never diverged: identical
        // prompts, or one that is a prefix of a sibling. Nothing here is a
        // distinguishing part, and resurrecting shared text via the line
        // snap below would dress the collision up as a repair.
        if (lcp >= head.length) return undefined
        // Back the cut up to the start of its line when the line is nearly
        // new, so `YOUR ITEM ID: W2-radius-otp` survives whole instead of
        // arriving as `-radius-otp` with its head eaten by the common prefix.
        // Bounded, because backing into a long template sentence would put
        // the same sixty characters on every row again — the exact failure
        // this function exists to end.
        const lineStart = head.lastIndexOf('\n', Math.max(lcp - 1, 0)) + 1
        const start = lcp - lineStart <= 24 ? lineStart : lcp
        const rest = head.slice(start)
        for (const line of rest.split('\n')) {
            // A mid-line cut can land on the template's separators; a cut
            // snapped to its line start is already clean.
            const trimmed = (start === lcp ? line.replace(/^[\s\p{P}\p{S}]+/u, '') : line).trim()
            if (trimmed.length > 0) return trimmed
        }
        return undefined
    })
}

/**
 * The phase titles a workflow script declares, in order (DROVE-268).
 *
 * The scripts on this machine all open with
 * `export const meta = { name, description, phases: [{ title: 'Work' }, …] }`,
 * so the titles are pulled straight out of that literal rather than by
 * evaluating a file this process must never run. Anything unrecognisable
 * yields nothing, which reads the same as an older Claude Code writing no
 * script at all: the run keeps its name and loses only the phase list.
 */
export function phaseNamesFromScript(source: string): string[] {
    const block = /phases\s*:\s*\[([\s\S]{0,2000}?)\]/.exec(source)
    if (!block) return []
    const titles: string[] = []
    for (const match of block[1].matchAll(/title\s*:\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)) {
        const title = match[2].trim()
        if (title.length > 0 && titles.length < 12) titles.push(title)
    }
    return titles
}

/** A `user` record that is a real prompt rather than a tool result. */
function isPrompt(record: Record<string, unknown>): boolean {
    if (record.type !== 'user') return false
    if (record.isSidechain === true) return false
    const message = record.message
    if (!message || typeof message !== 'object') return false
    const content = (message as Record<string, unknown>).content
    if (typeof content === 'string') return true
    if (!Array.isArray(content)) return false
    return !content.some((block) => (block as Record<string, unknown> | null)?.type === 'tool_result')
}

type RecordKind = 'prompt' | 'tool-result' | 'assistant-text' | 'other'

function classify(record: Record<string, unknown>): RecordKind {
    if (isPrompt(record)) return 'prompt'
    const message = record.message
    const content = message && typeof message === 'object'
        ? (message as Record<string, unknown>).content
        : undefined
    if (record.type === 'user' && Array.isArray(content)) {
        return content.some((b) => (b as Record<string, unknown> | null)?.type === 'tool_result')
            ? 'tool-result'
            : 'other'
    }
    if (record.type === 'assistant' && Array.isArray(content)) {
        return content.some((b) => (b as Record<string, unknown> | null)?.type === 'text')
            ? 'assistant-text'
            : 'other'
    }
    return 'other'
}

interface AgentState {
    tail: Tail
    startedAt: number
    tokens: number
    label?: string
    toolId?: string
    /** The agent that spawned it, read once off meta.json (DROVE-185). */
    parentId?: string
    /** Its category, the last thing tried before the id (DROVE-268). */
    agentType?: string
    /**
     * The opening line of its prompt, kept only when meta.json named nothing
     * better (DROVE-268).
     *
     * A workflow's agents have no `description` and no `toolUseId` at all —
     * measured across 152 of them on this machine, 138 carry exactly
     * `{agentType, spawnDepth}` and 14 add the worktree pair — so the label
     * chain used to bottom out at `agentType` and drew five identical rows
     * saying `workflow-subagent`. The prompt is the same text the terminal
     * previews, and it is record one of a file this already reads to the end.
     */
    prompt?: string
    /**
     * The prompt's raw head, kept only while the label came from the prompt,
     * so siblings sharing a template can be told apart (DROVE-290).
     */
    promptHead?: string
    /**
     * The label after collision repair, computed once and then held
     * (DROVE-290). Held, because the group it was computed against changes as
     * siblings finish, and a row whose name drifts tick to tick is worse than
     * one whose name is merely short.
     */
    distinctLabel?: string
    /** mtime of the last stat, so a file nothing writes drops out. */
    mtimeMs: number
}

/** The workflow run an agent directory belongs to, absent for the pane's own. */
interface AgentScope {
    runId?: string
}

/** What one workflow journal has said so far, accumulated as it is tailed. */
interface JournalState {
    tail: Tail
    /** Agent ids the run has spawned. */
    started: Set<string>
    /** Agent ids that reported a result. */
    done: Set<string>
    /** Agent ids that reported a failure. Settled, and not `done`. */
    failed: Set<string>
    /** The journal's birthtime: the run's start, for a run with nothing running. */
    birth: number
}

export interface LiveStatusReader {
    /** The snapshot as of `now`, or null when the session is idle. */
    read: (now?: number) => LiveStatus | null
    /** Follow the session into another account's config dir after a flip. */
    setProjectDir: (projectDir: string) => void
    setSessionId: (sessionId: string | null) => void
}

export function createLiveStatusReader(opts: {
    projectDir: string
    sessionId: string | null
    /** The process's own "an API call is in flight" flag; see the file header. */
    isThinking?: () => boolean
    /**
     * The compaction pass, opened by the `PreCompact` hook (DROVE-257).
     *
     * Read here and CLOSED here: the `compact_boundary` record is written into
     * the very transcript this reader is already tailing, so the end signal
     * costs nothing extra and cannot be missed by a hook that failed to fire.
     */
    compaction?: CompactionLatch
    agentStaleMs?: number
    idleGraceMs?: number
    settleGraceMs?: number
    seedBytes?: number
}): LiveStatusReader {
    let projectDir = opts.projectDir
    let sessionId = opts.sessionId
    const agentStaleMs = opts.agentStaleMs ?? defaultAgentStaleMs
    const idleGraceMs = opts.idleGraceMs ?? defaultIdleGraceMs
    const settleGraceMs = opts.settleGraceMs ?? defaultSettleGraceMs
    const seedBytes = opts.seedBytes ?? defaultSeedBytes

    let transcript: Tail = { offset: 0, carry: '' }
    let openTools = new Map<string, LiveStatusTool>()
    let turnStartedAt = 0
    /** Tokens the MAIN transcript has spent since that prompt (DROVE-155). */
    let turnTokens = 0
    /** The same for every subagent that has written since that prompt (DROVE-184). */
    let turnAgentTokens = 0
    /** The main thread's THINKING share of `turnTokens` (DROVE-244). */
    let turnThinkingTokens = 0
    /** Both again for the whole session. No prompt resets these. */
    let sessionMainTokens = 0
    let sessionAgentTokens = 0
    /**
     * The session total split by model (DROVE-241), main and agents in ONE
     * map. The by-model question is "what did Opus cost me", not "what did
     * Opus cost me on the main thread", and keeping two maps would invite a
     * surface to add them up and get it wrong.
     */
    let sessionByModel = new Map<string, number>()
    /** One record's spend, filed under the model that spent it (DROVE-241). */
    const bankModel = (record: Record<string, unknown>, spent: number): void => {
        if (spent <= 0) return
        const model = modelOf(record)
        if (!model) return
        sessionByModel.set(model, (sessionByModel.get(model) ?? 0) + spent)
    }
    let lastRecordAt = 0
    let lastKind: RecordKind = 'other'
    let agents = new Map<string, AgentState>()
    /**
     * One workflow journal's ledger so far, keyed by the journal's path
     * (DROVE-268). Append-only on disk, so it is tailed from a remembered
     * offset like everything else here and the sets only ever grow.
     */
    let journals = new Map<string, JournalState>()
    /** A run's phase titles, read once off its script. An empty array is a cached miss. */
    let phaseNames = new Map<string, string[]>()

    const resetTranscript = () => {
        transcript = { offset: 0, carry: '' }
        openTools = new Map()
        turnStartedAt = 0
        turnTokens = 0
        turnAgentTokens = 0
        turnThinkingTokens = 0
        sessionMainTokens = 0
        sessionAgentTokens = 0
        sessionByModel = new Map()
        lastRecordAt = 0
        lastKind = 'other'
        agents = new Map()
        journals = new Map()
        phaseNames = new Map()
    }

    /** Fold the transcript's new lines into the open-tool set and turn state. */
    const pumpTranscript = (): void => {
        if (!sessionId) return
        const lines = readNewLines(join(projectDir, `${sessionId}.jsonl`), transcript, seedBytes)
        if (!lines) return
        for (const line of lines) {
            if (line.length === 0) continue
            let record: Record<string, unknown>
            try {
                record = JSON.parse(line) as Record<string, unknown>
            } catch {
                continue
            }
            // A subagent's own records are written into the parent transcript
            // too. They are the AGENT's tools, not the pane's, and counting
            // them here is what would make the header claim the main turn is
            // running six different things at once.
            if (record.isSidechain === true) continue
            const at = parseTimestamp(record.timestamp)
            if (at > 0) lastRecordAt = Math.max(lastRecordAt, at)

            // THE COMPACTION IS OVER, said by the transcript itself
            // (DROVE-257). Claude Code writes one `system` record with
            // `subtype: "compact_boundary"` when the pass lands, carrying
            // `compactMetadata` (trigger, preTokens, postTokens, durationMs).
            // Closing the latch HERE rather than on a hook is what makes the
            // end reliable: this reader is already tailing the file the
            // boundary is written into, so there is no second process to fail.
            if (record.type === 'system' && record.subtype === 'compact_boundary') {
                opts.compaction?.end(at || Date.now())
            }

            const kind = classify(record)
            if (kind !== 'other') lastKind = kind
            if (kind === 'prompt' && at > 0) {
                turnStartedAt = at
                // A new prompt is a new turn, so the count starts over. Without
                // this the row would show the whole session's spend and never
                // go back down, which is the stale reading the app refuses to
                // draw on an idle session.
                turnTokens = 0
                // The agents' share of the turn goes with it (DROVE-184). A
                // fan-out that outlives the turn keeps spending, and what it
                // spends AFTER the prompt lands on the new turn, which is the
                // reading that matches the clock beside it. The session totals
                // below are the ones that never go back down.
                turnAgentTokens = 0
                // And the thinking share with it (DROVE-244). It is a share of
                // `turnTokens`, so it has to start over at the same moment or
                // it would claim a previous turn's reasoning belongs to this
                // one's clock.
                turnThinkingTokens = 0
            }
            // The same three fields, through the same countTokens, that give an
            // agent card its "251.2k tokens" (DROVE-155) — the difference is
            // only which transcript they are read from. Sidechain records were
            // dropped above, so this is the main thread and nothing else.
            if (record.type === 'assistant') {
                const usage = usageOf(record)
                const spent = countTokens(usage)
                turnTokens += spent
                sessionMainTokens += spent
                bankModel(record, spent)
                // The SAME record, the same read, one field further in
                // (DROVE-244). Folded here rather than anywhere else so the
                // thinking count cannot drift from the total it is a share of:
                // there is one pass over the transcript and both numbers come
                // off it together.
                turnThinkingTokens += thinkingTokensOf(usage)
            }

            const message = record.message
            const content = message && typeof message === 'object'
                ? (message as Record<string, unknown>).content
                : undefined
            // Only real conversation records get a say in what is open. The
            // transcript is full of others — attachment, system, cost-state,
            // queue-operation, bridge-session — and they interleave with a
            // running tool, so treating them as progress would clear a tool
            // that is still going.
            const isConversation = record.type === 'user' || record.type === 'assistant'
            if (!isConversation || (typeof content !== 'string' && !Array.isArray(content))) continue

            // Does this record BELONG to the batch of tools we think is open?
            //
            // While a tool runs, Claude Code writes nothing else to the parent
            // transcript — it is blocked on the result — so a conversation
            // record that is neither another tool_use nor a result for one of
            // ours means the turn moved on and anything still open will never
            // be answered. That is not a hypothetical: Clay's live transcript
            // holds a `tool_use` for ToolSearch with no `tool_result` anywhere
            // in the file, and without this the app would have shown it as the
            // running tool with a timer counting up for the rest of the day.
            let belongs = false
            if (Array.isArray(content)) {
                for (const raw of content) {
                    const block = raw as Record<string, unknown> | null
                    if (!block || typeof block !== 'object') continue
                    if (block.type === 'tool_use' && typeof block.id === 'string') {
                        openTools.set(block.id, {
                            id: block.id,
                            name: typeof block.name === 'string' ? block.name : 'tool',
                            arg: describeToolArg(typeof block.name === 'string' ? block.name : '', block.input),
                            startedAt: at || Date.now(),
                        })
                        belongs = true
                    } else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
                        if (openTools.delete(block.tool_use_id)) {
                            // A sibling of the batch reporting in. The rest of
                            // a parallel fan-out is still running.
                            belongs = true
                        }
                    }
                }
            }
            if (!belongs) {
                openTools.clear()
            }
        }
    }

    /**
     * Read one agent's meta.json — the label, the tool_use that spawned it,
     * and the agent that spawned it (DROVE-185).
     *
     * `parentAgentId` is trimmed and dropped when empty, and dropped when it
     * names the agent itself, so a malformed file cannot hand the app a row
     * that is its own parent.
     *
     * THE DESCRIPTION AND THE TYPE COME BACK APART (DROVE-268), because they
     * sit on opposite sides of the prompt in the label order. A Task's
     * `description` is what Clay wrote and beats everything. `agentType` is a
     * category — `general-purpose`, `workflow-subagent` — and a workflow's
     * agents carry nothing else, so five of them collapsed onto one string and
     * drew five identical rows. It is now the LAST resort, under the prompt's
     * opening line, which at least says what each agent was sent to do.
     */
    const readAgentMeta = (path: string, id: string): { label?: string, agentType?: string, toolId?: string, parentId?: string } => {
        try {
            const meta = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
            const description = typeof meta.description === 'string' ? meta.description.trim() : ''
            const agentType = typeof meta.agentType === 'string' ? meta.agentType.trim() : ''
            const parent = typeof meta.parentAgentId === 'string' ? meta.parentAgentId.trim() : ''
            return {
                ...(description ? { label: description } : {}),
                ...(agentType ? { agentType } : {}),
                toolId: typeof meta.toolUseId === 'string' ? meta.toolUseId : undefined,
                ...(parent && parent !== id ? { parentId: parent } : {}),
            }
        } catch {
            return {}
        }
    }

    /**
     * Tail every agent transcript in a directory and report the live ones.
     *
     * `dir` is either the session's own `subagents/` (agents the pane launched
     * directly) or one workflow's `wf_<id>/`. Keyed by the full path so the two
     * never collide — a workflow agent and a direct agent can share an id
     * across sessions.
     */
    const pumpAgents = (dir: string, now: number, scope: AgentScope = {}): LiveStatusAgent[] => {
        let entries: string[]
        try {
            entries = readdirSync(dir)
        } catch {
            return []
        }
        const out: LiveStatusAgent[] = []
        for (const entry of entries) {
            if (!entry.startsWith('agent-') || !entry.endsWith('.jsonl')) continue
            const path = join(dir, entry)
            const id = entry.slice('agent-'.length, -'.jsonl'.length)
            let mtimeMs = 0
            try {
                mtimeMs = statSync(path).mtimeMs
            } catch {
                continue
            }
            // Only files that moved recently are worth reading at all. This is
            // the whole cost control: a session directory can hold hundreds of
            // finished agent transcripts and none of them will ever change
            // again.
            if (now - mtimeMs > agentStaleMs) {
                agents.delete(path)
                continue
            }
            let state = agents.get(path)
            if (!state) {
                const meta = readAgentMeta(join(dir, `agent-${id}.meta.json`), id)
                state = { tail: { offset: 0, carry: '' }, startedAt: 0, tokens: 0, mtimeMs, ...meta }
                agents.set(path, state)
            }
            state.mtimeMs = mtimeMs
            // Whole file, not a seeded tail: tokens are cumulative and the
            // start time is the first record, so there is nothing to skip.
            const lines = readNewLines(path, state.tail, 0)
            if (lines) {
                for (const line of lines) {
                    if (line.length === 0) continue
                    let record: Record<string, unknown>
                    try {
                        record = JSON.parse(line) as Record<string, unknown>
                    } catch {
                        continue
                    }
                    if (state.startedAt === 0) {
                        state.startedAt = parseTimestamp(record.timestamp)
                        // Record one is the prompt, and it is the only label a
                        // workflow's agent has (DROVE-268). Taken here rather
                        // than in a second pass because this is the one place
                        // that record is ever parsed, and only when meta.json
                        // gave nothing — a Task with a description keeps it and
                        // the pane's own agents read exactly as they did.
                        if (!state.label) {
                            state.prompt = promptLabel(record)
                            state.promptHead = promptHead(record)
                        }
                    }
                    // One addition, three buckets (DROVE-184). The card's
                    // cumulative count and the two tallies are made of the
                    // SAME `countTokens` call on the SAME record, so no sum on
                    // any surface can drift from another.
                    const spent = countTokens(usageOf(record))
                    state.tokens += spent
                    turnAgentTokens += spent
                    sessionAgentTokens += spent
                    bankModel(record, spent)
                }
            }
            out.push({
                id,
                // Description, then the prompt's opening line, then the type,
                // then the id (DROVE-268). The pane's own agents almost always
                // have a description and read exactly as they did; a
                // workflow's have none, and this is what stops five of them
                // sharing one string.
                label: state.distinctLabel ?? state.label ?? state.prompt ?? state.agentType ?? id,
                startedAt: state.startedAt || mtimeMs,
                ...(state.tokens > 0 ? { tokens: state.tokens } : {}),
                ...(state.toolId ? { toolId: state.toolId } : {}),
                ...(state.parentId ? { parentId: state.parentId } : {}),
                ...(scope.runId ? { runId: scope.runId } : {}),
            })
        }
        // Six rows reading `You are executing ONE item of…` are six prompts
        // cut at their common template prefix (DROVE-290). Repair collisions
        // among the PROMPT-LABELLED rows of this one directory — a run's
        // agents, or the pane's own — with the part of each prompt that
        // differs. Description-labelled rows are never touched.
        const colliding = new Map<string, number[]>()
        for (let i = 0; i < out.length; i++) {
            const state = agents.get(join(dir, `agent-${out[i].id}.jsonl`))
            if (!state || state.label || !state.promptHead || !state.prompt) continue
            // Grouped by the ORIGINAL prompt label, not the repaired one, so
            // an agent that was already repaired still anchors its group and a
            // newcomer with the same template joins it.
            const rows = colliding.get(state.prompt)
            if (rows) rows.push(i)
            else colliding.set(state.prompt, [i])
        }
        for (const rows of colliding.values()) {
            if (rows.length < 2) continue
            const states = rows.map((i) => agents.get(join(dir, `agent-${out[i].id}.jsonl`))!)
            const parts = distinguishingLabels(states.map((state) => state.promptHead!))
            for (let k = 0; k < rows.length; k++) {
                const state = states[k]
                if (!state.distinctLabel) {
                    // Computed once and held — see the field. The fallback
                    // numbers identical prompts instead of leaving them equal.
                    state.distinctLabel = parts[k] !== undefined
                        ? shorten(parts[k]!)
                        : shorten(`${out[rows[k]].label} #${k + 1}`)
                }
                out[rows[k]] = { ...out[rows[k]], label: state.distinctLabel }
            }
        }
        return out
    }

    /**
     * The workflow runs that still have work out, and the agents doing it.
     *
     * LIVENESS COMES OFF THE AGENTS, NOT THE JOURNAL, and that is the whole of
     * DROVE-268. This used to open with
     *
     *     if (now - statSync(journal).mtimeMs > agentStaleMs) continue
     *
     * which is a heartbeat read off a file that has no pulse. The journal gets
     * one line when an agent starts and one when it stops; between those a run
     * can go for hours writing nothing to it at all. Measured on Clay's live
     * session at the moment he asked why nothing was happening: two runs, one
     * with five agents whose transcripts had been written 0.9 seconds earlier
     * and one with an agent written 7 seconds earlier, both journals last
     * touched 467 and 458 seconds before — so both were skipped by that line
     * and the whole snapshot published `agents: 1, workflows: 0`. Eight agents
     * flat out, reported as nothing. The transcripts move continuously and are
     * already stat'd by `pumpAgents`, so they are the pulse and the journal is
     * only the ledger.
     *
     * `total` is what the run has LAUNCHED, not what it will eventually launch:
     * the journal is append-only and nothing on disk states the plan. The
     * terminal counts it the same way.
     *
     * The journal is TAILED rather than re-read, for the reason every other
     * file here is: it is append-only, and re-parsing it on every tick for
     * every run in a long session is the cost this module was written to
     * avoid.
     */
    const readWorkflows = (sessionDir: string, now: number, agentsOut: LiveStatusAgent[]): LiveStatusWorkflow[] => {
        const root = join(sessionDir, 'subagents', 'workflows')
        let entries: string[]
        try {
            entries = readdirSync(root)
        } catch {
            return []
        }
        const out: LiveStatusWorkflow[] = []
        for (const id of entries) {
            if (!id.startsWith('wf_')) continue
            const dir = join(root, id)
            const journal = join(dir, 'journal.jsonl')
            let state = journals.get(journal)
            if (!state) {
                let birth = 0
                try {
                    const st = statSync(journal)
                    birth = st.birthtimeMs || st.mtimeMs
                } catch {
                    continue
                }
                state = { tail: { offset: 0, carry: '' }, started: new Set(), done: new Set(), failed: new Set(), birth }
                journals.set(journal, state)
            }
            const lines = readNewLines(journal, state.tail, 0)
            if (lines === null) continue
            for (const line of lines) {
                if (line.length === 0) continue
                let record: Record<string, unknown>
                try {
                    record = JSON.parse(line) as Record<string, unknown>
                } catch {
                    continue
                }
                // `agentId` is the join to the transcripts and the id every
                // surface addresses an agent by; `key` is the workflow's own
                // content hash and is on every line too. Prefer the agentId
                // and fall back, so a run from a Claude Code that wrote only
                // the key still counts correctly even though its agents can
                // no longer be named.
                const who = typeof record.agentId === 'string' && record.agentId.length > 0
                    ? record.agentId
                    : (typeof record.key === 'string' ? record.key : null)
                if (!who) continue
                if (record.type === 'started') state.started.add(who)
                // FAILED IS SETTLED. Counting only `result` is what drew a run
                // of 5 started and 5 failed as `0/5` and one of 21 started, 1
                // result and 19 failed as `1/21` — both read as barely begun
                // when both were finished. They are kept apart rather than
                // merged because "4 done, 1 failed" and "5 done" are different
                // pieces of news.
                else if (record.type === 'result') state.done.add(who)
                else if (record.type === 'failed') state.failed.add(who)
            }
            if (state.started.size === 0) continue
            const running = pumpAgents(dir, now, { runId: id }).sort((a, b) => a.startedAt - b.startedAt)
            const settled = new Set([...state.done, ...state.failed])
            const live = new Set(running.map((agent) => agent.id))
            // Started, unsettled, and not writing: work this reader cannot
            // see. The number exists so no surface is tempted to derive
            // "running" as `total - done` and call ten dead agents busy.
            let quiet = 0
            for (const who of state.started) {
                if (!settled.has(who) && !live.has(who)) quiet += 1
            }
            // Nothing is writing and nothing is left to write: the run is over,
            // or it died. Either way it leaves the list, which is what makes a
            // finished workflow's agents disappear with it.
            if (running.length === 0 && settled.size + quiet >= state.started.size) continue
            const tokens = running.reduce((sum, a) => sum + (a.tokens ?? 0), 0)
            out.push({
                id,
                name: workflowNameOf(sessionDir, id),
                // The phase Claude Code shows for a running workflow is the
                // work in front of it, and the only live statement of that is
                // the label on the agent it is waiting for. The newest one,
                // because a fan-out leaves several running at once and the one
                // it started last is the one it has just moved on to.
                ...(running.length > 0 ? { phase: running[running.length - 1].label } : {}),
                done: state.done.size,
                ...(state.failed.size > 0 ? { failed: state.failed.size } : {}),
                running: running.length,
                ...(quiet > 0 ? { quiet } : {}),
                total: state.started.size,
                ...(running.length > 0 ? { agentIds: running.map((agent) => agent.id) } : {}),
                ...(phaseNamesOf(sessionDir, id).length > 0
                    ? { phaseNames: phaseNamesOf(sessionDir, id) }
                    : {}),
                startedAt: running.reduce((min, a) => (a.startedAt > 0 && a.startedAt < min ? a.startedAt : min), state.birth),
                ...(tokens > 0 ? { tokens } : {}),
            })
            // The agents go into the SESSION's one agent array, not into the
            // workflow (DROVE-268). Every count on every surface is taken off
            // that array, and an agent filed inside a workflow object is an
            // agent that stops being counted — the exact way these five went
            // missing in the first place.
            for (const agent of running) agentsOut.push(agent)
        }
        return out
    }

    /**
     * The phase titles this run declares, read once off its script and kept.
     *
     * The script is written at launch and never rewritten, so this is a
     * one-time read per run — and a miss is cached as a miss, so a run whose
     * script cannot be found does not re-scan the scripts directory on every
     * tick for the rest of the session.
     */
    const phaseNamesOf = (sessionDir: string, id: string): string[] => {
        const cached = phaseNames.get(id)
        if (cached) return cached
        let titles: string[] = []
        try {
            const dir = join(sessionDir, 'workflows', 'scripts')
            for (const file of readdirSync(dir)) {
                if (!file.includes(`-${id}.`)) continue
                titles = phaseNamesFromScript(readFileSync(join(dir, file), 'utf8'))
                break
            }
        } catch {
            // No scripts directory, or a script this build cannot read. The
            // run keeps its name and loses only the phase list.
        }
        phaseNames.set(id, titles)
        return titles
    }

    /** The workflow's name, from its run record when it exists and its script otherwise. */
    const workflowNameOf = (sessionDir: string, id: string): string => {
        try {
            const run = JSON.parse(readFileSync(join(sessionDir, 'workflows', `${id}.json`), 'utf8')) as Record<string, unknown>
            if (typeof run.workflowName === 'string' && run.workflowName.length > 0) {
                return run.workflowName
            }
        } catch {
            // Expected while the run is still going — see the file header.
        }
        try {
            for (const file of readdirSync(join(sessionDir, 'workflows', 'scripts'))) {
                if (file.includes(`-${id}.`)) return workflowNameFromScript(file)
            }
        } catch {
            // No scripts directory: an older Claude Code, or a workflow that
            // never wrote one. The id is still a name.
        }
        return id
    }

    return {
        read: (now = Date.now()): LiveStatus | null => {
            if (!sessionId) return null
            pumpTranscript()
            const sessionDir = join(projectDir, sessionId)
            // ONE array, the pane's own agents and every workflow's together
            // (DROVE-268). `readWorkflows` appends the running agents it finds,
            // each stamped with its `runId`, so `agents` is what "how much is
            // out" is counted from and a workflow row is a group header rather
            // than a worker.
            const agentRows = pumpAgents(join(sessionDir, 'subagents'), now)
            const workflows = readWorkflows(sessionDir, now, agentRows)
            const tool = openTools.size > 0 ? Array.from(openTools.values()).pop() : undefined

            const thinking = opts.isThinking?.() === true
            // The compaction pass, if one is open (DROVE-257). Read AFTER the
            // pump, so a boundary that landed in this very tick has already
            // closed the latch and the last snapshot of a compaction is the
            // one that drops it.
            const compacting = opts.compaction?.read(now) ?? null
            // How long the transcript may stay quiet before the turn is over.
            //
            // `assistant-text` is the only record kind that can END a turn — a
            // tool result means the model is about to be called again, a
            // prompt means it just was — so it gets the shorter window. It
            // still gets one: an assistant text block and the tool_use that
            // followed it were measured 4.1s apart in Clay's session, and
            // treating text as an immediate end flickers the strip off and
            // back on in the middle of a turn.
            const quietMs = lastKind === 'assistant-text' ? settleGraceMs : idleGraceMs
            const quiet = lastRecordAt === 0 || now - lastRecordAt > quietMs
            // What the MAIN thread is doing, decided without the agents
            // (DROVE-155). Blocked on a tool, an API call in flight, or the
            // transcript still moving. Six background agents out on their own
            // are NOT the main thread working, and the phone's dot means this
            // and only this.
            //
            // COMPACTING COUNTS AS WORKING, and it is the whole of DROVE-257.
            // The other three terms are all false for the length of a
            // compaction — no tool is open, the fd 3 fetch resolved at the
            // response headers two minutes ago, and the transcript has not
            // moved since before the pass began — so without this term the
            // most disruptive thing a session does is the one thing that looks
            // idle from outside.
            const mainWorking = !!tool || thinking || !quiet || !!compacting
            const moving = mainWorking || agentRows.length > 0 || workflows.length > 0
            if (!moving) {
                return null
            }
            const mainStartedAt = turnStartedAt > 0
                ? turnStartedAt
                : (tool?.startedAt ?? lastRecordAt)

            // The tally, published whether or not the MAIN thread is the thing
            // working (DROVE-184). A fan-out that outlives its turn leaves
            // `main` absent and nine agents burning, which is exactly the state
            // Clay was looking at when he asked where the number was, so the
            // block is keyed off the spend and not off `mainWorking`.
            const tokens: LiveStatusTokens = {
                turn: turnTokens + turnAgentTokens,
                turnMain: turnTokens,
                session: sessionMainTokens + sessionAgentTokens,
                sessionMain: sessionMainTokens,
                ...(sessionByModel.size > 0
                    ? { sessionByModel: Object.fromEntries(sessionByModel) }
                    : {}),
                // Omitted at zero rather than sent as 0 (DROVE-244), so an
                // absent field and a model that did no thinking read the same
                // on the phone, which is what they mean.
                ...(turnThinkingTokens > 0 ? { turnThinking: turnThinkingTokens } : {}),
            }

            return {
                at: now,
                ...(turnStartedAt > 0 ? { turnStartedAt } : {}),
                ...(tokens.session > 0 ? { tokens } : {}),
                ...(mainWorking && mainStartedAt > 0
                    ? {
                        main: {
                            startedAt: mainStartedAt,
                            ...(turnTokens > 0 ? { tokens: turnTokens } : {}),
                        },
                    }
                    : {}),
                ...(compacting ? { compacting } : {}),
                ...(tool ? { tool } : {}),
                ...(agentRows.length > 0
                    ? { agents: agentRows.sort((a, b) => a.startedAt - b.startedAt) }
                    : {}),
                ...(workflows.length > 0
                    ? { workflows: workflows.sort((a, b) => a.startedAt - b.startedAt) }
                    : {}),
            }
        },
        setProjectDir: (next: string) => {
            if (next === projectDir) return
            projectDir = next
            resetTranscript()
        },
        setSessionId: (next: string | null) => {
            if (next === sessionId) return
            sessionId = next
            resetTranscript()
        },
    }
}

/**
 * Writes `metadata.liveStatus` while something is running, and nothing at all
 * while the session is idle.
 *
 * A metadata write is not free — `updateMetadata` encrypts the whole record
 * and waits on a socket ack, serialized behind a lock — so three filters, not
 * one:
 *
 *  - DEDUPE. `at` is excluded from the comparison, so a snapshot where nothing
 *    actually moved is never published. That is what makes an idle or slow
 *    session cost nothing at all.
 *  - THROTTLE. At most one write per `minIntervalMs` (1s) when the WORK
 *    changed. The app does not need more: every duration on screen is computed
 *    from a `startedAt` that does not change, so its clocks tick between
 *    publishes and a long tool call needs no writes at all.
 *  - A SLOWER LANE FOR TOKEN COUNTS (`slowIntervalMs`, 2s). Token totals move
 *    on every response of the main thread and of every running agent, so with
 *    six agents out they are
 *    the only thing changing and they would pin the fast lane at one write a
 *    second for the whole fan-out. Nothing on screen jumps because of it: the
 *    counters are read at a glance and the elapsed clocks beside them still
 *    tick once a second locally.
 *
 * The busy -> idle edge publishes `null` once, immediately, skipping both
 * throttles. That single write is what makes the strip disappear; without it
 * the phone keeps a finished turn's timer running forever, which is the same
 * stale reading BASED-134's activity block had to solve at its own drop to
 * zero.
 */
export class LiveStatusPublisher {
    private readonly publish: (status: LiveStatus | null) => void
    private readonly minIntervalMs: number
    private readonly slowIntervalMs: number
    private readonly now: () => number
    /**
     * Negative infinity, not 0: the FIRST snapshot has to go out at once, and
     * a zero here makes the throttle measure it against the epoch, which in a
     * process whose clock is mocked from 0 means the first real reading is
     * held for a second.
     */
    private lastPublishedAt = Number.NEGATIVE_INFINITY
    private lastKey: string | null = null
    private lastShapeKey: string | null = null
    private timer: ReturnType<typeof setTimeout> | null = null
    private pending: LiveStatus | null = null

    constructor(
        publish: (status: LiveStatus | null) => void,
        opts?: { minIntervalMs?: number, slowIntervalMs?: number, now?: () => number },
    ) {
        this.publish = publish
        this.minIntervalMs = opts?.minIntervalMs ?? 1000
        this.slowIntervalMs = opts?.slowIntervalMs ?? 2000
        this.now = opts?.now ?? (() => Date.now())
    }

    /** Everything but `at`: the whole snapshot, for the dedupe. */
    private static key(status: LiveStatus): string {
        return JSON.stringify({ ...status, at: 0 })
    }

    /** The same thing with the token counts flattened out, for the fast lane. */
    private static shapeKey(status: LiveStatus): string {
        return JSON.stringify({
            ...status,
            at: 0,
            // The tally moves on every response of every agent, so leaving it
            // in here would pin the FAST lane for a whole fan-out and undo the
            // slow lane this class exists for (DROVE-184).
            tokens: undefined,
            main: status.main ? { ...status.main, tokens: 0 } : undefined,
            // The compaction's PRESENCE is a shape change and must go out at
            // once — it is the whole point of DROVE-257 — but its percentage
            // creeps every tick for a couple of minutes, and left in here it
            // would pin the fast lane for the length of the pass. Same
            // argument as the token counts above.
            compacting: status.compacting ? { ...status.compacting, percent: 0 } : undefined,
            agents: status.agents?.map((agent) => ({ ...agent, tokens: 0 })),
            workflows: status.workflows?.map((workflow) => ({ ...workflow, tokens: 0 })),
        })
    }

    sync(status: LiveStatus | null): void {
        const key = status ? LiveStatusPublisher.key(status) : null
        if (key === this.lastKey) {
            this.pending = null
            this.clearTimer()
            return
        }
        if (key === null || !status) {
            // Going idle. Immediately, and out of turn.
            this.clearTimer()
            this.pending = null
            this.lastKey = null
            this.lastShapeKey = null
            this.lastPublishedAt = this.now()
            this.publish(null)
            return
        }
        this.pending = status
        const shapeChanged = LiveStatusPublisher.shapeKey(status) !== this.lastShapeKey
        const interval = shapeChanged ? this.minIntervalMs : this.slowIntervalMs
        const wait = interval - (this.now() - this.lastPublishedAt)
        if (wait <= 0) {
            this.flush()
            return
        }
        // A pending timer is not rescheduled when the work CHANGES under it.
        // It was set for the longer wait at worst, and re-arming on every read
        // is how a snapshot that keeps changing never gets published at all.
        if (this.timer) return
        this.timer = setTimeout(() => {
            this.timer = null
            this.flush()
        }, wait)
        this.timer.unref?.()
    }

    flush(): void {
        this.clearTimer()
        const next = this.pending
        this.pending = null
        if (!next) return
        const key = LiveStatusPublisher.key(next)
        if (key === this.lastKey) return
        this.lastKey = key
        this.lastShapeKey = LiveStatusPublisher.shapeKey(next)
        this.lastPublishedAt = this.now()
        this.publish(next)
    }

    dispose(): void {
        this.clearTimer()
        this.pending = null
    }

    private clearTimer(): void {
        if (this.timer) {
            clearTimeout(this.timer)
            this.timer = null
        }
    }
}
