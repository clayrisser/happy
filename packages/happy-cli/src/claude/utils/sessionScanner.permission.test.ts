/**
 * The pane -> app half of DROVE-36.
 *
 * Clay had Yolo selected in the composer for a terminal-started session and
 * every tool call still raised a card. Half of why: nothing ever told the app
 * what the pane's permission mode actually was, so the composer showed its own
 * stored pick and there was no way to see the two disagree.
 *
 * The transcript has always known. Claude Code appends
 * `{"type":"permission-mode","permissionMode":...}` as part of the state block
 * it writes around every prompt — 123 of them in one live session of Clay's,
 * one per turn — and RawJSONLinesSchema dropped every one as an unknown type.
 *
 * Its own file, for the same reason sessionScanner.model.test.ts is one: these
 * want a transcript built a record at a time rather than the shared replay
 * story in sessionScanner.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createSessionScanner } from './sessionScanner'
import { getProjectPath } from './path'

const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-000000000036'

/**
 * The state block Claude Code appends around a prompt, copied field for field
 * off a live 2.1.251 transcript. The neighbours are kept because they are the
 * reason this record was invisible: it arrives in a run of types the scanner
 * has no schema for, and only `custom-title` had ever been picked out of it.
 */
function stateBlock(mode: string) {
    return [
        { type: 'custom-title', customTitle: 'DROVER', sessionId },
        { type: 'agent-name', sessionId },
        { type: 'mode', mode: 'normal', sessionId },
        { type: 'permission-mode', permissionMode: mode, sessionId },
        { type: 'atis-latch', sessionId },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n'
}

describe('sessionScanner reports the permission mode the pane is in', () => {
    let testDir: string
    let projectDir: string
    let file: string
    let modes: string[]
    let seen: number
    let scanner: Awaited<ReturnType<typeof createSessionScanner>> | null = null

    /**
     * Wait for the scanner to have reported exactly this (DROVE-68).
     *
     * It used to sleep 200 ms after each write and read the array once. On a
     * loaded box a poll can miss that window, and the failure then reads as a
     * wrong answer rather than a slow one. Waiting for the answer instead is
     * the same assertion. A mode that never arrives, or an extra report that
     * should not exist, still fails, and the diff still shows both lists.
     */
    async function reports(expected: string[]): Promise<void> {
        await vi.waitFor(() => expect(modes).toEqual(expected), { timeout: 2_000, interval: 10 })
    }

    /**
     * Wait for the scanner to have delivered n transcript records.
     *
     * The barrier for the tests that assert NOTHING was reported: a report is
     * made in the same pass that hands the record over, so a record arriving
     * is proof the pass ran and chose to stay quiet.
     */
    async function delivered(n: number): Promise<void> {
        await vi.waitFor(() => expect(seen).toBeGreaterThanOrEqual(n), { timeout: 2_000, interval: 10 })
    }

    beforeEach(async () => {
        // Nothing here may reach the real drover bus.
        process.env.DROVER_URL = 'http://127.0.0.1:1'
        testDir = join(tmpdir(), `scanner-perm-${Date.now()}-${Math.random().toString(36).slice(2)}`)
        await mkdir(testDir, { recursive: true })
        projectDir = getProjectPath(testDir)
        await mkdir(projectDir, { recursive: true })
        file = join(projectDir, `${sessionId}.jsonl`)
        modes = []
        seen = 0
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
            onMessage: () => { seen += 1 },
            onPermissionModeObserved: (mode) => modes.push(mode),
        })
    }

    it('seeds from what the transcript already says, so a reconnect is not blank', async () => {
        await writeFile(file, stateBlock('bypassPermissions'))
        await start()
        await reports(['bypassPermissions'])
    })

    it('reports a shift+tab at the keyboard on the next turn, with nothing restarting', async () => {
        await writeFile(file, stateBlock('bypassPermissions'))
        await start()
        await reports(['bypassPermissions'])

        await writeFile(file, stateBlock('bypassPermissions') + stateBlock('plan'))
        await reports(['bypassPermissions', 'plan'])
    })

    it('says nothing while the mode holds, however many turns write it down', async () => {
        // Claude Code re-appends the record every turn even when nothing
        // changed. Each report is a metadata write that reaches the phone, so
        // the repetition has to die here.
        await writeFile(file, stateBlock('bypassPermissions'))
        await start()
        await reports(['bypassPermissions'])
        // The repeats are followed by a real change, so there is something to
        // wait FOR. Arriving at exactly [bypass, plan] is the proof the four
        // repetitions in between were read and said nothing, which is stronger
        // than reading the array once, 200 ms later, and hoping they had been.
        await writeFile(file, stateBlock('bypassPermissions').repeat(4) + stateBlock('plan'))
        await reports(['bypassPermissions', 'plan'])
    })

    it('reports a mode the session comes back to', async () => {
        // The reason the record is keyed by line index rather than by value:
        // bypass -> plan -> bypass has to report bypass twice, and a value key
        // would have marked it history the first time.
        await writeFile(file, stateBlock('bypassPermissions'))
        await start()
        await reports(['bypassPermissions'])
        await writeFile(file, stateBlock('bypassPermissions') + stateBlock('plan'))
        await reports(['bypassPermissions', 'plan'])
        await writeFile(file,
            stateBlock('bypassPermissions') + stateBlock('plan') + stateBlock('bypassPermissions'))
        await reports(['bypassPermissions', 'plan', 'bypassPermissions'])
    })

    it('says nothing for a transcript that has never recorded a mode', async () => {
        const turn = (uuid: string) => JSON.stringify({
            type: 'assistant',
            uuid,
            sessionId,
            message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'ok' }] },
        }) + '\n'
        await writeFile(file, turn('u1'))
        await start()

        // A second turn, appended after the scanner is watching, so there is a
        // signal to wait for: the seeding pass and the pass that delivers this
        // record have both been over a transcript with no mode in it, and
        // neither reported one. The sleep it replaces could only say "nothing
        // yet", which is also what a scanner that had not looked would say.
        await writeFile(file, turn('u1') + turn('u2'))
        await delivered(1)
        expect(modes).toEqual([])
    })
})
