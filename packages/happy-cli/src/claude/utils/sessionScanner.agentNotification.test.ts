/**
 * DROVE-115: the scanner reporting that a background agent has stopped.
 *
 * The point of the test is the two carriers the message stream cannot see. A
 * `queue-operation` is in INTERNAL_CLAUDE_EVENT_TYPES and an `attachment`
 * fails RawJSONLinesSchema, so both are dropped before onMessage; measured
 * across 1084 launched agents in BASED-135, 313 of them reported on one of
 * those two and nothing else. If those are not read here, roughly a third of
 * finished agents keep drawing "Running" on the phone forever.
 *
 * Its own file rather than a case in sessionScanner.test.ts, for the reason
 * sessionScanner.model.test.ts gives: that suite replays one shared tmpdir.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createSessionScanner } from './sessionScanner'
import type { AgentNotification } from './agentNotification'
import { getProjectPath } from './path'

const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-000000000115'
const agentId = 'a752a2a9e89efbca8'
const toolUseId = 'toolu_01ChtSUF4BxNmvYEeRcoKxxi'

function notificationText(status = 'completed'): string {
    return '<task-notification>\n'
        + `<task-id>${agentId}</task-id>\n`
        + `<tool-use-id>${toolUseId}</tool-use-id>\n`
        + `<status>${status}</status>\n`
        + '<result>Pushed as 55c43f95.</result>\n'
        + '</task-notification>'
}

function line(record: unknown): string {
    return JSON.stringify(record) + '\n'
}

const prompt = line({
    type: 'user',
    uuid: 'u0',
    sessionId,
    timestamp: '2026-08-31T05:00:00.000Z',
    message: { role: 'user', content: 'go' },
})

describe('sessionScanner reports a background agent stopping', () => {
    let testDir: string
    let projectDir: string
    let file: string
    let reported: AgentNotification[]
    let messageTypes: string[]
    let scanner: Awaited<ReturnType<typeof createSessionScanner>> | null = null

    async function reports(expected: Partial<AgentNotification>[]): Promise<void> {
        await vi.waitFor(() => {
            expect(reported).toHaveLength(expected.length)
            expected.forEach((one, i) => expect(reported[i]).toMatchObject(one))
        }, { timeout: 2_000, interval: 10 })
    }

    beforeEach(async () => {
        process.env.DROVER_URL = 'http://127.0.0.1:1'
        testDir = join(tmpdir(), `scanner-agent-${Date.now()}-${Math.random().toString(36).slice(2)}`)
        await mkdir(testDir, { recursive: true })
        projectDir = getProjectPath(testDir)
        await mkdir(projectDir, { recursive: true })
        file = join(projectDir, `${sessionId}.jsonl`)
        reported = []
        messageTypes = []
    })

    afterEach(async () => {
        if (scanner) {
            await scanner.cleanup()
            scanner = null
        }
        for (const dir of [testDir, projectDir]) {
            if (existsSync(dir)) await rm(dir, { recursive: true, force: true })
        }
    })

    async function start(): Promise<void> {
        scanner = await createSessionScanner({
            sessionId,
            workingDirectory: testDir,
            onMessage: (message) => { messageTypes.push(message.type) },
            onAgentNotification: (notification) => { reported.push(notification) },
        })
    }

    it('reports the completion delivered as its own user turn', async () => {
        await writeFile(file, prompt)
        await start()
        await writeFile(file, prompt + line({
            type: 'user',
            uuid: 'u1',
            sessionId,
            timestamp: '2026-08-31T05:10:00.000Z',
            message: { role: 'user', content: notificationText() },
        }))
        await reports([{ agentId, toolUseId, status: 'completed', terminal: true, succeeded: true }])
        // Still forwarded as a message: the record is whatever it was, and the
        // app drops a control-only notification on its own side.
        expect(messageTypes).toContain('user')
    })

    it('reports one that only ever appears on a queue-operation', async () => {
        await writeFile(file, prompt)
        await start()
        await writeFile(file, prompt + line({
            type: 'queue-operation',
            operation: 'enqueue',
            content: notificationText(),
            timestamp: '2026-08-31T05:10:00.000Z',
        }))
        await reports([{ agentId, status: 'completed' }])
    })

    it('reports one that only ever appears on an attachment', async () => {
        await writeFile(file, prompt)
        await start()
        await writeFile(file, prompt + line({
            type: 'attachment',
            attachment: { type: 'queued_command', prompt: notificationText('failed') },
            timestamp: '2026-08-31T05:10:00.000Z',
        }))
        await reports([{ agentId, status: 'failed', terminal: true, succeeded: false }])
    })

    it('reports one agent once when all three carriers repeat it', async () => {
        await writeFile(file, prompt)
        await start()
        await writeFile(file, prompt
            + line({ type: 'queue-operation', operation: 'enqueue', content: notificationText(), timestamp: '2026-08-31T05:10:00.000Z' })
            + line({ type: 'attachment', attachment: { type: 'queued_command', prompt: notificationText() }, timestamp: '2026-08-31T05:10:01.000Z' })
            + line({ type: 'user', uuid: 'u1', sessionId, timestamp: '2026-08-31T05:10:02.000Z', message: { role: 'user', content: notificationText() } }))
        await reports([{ agentId, status: 'completed' }])
        // A second agent proves the de-dupe is per agent, not a one-shot latch.
        await writeFile(file, prompt
            + line({ type: 'queue-operation', operation: 'enqueue', content: notificationText(), timestamp: '2026-08-31T05:10:00.000Z' })
            + line({ type: 'attachment', attachment: { type: 'queued_command', prompt: notificationText() }, timestamp: '2026-08-31T05:10:01.000Z' })
            + line({ type: 'user', uuid: 'u1', sessionId, timestamp: '2026-08-31T05:10:02.000Z', message: { role: 'user', content: notificationText() } })
            + line({
                type: 'user',
                uuid: 'u2',
                sessionId,
                timestamp: '2026-08-31T05:11:00.000Z',
                message: { role: 'user', content: notificationText().replace(agentId, 'b0000000000000001') },
            }))
        await reports([{ agentId }, { agentId: 'b0000000000000001' }])
    })

    it('says nothing about the notifications already on disk when it starts', async () => {
        await writeFile(file, prompt + line({
            type: 'user',
            uuid: 'u1',
            sessionId,
            timestamp: '2026-08-31T05:10:00.000Z',
            message: { role: 'user', content: notificationText() },
        }))
        await start()
        // Something newer, so there is an event to wait FOR rather than a sleep.
        await writeFile(file, prompt + line({
            type: 'user',
            uuid: 'u1',
            sessionId,
            timestamp: '2026-08-31T05:10:00.000Z',
            message: { role: 'user', content: notificationText() },
        }) + line({
            type: 'user',
            uuid: 'u2',
            sessionId,
            timestamp: '2026-08-31T05:11:00.000Z',
            message: { role: 'user', content: notificationText().replace(agentId, 'b0000000000000001') },
        }))
        await reports([{ agentId: 'b0000000000000001' }])
    })
})
