/**
 * DROVE-115. Three records carry a background agent's completion and only one
 * of them ever reaches the phone, so the parsing has to work on all three or
 * roughly a third of finished agents keep drawing "Running" forever.
 */
import { describe, expect, it } from 'vitest'

import {
    AgentLaunchIndex,
    agentStopResult,
    parseAgentNotifications,
    readAsyncAgentLaunch,
    readableTranscriptStrings,
} from './agentNotification'

const agentId = 'a752a2a9e89efbca8'
const toolUseId = 'toolu_01ChtSUF4BxNmvYEeRcoKxxi'

function notificationText(opts: { agent?: string, tool?: string | null, status?: string, result?: string } = {}): string {
    const tool = opts.tool === null ? '' : `<tool-use-id>${opts.tool ?? toolUseId}</tool-use-id>\n`
    return '<task-notification>\n'
        + `<task-id>${opts.agent ?? agentId}</task-id>\n`
        + tool
        + `<output-file>/tmp/claude-501/x/tasks/${opts.agent ?? agentId}.output</output-file>\n`
        + `<status>${opts.status ?? 'completed'}</status>\n`
        + '<summary>Agent "DROVE-115 card" finished</summary>\n'
        + `<result>${opts.result ?? 'Pushed as 55c43f95. Done.'}</result>\n`
        + '</task-notification>'
}

/** The delivered-as-its-own-turn carrier: the only one the scanner forwards. */
function userNotification(text: string, at = '2026-08-31T05:10:00.000Z') {
    return { type: 'user', uuid: 'u1', timestamp: at, message: { role: 'user', content: text } }
}

/** The enqueue carrier, dropped by INTERNAL_CLAUDE_EVENT_TYPES. */
function queueNotification(text: string) {
    return { type: 'queue-operation', operation: 'enqueue', content: text, timestamp: '2026-08-31T05:10:00.000Z' }
}

/** The mid-turn injection, dropped by RawJSONLinesSchema. */
function attachmentNotification(text: string) {
    return { type: 'attachment', attachment: { type: 'queued_command', prompt: text }, timestamp: '2026-08-31T05:10:00.000Z' }
}

/** The launch: an async Agent's tool_result, ~19ms after the call. */
function launchRecord(opts: { agent?: string, tool?: string, structured?: boolean } = {}) {
    const id = opts.agent ?? agentId
    const call = opts.tool ?? toolUseId
    const banner = `Async agent launched successfully.\n  agentId: ${id}\n  output_file: /tmp/claude-501/x/tasks/${id}.output`
    return {
        type: 'user',
        uuid: 'u0',
        timestamp: '2026-08-31T05:00:00.000Z',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: call, content: banner }] },
        ...(opts.structured === false ? {} : {
            toolUseResult: {
                isAsync: true,
                status: 'async_launched',
                agentId: id,
                description: 'DROVE-115 card',
                outputFile: `/tmp/claude-501/x/tasks/${id}.output`,
            },
        }),
    }
}

describe('readableTranscriptStrings', () => {
    it('reaches the text on all three carriers', () => {
        const text = notificationText()
        expect(readableTranscriptStrings(userNotification(text))).toContain(text)
        expect(readableTranscriptStrings(queueNotification(text))).toContain(text)
        expect(readableTranscriptStrings(attachmentNotification(text))).toContain(text)
    })

    it('never throws on a record it does not understand', () => {
        expect(readableTranscriptStrings(null)).toEqual([])
        expect(readableTranscriptStrings(42)).toEqual([])
        expect(readableTranscriptStrings({ message: { content: [null, 3, { text: 'x' }] } })).toEqual(['x'])
    })
})

describe('parseAgentNotifications', () => {
    it('reads agent, call, status and result off a delivered turn', () => {
        const [notification] = parseAgentNotifications(userNotification(notificationText()))
        expect(notification).toMatchObject({
            agentId,
            toolUseId,
            status: 'completed',
            terminal: true,
            succeeded: true,
            result: 'Pushed as 55c43f95. Done.',
        })
        expect(notification.at).toBe(Date.parse('2026-08-31T05:10:00.000Z'))
    })

    it('reads the same block off the two carriers the app never sees', () => {
        const text = notificationText()
        expect(parseAgentNotifications(queueNotification(text))[0]).toMatchObject({ agentId, status: 'completed' })
        expect(parseAgentNotifications(attachmentNotification(text))[0]).toMatchObject({ agentId, status: 'completed' })
    })

    it('marks a failure terminal but not succeeded', () => {
        const [notification] = parseAgentNotifications(userNotification(notificationText({ status: 'failed' })))
        expect(notification).toMatchObject({ status: 'failed', terminal: true, succeeded: false })
    })

    it('keeps an unrecognised status off the terminal path', () => {
        const [notification] = parseAgentNotifications(userNotification(notificationText({ status: 'progress' })))
        expect(notification).toMatchObject({ status: 'progress', terminal: false, succeeded: false })
    })

    it('reports each agent once when one record carries the block twice', () => {
        const text = notificationText()
        const record = {
            type: 'user',
            timestamp: '2026-08-31T05:10:00.000Z',
            message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text }] }] },
            content: text,
        }
        expect(parseAgentNotifications(record)).toHaveLength(1)
    })

    it('reads two agents reporting in one record', () => {
        const text = `${notificationText()}\n${notificationText({ agent: 'b99', tool: 'toolu_b99' })}`
        expect(parseAgentNotifications(userNotification(text)).map((n) => n.agentId)).toEqual([agentId, 'b99'])
    })

    it('finds nothing in an ordinary message', () => {
        expect(parseAgentNotifications(userNotification('please rebase this'))).toEqual([])
    })
})

describe('readAsyncAgentLaunch', () => {
    it('reads the agent, its call and its output path off the receipt', () => {
        expect(readAsyncAgentLaunch(launchRecord())).toMatchObject({
            agentId,
            toolUseId,
            description: 'DROVE-115 card',
            outputFile: `/tmp/claude-501/x/tasks/${agentId}.output`,
        })
    })

    it('falls back to the banner when there is no structured result', () => {
        expect(readAsyncAgentLaunch(launchRecord({ structured: false }))).toMatchObject({ agentId, toolUseId })
    })

    it('ignores Claude quoting a launch banner back at itself', () => {
        expect(readAsyncAgentLaunch({
            type: 'assistant',
            message: { role: 'assistant', content: [{ type: 'text', text: 'Async agent launched successfully. agentId: aaaa1111' }] },
        })).toBeNull()
    })

    it('ignores every other tool result', () => {
        expect(readAsyncAgentLaunch({
            type: 'user',
            message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] },
            toolUseResult: { stdout: 'ok', stderr: '' },
        })).toBeNull()
    })
})

describe('AgentLaunchIndex', () => {
    it('remembers which call an agent belongs to, and forgets on report', () => {
        const index = new AgentLaunchIndex()
        index.note(launchRecord())
        expect(index.get(agentId)?.toolUseId).toBe(toolUseId)
        index.forget(agentId)
        expect(index.get(agentId)).toBeUndefined()
    })

    it('keeps the first sighting time and fills the rest in', () => {
        const index = new AgentLaunchIndex()
        index.note(launchRecord({ structured: false }))
        const first = index.get(agentId)!.at
        index.note({ ...launchRecord(), timestamp: '2026-08-31T06:00:00.000Z' })
        expect(index.get(agentId)?.at).toBe(first)
        expect(index.get(agentId)?.description).toBe('DROVE-115 card')
    })

    it('stays bounded on a session that launches hundreds', () => {
        const index = new AgentLaunchIndex(4)
        for (let i = 0; i < 20; i += 1) index.note(launchRecord({ agent: `a${i}00`, tool: `toolu_${i}` }))
        expect(index.size).toBe(4)
        expect(index.get('a1900')?.toolUseId).toBe('toolu_19')
    })

    it('never throws on rubbish', () => {
        const index = new AgentLaunchIndex()
        expect(() => index.note(null)).not.toThrow()
        expect(index.size).toBe(0)
    })
})

describe('agentStopResult', () => {
    it('reports a completion in the same shape the launch receipt had', () => {
        const index = new AgentLaunchIndex()
        index.note(launchRecord())
        const [notification] = parseAgentNotifications(userNotification(notificationText()))
        const stop = agentStopResult(notification, index.get(agentId))
        expect(stop.isError).toBe(false)
        expect(stop.result).toMatchObject({
            isAsync: true,
            status: 'completed',
            agentId,
            content: [{ type: 'text', text: 'Pushed as 55c43f95. Done.' }],
            totalDurationMs: 600_000,
        })
        // The word the app tells a receipt from an outcome by must not repeat.
        expect(stop.result.status).not.toBe('async_launched')
    })

    it('reports a failure as an error', () => {
        const [notification] = parseAgentNotifications(userNotification(notificationText({ status: 'killed' })))
        expect(agentStopResult(notification).isError).toBe(true)
        expect(agentStopResult(notification).result).toMatchObject({ status: 'killed' })
    })

    it('leaves out a duration it cannot honestly compute', () => {
        const [notification] = parseAgentNotifications(userNotification(notificationText()))
        expect(agentStopResult(notification).result.totalDurationMs).toBeUndefined()
    })
})
