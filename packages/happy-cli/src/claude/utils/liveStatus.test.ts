import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createCompactionLatch } from './compaction'
import {
    createLiveStatusReader,
    describeToolArg,
    LiveStatusPublisher,
    workflowNameFromScript,
    type LiveStatus,
} from './liveStatus'

beforeEach(() => {
    // Never let a unit test reach the real drover bus.
    process.env.DROVER_URL = 'http://127.0.0.1:1'
})

/**
 * A transcript shaped like the ones Claude Code actually writes.
 *
 * Every field here was read off Clay's live session before it was copied:
 * assistant content blocks arrive one record per block, a tool result comes
 * back as a `user` record carrying a `tool_result`, and the agent metadata
 * sidecar is `{agentType, description, toolUseId}`.
 */
const iso = (ms: number) => new Date(ms).toISOString()

const promptRecord = (at: number, text: string) => JSON.stringify({
    type: 'user',
    isSidechain: false,
    timestamp: iso(at),
    uuid: `u-${at}`,
    message: { role: 'user', content: text },
})

const toolUseRecord = (at: number, id: string, name: string, input: unknown) => JSON.stringify({
    type: 'assistant',
    isSidechain: false,
    timestamp: iso(at),
    uuid: `a-${at}`,
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
})

const toolResultRecord = (at: number, id: string) => JSON.stringify({
    type: 'user',
    isSidechain: false,
    timestamp: iso(at),
    uuid: `r-${at}`,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
})

/**
 * The record Claude Code writes when a compaction lands (DROVE-257).
 *
 * Copied field for field off Clay's own 2026-08-29 transcript, including the
 * `compactMetadata` block: `trigger: "auto"`, `preTokens: 1000254`,
 * `postTokens: 28835`, `durationMs: 126552`.
 */
const compactBoundaryRecord = (at: number) => JSON.stringify({
    type: 'system',
    subtype: 'compact_boundary',
    isSidechain: false,
    timestamp: iso(at),
    content: 'Conversation compacted',
    level: 'info',
    compactMetadata: {
        trigger: 'auto',
        preTokens: 1_000_254,
        postTokens: 28_835,
        durationMs: 126_552,
    },
})

const assistantTextRecord = (at: number, text: string) => JSON.stringify({
    type: 'assistant',
    isSidechain: false,
    timestamp: iso(at),
    uuid: `t-${at}`,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
})

/**
 * An assistant record on the MAIN transcript, carrying the turn's usage.
 *
 * `model` is optional and sits beside `usage` on `message`, exactly where
 * Claude Code writes it (DROVE-241). Left off, the record is what it always
 * was, which is why the DROVE-184 tally tests below still read a `tokens`
 * block with no split in it.
 */
const assistantUsageRecord = (at: number, usage: Record<string, number>, model?: string) => JSON.stringify({
    type: 'assistant',
    isSidechain: false,
    timestamp: iso(at),
    uuid: `au-${at}`,
    message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'thinking' }],
        usage,
        ...(model ? { model } : {}),
    },
})

/**
 * The same record with a thinking share on it (DROVE-244).
 *
 * `usage.output_tokens_details.thinking_tokens` is what the API returns and
 * Claude Code writes into the transcript verbatim. Measured across this
 * machine's transcripts: absent before 2026-08-11, present on 99% of records
 * from 2026-08-13. It is a SHARE of `output_tokens`, so the fixture keeps it
 * under that number the way a real one does.
 */
const thinkingUsageRecord = (at: number, usage: Record<string, number>, thinking: number) => JSON.stringify({
    type: 'assistant',
    isSidechain: false,
    timestamp: iso(at),
    uuid: `th-${at}`,
    message: {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: '', signature: 'sig' }],
        usage: { ...usage, output_tokens_details: { thinking_tokens: thinking } },
    },
})

const agentRecord = (at: number, usage?: Record<string, number>, model?: string) => JSON.stringify({
    type: usage ? 'assistant' : 'user',
    isSidechain: true,
    timestamp: iso(at),
    uuid: `g-${at}-${Math.random()}`,
    message: usage
        ? { role: 'assistant', content: [], usage, ...(model ? { model } : {}) }
        : { role: 'user', content: 'go' },
})

describe('describeToolArg', () => {
    it('prefers a Bash description over the command, because that is what the terminal shows', () => {
        expect(describeToolArg('Bash', { command: 'git status --porcelain', description: 'Show working tree status' }))
            .toBe('Show working tree status')
        expect(describeToolArg('Bash', { command: 'git status --porcelain' }))
            .toBe('git status --porcelain')
    })

    it('names the file a file tool is working on', () => {
        expect(describeToolArg('Edit', { file_path: '/tmp/a.ts', old_string: 'x', new_string: 'y' }))
            .toBe('/tmp/a.ts')
    })

    it('falls back to the first short string so an unknown MCP tool still says something', () => {
        expect(describeToolArg('mcp__thing__do', { widget: 'the blue one' })).toBe('the blue one')
    })

    it('collapses whitespace and truncates, so a multi-line command cannot wrap the header', () => {
        const arg = describeToolArg('Bash', { command: `echo one\n  echo two ${'x'.repeat(200)}` })
        expect(arg!.length).toBeLessThanOrEqual(64)
        expect(arg).not.toContain('\n')
        expect(arg!.endsWith('…')).toBe(true)
    })
})

describe('workflowNameFromScript', () => {
    it('strips the run id Claude Code appends to the script filename', () => {
        expect(workflowNameFromScript('/x/scripts/drover-close-out-wf_f7b09017-045.js')).toBe('drover-close-out')
    })

    it('leaves a script that carries no run id alone', () => {
        expect(workflowNameFromScript('/x/scripts/plain.js')).toBe('plain')
    })
})

describe('createLiveStatusReader', () => {
    let root: string
    let projectDir: string
    const sessionId = 'sess-1'
    let transcript: string
    let subagents: string

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'drove54-'))
        projectDir = join(root, 'projects', '-x')
        subagents = join(projectDir, sessionId, 'subagents')
        mkdirSync(subagents, { recursive: true })
        transcript = join(projectDir, `${sessionId}.jsonl`)
    })

    afterEach(() => {
        rmSync(root, { recursive: true, force: true })
    })

    const touch = (path: string, at: number) => {
        const seconds = at / 1000
        utimesSync(path, seconds, seconds)
    }

    /**
     * The fixture DROVE-54's acceptance criterion names: one running tool and
     * two agents, on disk, exactly as Claude Code lays them out.
     */
    const writeFixture = (now: number) => {
        writeFileSync(transcript, [
            promptRecord(now - 300_000, 'go and do the thing'),
            assistantTextRecord(now - 290_000, 'On it.'),
            toolUseRecord(now - 280_000, 'toolu_agent_a', 'Agent', { description: 'Un-drop thinking' }),
            toolResultRecord(now - 279_000, 'toolu_agent_a'),
            toolUseRecord(now - 275_000, 'toolu_agent_b', 'Agent', { description: 'Sweep the backlog' }),
            toolResultRecord(now - 274_000, 'toolu_agent_b'),
            toolUseRecord(now - 65_000, 'toolu_bash', 'Bash', {
                command: 'pnpm vitest run',
                description: 'Run the unit suite',
            }),
            '',
        ].join('\n'))

        writeFileSync(join(subagents, 'agent-a1.meta.json'), JSON.stringify({
            agentType: 'general-purpose',
            description: 'Un-drop thinking',
            toolUseId: 'toolu_agent_a',
        }))
        writeFileSync(join(subagents, 'agent-a1.jsonl'), [
            agentRecord(now - 280_000),
            agentRecord(now - 200_000, { input_tokens: 12, output_tokens: 30, cache_creation_input_tokens: 1958, cache_read_input_tokens: 240_000 }),
            '',
        ].join('\n'))

        writeFileSync(join(subagents, 'agent-a2.meta.json'), JSON.stringify({
            agentType: 'general-purpose',
            description: 'Sweep the backlog',
            toolUseId: 'toolu_agent_b',
        }))
        writeFileSync(join(subagents, 'agent-a2.jsonl'), [
            agentRecord(now - 275_000),
            agentRecord(now - 100_000, { input_tokens: 8, output_tokens: 42, cache_creation_input_tokens: 950 }),
            '',
        ].join('\n'))

        // An agent that finished long ago. Its transcript is still sitting in
        // the same directory, and a session directory can hold hundreds of
        // them — this is the one that must NOT be reported.
        writeFileSync(join(subagents, 'agent-old.meta.json'), JSON.stringify({ description: 'Yesterday' }))
        writeFileSync(join(subagents, 'agent-old.jsonl'), `${agentRecord(now - 86_400_000)}\n`)
        touch(join(subagents, 'agent-old.jsonl'), now - 86_400_000)

        touch(join(subagents, 'agent-a1.jsonl'), now - 5_000)
        touch(join(subagents, 'agent-a2.jsonl'), now - 5_000)
    }

    it('reads the running tool, its short argument and its start time off the transcript', () => {
        const now = Date.now()
        writeFixture(now)
        const status = createLiveStatusReader({ projectDir, sessionId }).read(now)
        expect(status).not.toBeNull()
        expect(status!.tool).toEqual({
            id: 'toolu_bash',
            name: 'Bash',
            arg: 'Run the unit suite',
            startedAt: now - 65_000,
        })
        // The elapsed clock the app draws is now minus this, so the snapshot
        // does not have to be republished for the timer to move.
        expect(status!.at - status!.tool!.startedAt).toBe(65_000)
    })

    it('reports both running agents with label, start and tokens, and drops the stale one', () => {
        const now = Date.now()
        writeFixture(now)
        const status = createLiveStatusReader({ projectDir, sessionId }).read(now)
        expect(status!.agents).toEqual([
            { id: 'a1', label: 'Un-drop thinking', startedAt: now - 280_000, tokens: 2000, toolId: 'toolu_agent_a' },
            { id: 'a2', label: 'Sweep the backlog', startedAt: now - 275_000, tokens: 1000, toolId: 'toolu_agent_b' },
        ])
    })

    it('takes the turn start from the last real prompt, not from a tool result', () => {
        const now = Date.now()
        writeFixture(now)
        const status = createLiveStatusReader({ projectDir, sessionId }).read(now)
        expect(status!.turnStartedAt).toBe(now - 300_000)
    })

    it('reports a running workflow with its name, phase and agents done out of launched', () => {
        const now = Date.now()
        writeFixture(now)
        const wf = join(subagents, 'workflows', 'wf_abc123-def')
        mkdirSync(wf, { recursive: true })
        mkdirSync(join(projectDir, sessionId, 'workflows', 'scripts'), { recursive: true })
        writeFileSync(join(projectDir, sessionId, 'workflows', 'scripts', 'drover-relaunch-wf_abc123-def.js'), '// script')
        writeFileSync(join(wf, 'journal.jsonl'), [
            JSON.stringify({ type: 'started', key: 'k1', agentId: 'w1' }),
            JSON.stringify({ type: 'started', key: 'k2', agentId: 'w2' }),
            JSON.stringify({ type: 'started', key: 'k3', agentId: 'w3' }),
            JSON.stringify({ type: 'result', key: 'k1', agentId: 'w1', result: {} }),
            '',
        ].join('\n'))
        writeFileSync(join(wf, 'agent-w3.meta.json'), JSON.stringify({ description: 'Implement the fix' }))
        writeFileSync(join(wf, 'agent-w3.jsonl'), [
            agentRecord(now - 60_000),
            agentRecord(now - 30_000, { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 4997 }),
            '',
        ].join('\n'))
        touch(join(wf, 'agent-w3.jsonl'), now - 2_000)
        touch(join(wf, 'journal.jsonl'), now - 2_000)

        const status = createLiveStatusReader({ projectDir, sessionId }).read(now)
        expect(status!.workflows).toEqual([{
            id: 'wf_abc123-def',
            name: 'drover-relaunch',
            phase: 'Implement the fix',
            done: 1,
            total: 3,
            startedAt: now - 60_000,
            tokens: 5000,
        }])
    })

    it('says nothing at all once the turn has ended', () => {
        const now = Date.now()
        writeFileSync(transcript, [
            promptRecord(now - 60_000, 'hello'),
            assistantTextRecord(now - 50_000, 'Done.'),
            '',
        ].join('\n'))
        expect(createLiveStatusReader({ projectDir, sessionId }).read(now)).toBeNull()
    })

    it('keeps the turn alive across the gap between an assistant text block and the tool that follows it', () => {
        // Measured in Clay's own session: text at 20:25:16.497, tool_use at
        // 20:25:20.616. Treating text as an immediate end flickers the strip.
        const now = Date.now()
        writeFileSync(transcript, [
            promptRecord(now - 60_000, 'hello'),
            assistantTextRecord(now - 4_100, 'Let me look.'),
            '',
        ].join('\n'))
        expect(createLiveStatusReader({ projectDir, sessionId }).read(now)).not.toBeNull()
    })

    it('stays busy while the model is composing, which writes nothing to disk', () => {
        const now = Date.now()
        writeFileSync(transcript, [
            promptRecord(now - 900_000, 'sketch it'),
            assistantTextRecord(now - 880_000, 'Thinking about it.'),
            '',
        ].join('\n'))
        const idle = createLiveStatusReader({ projectDir, sessionId }).read(now)
        expect(idle).toBeNull()
        const busy = createLiveStatusReader({ projectDir, sessionId, isThinking: () => true }).read(now)
        expect(busy!.turnStartedAt).toBe(now - 900_000)
    })

    /**
     * DROVE-257. The state Clay photographed: a terminal reading `Compacting
     * conversation… (1m 55s, 2.3k tokens)` over `100% context used`, and a
     * phone drawing a flat green dot beside three workers.
     *
     * The transcript below is the shape of his real one — the last record is
     * two minutes old and there is nothing after it, because Claude Code
     * writes nothing at all while it compacts.
     */
    describe('a compaction in flight', () => {
        it('is idle without the latch, which is the bug', () => {
            const now = Date.now()
            writeFileSync(transcript, [
                promptRecord(now - 900_000, 'go'),
                toolUseRecord(now - 132_000, 'toolu_a', 'Bash', { command: 'ls' }),
                toolResultRecord(now - 131_000, 'toolu_a'),
                '',
            ].join('\n'))
            // No tool open, nothing written for 131s, no fetch in flight.
            expect(createLiveStatusReader({ projectDir, sessionId }).read(now)).toBeNull()
        })

        it('is working, and says so, once PreCompact has opened the latch', () => {
            const now = Date.now()
            writeFileSync(transcript, [
                promptRecord(now - 900_000, 'go'),
                toolUseRecord(now - 132_000, 'toolu_a', 'Bash', { command: 'ls' }),
                toolResultRecord(now - 131_000, 'toolu_a'),
                '',
            ].join('\n'))
            const compaction = createCompactionLatch()
            compaction.begin('auto', now - 115_000)
            const status = createLiveStatusReader({ projectDir, sessionId, compaction }).read(now)
            expect(status).not.toBeNull()
            expect(status!.compacting).toEqual({ startedAt: now - 115_000, trigger: 'auto' })
            // And the main block is present, which is what the phone's dot
            // reads. Without it the app draws `connected`, in green.
            expect(status!.main).toBeTruthy()
        })

        it('lets go the moment the transcript writes its own compact_boundary', () => {
            const now = Date.now()
            writeFileSync(transcript, [
                promptRecord(now - 900_000, 'go'),
                toolResultRecord(now - 131_000, 'toolu_a'),
                '',
            ].join('\n'))
            const compaction = createCompactionLatch()
            compaction.begin('auto', now - 115_000)
            const reader = createLiveStatusReader({ projectDir, sessionId, compaction })
            expect(reader.read(now)!.compacting).toBeTruthy()
            appendFileSync(transcript, `${compactBoundaryRecord(now - 1_000)}\n`)
            // The purple goes at once.
            expect(reader.read(now)!.compacting).toBeUndefined()
            expect(compaction.read(now)).toBeNull()
            // And the session goes back to idle once the boundary record is
            // outside the ordinary idle grace, like any other write. This is
            // the half Clay asked for by name: the dot has to come BACK.
            expect(reader.read(now + 11_000)).toBeNull()
        })

        it('carries the pane percentage when something could read one', () => {
            const now = Date.now()
            writeFileSync(transcript, [promptRecord(now - 900_000, 'go'), ''].join('\n'))
            const compaction = createCompactionLatch()
            compaction.begin('manual', now - 40_000)
            compaction.progress(38)
            const status = createLiveStatusReader({ projectDir, sessionId, compaction }).read(now)
            expect(status!.compacting!.percent).toBe(38)
        })
    })

    it('picks up a tool started after the first read without re-reading the whole transcript', () => {
        const now = Date.now()
        writeFixture(now)
        const reader = createLiveStatusReader({ projectDir, sessionId })
        expect(reader.read(now)!.tool!.id).toBe('toolu_bash')
        appendFileSync(transcript, `${toolResultRecord(now - 1_000, 'toolu_bash')}\n`)
        appendFileSync(transcript, `${toolUseRecord(now - 500, 'toolu_read', 'Read', { file_path: '/tmp/next.ts' })}\n`)
        const after = reader.read(now)
        expect(after!.tool).toEqual({
            id: 'toolu_read',
            name: 'Read',
            arg: '/tmp/next.ts',
            startedAt: now - 500,
        })
    })

    /**
     * The main thread's own clock and tokens (DROVE-155). Clay: "Where is the
     * live token counter for the main thread as it's thinking".
     */
    it('reports the main thread\'s own start and the tokens the turn has spent', () => {
        const now = Date.now()
        writeFixture(now)
        const status = createLiveStatusReader({ projectDir, sessionId }).read(now)
        expect(status!.main).toEqual({ startedAt: now - 300_000 })
        appendFileSync(transcript, `${assistantUsageRecord(now - 2_000, {
            input_tokens: 12,
            output_tokens: 30,
            cache_creation_input_tokens: 1958,
            cache_read_input_tokens: 240_000,
        })}\n`)
        const reader = createLiveStatusReader({ projectDir, sessionId })
        // The same three fields an agent's count uses, and cache reads left
        // out of it for the same reason.
        expect(reader.read(now)!.main).toEqual({ startedAt: now - 300_000, tokens: 2000 })
    })

    it('starts the token count over on the next prompt, so the row never shows the last turn\'s', () => {
        const now = Date.now()
        writeFileSync(transcript, [
            promptRecord(now - 600_000, 'first'),
            assistantUsageRecord(now - 590_000, { input_tokens: 500_000, output_tokens: 0 }),
            assistantTextRecord(now - 580_000, 'Done.'),
            promptRecord(now - 60_000, 'second'),
            assistantUsageRecord(now - 4_000, { input_tokens: 40, output_tokens: 60 }),
            '',
        ].join('\n'))
        const status = createLiveStatusReader({ projectDir, sessionId }).read(now)
        expect(status!.main).toEqual({ startedAt: now - 60_000, tokens: 100 })
    })

    it('adds the main thread and both subagents into one tally (DROVE-184)', () => {
        const now = Date.now()
        writeFixture(now)
        // A main-transcript response ahead of the fixture's running tool, so
        // the tally has all three sources in it and the Bash call stays open.
        writeFileSync(transcript, [
            promptRecord(now - 300_000, 'go and do the thing'),
            toolUseRecord(now - 280_000, 'toolu_agent_a', 'Agent', { description: 'Un-drop thinking' }),
            toolResultRecord(now - 279_000, 'toolu_agent_a'),
            toolUseRecord(now - 275_000, 'toolu_agent_b', 'Agent', { description: 'Sweep the backlog' }),
            toolResultRecord(now - 274_000, 'toolu_agent_b'),
            assistantUsageRecord(now - 70_000, {
                input_tokens: 100,
                output_tokens: 400,
                cache_creation_input_tokens: 1500,
                cache_read_input_tokens: 900_000,
            }),
            toolUseRecord(now - 65_000, 'toolu_bash', 'Bash', { description: 'Run the unit suite' }),
            '',
        ].join('\n'))
        const status = createLiveStatusReader({ projectDir, sessionId }).read(now)!
        // 2000 and 1000 are the agents' own card numbers, unchanged.
        expect(status.agents!.map((agent) => agent.tokens)).toEqual([2000, 1000])
        expect(status.main!.tokens).toBe(2000)
        expect(status.tokens).toEqual({
            turn: 5000,
            turnMain: 2000,
            session: 5000,
            sessionMain: 2000,
        })
        // The tally IS the parts added up, not a second reading of them.
        const parts = status.main!.tokens! + status.agents!.reduce((sum, a) => sum + a.tokens!, 0)
        expect(status.tokens!.turn).toBe(parts)
    })

    it('keeps a finished subagent in the tally after its card is gone (DROVE-184)', () => {
        const now = Date.now()
        writeFixture(now)
        const reader = createLiveStatusReader({ projectDir, sessionId })
        expect(reader.read(now)!.tokens!.session).toBe(3000)

        // Both agents stop writing. 90s later they drop out of `agents[]` and
        // their cards go with them. What they SPENT does not: the question is
        // what the session has cost, and a finished agent's tokens are spent.
        touch(join(subagents, 'agent-a1.jsonl'), now - 200_000)
        touch(join(subagents, 'agent-a2.jsonl'), now - 200_000)
        const after = reader.read(now)!
        expect(after.agents).toBeUndefined()
        expect(after.tokens).toEqual({
            turn: 3000,
            turnMain: 0,
            session: 3000,
            sessionMain: 0,
        })
    })

    it('starts the turn tally over at a prompt and never the session one (DROVE-184)', () => {
        const now = Date.now()
        writeFileSync(transcript, [
            promptRecord(now - 600_000, 'first'),
            toolUseRecord(now - 590_000, 'toolu_agent_a', 'Agent', { description: 'Sweep' }),
            toolResultRecord(now - 589_000, 'toolu_agent_a'),
            assistantUsageRecord(now - 580_000, { input_tokens: 500_000, output_tokens: 0 }),
            '',
        ].join('\n'))
        writeFileSync(join(subagents, 'agent-a1.meta.json'), JSON.stringify({ description: 'Sweep' }))
        writeFileSync(join(subagents, 'agent-a1.jsonl'), [
            agentRecord(now - 585_000),
            agentRecord(now - 570_000, { input_tokens: 1000, output_tokens: 1000 }),
            '',
        ].join('\n'))
        touch(join(subagents, 'agent-a1.jsonl'), now - 5_000)

        const reader = createLiveStatusReader({ projectDir, sessionId })
        expect(reader.read(now)!.tokens).toEqual({
            turn: 502_000,
            turnMain: 500_000,
            session: 502_000,
            sessionMain: 500_000,
        })

        // A new prompt, and the agent launched by the LAST turn keeps writing.
        appendFileSync(transcript, [
            promptRecord(now - 60_000, 'second'),
            assistantUsageRecord(now - 4_000, { input_tokens: 40, output_tokens: 60 }),
            '',
        ].join('\n'))
        appendFileSync(join(subagents, 'agent-a1.jsonl'), `${agentRecord(now - 3_000, {
            input_tokens: 200,
            output_tokens: 300,
        })}\n`)
        touch(join(subagents, 'agent-a1.jsonl'), now - 1_000)

        // The turn holds only what has been spent SINCE the prompt, main and
        // fan-out alike, so the row's number goes back down with its clock.
        // The session total is the one that only ever rises.
        expect(reader.read(now)!.tokens).toEqual({
            turn: 600,
            turnMain: 100,
            session: 502_600,
            sessionMain: 500_100,
        })
    })

    it('splits the session total by the model that spent it, main and agents in one map (DROVE-241)', () => {
        const now = Date.now()
        writeFileSync(transcript, [
            promptRecord(now - 300_000, 'go'),
            toolUseRecord(now - 280_000, 'toolu_agent_a', 'Agent', { description: 'Sweep' }),
            toolResultRecord(now - 279_000, 'toolu_agent_a'),
            assistantUsageRecord(now - 70_000, { input_tokens: 1000, output_tokens: 500 }, 'claude-opus-5'),
            assistantUsageRecord(now - 60_000, { input_tokens: 200, output_tokens: 100 }, 'claude-fable-5'),
            toolUseRecord(now - 50_000, 'toolu_bash', 'Bash', { description: 'Run the suite' }),
            '',
        ].join('\n'))
        // A subagent on Sonnet, and a SECOND Opus record from inside it. The
        // split is one map across main and agents, so Opus's two sources land
        // in one bucket.
        writeFileSync(join(subagents, 'agent-a1.meta.json'), JSON.stringify({ description: 'Sweep' }))
        writeFileSync(join(subagents, 'agent-a1.jsonl'), [
            agentRecord(now - 275_000),
            agentRecord(now - 200_000, { input_tokens: 40, output_tokens: 60 }, 'claude-sonnet-5'),
            agentRecord(now - 190_000, { input_tokens: 300, output_tokens: 200 }, 'claude-opus-5'),
            // A PINNED id, which Claude Code writes alongside the bare ones:
            // `claude-haiku-4-5-20251001` appears 86 times across a night of
            // Clay's transcripts. It is its own bucket, verbatim.
            agentRecord(now - 185_000, { input_tokens: 30, output_tokens: 20 }, 'claude-haiku-4-5-20251001'),
            '',
        ].join('\n'))
        touch(join(subagents, 'agent-a1.jsonl'), now - 5_000)

        const tokens = createLiveStatusReader({ projectDir, sessionId }).read(now)!.tokens!
        expect(tokens.sessionByModel).toEqual({
            'claude-opus-5': 2000,
            'claude-fable-5': 300,
            'claude-sonnet-5': 100,
            'claude-haiku-4-5-20251001': 50,
        })
        // THE PARTS ARE THE WHOLE. Nothing is attributed twice and nothing
        // attributed is missing from the total, which is the property that
        // makes the breakdown worth drawing beside the number.
        const parts = Object.values(tokens.sessionByModel!).reduce((sum, n) => sum + n, 0)
        expect(parts).toBe(tokens.session)
    })

    it('counts an unattributed record into the total and out of the split (DROVE-241)', () => {
        const now = Date.now()
        writeFileSync(transcript, [
            promptRecord(now - 300_000, 'go'),
            assistantUsageRecord(now - 70_000, { input_tokens: 1000, output_tokens: 0 }, 'claude-opus-5'),
            // Claude Code's own composed record. It names no model, so it has
            // no bucket, but its spend is still spend.
            assistantUsageRecord(now - 60_000, { input_tokens: 7, output_tokens: 0 }, '<synthetic>'),
            // An older CLI's record, or a harness that writes no model at all.
            assistantUsageRecord(now - 50_000, { input_tokens: 11, output_tokens: 0 }),
            toolUseRecord(now - 40_000, 'toolu_bash', 'Bash', { description: 'Run the suite' }),
            '',
        ].join('\n'))
        const tokens = createLiveStatusReader({ projectDir, sessionId }).read(now)!.tokens!
        expect(tokens.session).toBe(1018)
        expect(tokens.sessionByModel).toEqual({ 'claude-opus-5': 1000 })
    })

    it('publishes no split at all when nothing named a model (DROVE-241)', () => {
        const now = Date.now()
        writeFixture(now)
        // Every fixture record predates the model field. The key is absent
        // rather than `{}`, so an app on the old schema sees exactly what it
        // saw before.
        expect(createLiveStatusReader({ projectDir, sessionId }).read(now)!.tokens)
            .toEqual({ turn: 3000, turnMain: 0, session: 3000, sessionMain: 0 })
    })

    it('leaves the main block out while only background agents are out (DROVE-155)', () => {
        const now = Date.now()
        // The turn ended long ago: no open tool, nothing thinking, the
        // transcript quiet. An agent it launched is still writing.
        writeFileSync(transcript, [
            promptRecord(now - 400_000, 'go'),
            toolUseRecord(now - 390_000, 'toolu_agent_a', 'Agent', { description: 'Sweep the backlog' }),
            toolResultRecord(now - 389_000, 'toolu_agent_a'),
            assistantTextRecord(now - 300_000, 'Launched it.'),
            '',
        ].join('\n'))
        writeFileSync(join(subagents, 'agent-a1.meta.json'), JSON.stringify({
            description: 'Sweep the backlog',
            toolUseId: 'toolu_agent_a',
        }))
        writeFileSync(join(subagents, 'agent-a1.jsonl'), [
            agentRecord(now - 380_000),
            agentRecord(now - 10_000, { input_tokens: 8, output_tokens: 42, cache_creation_input_tokens: 950 }),
            '',
        ].join('\n'))
        touch(join(subagents, 'agent-a1.jsonl'), now - 5_000)

        const status = createLiveStatusReader({ projectDir, sessionId }).read(now)
        expect(status!.agents).toHaveLength(1)
        // This is what keeps the phone's dot off: the pane is not idle, but
        // the MAIN thread is.
        expect(status!.main).toBeUndefined()
    })

    it('calls the main thread busy while the model composes, which writes nothing to disk', () => {
        const now = Date.now()
        writeFileSync(transcript, [
            promptRecord(now - 900_000, 'sketch it'),
            assistantTextRecord(now - 880_000, 'Thinking about it.'),
            '',
        ].join('\n'))
        const busy = createLiveStatusReader({ projectDir, sessionId, isThinking: () => true }).read(now)
        expect(busy!.main).toEqual({ startedAt: now - 900_000 })
    })

    it('ignores a subagent\'s own tool calls, which are written into the parent transcript too', () => {
        const now = Date.now()
        writeFileSync(transcript, [
            promptRecord(now - 60_000, 'go'),
            JSON.stringify({
                type: 'assistant',
                isSidechain: true,
                timestamp: iso(now - 5_000),
                uuid: 'side',
                message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_side', name: 'Grep', input: { pattern: 'x' } }] },
            }),
            '',
        ].join('\n'))
        const status = createLiveStatusReader({ projectDir, sessionId }).read(now)
        expect(status?.tool).toBeUndefined()
    })

    /**
     * Agents that spawn agents (DROVE-185).
     *
     * Clay: "what if a subagent has lanes in it? Can we visualize that?"
     *
     * The nesting was never a reporting gap: Claude Code files EVERY agent, at
     * every depth, in the one flat `subagents/` directory, so a grandchild was
     * always in this list. What was missing is which of them belongs to which,
     * and that is on disk too — `parentAgentId` in the sidecar, written from
     * spawnDepth 2 down and absent at depth 1. These fixtures are that layout:
     * a1 launched by the pane, a2 launched by a1, a3 launched by a2.
     */
    /**
     * THE THINKING SHARE OF THE TURN (DROVE-244).
     *
     * Clay: "When it's thinking instead of bashing on the main thread show the
     * thinking token count." Folded at the same `countTokens(usageOf(record))`
     * call the other totals come off, so there is one pass over the transcript
     * and the thinking count cannot drift from the number it is a share of.
     */
    describe('the thinking share (DROVE-244)', () => {
        it('folds the per-record figure the API already reports', () => {
            const now = Date.now()
            writeFileSync(transcript, [
                promptRecord(now - 300_000, 'go'),
                thinkingUsageRecord(now - 200_000, { input_tokens: 100, output_tokens: 4_000 }, 3_000),
                thinkingUsageRecord(now - 100_000, { input_tokens: 100, output_tokens: 900 }, 412),
                assistantTextRecord(now - 4_000, 'Done thinking.'),
                '',
            ].join('\n'))
            const tokens = createLiveStatusReader({ projectDir, sessionId }).read(now)!.tokens!
            expect(tokens.turnThinking).toBe(3_412)
            // A SHARE of the turn, never an addition to it: extended thinking
            // is billed inside output tokens, so it is already in turnMain.
            expect(tokens.turnMain).toBe(5_100)
            expect(tokens.turnThinking!).toBeLessThan(tokens.turnMain)
        })

        it('says nothing at all when no record reports one', () => {
            const now = Date.now()
            writeFileSync(transcript, [
                promptRecord(now - 300_000, 'go'),
                // An older Claude Code, or a model doing no extended thinking.
                // Both are honestly zero and both draw nothing on the strip, so
                // the field is omitted rather than sent as 0.
                assistantUsageRecord(now - 4_000, { input_tokens: 100, output_tokens: 900 }),
                '',
            ].join('\n'))
            const tokens = createLiveStatusReader({ projectDir, sessionId }).read(now)!.tokens!
            expect(tokens.turnThinking).toBeUndefined()
            expect(tokens.turnMain).toBe(1_000)
        })

        it('starts over at a prompt, with the turn it is a share of', () => {
            const now = Date.now()
            writeFileSync(transcript, [
                promptRecord(now - 600_000, 'first'),
                thinkingUsageRecord(now - 590_000, { input_tokens: 10, output_tokens: 9_000 }, 8_000),
                '',
            ].join('\n'))
            const reader = createLiveStatusReader({ projectDir, sessionId })
            // Read while that first turn is still moving; ten minutes later
            // the reader would call the session idle and publish nothing.
            expect(reader.read(now - 589_000)!.tokens!.turnThinking).toBe(8_000)

            appendFileSync(transcript, [
                promptRecord(now - 60_000, 'second'),
                thinkingUsageRecord(now - 4_000, { input_tokens: 10, output_tokens: 500 }, 120),
                '',
            ].join('\n'))
            // The new turn's own reasoning, not the last one's carried over.
            const after = reader.read(now)!.tokens!
            expect(after.turnThinking).toBe(120)
            expect(after.sessionMain).toBe(9_520)
        })

        it('ignores a subagent\'s thinking, because the word is about the main thread', () => {
            const now = Date.now()
            writeFileSync(transcript, [
                promptRecord(now - 300_000, 'go'),
                thinkingUsageRecord(now - 200_000, { input_tokens: 10, output_tokens: 900 }, 500),
                '',
            ].join('\n'))
            writeFileSync(join(subagents, 'agent-a1.meta.json'), JSON.stringify({ description: 'Sweep' }))
            writeFileSync(join(subagents, 'agent-a1.jsonl'), [
                agentRecord(now - 250_000),
                // Sidechain records are dropped from the main pass anyway, and
                // an agent's own transcript is read by a different loop that
                // never touches this counter.
                thinkingUsageRecord(now - 100_000, { input_tokens: 10, output_tokens: 50_000 }, 40_000),
                '',
            ].join('\n'))
            touch(join(subagents, 'agent-a1.jsonl'), now - 1_000)
            expect(createLiveStatusReader({ projectDir, sessionId }).read(now)!.tokens!.turnThinking)
                .toBe(500)
        })
    })

    describe('nesting', () => {
        const writeAgent = (id: string, now: number, meta: Record<string, unknown>) => {
            writeFileSync(join(subagents, `agent-${id}.meta.json`), JSON.stringify(meta))
            writeFileSync(join(subagents, `agent-${id}.jsonl`), `${agentRecord(now - 60_000)}\n`)
            touch(join(subagents, `agent-${id}.jsonl`), now - 5_000)
        }

        const readAgents = (now: number) => {
            writeFileSync(transcript, `${promptRecord(now - 120_000, 'go')}\n`)
            const status = createLiveStatusReader({ projectDir, sessionId }).read(now)
            return status?.agents ?? []
        }

        it('publishes the parent link two levels down, and none at the top', () => {
            const now = Date.now()
            writeAgent('a1', now, { description: 'Top', toolUseId: 'toolu_1', spawnDepth: 1 })
            writeAgent('a2', now, { description: 'Child', toolUseId: 'toolu_2', spawnDepth: 2, parentAgentId: 'a1' })
            writeAgent('a3', now, { description: 'Grandchild', toolUseId: 'toolu_3', spawnDepth: 3, parentAgentId: 'a2' })

            const byId = new Map(readAgents(now).map((agent) => [agent.id, agent]))
            expect(byId.size).toBe(3)
            // Absence IS "the pane launched it". There is no depth on the wire.
            expect(byId.get('a1')!.parentId).toBeUndefined()
            expect(byId.get('a2')!.parentId).toBe('a1')
            expect(byId.get('a3')!.parentId).toBe('a2')
        })

        it('still reports a nested agent, which is what it always did', () => {
            const now = Date.now()
            writeAgent('a1', now, { description: 'Top', spawnDepth: 1 })
            writeAgent('a2', now, { description: 'Child', spawnDepth: 2, parentAgentId: 'a1' })
            // The count is the point: nesting must not shrink the fan-out the
            // status row and the wrist are both reading off this array.
            expect(readAgents(now)).toHaveLength(2)
        })

        it('drops a parent link that names the agent itself', () => {
            const now = Date.now()
            writeAgent('a1', now, { description: 'Top', spawnDepth: 2, parentAgentId: 'a1' })
            expect(readAgents(now)[0].parentId).toBeUndefined()
        })

        it('sends no parent link when the sidecar has none', () => {
            const now = Date.now()
            writeAgent('a1', now, { description: 'Top', toolUseId: 'toolu_1' })
            const agent = readAgents(now)[0]
            expect(agent.parentId).toBeUndefined()
            expect(agent.label).toBe('Top')
        })
    })
})

describe('LiveStatusPublisher', () => {
    const status = (at: number, toolStartedAt: number): LiveStatus => ({
        at,
        turnStartedAt: 1,
        tool: { id: 't', name: 'Bash', startedAt: toolStartedAt },
    })

    it('publishes at most once a second while work is running', () => {
        const seen: Array<LiveStatus | null> = []
        let clock = 10_000
        const publisher = new LiveStatusPublisher((s) => seen.push(s), { now: () => clock })

        publisher.sync(status(clock, 1))
        expect(seen).toHaveLength(1)

        // Nine more reads inside the same second, each one genuinely different.
        for (let i = 1; i <= 9; i++) {
            clock += 100
            publisher.sync(status(clock, 1 + i))
        }
        expect(seen).toHaveLength(1)

        clock += 100
        publisher.flush()
        expect(seen).toHaveLength(2)
        expect((seen[1] as LiveStatus).tool!.startedAt).toBe(10)
    })

    it('publishes nothing at all when the snapshot has not actually moved', () => {
        const seen: Array<LiveStatus | null> = []
        let clock = 0
        const publisher = new LiveStatusPublisher((s) => seen.push(s), { now: () => clock })
        publisher.sync(status(clock, 5))
        expect(seen).toHaveLength(1)
        // Same work, later snapshot. `at` moved and nothing else did, and the
        // app computes every duration from `startedAt`, so this is a write
        // that would tell the phone nothing.
        clock += 60_000
        publisher.sync(status(clock, 5))
        expect(seen).toHaveLength(1)
    })

    it('holds a token-only change to the slower lane, so six running agents cannot pin the socket', () => {
        const seen: Array<LiveStatus | null> = []
        let clock = 10_000
        const withTokens = (tokens: number): LiveStatus => ({
            at: clock,
            turnStartedAt: 1,
            agents: [{ id: 'a1', label: 'one', startedAt: 1, tokens }],
        })
        const publisher = new LiveStatusPublisher((s) => seen.push(s), { now: () => clock })

        publisher.sync(withTokens(1_000))
        expect(seen).toHaveLength(1)

        // A second later the only thing that moved is the token count. The
        // fast lane would take it; the slow one does not.
        clock += 1_100
        publisher.sync(withTokens(2_000))
        expect(seen).toHaveLength(1)

        clock += 1_000
        publisher.sync(withTokens(3_000))
        expect(seen).toHaveLength(2)
        expect((seen[1] as LiveStatus).agents![0].tokens).toBe(3_000)
    })

    it('takes a change in the WORK straight away, on the fast lane', () => {
        const seen: Array<LiveStatus | null> = []
        let clock = 10_000
        const publisher = new LiveStatusPublisher((s) => seen.push(s), { now: () => clock })
        publisher.sync(status(clock, 5))
        expect(seen).toHaveLength(1)

        // A new tool is not a token count. It goes out on the 1s lane.
        clock += 1_100
        publisher.sync({ at: clock, turnStartedAt: 1, tool: { id: 't2', name: 'Read', startedAt: clock } })
        expect(seen).toHaveLength(2)
        expect((seen[1] as LiveStatus).tool!.name).toBe('Read')
    })

    it('publishes nothing while the session is idle, and clears once on the way there', () => {
        const seen: Array<LiveStatus | null> = []
        let clock = 0
        const publisher = new LiveStatusPublisher((s) => seen.push(s), { now: () => clock })
        publisher.sync(null)
        expect(seen).toHaveLength(0)

        clock += 5_000
        publisher.sync(status(clock, 5))
        expect(seen).toHaveLength(1)

        // Turn ends. One clearing write, immediately, ahead of the throttle —
        // otherwise a finished turn's timer runs on the phone forever.
        clock += 10
        publisher.sync(null)
        expect(seen).toHaveLength(2)
        expect(seen[1]).toBeNull()

        for (let i = 0; i < 20; i++) {
            clock += 1_000
            publisher.sync(null)
        }
        expect(seen).toHaveLength(2)
    })
})
