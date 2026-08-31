import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

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

const assistantTextRecord = (at: number, text: string) => JSON.stringify({
    type: 'assistant',
    isSidechain: false,
    timestamp: iso(at),
    uuid: `t-${at}`,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
})

/** An assistant record on the MAIN transcript, carrying the turn's usage. */
const assistantUsageRecord = (at: number, usage: Record<string, number>) => JSON.stringify({
    type: 'assistant',
    isSidechain: false,
    timestamp: iso(at),
    uuid: `au-${at}`,
    message: { role: 'assistant', content: [{ type: 'text', text: 'thinking' }], usage },
})

const agentRecord = (at: number, usage?: Record<string, number>) => JSON.stringify({
    type: usage ? 'assistant' : 'user',
    isSidechain: true,
    timestamp: iso(at),
    uuid: `g-${at}-${Math.random()}`,
    message: usage ? { role: 'assistant', content: [], usage } : { role: 'user', content: 'go' },
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
