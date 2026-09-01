/**
 * The wave fold and its byte bound (DROVE-290).
 *
 * The fixture shapes are the measured ones: a journal line is
 * `{type, key, agentId}` and nothing else, and a run record's
 * `workflow_agent` entries carry label/phaseIndex/phaseTitle/state/queuedAt/
 * startedAt — the exact fields probe runs and the real mpo-component-waves
 * artifacts on Clay's machine carry.
 */
import { describe, expect, it } from 'vitest'

import {
    WORKFLOW_DETAIL_MAX_AGENTS,
    WORKFLOW_DETAIL_MAX_BYTES,
    WORKFLOW_UNATTRIBUTED_INDEX,
    boundWorkflowDetail,
    foldWorkflowDetail,
    utf8ByteLength,
    type WorkflowDetailInput,
    type WorkflowDetailResponse,
} from './workflowDetail'

function baseInput(overrides: Partial<WorkflowDetailInput>): WorkflowDetailInput {
    return {
        runId: 'wf_test-123',
        name: 'test-waves',
        phaseTitles: [],
        record: [],
        status: undefined,
        journal: [],
        live: [],
        now: 1_000_000,
        ...overrides,
    }
}

describe('foldWorkflowDetail, live run (journal only)', () => {
    const input = baseInput({
        phaseTitles: ['Wave0', 'Wave1', 'Judge'],
        journal: [
            { agentId: 'a1', settled: 'done' },
            { agentId: 'a2', settled: 'failed' },
            { agentId: 'a3', settled: null },
            { agentId: 'a4', settled: null },
        ],
        live: [
            { agentId: 'a3', running: true, startedAt: 900_000, label: 'the running one' },
            // a4 started per the journal and writes nothing: quiet, never running.
        ],
    })

    it('declares every scripted wave even with nothing attributed to it', () => {
        const detail = foldWorkflowDetail(input)
        if (!detail.ok) throw new Error(detail.reason)
        expect(detail.source).toBe('journal')
        expect(detail.waves.map((wave) => wave.title)).toEqual(['Wave0', 'Wave1', 'Judge', 'Unattributed'])
    })

    it('never guesses an agent into a phase: all four land unattributed', () => {
        const detail = foldWorkflowDetail(input)
        if (!detail.ok) throw new Error(detail.reason)
        const unattributed = detail.waves.find((wave) => wave.index === WORKFLOW_UNATTRIBUTED_INDEX)!
        expect(unattributed).toMatchObject({ done: 1, failed: 1, running: 1, quiet: 1, queued: 0 })
        const scripted = detail.waves.filter((wave) => wave.index !== WORKFLOW_UNATTRIBUTED_INDEX)
        for (const wave of scripted) {
            expect(wave.done + wave.failed + wave.running + wave.queued + wave.quiet).toBe(0)
        }
    })

    it('does not put the current marker on the unattributed bucket', () => {
        const detail = foldWorkflowDetail(input)
        if (!detail.ok) throw new Error(detail.reason)
        expect(detail.waves.every((wave) => wave.current !== true)).toBe(true)
    })

    it('lists the unattributed agents on request, failures first', () => {
        const detail = foldWorkflowDetail(input, WORKFLOW_UNATTRIBUTED_INDEX)
        if (!detail.ok) throw new Error(detail.reason)
        const bucket = detail.waves.find((wave) => wave.index === WORKFLOW_UNATTRIBUTED_INDEX)!
        expect(bucket.agents!.map((agent) => agent.state)).toEqual(['failed', 'running', 'quiet', 'done'])
        expect(bucket.agents!.find((agent) => agent.id === 'a3')!.label).toBe('the running one')
    })
})

describe('foldWorkflowDetail, recorded run', () => {
    const input = baseInput({
        phaseTitles: ['Wave0', 'Wave1', 'Wave2'],
        status: 'killed',
        record: [
            { agentId: 'r1', label: 'w0-a', phaseIndex: 1, state: 'done', startedAt: 100, endedAt: 200, tokens: 5 },
            { agentId: 'r2', label: 'w0-b', phaseIndex: 1, state: 'error', startedAt: 100 },
            { agentId: 'r3', label: 'w1-a', phaseIndex: 2, state: 'progress', startedAt: 300 },
            { agentId: 'r4', label: 'w1-b', phaseIndex: 2, state: 'progress', startedAt: 300 },
            // The 0/8 shape: planned, queued at the kill, never started.
            { label: 'w2-a', phaseIndex: 3, state: 'start', queuedAt: 400 },
        ],
        journal: [
            { agentId: 'r1', settled: 'done' },
            { agentId: 'r2', settled: 'failed' },
            // r3 settled AFTER the record was written: the journal wins.
            { agentId: 'r3', settled: 'done' },
            { agentId: 'r4', settled: null },
            // The resume launched an agent the record never heard of.
            { agentId: 'n1', settled: null },
        ],
        live: [
            { agentId: 'r4', running: true },
            { agentId: 'n1', running: true, label: 'resumed worker' },
        ],
    })

    it('attributes by phaseIndex and folds the three sources by recency', () => {
        const detail = foldWorkflowDetail(input)
        if (!detail.ok) throw new Error(detail.reason)
        expect(detail.source).toBe('record')
        expect(detail.status).toBe('killed')
        const [wave0, wave1, wave2, rest] = detail.waves
        expect(wave0).toMatchObject({ title: 'Wave0', done: 1, failed: 1, running: 0 })
        expect(wave1).toMatchObject({ title: 'Wave1', done: 1, running: 1 })
        expect(wave2).toMatchObject({ title: 'Wave2', queued: 1 })
        expect(rest).toMatchObject({ index: WORKFLOW_UNATTRIBUTED_INDEX, running: 1 })
    })

    it('marks the lowest wave still holding unsettled work as current', () => {
        const detail = foldWorkflowDetail(input)
        if (!detail.ok) throw new Error(detail.reason)
        expect(detail.waves.find((wave) => wave.current)!.title).toBe('Wave1')
    })

    it('prefers the record label and keeps the live label for resumed agents', () => {
        const detail = foldWorkflowDetail(input, WORKFLOW_UNATTRIBUTED_INDEX)
        if (!detail.ok) throw new Error(detail.reason)
        const bucket = detail.waves.find((wave) => wave.index === WORKFLOW_UNATTRIBUTED_INDEX)!
        expect(bucket.agents![0].label).toBe('resumed worker')
        const wave0 = foldWorkflowDetail(input, 1)
        if (!wave0.ok) throw new Error(wave0.reason)
        const labels = wave0.waves.find((wave) => wave.index === 1)!.agents!.map((agent) => agent.label)
        expect(labels.sort()).toEqual(['w0-a', 'w0-b'])
    })

    it('keeps a planned-but-never-started entry countable without a tappable id', () => {
        const detail = foldWorkflowDetail(input, 3)
        if (!detail.ok) throw new Error(detail.reason)
        const bucket = detail.waves.find((wave) => wave.index === 3)!
        expect(bucket.agents).toHaveLength(1)
        expect(bucket.agents![0]).toMatchObject({ id: '', state: 'queued', label: 'w2-a' })
    })

    it('caps a wave page and says how many rows it left out', () => {
        const wide = baseInput({
            phaseTitles: ['Wide'],
            record: Array.from({ length: WORKFLOW_DETAIL_MAX_AGENTS + 40 }, (_, i) => ({
                agentId: `a${i}`, label: `agent ${i}`, phaseIndex: 1, state: 'done' as const,
            })),
        })
        const detail = foldWorkflowDetail(wide, 1)
        if (!detail.ok) throw new Error(detail.reason)
        const bucket = detail.waves[0]
        expect(bucket.agents).toHaveLength(WORKFLOW_DETAIL_MAX_AGENTS)
        expect(bucket.elided).toBe(40)
        expect(bucket.done).toBe(WORKFLOW_DETAIL_MAX_AGENTS + 40)
    })
})

describe('boundWorkflowDetail', () => {
    function pageOf(agentCount: number, labelSize = 120): WorkflowDetailResponse {
        const input = baseInput({
            phaseTitles: ['Big'],
            record: Array.from({ length: agentCount }, (_, i) => ({
                agentId: `agent-${i}`,
                label: `${'x'.repeat(labelSize)} ${i}`,
                phaseIndex: 1,
                state: 'done' as const,
                startedAt: 1_000 + i,
                tokens: 40_000 + i,
            })),
        })
        return foldWorkflowDetail(input, 1)
    }

    it('leaves an in-budget answer alone', () => {
        const detail = pageOf(50)
        expect(boundWorkflowDetail(detail)).toBe(detail)
    })

    it('sheds rows until the serialized answer fits the budget', () => {
        const detail = pageOf(WORKFLOW_DETAIL_MAX_AGENTS, 400)
        const before = utf8ByteLength(JSON.stringify(detail))
        expect(before).toBeGreaterThan(WORKFLOW_DETAIL_MAX_BYTES)
        const bounded = boundWorkflowDetail(detail)
        expect(utf8ByteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(WORKFLOW_DETAIL_MAX_BYTES)
        if (!bounded.ok) throw new Error('bounded lost ok')
        const bucket = bounded.waves[0]
        // The counts never shrink, and every shed row is on the elided count.
        expect(bucket.done).toBe(WORKFLOW_DETAIL_MAX_AGENTS)
        expect(bucket.agents!.length + (bucket.elided ?? 0)).toBe(WORKFLOW_DETAIL_MAX_AGENTS)
        expect(bucket.agents!.length).toBeGreaterThan(0)
    })

    it('holds at any budget: rows go first, then the empty page itself', () => {
        // Mutation check for the bound: sweep budgets down to one where even
        // the counts-only shape cannot fit, and require the invariant at
        // every step — a response the bound could still shrink is never
        // returned over budget. Removing the loop, the shed, or the strip
        // fails one of these sizes.
        const detail = pageOf(80, 300)
        for (const budget of [32 * 1024, 8 * 1024, 2 * 1024, 512, 64]) {
            const bounded = boundWorkflowDetail(detail, budget)
            if (!bounded.ok) throw new Error('bounded lost ok')
            const size = utf8ByteLength(JSON.stringify(bounded))
            const shrinkable = bounded.waves.some((wave) => wave.agents !== undefined)
            if (size > budget) {
                // Only the irreducible counts-only shape may exceed a budget.
                expect(shrinkable).toBe(false)
            }
            expect(bounded.waves[0].done).toBe(80)
        }
    })

    it('the default budget clears DROVE-274\'s 64 KiB pipe with room', () => {
        expect(WORKFLOW_DETAIL_MAX_BYTES).toBeLessThanOrEqual(48 * 1024)
    })
})

describe('utf8ByteLength', () => {
    it('agrees with Buffer on ascii, multibyte and surrogate pairs', () => {
        for (const text of ['plain', 'wäve × phase', '🐮🚜', 'mixed 🐮 wäve']) {
            expect(utf8ByteLength(text)).toBe(Buffer.byteLength(text, 'utf8'))
        }
    })
})
