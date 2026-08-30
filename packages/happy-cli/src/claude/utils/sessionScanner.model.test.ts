/**
 * The pane -> app half of DROVE-45.
 *
 * Clay's composer showed "Fable 5 - Ultracode" for a session whose pane was
 * running claude-opus-5[1m], because the picker reflected the app's stored
 * preference and nothing ever told it otherwise. The transcript has always
 * known: every real assistant turn carries `message.model` and a top-level
 * `effort`. This is the scanner reading them.
 *
 * Its own file rather than a case in sessionScanner.test.ts: that suite runs
 * the whole replay/flip/rescan story against one shared tmpdir per test, and
 * these want a transcript built one assistant entry at a time.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createSessionScanner, type ObservedRun } from './sessionScanner'
import { getProjectPath } from './path'

const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-000000000045'

function assistantTurn(uuid: string, model: string, effort?: string | null) {
    return JSON.stringify({
        type: 'assistant',
        uuid,
        sessionId,
        ...(effort === undefined ? {} : { effort }),
        message: { role: 'assistant', model, content: [{ type: 'text', text: 'ok' }] },
    }) + '\n'
}

const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms))

describe('sessionScanner reports the model the pane is running', () => {
    let testDir: string
    let projectDir: string
    let file: string
    let runs: ObservedRun[]
    let scanner: Awaited<ReturnType<typeof createSessionScanner>> | null = null

    beforeEach(async () => {
        // Nothing here may reach the real drover bus.
        process.env.DROVER_URL = 'http://127.0.0.1:1'
        testDir = join(tmpdir(), `scanner-model-${Date.now()}-${Math.random().toString(36).slice(2)}`)
        await mkdir(testDir, { recursive: true })
        projectDir = getProjectPath(testDir)
        await mkdir(projectDir, { recursive: true })
        file = join(projectDir, `${sessionId}.jsonl`)
        runs = []
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
            onRunObserved: (run) => runs.push(run),
        })
    }

    it('reports the newest real turn, with the effort it ran at', async () => {
        await writeFile(file, assistantTurn('u1', 'claude-fable-5', 'xhigh'))
        await start()
        await writeFile(file,
            assistantTurn('u1', 'claude-fable-5', 'xhigh')
            + assistantTurn('u2', 'claude-opus-5', 'high'))
        await settle()

        // The first report is the SEEDING one: what the session was already
        // running when the app reconnected, not something that just changed.
        expect(runs).toEqual([
            { model: 'claude-fable-5', effort: 'xhigh' },
            { model: 'claude-opus-5', effort: 'high' },
        ])
    })

    it('reports a /model typed in the terminal without anything restarting', async () => {
        // The acceptance criterion in Clay's own words: "if I /model from the
        // terminal it should always update the mobile app". A `/model` leaves
        // no record of its own — the evidence is the NEXT turn's model id.
        await writeFile(file, assistantTurn('u1', 'claude-opus-5', 'xhigh'))
        await start()
        await settle()
        expect(runs).toEqual([{ model: 'claude-opus-5', effort: 'xhigh' }])

        await writeFile(file,
            assistantTurn('u1', 'claude-opus-5', 'xhigh')
            + assistantTurn('u2', 'claude-sonnet-5', 'xhigh'))
        await settle()

        expect(runs.at(-1)).toEqual({ model: 'claude-sonnet-5', effort: 'xhigh' })
    })

    it('says nothing when the model has not changed', async () => {
        await writeFile(file, assistantTurn('u1', 'claude-opus-5', 'xhigh'))
        await start()
        await settle()
        await writeFile(file,
            assistantTurn('u1', 'claude-opus-5', 'xhigh')
            + assistantTurn('u2', 'claude-opus-5', 'xhigh'))
        await settle()

        expect(runs).toEqual([{ model: 'claude-opus-5', effort: 'xhigh' }])
    })

    it('reports a switch BACK, which a per-entry dedupe key would have eaten', async () => {
        await writeFile(file, assistantTurn('u1', 'claude-opus-5', 'xhigh'))
        await start()
        await settle()
        await writeFile(file,
            assistantTurn('u1', 'claude-opus-5', 'xhigh')
            + assistantTurn('u2', 'claude-sonnet-5', 'xhigh'))
        await settle()
        await writeFile(file,
            assistantTurn('u1', 'claude-opus-5', 'xhigh')
            + assistantTurn('u2', 'claude-sonnet-5', 'xhigh')
            + assistantTurn('u3', 'claude-opus-5', 'xhigh'))
        await settle()

        expect(runs.map((r) => r.model)).toEqual([
            'claude-opus-5', 'claude-sonnet-5', 'claude-opus-5',
        ])
    })

    it('notices an effort change on its own, with the model unchanged', async () => {
        await writeFile(file, assistantTurn('u1', 'claude-opus-5', 'high'))
        await start()
        await settle()
        await writeFile(file,
            assistantTurn('u1', 'claude-opus-5', 'high')
            + assistantTurn('u2', 'claude-opus-5', 'xhigh'))
        await settle()

        expect(runs).toEqual([
            { model: 'claude-opus-5', effort: 'high' },
            { model: 'claude-opus-5', effort: 'xhigh' },
        ])
    })

    it('ignores <synthetic>, which marks a harness notice rather than a turn', async () => {
        await writeFile(file, assistantTurn('u1', 'claude-opus-5', 'xhigh'))
        await start()
        await settle()
        await writeFile(file,
            assistantTurn('u1', 'claude-opus-5', 'xhigh')
            + assistantTurn('u2', '<synthetic>'))
        await settle()

        expect(runs).toEqual([{ model: 'claude-opus-5', effort: 'xhigh' }])
    })

    it('reports a turn with no effort field rather than dropping it', async () => {
        await writeFile(file, assistantTurn('u1', 'claude-opus-5'))
        await start()
        await settle()

        expect(runs).toEqual([{ model: 'claude-opus-5', effort: null }])
    })
})
