/**
 * The wave reader against the disk layout harness 2.1.252 actually writes
 * (DROVE-290). Every fixture shape below is copied from real artifacts on
 * Clay's machine: probe runs whose journals were polled live, and the
 * 60-agent mpo-component-waves run the ticket's screenshots show.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { WORKFLOW_UNATTRIBUTED_INDEX } from '@slopus/happy-wire'

import { createWorkflowDetailReader } from './workflowDetail'

const iso = (ms: number) => new Date(ms).toISOString()

describe('createWorkflowDetailReader', () => {
    let root: string
    let projectDir: string
    const sessionId = 'sess-wf'
    const runId = 'wf_abc123-def'

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'drove290-detail-'))
        projectDir = join(root, 'projects', '-x')
        mkdirSync(join(projectDir, sessionId, 'subagents', 'workflows', runId), { recursive: true })
        mkdirSync(join(projectDir, sessionId, 'workflows', 'scripts'), { recursive: true })
    })

    afterEach(() => {
        rmSync(root, { recursive: true, force: true })
    })

    const reader = () => createWorkflowDetailReader({
        getProjectDir: () => projectDir,
        getSessionId: () => sessionId,
    })

    const runDir = () => join(projectDir, sessionId, 'subagents', 'workflows', runId)

    const touch = (path: string, at: number) => {
        utimesSync(path, at / 1000, at / 1000)
    }

    const journalLine = (type: string, agentId: string) =>
        `${JSON.stringify({ type, key: `v2:${agentId}`, agentId })}\n`

    const agentTranscript = (agentId: string, at: number, prompt: string) => {
        const path = join(runDir(), `agent-${agentId}.jsonl`)
        writeFileSync(path, `${JSON.stringify({
            type: 'user', isSidechain: true, timestamp: iso(at), uuid: `p-${agentId}`,
            message: { role: 'user', content: prompt },
        })}\n`)
        touch(path, at)
    }

    const script = (phases: string[]) => {
        writeFileSync(
            join(projectDir, sessionId, 'workflows', 'scripts', `my-waves-${runId}.js`),
            `export const meta = {\n  name: 'my-waves',\n  phases: [\n${phases.map((title) => `    { title: '${title}' },\n`).join('')}  ],\n}\n`,
        )
    }

    it('refuses a runId that is not a workflow directory name', () => {
        expect(reader().read({ runId: '../escape' })).toEqual({ ok: false, reason: 'No such workflow run' })
    })

    it('says so when nothing on disk knows the run', () => {
        const detail = reader().read({ runId: 'wf_nothing-000' })
        expect(detail).toEqual({ ok: false, reason: 'Nothing on disk for this workflow run' })
    })

    it('folds a LIVE run from journal, transcripts and script — every agent unattributed', () => {
        const now = Date.now()
        script(['Wave0', 'Wave1', 'Judge'])
        writeFileSync(join(runDir(), 'journal.jsonl'),
            journalLine('started', 'a1') + journalLine('started', 'a2') + journalLine('result', 'a1'))
        agentTranscript('a2', now - 5_000, 'Audit the docker directory for convention breaks.')

        const detail = reader().read({ runId })
        if (!detail.ok) throw new Error(detail.reason)
        expect(detail.source).toBe('journal')
        expect(detail.name).toBe('my-waves')
        expect(detail.waves.map((wave) => wave.title)).toEqual(['Wave0', 'Wave1', 'Judge', 'Unattributed'])
        const unattributed = detail.waves[3]
        expect(unattributed).toMatchObject({ done: 1, running: 1, failed: 0, quiet: 0 })
    })

    it('serves one wave\'s agents on request with labels off the transcripts', () => {
        const now = Date.now()
        script(['Wave0'])
        writeFileSync(join(runDir(), 'journal.jsonl'),
            journalLine('started', 'a1') + journalLine('failed', 'a1') + journalLine('started', 'a2'))
        agentTranscript('a2', now - 2_000, 'Verify the login flow end to end.')

        const detail = reader().read({ runId, wave: WORKFLOW_UNATTRIBUTED_INDEX })
        if (!detail.ok) throw new Error(detail.reason)
        const bucket = detail.waves.find((wave) => wave.index === WORKFLOW_UNATTRIBUTED_INDEX)!
        expect(bucket.agents!.map((agent) => `${agent.state}:${agent.label}`)).toEqual([
            'failed:a1',
            'running:Verify the login flow end to end.',
        ])
    })

    it('attributes waves from a kill\'s run record and keeps the resume\'s new agents honest', () => {
        const now = Date.now()
        // The record a kill writes, field for field like wf_1076cb15-c7c.json
        // (mpo-component-waves): phases, and workflowProgress rows with
        // phaseIndex/phaseTitle/state/queuedAt/startedAt.
        writeFileSync(join(projectDir, sessionId, 'workflows', `${runId}.json`), JSON.stringify({
            runId,
            workflowName: 'mpo-component-waves',
            status: 'killed',
            phases: [{ title: 'Wave0' }, { title: 'Wave1' }],
            workflowProgress: [
                { type: 'workflow_phase', index: 1, title: 'Wave0' },
                { type: 'workflow_phase', index: 2, title: 'Wave1' },
                { type: 'workflow_agent', index: 1, label: 'w0-a', phaseIndex: 1, phaseTitle: 'Wave0', agentId: 'r1', state: 'done', queuedAt: 1, startedAt: 2, durationMs: 100, tokens: 60_110 },
                { type: 'workflow_agent', index: 2, label: 'w1-a', phaseIndex: 2, phaseTitle: 'Wave1', agentId: 'r2', state: 'progress', queuedAt: 1, startedAt: 3 },
                { type: 'workflow_agent', index: 3, label: 'w1-b', phaseIndex: 2, phaseTitle: 'Wave1', state: 'start', queuedAt: 4 },
            ],
        }))
        // The journal carries on across the resume: r2 settled after the kill,
        // and the resume launched n1, which the record never heard of.
        writeFileSync(join(runDir(), 'journal.jsonl'),
            journalLine('started', 'r1') + journalLine('result', 'r1')
            + journalLine('started', 'r2') + journalLine('failed', 'r2')
            + journalLine('started', 'n1'))
        agentTranscript('n1', now - 3_000, 'Redo the storybook item.')

        const detail = reader().read({ runId })
        if (!detail.ok) throw new Error(detail.reason)
        expect(detail.source).toBe('record')
        expect(detail.status).toBe('killed')
        expect(detail.name).toBe('mpo-component-waves')
        const [wave0, wave1, rest] = detail.waves
        expect(wave0).toMatchObject({ title: 'Wave0', done: 1 })
        // r2: the record said progress at the kill; the journal has since said
        // failed, and the journal is current, so failed it is.
        expect(wave1).toMatchObject({ title: 'Wave1', failed: 1, queued: 1, current: true })
        expect(rest).toMatchObject({ index: WORKFLOW_UNATTRIBUTED_INDEX, running: 1 })
    })

    it('follows the journal as it grows between polls', () => {
        script(['Wave0'])
        const journal = join(runDir(), 'journal.jsonl')
        writeFileSync(journal, journalLine('started', 'a1'))
        const shared = reader()
        const first = shared.read({ runId })
        if (!first.ok) throw new Error(first.reason)
        expect(first.waves.find((wave) => wave.index === WORKFLOW_UNATTRIBUTED_INDEX)).toMatchObject({ quiet: 1 })

        appendFileSync(journal, journalLine('result', 'a1'))
        const second = shared.read({ runId })
        if (!second.ok) throw new Error(second.reason)
        expect(second.waves.find((wave) => wave.index === WORKFLOW_UNATTRIBUTED_INDEX)).toMatchObject({ done: 1, quiet: 0 })
    })
})
