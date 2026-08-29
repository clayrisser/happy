/**
 * The scanner must not re-read a transcript that has not changed.
 *
 * Its own poll is a flat `setInterval(..., 3000)`, and every tick used to pull
 * the WHOLE transcript into a string, split it and JSON.parse every line — then
 * skip every entry, because they were all processed the first time. On Clay's
 * live session (182MB, 63k lines) one pass measured 701ms, so the scanner never
 * finished before the next tick and held a core at 99% for five and a half
 * hours on a session that was doing nothing.
 *
 * Lives in its own file because it mocks node:fs/promises to count reads, and
 * that mock must not reach the rest of the scanner suite.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdir, writeFile, appendFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { existsSync } from 'node:fs'

const transcriptReads = { count: 0 }

vi.mock('node:fs/promises', async (importOriginal) => {
    const real = await importOriginal<typeof import('node:fs/promises')>()
    return {
        ...real,
        readFile: (p: any, ...rest: any[]) => {
            if (typeof p === 'string' && p.endsWith('.jsonl')) {
                transcriptReads.count++
            }
            return (real.readFile as any)(p, ...rest)
        },
    }
})

const { createSessionScanner } = await import('./sessionScanner')
const { getProjectPath } = await import('./path')

describe('sessionScanner rescan', () => {
    let testDir: string
    let projectDir: string
    let scanner: Awaited<ReturnType<typeof createSessionScanner>> | null = null

    beforeEach(async () => {
        testDir = join(tmpdir(), `scanner-rescan-${Date.now()}`)
        await mkdir(testDir, { recursive: true })
        projectDir = getProjectPath(testDir)
        await mkdir(projectDir, { recursive: true })
        transcriptReads.count = 0
    })

    afterEach(async () => {
        if (scanner) {
            await scanner.cleanup()
            scanner = null
        }
        if (existsSync(testDir)) await rm(testDir, { recursive: true, force: true })
        if (existsSync(projectDir)) await rm(projectDir, { recursive: true, force: true })
    })

    it('stops reading a transcript that has not changed, and picks it up again when it does', async () => {
        const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
        const file = join(projectDir, `${sessionId}.jsonl`)
        const line = (uuid: string) => JSON.stringify({
            type: 'user',
            uuid,
            sessionId,
            timestamp: new Date().toISOString(),
            message: { role: 'user', content: 'hi' },
        }) + '\n'

        await writeFile(file, line('11111111-1111-1111-1111-111111111111'))

        const seen: any[] = []
        scanner = await createSessionScanner({
            sessionId: null,
            workingDirectory: testDir,
            onMessage: (m) => seen.push(m),
        })
        scanner.onNewSession(sessionId)

        // Two full poll windows with the file untouched. Before the stat guard
        // this was three or more whole-file reads producing nothing.
        await new Promise(r => setTimeout(r, 7500))
        const idleReads = transcriptReads.count
        expect(idleReads).toBeLessThanOrEqual(2)

        // A real append must still be seen — the guard is a skip, not a stop.
        await appendFile(file, line('22222222-2222-2222-2222-222222222222'))
        await new Promise(r => setTimeout(r, 4000))
        expect(transcriptReads.count).toBeGreaterThan(idleReads)
        expect(seen.length).toBeGreaterThan(0)
    }, 20000)
})
