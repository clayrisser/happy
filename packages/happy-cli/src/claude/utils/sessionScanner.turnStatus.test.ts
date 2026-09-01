/**
 * The wiring half of DROVE-344: the scanner reads Claude Code's registry, and
 * both consumers get the same fact.
 *
 * `turnStatus.test.ts` pins the reader and `liveStatus.test.ts` pins the
 * derivation. Neither proves the two are connected, and the connection is where
 * this class of bug lives — DROVE-257's `compacting` and DROVE-268's workflow
 * agents were both correct vocabularies that no signal ever reached.
 *
 * So this drives the real scanner against a real temp config dir and asserts
 * the two things the launcher depends on:
 *
 *   - a snapshot appears while the registry says `busy` and the transcript is
 *     silent, which is the phone's dot;
 *   - `onTurnStatusChange` fires on the transition, which is `session.thinking`
 *     and therefore the row's fallback when no snapshot has arrived yet.
 *
 * The registry record is copied off Clay's own live session (claude 2.1.257,
 * native installer), not invented — same rule DROVE-63's fixtures follow.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createSessionScanner } from './sessionScanner'
import { getProjectPath } from './path'
import type { LiveStatus } from './liveStatus'
import type { TurnStatus } from './turnStatus'

const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-000000000344'

/** The opening prompt of a turn, and then nothing — the model is composing. */
function prompt(at: number) {
    return JSON.stringify({
        type: 'user',
        isSidechain: false,
        uuid: `u-${at}`,
        sessionId,
        timestamp: new Date(at).toISOString(),
        message: { role: 'user', content: 'do the thing' },
    }) + '\n'
}

function registry(status: string, statusUpdatedAt: number) {
    return JSON.stringify({
        pid: 9710,
        sessionId,
        cwd: '/Users/clay/Projects/x',
        startedAt: statusUpdatedAt - 700,
        version: '2.1.257',
        kind: 'interactive',
        entrypoint: 'cli',
        tmux: 'cattle-drover:@1.%1',
        status,
        statusUpdatedAt,
    })
}

describe('sessionScanner reads Claude Code\'s own turn status (DROVE-344)', () => {
    let testDir: string
    let configDir: string
    let projectDir: string
    let transcript: string
    let statuses: (LiveStatus | null)[]
    let turns: (TurnStatus | null)[]
    let scanner: Awaited<ReturnType<typeof createSessionScanner>> | null = null

    beforeEach(async () => {
        // Nothing here may reach the real drover bus.
        process.env.DROVER_URL = 'http://127.0.0.1:1'
        testDir = join(tmpdir(), `scanner-turn-${Date.now()}-${Math.random().toString(36).slice(2)}`)
        configDir = join(testDir, 'config')
        await mkdir(join(configDir, 'sessions'), { recursive: true })
        await mkdir(join(testDir, 'work'), { recursive: true })
        projectDir = getProjectPath(join(testDir, 'work'), configDir)
        await mkdir(projectDir, { recursive: true })
        transcript = join(projectDir, `${sessionId}.jsonl`)
        statuses = []
        turns = []
    })

    afterEach(async () => {
        if (scanner) {
            await scanner.cleanup()
            scanner = null
        }
        if (existsSync(testDir)) await rm(testDir, { recursive: true, force: true })
    })

    const start = async () => {
        scanner = await createSessionScanner({
            sessionId,
            workingDirectory: join(testDir, 'work'),
            claudeConfigDir: configDir,
            onMessage: () => { },
            onLiveStatus: (status) => { statuses.push(status) },
            onTurnStatusChange: (turn) => { turns.push(turn) },
            liveStatusIntervalMs: 20,
        })
    }

    it('publishes a snapshot while the registry says busy and the transcript is silent', async () => {
        const now = Date.now()
        // The state Clay photographed: the turn opened 2m 14s ago and nothing
        // has been written since, because the assistant record is not written
        // until the message finishes streaming.
        await writeFile(transcript, prompt(now - 134_000))
        await writeFile(join(configDir, 'sessions', '9710.json'), registry('busy', now - 134_000))
        await start()
        await vi.waitFor(
            () => expect(statuses.some((s) => s?.main !== undefined)).toBe(true),
            { timeout: 3_000, interval: 10 },
        )
    })

    it('says nothing at all when the registry says idle, so green still means idle', async () => {
        const now = Date.now()
        await writeFile(transcript, prompt(now - 134_000))
        await writeFile(join(configDir, 'sessions', '9710.json'), registry('idle', now - 30_000))
        await start()
        // A marker rather than a sleep: wait until the registry has provably
        // been read at least once, then assert nothing was published. Sleeping
        // cannot tell "read it and stayed quiet" from "has not looked yet".
        await vi.waitFor(() => expect(turns.length).toBeGreaterThan(0), { timeout: 3_000, interval: 10 })
        expect(statuses.filter((s) => s !== null)).toEqual([])
    })

    it('reports the turn out to the launcher, once per transition and not per poll', async () => {
        const now = Date.now()
        const record = join(configDir, 'sessions', '9710.json')
        await writeFile(transcript, prompt(now - 134_000))
        await writeFile(record, registry('busy', now - 134_000))
        await start()
        await vi.waitFor(
            () => expect(turns.map((t) => t?.phase)).toEqual(['busy']),
            { timeout: 3_000, interval: 10 },
        )
        await writeFile(record, registry('idle', now))
        await vi.waitFor(
            () => expect(turns.map((t) => t?.phase)).toEqual(['busy', 'idle']),
            { timeout: 3_000, interval: 10 },
        )
        // Several more polls have run by now. A level, not an event.
        expect(turns.map((t) => t?.phase)).toEqual(['busy', 'idle'])
    })

    it('stays silent with no registry, so an older Claude behaves as it always did', async () => {
        const now = Date.now()
        await rm(join(configDir, 'sessions'), { recursive: true, force: true })
        await writeFile(transcript, prompt(now - 134_000))
        await start()
        // Nothing to report and nothing to publish. Unknown is not a
        // transition, so `onTurnStatusChange` does not fire on it either — the
        // launcher's flag starts false and null means false.
        expect(turns).toEqual([])
        expect(statuses.filter((s) => s !== null)).toEqual([])
        // And the loop was running the whole time, which is what makes the
        // quiet above a decision rather than a scanner that never looked: drop
        // the registry back in and the same loop picks it up.
        await mkdir(join(configDir, 'sessions'), { recursive: true })
        await writeFile(join(configDir, 'sessions', '9710.json'), registry('busy', now - 134_000))
        await vi.waitFor(
            () => expect(turns.map((t) => t?.phase)).toEqual(['busy']),
            { timeout: 3_000, interval: 10 },
        )
        await vi.waitFor(
            () => expect(statuses.some((s) => s?.main !== undefined)).toBe(true),
            { timeout: 3_000, interval: 10 },
        )
    })
})
