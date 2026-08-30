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

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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

const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms))

describe('sessionScanner reports the permission mode the pane is in', () => {
    let testDir: string
    let projectDir: string
    let file: string
    let modes: string[]
    let scanner: Awaited<ReturnType<typeof createSessionScanner>> | null = null

    beforeEach(async () => {
        // Nothing here may reach the real drover bus.
        process.env.DROVER_URL = 'http://127.0.0.1:1'
        testDir = join(tmpdir(), `scanner-perm-${Date.now()}-${Math.random().toString(36).slice(2)}`)
        await mkdir(testDir, { recursive: true })
        projectDir = getProjectPath(testDir)
        await mkdir(projectDir, { recursive: true })
        file = join(projectDir, `${sessionId}.jsonl`)
        modes = []
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
            onMessage: () => { },
            onPermissionModeObserved: (mode) => modes.push(mode),
        })
    }

    it('seeds from what the transcript already says, so a reconnect is not blank', async () => {
        await writeFile(file, stateBlock('bypassPermissions'))
        await start()
        await settle()
        expect(modes).toEqual(['bypassPermissions'])
    })

    it('reports a shift+tab at the keyboard on the next turn, with nothing restarting', async () => {
        await writeFile(file, stateBlock('bypassPermissions'))
        await start()
        await settle()

        await writeFile(file, stateBlock('bypassPermissions') + stateBlock('plan'))
        await settle()

        expect(modes).toEqual(['bypassPermissions', 'plan'])
    })

    it('says nothing while the mode holds, however many turns write it down', async () => {
        // Claude Code re-appends the record every turn even when nothing
        // changed. Each report is a metadata write that reaches the phone, so
        // the repetition has to die here.
        await writeFile(file, stateBlock('bypassPermissions'))
        await start()
        await settle()
        await writeFile(file, stateBlock('bypassPermissions').repeat(4))
        await settle()

        expect(modes).toEqual(['bypassPermissions'])
    })

    it('reports a mode the session comes back to', async () => {
        // The reason the record is keyed by line index rather than by value:
        // bypass -> plan -> bypass has to report bypass twice, and a value key
        // would have marked it history the first time.
        await writeFile(file, stateBlock('bypassPermissions'))
        await start()
        await settle()
        await writeFile(file, stateBlock('bypassPermissions') + stateBlock('plan'))
        await settle()
        await writeFile(file,
            stateBlock('bypassPermissions') + stateBlock('plan') + stateBlock('bypassPermissions'))
        await settle()

        expect(modes).toEqual(['bypassPermissions', 'plan', 'bypassPermissions'])
    })

    it('says nothing for a transcript that has never recorded a mode', async () => {
        await writeFile(file, JSON.stringify({
            type: 'assistant',
            uuid: 'u1',
            sessionId,
            message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'ok' }] },
        }) + '\n')
        await start()
        await settle()
        expect(modes).toEqual([])
    })
})
