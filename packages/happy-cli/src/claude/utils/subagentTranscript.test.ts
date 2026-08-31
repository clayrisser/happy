import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createSubagentTranscriptReader, findSubagentTranscript } from './subagentTranscript'

/**
 * A subagent transcript shaped like the ones Claude Code writes: every record
 * `isSidechain: true` with an `agentId`, the prompt first as a string, one
 * assistant block per record, tool results as `user` records, attachments
 * interleaved, no result record. Read off Clay's live session before it was
 * copied here.
 */
const iso = (ms: number) => new Date(ms).toISOString()
const agentId = 'a55aa69f35f8e409e'
const toolUseId = 'toolu_01XsVTfXBcL1pN22LFM5wMvL'

const usage = { input_tokens: 2, output_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 9000 }

const agentRecord = (record: Record<string, unknown>) => JSON.stringify({
    isSidechain: true,
    agentId,
    userType: 'external',
    sessionId: 'sess',
    ...record,
})

const fixtureLines = [
    agentRecord({ type: 'user', uuid: 'u1', parentUuid: null, timestamp: iso(1000), message: { role: 'user', content: 'Implement DROVE-91 in the happy fork' } }),
    agentRecord({ type: 'attachment', uuid: 'att1', timestamp: iso(1001), attachment: { type: 'skill_listing', content: 'lots' } }),
    agentRecord({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: iso(2000), message: { role: 'assistant', model: 'claude-fable-5', content: [{ type: 'thinking', thinking: 'plan it', signature: 'CAQS8wQKEAgRGAI4' }], usage } }),
    agentRecord({ type: 'assistant', uuid: 'a2', parentUuid: 'a1', timestamp: iso(2100), message: { role: 'assistant', model: 'claude-fable-5', content: [{ type: 'text', text: 'Reading the ticket first.' }], usage } }),
    agentRecord({ type: 'assistant', uuid: 'a3', parentUuid: 'a2', timestamp: iso(2200), message: { role: 'assistant', model: 'claude-fable-5', content: [{ type: 'tool_use', id: 'toolu_bash1', name: 'Bash', input: { command: 'ls', description: 'List files' } }], usage } }),
    agentRecord({ type: 'user', uuid: 'u2', parentUuid: 'a3', timestamp: iso(3000), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_bash1', content: 'a.ts\nb.ts' }] }, toolUseResult: { stdout: 'a.ts\nb.ts' } }),
    agentRecord({ type: 'assistant', uuid: 'a4', parentUuid: 'u2', timestamp: iso(4000), message: { role: 'assistant', model: 'claude-fable-5', content: [{ type: 'text', text: 'Pushed as 55c43f95. Done.' }], usage } }),
]

const parentRecord = (record: Record<string, unknown>) => JSON.stringify({ isSidechain: false, sessionId: 'sess', ...record })

const parentLaunch = [
    parentRecord({ type: 'user', uuid: 'p1', timestamp: iso(500), message: { role: 'user', content: 'Ship DROVE-91' } }),
    parentRecord({ type: 'assistant', uuid: 'p2', timestamp: iso(900), message: { role: 'assistant', model: 'claude-fable-5', content: [{ type: 'tool_use', id: toolUseId, name: 'Agent', input: { description: 'DROVE-91 watch shows live transcript', prompt: 'Implement DROVE-91 in the happy fork', subagent_type: 'general-purpose' } }] } }),
    parentRecord({ type: 'user', uuid: 'p3', timestamp: iso(950), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: [{ type: 'text', text: `Async agent launched successfully. (internal)\nagentId: ${agentId}` }] }] }, toolUseResult: { isAsync: true, status: 'async_launched', agentId } }),
]

const notification = (status: string, at: number) => parentRecord({
    type: 'user',
    uuid: `n-${at}`,
    timestamp: iso(at),
    message: {
        role: 'user',
        content: `<task-notification>\n<task-id>${agentId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<output-file>/tmp/x/tasks/${agentId}.output</output-file>\n<status>${status}</status>\n<summary>Agent "DROVE-91 watch shows live transcript" finished</summary>\n<result>Pushed as 55c43f95. Done.</result>\n</task-notification>`,
    },
})

let root: string
let projectDir: string
const sessionId = 'sess'

beforeEach(() => {
    process.env.DROVER_URL = 'http://127.0.0.1:1'
    root = mkdtempSync(join(tmpdir(), 'subagent-transcript-'))
    projectDir = join(root, 'projects', '-Users-clay-repo')
    mkdirSync(join(projectDir, sessionId, 'subagents'), { recursive: true })
    writeFileSync(join(projectDir, `${sessionId}.jsonl`), parentLaunch.join('\n') + '\n')
    writeFileSync(join(projectDir, sessionId, 'subagents', `agent-${agentId}.jsonl`), fixtureLines.join('\n') + '\n')
    writeFileSync(
        join(projectDir, sessionId, 'subagents', `agent-${agentId}.meta.json`),
        JSON.stringify({ agentType: 'general-purpose', description: 'DROVE-91 watch shows live transcript', toolUseId, spawnDepth: 1 }),
    )
})

afterEach(() => {
    rmSync(root, { recursive: true, force: true })
})

function reader() {
    return createSubagentTranscriptReader({ getProjectDir: () => projectDir, getSessionId: () => sessionId })
}

describe('findSubagentTranscript', () => {
    it('finds a direct agent beside the session', () => {
        expect(findSubagentTranscript(projectDir, sessionId, agentId))
            .toBe(join(projectDir, sessionId, 'subagents', `agent-${agentId}.jsonl`))
    })

    it('finds a workflow agent one level deeper', () => {
        const wf = join(projectDir, sessionId, 'subagents', 'workflows', 'wf_35ef886a-960')
        mkdirSync(wf, { recursive: true })
        writeFileSync(join(wf, 'agent-a06a207b89ed7a9e0.jsonl'), fixtureLines[0] + '\n')
        expect(findSubagentTranscript(projectDir, sessionId, 'a06a207b89ed7a9e0')).toBe(join(wf, 'agent-a06a207b89ed7a9e0.jsonl'))
    })

    it('refuses anything that is not an agent id', () => {
        expect(findSubagentTranscript(projectDir, sessionId, '../../etc/passwd')).toBeNull()
        expect(findSubagentTranscript(projectDir, sessionId, '')).toBeNull()
    })
})

describe('createSubagentTranscriptReader', () => {
    it('reads the whole fixture from the top: prompt, thinking, text, tool pair, final text', () => {
        const response = reader().read({ agentId })
        expect(response.ok).toBe(true)
        if (!response.ok) return
        const kinds = response.rows.map((row) => {
            const content = (row.message as { content: unknown }).content
            if (typeof content === 'string') return 'prompt'
            return (content as { type: string }[]).map((b) => b.type).join('+')
        })
        expect(kinds).toEqual(['prompt', 'thinking', 'text', 'tool_use', 'tool_result', 'text'])
        // The attachment never travels.
        expect(response.rows.some((row) => row.type === 'attachment')).toBe(false)
        // Sidechain is off, or the app files it under a Task card.
        expect(response.rows.every((row) => row.isSidechain === false)).toBe(true)
        // The thinking signature is dead weight on the wire.
        const thinking = (response.rows[1].message as { content: Record<string, unknown>[] }).content[0]
        expect(thinking).toEqual({ type: 'thinking', thinking: 'plan it' })
        // The tool pair keeps the ids the app joins them on.
        const toolUse = (response.rows[3].message as { content: Record<string, unknown>[] }).content[0]
        expect(toolUse.id).toBe('toolu_bash1')
        const toolResult = (response.rows[4].message as { content: Record<string, unknown>[] }).content[0]
        expect(toolResult.tool_use_id).toBe('toolu_bash1')
        expect(response.cursor).toBe(Buffer.byteLength(fixtureLines.join('\n') + '\n', 'utf8'))
        expect(response.agent).toMatchObject({
            id: agentId,
            label: 'DROVE-91 watch shows live transcript',
            agentType: 'general-purpose',
            toolId: toolUseId,
            state: 'running',
        })
        expect(response.agent.updatedAt).toBeGreaterThan(0)
        expect(response.agent.endedAt).toBeUndefined()
    })

    it('a poll with the cursor gets only what was appended, and a half-written line waits', () => {
        const r = reader()
        const first = r.read({ agentId })
        expect(first.ok).toBe(true)
        if (!first.ok) return

        const again = r.read({ agentId, since: first.cursor })
        expect(again.ok && again.rows).toEqual([])
        expect(again.ok && again.cursor).toBe(first.cursor)

        const path = join(projectDir, sessionId, 'subagents', `agent-${agentId}.jsonl`)
        const next = agentRecord({ type: 'assistant', uuid: 'a5', parentUuid: 'a4', timestamp: iso(5000), message: { role: 'assistant', model: 'claude-fable-5', content: [{ type: 'text', text: 'One more thing.' }], usage } })
        appendFileSync(path, next + '\n')
        // Half of the next record, mid-write.
        appendFileSync(path, '{"type":"assistant","uuid":"a6"')

        const delta = r.read({ agentId, since: first.cursor })
        expect(delta.ok).toBe(true)
        if (!delta.ok) return
        expect(delta.rows).toHaveLength(1)
        expect(delta.rows[0].uuid).toBe('a5')
        expect(delta.cursor).toBe(first.cursor + Buffer.byteLength(next + '\n', 'utf8'))

        // The line completes; the cursor picks it up from where it started.
        appendFileSync(path, ',"message":{"role":"assistant","model":"m","content":[{"type":"text","text":"tail"}]},"timestamp":"' + iso(6000) + '"}\n')
        const rest = r.read({ agentId, since: delta.cursor })
        expect(rest.ok && rest.rows.map((row) => row.uuid)).toEqual(['a6'])
    })

    it('turns done when the parent transcript sees the task notification, and failed on any other status', () => {
        const r = reader()
        const running = r.read({ agentId })
        expect(running.ok && running.agent.state).toBe('running')

        appendFileSync(join(projectDir, `${sessionId}.jsonl`), notification('completed', 7000) + '\n')
        const done = r.read({ agentId, since: 10 })
        expect(done.ok).toBe(true)
        if (!done.ok) return
        expect(done.agent.state).toBe('done')
        expect(done.agent.endedAt).toBe(7000)
        expect(done.agent.result).toBe('Pushed as 55c43f95. Done.')

        appendFileSync(join(projectDir, `${sessionId}.jsonl`), notification('failed', 8000) + '\n')
        const failed = r.read({ agentId })
        expect(failed.ok && failed.agent.state).toBe('failed')
    })

    it('a synchronous Task ends when its tool_result lands', () => {
        const r = reader()
        appendFileSync(join(projectDir, `${sessionId}.jsonl`), parentRecord({
            type: 'user',
            uuid: 'p9',
            timestamp: iso(9000),
            message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: [{ type: 'text', text: 'Final report from the sync agent' }] }] },
        }) + '\n')
        const response = r.read({ agentId })
        expect(response.ok).toBe(true)
        if (!response.ok) return
        expect(response.agent.state).toBe('done')
        expect(response.agent.result).toBe('Final report from the sync agent')
        expect(response.agent.endedAt).toBe(9000)
    })

    it('says why when there is nothing to show', () => {
        const missing = reader().read({ agentId: 'a0000000000000000' })
        expect(missing).toMatchObject({ ok: false, reason: 'No transcript on disk for this agent', cursor: 0 })

        const bad = reader().read({ agentId: '../../x' })
        expect(bad).toMatchObject({ ok: false, reason: 'No such agent', cursor: 0 })

        const noSession = createSubagentTranscriptReader({ getProjectDir: () => projectDir, getSessionId: () => null }).read({ agentId })
        expect(noSession.ok).toBe(false)
    })

    it('keeps the result even when the transcript is gone', () => {
        appendFileSync(join(projectDir, `${sessionId}.jsonl`), notification('completed', 7000) + '\n')
        rmSync(join(projectDir, sessionId, 'subagents', `agent-${agentId}.jsonl`))
        const response = reader().read({ agentId })
        expect(response.ok).toBe(false)
        if (response.ok) return
        expect(response.agent).toMatchObject({ id: agentId, state: 'done', result: 'Pushed as 55c43f95. Done.' })
    })

    it('follows the scanner to another session', () => {
        let current = sessionId
        const r = createSubagentTranscriptReader({ getProjectDir: () => projectDir, getSessionId: () => current })
        expect(r.read({ agentId }).ok).toBe(true)
        current = 'other'
        expect(r.read({ agentId }).ok).toBe(false)
    })
})

/**
 * DROVE-211. The whole transcript in one answer is what killed the CLI's
 * socket: Socket.IO drops a frame over 1 MB and closes the connection that
 * sent it, so the phone never got an ack and told Clay his live machine was
 * out of reach. The reader pages instead.
 */
describe('a transcript bigger than one frame', () => {
    /** One record per 64 KB, so a handful of them clears the 512 KB page. */
    const fat = (n: number) => agentRecord({
        type: 'assistant',
        uuid: `fat${n}`,
        parentUuid: 'u1',
        timestamp: iso(5000 + n),
        message: { role: 'assistant', model: 'claude-fable-5', content: [{ type: 'text', text: 'x'.repeat(64 * 1024) }], usage },
    })

    const writeFat = (count: number) => {
        const lines = [fixtureLines[0], ...Array.from({ length: count }, (_, i) => fat(i))]
        writeFileSync(join(projectDir, sessionId, 'subagents', `agent-${agentId}.jsonl`), lines.join('\n') + '\n')
    }

    it('caps a page well under the frame limit and says there is more', () => {
        writeFat(40)
        const page = reader().read({ agentId })
        expect(page.ok).toBe(true)
        if (!page.ok) return
        expect(page.more).toBe(true)
        expect(JSON.stringify(page).length).toBeLessThan(700_000)
    })

    it('walks the whole file across pages, each row once', () => {
        writeFat(40)
        const r = reader()
        let since = 0
        let rows = 0
        let pages = 0
        for (;;) {
            const page = r.read({ agentId, since })
            expect(page.ok).toBe(true)
            if (!page.ok) break
            rows += page.rows.length
            since = page.cursor
            pages += 1
            if (!page.more) break
            expect(pages).toBeLessThan(20)
        }
        expect(pages).toBeGreaterThan(1)
        expect(rows).toBe(41)
        // The cursor landed on the end of the file, so the next poll is a
        // plain tail read rather than a re-read of everything.
        const tail = r.read({ agentId, since })
        expect(tail.ok).toBe(true)
        if (!tail.ok) return
        expect(tail.rows).toEqual([])
    })

    it('still answers a small transcript in one page', () => {
        const page = reader().read({ agentId })
        expect(page.ok).toBe(true)
        if (!page.ok) return
        expect(page.more).toBeUndefined()
        expect(page.rows).toHaveLength(6)
    })

    it('always moves the cursor, even past a record bigger than a page', () => {
        const huge = agentRecord({
            type: 'assistant',
            uuid: 'huge',
            parentUuid: 'u1',
            timestamp: iso(6000),
            message: { role: 'assistant', model: 'claude-fable-5', content: [{ type: 'text', text: 'y'.repeat(700 * 1024) }], usage },
        })
        writeFileSync(join(projectDir, sessionId, 'subagents', `agent-${agentId}.jsonl`), [huge, fixtureLines[6]].join('\n') + '\n')
        const first = reader().read({ agentId })
        expect(first.ok).toBe(true)
        if (!first.ok) return
        expect(first.cursor).toBeGreaterThan(0)
        expect(first.more).toBe(true)
    })

    it('restarts from the top when the file shrank below the cursor', () => {
        const page = reader().read({ agentId, since: 10_000_000 })
        expect(page.ok).toBe(true)
        if (!page.ok) return
        expect(page.rows).toHaveLength(6)
        expect(page.cursor).toBeGreaterThan(0)
    })
})
