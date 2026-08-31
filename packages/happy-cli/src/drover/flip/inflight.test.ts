/**
 * Counting the subagents a SIGTERM would take with it (BASED-135).
 *
 * The fixtures below are the real record shapes, copied out of
 * ~/.claude/projects rather than invented: a launch is a `user` record whose
 * tool_result text opens "Async agent launched successfully", and a completion
 * is a `queue-operation` (or, when it is delivered as its own turn, a `user`)
 * record holding a <task-notification> block. Getting either shape wrong is
 * the whole failure mode, so they are pinned here.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { InFlightTracker, describeInFlight, emptyInFlight } from './inflight'

/** The tool_result Claude Code writes ~19ms after an async Agent call. */
function launchRecord(id: string, opts: { description?: string; output?: string } = {}) {
    const output =
        opts.output ?? `/private/tmp/claude-501/-Users-clay-project/sess-1/tasks/${id}.output`
    return {
        parentUuid: 'adda00f0-15c4-4e40-ba02-2af3ffe848f9',
        isSidechain: false,
        type: 'user',
        message: {
            role: 'user',
            content: [
                {
                    tool_use_id: `toolu_${id}`,
                    type: 'tool_result',
                    content: [
                        {
                            type: 'text',
                            text:
                                'Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, including the agentId below, into a user-facing reply.)\n' +
                                `agentId: ${id} (internal ID - do not mention to user. Use SendMessage with to: '${id}', summary: '<5-10 word recap>' to continue this agent.)\n` +
                                'The agent is working in the background. You will be notified automatically when it completes.\n' +
                                'Do not duplicate this agent\'s work — avoid working with the same files or topics it is using.\n' +
                                `output_file: ${output}\n` +
                                'Do NOT Read or tail this file via the shell tool — it is the full subagent JSONL transcript and reading it will overflow your context.',
                        },
                    ],
                },
            ],
        },
        uuid: `uuid-${id}`,
        timestamp: '2026-07-19T03:11:26.886Z',
        toolUseResult: {
            isAsync: true,
            status: 'async_launched',
            agentId: id,
            description: opts.description ?? 'Build interactive raft animation',
            resolvedModel: 'claude-fable-5',
        },
    }
}

/** The completion, as the enqueue record. This is the one the scanner drops. */
function queueNotification(id: string, status: string) {
    return {
        type: 'queue-operation',
        operation: 'enqueue',
        timestamp: '2026-07-15T03:23:28.396Z',
        sessionId: 'sess-1',
        content:
            '<task-notification>\n' +
            `<task-id>${id}</task-id>\n` +
            `<tool-use-id>toolu_${id}</tool-use-id>\n` +
            `<output-file>/private/tmp/claude-501/-Users-clay-project/sess-1/tasks/${id}.output</output-file>\n` +
            `<status>${status}</status>\n` +
            `<summary>Agent "${id}" ${status}</summary>\n` +
            '</task-notification>',
    }
}

/** The same notification once it is delivered as its own user turn. */
function deliveredNotification(id: string, status: string) {
    return {
        parentUuid: 'b645f6d7-b13b-44f4-8d03-56844454abff',
        isSidechain: false,
        type: 'user',
        uuid: `uuid-note-${id}`,
        origin: { kind: 'task-notification' },
        promptSource: 'system',
        message: {
            role: 'user',
            content: queueNotification(id, status).content,
        },
    }
}

describe('InFlightTracker', () => {
    it('counts a launch and clears it on a completion', () => {
        const t = new InFlightTracker()
        expect(t.count()).toBe(0)

        t.note(launchRecord('a752a2a9e89efbca8'))
        expect(t.count()).toBe(1)
        expect(t.ids()).toEqual(['a752a2a9e89efbca8'])
        expect(t.names()).toEqual(['Build interactive raft animation'])

        t.note(queueNotification('a752a2a9e89efbca8', 'completed'))
        expect(t.count()).toBe(0)
    })

    it('reads the launch out of the PROSE when the structured result is missing', () => {
        const t = new InFlightTracker()
        const record: any = launchRecord('a0222667a1b1a8886')
        delete record.toolUseResult

        t.note(record)
        expect(t.count()).toBe(1)
        // No description to be had, so the id stands in for the name.
        expect(t.names()).toEqual(['a0222667a1b1a8886'])
        expect(t.snapshot().agents[0].output).toBe(
            '/private/tmp/claude-501/-Users-clay-project/sess-1/tasks/a0222667a1b1a8886.output',
        )
    })

    it('keeps the output path, which is the only route back to partial work', () => {
        const t = new InFlightTracker()
        t.note(launchRecord('a13587f10aaa7d798', { output: '/tmp/tasks/a13587f10aaa7d798.output' }))
        expect(t.snapshot().agents[0].output).toBe('/tmp/tasks/a13587f10aaa7d798.output')
    })

    it('treats failed, killed and stopped as ended, because they all end the agent', () => {
        for (const status of ['completed', 'failed', 'killed', 'stopped']) {
            const t = new InFlightTracker()
            t.note(launchRecord('a1a9501cb6331b8b8'))
            expect(t.count()).toBe(1)
            t.note(queueNotification('a1a9501cb6331b8b8', status))
            expect(t.count()).toBe(0)
        }
    })

    it('keeps counting an agent whose notification is not terminal', () => {
        const t = new InFlightTracker()
        t.note(launchRecord('a061b4f3e4810cc00'))
        t.note(queueNotification('a061b4f3e4810cc00', 'running'))
        expect(t.count()).toBe(1)
    })

    it('clears on the DELIVERED user-turn notification too', () => {
        const t = new InFlightTracker()
        t.note(launchRecord('a1c71c7aeb81e729d'))
        t.note(deliveredNotification('a1c71c7aeb81e729d', 'completed'))
        expect(t.count()).toBe(0)
    })

    it('ignores a notification for an agent it never saw launch', () => {
        const t = new InFlightTracker()
        t.note(queueNotification('a-never-launched', 'completed'))
        expect(t.count()).toBe(0)
    })

    it('does not re-add an agent whose completion arrived before its launch', () => {
        // The tail reads the file directly while the scanner polls it, so the
        // tail can be ahead. Without this the late launch record would
        // register an agent that has already finished, and it would never
        // clear.
        const t = new InFlightTracker()
        t.note(queueNotification('a08d5829a2eb5a15f', 'completed'))
        t.note(launchRecord('a08d5829a2eb5a15f'))
        expect(t.count()).toBe(0)
    })

    it('counts one agent once, however many times its launch is replayed', () => {
        const t = new InFlightTracker()
        t.note(launchRecord('a09877b291318d5a1'))
        t.note(launchRecord('a09877b291318d5a1'))
        expect(t.count()).toBe(1)
    })

    it('tracks several agents at once and drains them one at a time', () => {
        const t = new InFlightTracker()
        const ids = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8']
        for (const id of ids) t.note(launchRecord(id, { description: `job ${id}` }))
        expect(t.count()).toBe(8)
        t.note(queueNotification('a3', 'completed'))
        t.note(queueNotification('a7', 'failed'))
        expect(t.count()).toBe(6)
        expect(t.ids()).not.toContain('a3')
        expect(t.ids()).not.toContain('a7')
    })

    it('ignores a launch banner that is not in a tool_result record', () => {
        // Claude quoting its own tool result must not invent an agent.
        const t = new InFlightTracker()
        t.note({
            type: 'assistant',
            uuid: 'u1',
            message: {
                role: 'assistant',
                model: 'claude-fable-5',
                content: [
                    { type: 'text', text: 'Async agent launched successfully. agentId: a999999999999999f' },
                ],
            },
        })
        expect(t.count()).toBe(0)
    })

    describe('onIdle', () => {
        it('fires once, on the busy -> idle edge', () => {
            let idle = 0
            const t = new InFlightTracker({ onIdle: () => idle++ })
            t.note(launchRecord('a1'))
            t.note(launchRecord('a2'))
            expect(idle).toBe(0)
            t.note(queueNotification('a1', 'completed'))
            expect(idle).toBe(0)
            t.note(queueNotification('a2', 'completed'))
            expect(idle).toBe(1)
            // Nothing more arrives, so nothing more fires.
            t.note(queueNotification('a2', 'completed'))
            expect(idle).toBe(1)
        })

        it('fires again after a second batch', () => {
            let idle = 0
            const t = new InFlightTracker({ onIdle: () => idle++ })
            t.note(launchRecord('a1'))
            t.note(queueNotification('a1', 'completed'))
            t.note(launchRecord('a2'))
            t.note(queueNotification('a2', 'failed'))
            expect(idle).toBe(2)
        })

        it('stays quiet through reset(), which runs as the NEXT child launches', () => {
            let idle = 0
            const t = new InFlightTracker({ onIdle: () => idle++ })
            t.note(launchRecord('a1'))
            t.reset()
            expect(idle).toBe(0)
            expect(t.count()).toBe(0)
            expect(idle).toBe(0)
        })

        it('does not let a throwing callback break the tracker', () => {
            const t = new InFlightTracker({
                onIdle: () => {
                    throw new Error('abort exploded')
                },
            })
            t.note(launchRecord('a1'))
            expect(() => t.note(queueNotification('a1', 'completed'))).not.toThrow()
            expect(t.count()).toBe(0)
        })
    })

    it('reset() forgets everything, so a stale entry cannot jam the next child', () => {
        const t = new InFlightTracker()
        t.note(launchRecord('a20ef113b13729e13'))
        expect(t.count()).toBe(1)
        t.reset()
        expect(t.count()).toBe(0)
    })

    describe('malformed input', () => {
        it('survives anything', () => {
            const t = new InFlightTracker()
            const junk: unknown[] = [
                null,
                undefined,
                0,
                '',
                'a bare string',
                [],
                {},
                { type: 'user' },
                { type: 'user', message: null },
                { type: 'user', message: { content: null } },
                { type: 'user', message: { content: 42 } },
                { type: 'user', message: { content: [null, 1, 'x', { type: 'text' }] } },
                { type: 'user', message: { content: [{ type: 'tool_result', content: [{ type: 'text' }] }] } },
                { type: 'queue-operation', content: '<task-notification>' },
                { type: 'queue-operation', content: '<task-notification></task-notification>' },
                { type: 'queue-operation', content: '<task-notification><task-id></task-id><status>completed</status></task-notification>' },
                { type: 'queue-operation', content: '<task-notification><task-id>x</task-id></task-notification>' },
                { toolUseResult: 'not an object' },
                { toolUseResult: { status: 'async_launched' } },
                { toolUseResult: { agentId: 42, status: 'async_launched' } },
                { type: 'user', toolUseResult: { agentId: 'a1', status: 'some_other_tool' } },
            ]
            for (const record of junk) {
                expect(() => t.note(record)).not.toThrow()
            }
            expect(t.count()).toBe(0)
        })

        it('survives a launch whose banner carries no agentId', () => {
            const t = new InFlightTracker()
            t.note({
                type: 'user',
                message: {
                    content: [
                        { type: 'tool_result', content: [{ type: 'text', text: 'Async agent launched successfully.' }] },
                    ],
                },
            })
            expect(t.count()).toBe(0)
        })
    })

    describe('tailing the transcript, because the scanner drops queue-operation records', () => {
        let root: string
        let transcript: string

        beforeEach(() => {
            root = mkdtempSync(join(tmpdir(), 'inflight-'))
            transcript = join(root, 'sess-1.jsonl')
            writeFileSync(transcript, '{"type":"summary","summary":"old","leafUuid":"x"}\n')
        })

        afterEach(() => {
            rmSync(root, { recursive: true, force: true })
        })

        it('clears an agent from a queue-operation the tracker was never handed', () => {
            const t = new InFlightTracker({ transcript: () => transcript, drainEveryMs: 0 })
            // The launch arrives through the scanner, as it does in production.
            appendFileSync(transcript, JSON.stringify(launchRecord('a115518f68ceec138')) + '\n')
            t.note(launchRecord('a115518f68ceec138'))
            expect(t.count()).toBe(1)

            // The completion only ever lands in the file — the scanner skips
            // queue-operation outright. This is the whole reason the tail exists.
            appendFileSync(transcript, JSON.stringify(queueNotification('a115518f68ceec138', 'completed')) + '\n')
            expect(t.count()).toBe(0)
        })

        it('does not re-read history written before the first launch', () => {
            // A completion for some OTHER, older agent sitting in the file must
            // not be mistaken for anything, and a 190 MB history must not be
            // read at all.
            appendFileSync(transcript, JSON.stringify(queueNotification('a-old', 'completed')) + '\n')
            const t = new InFlightTracker({ transcript: () => transcript, drainEveryMs: 0 })
            t.note(launchRecord('a-old'))
            expect(t.count()).toBe(1)
        })

        it('survives a record split across two reads', () => {
            const t = new InFlightTracker({ transcript: () => transcript, drainEveryMs: 0 })
            t.note(launchRecord('a125999b6a2489127'))
            const line = JSON.stringify(queueNotification('a125999b6a2489127', 'completed')) + '\n'
            appendFileSync(transcript, line.slice(0, 40))
            expect(t.count()).toBe(1)
            appendFileSync(transcript, line.slice(40))
            expect(t.count()).toBe(0)
        })

        it('survives a transcript that is not there', () => {
            const t = new InFlightTracker({ transcript: () => join(root, 'gone.jsonl'), drainEveryMs: 0 })
            t.note(launchRecord('a16138496879c2d01'))
            expect(t.count()).toBe(1)
        })

        it('survives a transcript path that throws', () => {
            const t = new InFlightTracker({
                transcript: () => {
                    throw new Error('no session id yet')
                },
                drainEveryMs: 0,
            })
            expect(() => t.note(launchRecord('a18781d82f2d3da35'))).not.toThrow()
            expect(t.count()).toBe(1)
        })

        it('follows the file a flip moved it into', () => {
            let path = transcript
            const t = new InFlightTracker({ transcript: () => path, drainEveryMs: 0 })
            t.note(launchRecord('a1f5c4f4aba5379b0'))
            expect(t.count()).toBe(1)

            // carryTranscript copies the file byte for byte into the target
            // account, so the offset still points at the same record.
            const carried = join(root, 'carried.jsonl')
            const head = '{"type":"summary","summary":"old","leafUuid":"x"}\n'
            writeFileSync(carried, head)
            appendFileSync(carried, JSON.stringify(queueNotification('a1f5c4f4aba5379b0', 'completed')) + '\n')
            path = carried
            expect(t.count()).toBe(0)
        })

        it('ignores unparseable lines in the tail', () => {
            const t = new InFlightTracker({ transcript: () => transcript, drainEveryMs: 0 })
            t.note(launchRecord('a1faaab73adbb3b74'))
            appendFileSync(transcript, 'not json at all\n{"broken":\n')
            appendFileSync(transcript, JSON.stringify(queueNotification('a1faaab73adbb3b74', 'killed')) + '\n')
            expect(t.count()).toBe(0)
        })
    })
})

describe('describeInFlight', () => {
    it('says nothing is running when nothing is', () => {
        expect(describeInFlight(emptyInFlight)).toBe('nothing still running')
    })

    it('names the agents, descriptions first', () => {
        const t = new InFlightTracker()
        t.note(launchRecord('a1', { description: 'raft animation' }))
        t.note(launchRecord('a2', { description: 'audit the launcher' }))
        expect(describeInFlight(t.snapshot())).toBe(
            '2 subagents still running (raft animation, audit the launcher)',
        )
    })

    it('is singular for one', () => {
        const t = new InFlightTracker()
        t.note(launchRecord('a1', { description: 'raft animation' }))
        expect(describeInFlight(t.snapshot())).toBe('1 subagent still running (raft animation)')
    })

    it('caps the list rather than printing twelve names', () => {
        const t = new InFlightTracker()
        for (let i = 0; i < 12; i++) t.note(launchRecord(`a${i}`, { description: `job ${i}` }))
        expect(describeInFlight(t.snapshot(), 3)).toBe(
            '12 subagents still running (job 0, job 1, job 2, +9 more)',
        )
    })
})

/**
 * The gate itself: what a flip does when the answer is "eight of them".
 *
 * The answer used to be "not yet, ask again". It is now "going, and here is
 * what you are dropping" (DROVE-240) -- Clay replaced the design before a
 * drain was built, because a flip he has to ask for twice is a flip he forgets
 * to come back to. What the gate was spending on a refusal it now spends on
 * the handover the arrival prompt carries.
 *
 * These drive FlipController.request() directly. It decides before it touches
 * the account registry, so no fixture on disk is needed — the whole point is
 * that the decision happens BEFORE anything is stopped.
 */
describe('FlipController, gated on running subagents', () => {
    // Point the registry and the ledger at a directory that does not exist.
    // The gate now also asks whether an explicitly named account has headroom
    // (DROVE-64), and without this these tests would read whatever accounts
    // and cooldowns the machine running them happens to have — a unit test of
    // the gate that passes or fails on Clay's own quota is not a test.
    beforeEach(() => {
        const nowhere = join(tmpdir(), `drover-gate-${process.pid}-${Date.now()}`)
        process.env.DROVER_ACCOUNTS = join(nowhere, 'no-registry.json')
        process.env.XDG_STATE_HOME = join(nowhere, 'no-state')
    })

    async function controller(opts: { running: number }) {
        const { FlipController } = await import('./controller')
        const said: string[] = []
        let aborts = 0
        const tracker = new InFlightTracker()
        for (let i = 0; i < opts.running; i++) {
            tracker.note(launchRecord(`a${i}`, { description: `job ${i}` }))
        }
        const flip = new FlipController('/tmp/project', (m: string) => said.push(m), {
            toTerminal: () => {},
            toPane: () => {},
            flipConfirmMs: 30_000,
        })
        flip.setAbortHandler(() => {
            aborts++
        })
        flip.setInFlightProbe(() => tracker.snapshot())
        return { flip, said, tracker, aborts: () => aborts }
    }

    it('stops the child immediately when nothing is running', async () => {
        const c = await controller({ running: 0 })
        c.flip.request({ account: 'alt', reason: 'manual', by: 'app' })
        expect(c.aborts()).toBe(1)
        expect(c.flip.take()).toMatchObject({ account: 'alt' })
    })

    it('flips at once with eight running, and says what it is dropping', async () => {
        const c = await controller({ running: 8 })
        c.flip.request({ account: 'alt', reason: 'manual', by: 'app' })

        // The whole change: one ask, one flip. No hold, no second press.
        expect(c.aborts()).toBe(1)
        expect(c.flip.take()).toMatchObject({ account: 'alt' })
        const note = c.said.join('\n')
        expect(note).toContain('8 subagents still running')
        expect(note).not.toContain('Ask again within')
    })

    it('never calls the handover a resume, because a subagent has none', async () => {
        const c = await controller({ running: 3 })
        c.flip.request({ account: 'alt', reason: 'manual', by: 'app' })
        const note = c.said.join('\n')
        expect(note).toContain('RE-DISPATCH')
        expect(note).toContain('cannot be resumed')
        expect(note).not.toMatch(/resuming/i)
    })

    it('says where the work is, so the drop is a handover rather than a loss', async () => {
        const c = await controller({ running: 2 })
        c.flip.request({ account: 'alt', reason: 'manual', by: 'app' })
        const note = c.said.join('\n')
        expect(note).toContain('where its transcript')
        expect(note).toContain('pushed a lane')
    })

    it('flips on a usage limit too, and says why waiting would not have helped', async () => {
        // The account is dead. Waiting does not save them, it only fails them
        // one API call later. So the loss goes on the record instead.
        const c = await controller({ running: 5 })
        c.flip.request({ account: null, reason: 'usage limit', by: 'auto' })

        expect(c.aborts()).toBe(1)
        expect(c.flip.take()).toMatchObject({ by: 'auto' })
        const note = c.said.join('\n')
        expect(note).toContain('5 subagents still running')
        expect(note).toContain('no headroom left')
        expect(note).toContain('RE-DISPATCH')
    })

    it('does not need a second press even with twelve out', async () => {
        // The old gate turned a twelve-agent fan-out into two keypresses and
        // a thirty-second window. Clay forgot the second press; the flip he
        // asked for simply never happened.
        const c = await controller({ running: 12 })
        c.flip.request({ account: 'alt', reason: 'manual', by: 'app' })
        expect(c.aborts()).toBe(1)
    })

    it('behaves exactly as before when no probe is wired up', async () => {
        const { FlipController } = await import('./controller')
        let aborts = 0
        const flip = new FlipController('/tmp/project', () => {}, { toTerminal: () => {}, toPane: () => {} })
        flip.setAbortHandler(() => {
            aborts++
        })
        flip.request({ account: 'alt', reason: 'manual', by: 'app' })
        expect(aborts).toBe(1)
    })

    it('does not let a broken probe block a flip', async () => {
        const { FlipController } = await import('./controller')
        let aborts = 0
        const flip = new FlipController('/tmp/project', () => {}, { toTerminal: () => {}, toPane: () => {} })
        flip.setAbortHandler(() => {
            aborts++
        })
        flip.setInFlightProbe(() => {
            throw new Error('tracker exploded')
        })
        flip.request({ account: 'alt', reason: 'manual', by: 'app' })
        expect(aborts).toBe(1)
    })
})

describe('the arrival prompt hands the stranded agents over', () => {
    // The handover writes a file as it goes, on purpose (see handover.ts), so
    // the state dir is pointed somewhere disposable rather than at Clay's.
    let state: string

    beforeEach(() => {
        state = mkdtempSync(join(tmpdir(), 'drover-handover-'))
        process.env.XDG_STATE_HOME = state
    })

    it('names each agent and points at its transcript, keeping the prompt intact', async () => {
        const { resolveFlipPrompt, defaultFlipPrompt } = await import('./prompt')
        const tracker = new InFlightTracker()
        tracker.note(launchRecord('a752a2a9e89efbca8', { description: 'raft animation' }))
        tracker.note(launchRecord('a0222667a1b1a8886', { description: 'platforms scroll-pop' }))

        const prompt = resolveFlipPrompt({
            to: 'alt',
            reason: 'usage limit',
            cwd: '/tmp/project',
            override: defaultFlipPrompt,
            stranded: tracker.snapshot().agents,
        })

        // The configured prompt still leads; the handover is appended under it.
        expect(prompt).toContain('Pick up where we left off, including all subagents')
        expect(prompt).toContain('raft animation')
        expect(prompt).toContain('/private/tmp/claude-501/-Users-clay-project/sess-1/tasks/a752a2a9e89efbca8.output')
        expect(prompt).toContain('platforms scroll-pop')
        expect(prompt).toContain('/private/tmp/claude-501/-Users-clay-project/sess-1/tasks/a0222667a1b1a8886.output')
        expect(prompt).toContain('RE-DISPATCH')
        expect(prompt).toContain('READ THAT FILE FIRST')
    })

    it('calls it a re-dispatch and never a resume', async () => {
        const { resolveFlipPrompt, defaultFlipPrompt } = await import('./prompt')
        const tracker = new InFlightTracker()
        tracker.note(launchRecord('a752a2a9e89efbca8', { description: 'raft animation' }))

        const prompt = resolveFlipPrompt({
            to: 'alt',
            reason: 'manual',
            cwd: '/tmp/project',
            override: defaultFlipPrompt,
            stranded: tracker.snapshot().agents,
        })
        expect(prompt).toContain('RE-DISPATCH')
        expect(prompt).toContain('no way to resume a subagent')
        // "resume" appears only in the sentence denying it.
        expect(prompt).not.toMatch(/resuming/i)
    })

    it('says nothing at all when nothing was stranded', async () => {
        const { resolveFlipPrompt, defaultFlipPrompt } = await import('./prompt')
        const prompt = resolveFlipPrompt({
            to: 'alt',
            reason: 'manual',
            cwd: '/tmp/project',
            override: defaultFlipPrompt,
            stranded: [],
        })
        expect(prompt).toBe(defaultFlipPrompt)
    })

    it('drops the block for bare ids, which name neither the work nor where it is', async () => {
        const { resolveFlipPrompt, defaultFlipPrompt } = await import('./prompt')
        const prompt = resolveFlipPrompt({
            to: 'alt',
            reason: 'manual',
            cwd: '/tmp/project',
            override: defaultFlipPrompt,
            stranded: [{ id: 'a1' }, { id: 'a2' }],
        })
        expect(prompt).toBe(defaultFlipPrompt)
    })

    it('points at a file instead of inlining once five agents are out', async () => {
        const { resolveFlipPrompt, defaultFlipPrompt } = await import('./prompt')
        const tracker = new InFlightTracker()
        for (let i = 0; i < 5; i++) {
            tracker.note(launchRecord(`a752a2a9e89efbc${i}`, { description: `job number ${i}` }))
        }

        const prompt = resolveFlipPrompt({
            to: 'alt',
            reason: 'manual',
            cwd: '/tmp/project',
            session: 'sess-1',
            override: defaultFlipPrompt,
            stranded: tracker.snapshot().agents,
        })

        const path = join(state, 'cattle-drover', 'handover', 'sess-1.md')
        expect(prompt).toContain(path)
        expect(prompt).toContain('Read that file before you start anything')
        // The point of the pointer: the prompt stops growing with the fan-out.
        expect(prompt).not.toContain('job number 3')

        const written = readFileSync(path, 'utf8')
        expect(written).toContain('job number 3')
        expect(written).toContain('5 subagents were running')
    })

    it('writes the file even for a flip nobody asked for, and even when it inlines', async () => {
        // The unwatched flips are exactly the ones where the file has to
        // outlive the prompt: nobody is at the terminal to read the announce.
        const { resolveFlipPrompt, defaultFlipPrompt } = await import('./prompt')
        const tracker = new InFlightTracker()
        tracker.note(launchRecord('a752a2a9e89efbca8', { description: 'raft animation' }))

        resolveFlipPrompt({
            to: 'alt',
            reason: 'usage limit',
            cwd: '/tmp/project',
            session: 'sess-auto',
            override: defaultFlipPrompt,
            stranded: tracker.snapshot().agents,
        })

        const written = readFileSync(join(state, 'cattle-drover', 'handover', 'sess-auto.md'), 'utf8')
        expect(written).toContain('raft animation')
        expect(written).toContain('RE-DISPATCH')
    })

    it('reads the ticket out of the label, so the new agent can go and read it', async () => {
        const { buildHandover, renderHandover } = await import('./handover')
        const entries = buildHandover(
            [{ id: 'a1', name: 'DROVE-240 flip drains', output: '/tmp/a1.jsonl' }],
            { cwd: '/tmp/project' },
        )
        expect(entries[0].ticket).toBe('DROVE-240')
        expect(renderHandover(entries)).toContain('DROVE-240 flip drains')
    })
})
