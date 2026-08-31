/**
 * The pane -> app half of DROVE-63: is Remote Control on for this session?
 *
 * The button exists because `/remote-control` is only reachable by typing it in
 * the pane, and a button that cannot read the current state is a button that
 * lies. Nothing on disk answers it except the transcript. Measured on 2.1.251
 * before any of this was written:
 *
 *   - `~/.claude.json` carries `hasUsedRemoteControl`, `remoteControlSurfacesSeen`
 *     and `remoteControlReadyPushKey`. All three are install-wide upsell
 *     counters — `hasUsedRemoteControl` is true for Clay's whole install while
 *     three of the five per-account config dirs do not have the key at all.
 *   - Claude Code writes the real answer once per transition as its own record:
 *     `{"type":"bridge-session","bridgeSessionId":"cse_01…"}` when it comes up
 *     and the same record with `bridgeSessionId:""` when it goes down. 6649
 *     non-empty against 101 empty across 14 days of Clay's transcripts.
 *
 * The fixtures below are copied from real lines in those transcripts, not
 * invented, which is the lesson DROVE-37 paid for: a test that fakes the wire
 * format is a test of the fake.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createSessionScanner } from './sessionScanner'
import { getProjectPath } from './path'

const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-000000000063'

/** A live bridge. Shape taken from a real record, owner uuids and all. */
function bridgeUp(id: string) {
    return JSON.stringify({
        type: 'bridge-session',
        sessionId,
        bridgeSessionId: id,
        lastSequenceNum: 0,
        noHistoryBackfill: true,
        ownerAccountUuid: '727df8b6-1d62-440f-9369-9e48bc336724',
        ownerOrganizationUuid: '08b924a8-af53-4403-b91d-82a7fe86fe16',
    }) + '\n'
}

/** The teardown. Written for /remote-control off, shutdown, AND the DROVE-37
 * account_mismatch case — one record covers all three. */
function bridgeDown() {
    return JSON.stringify({
        type: 'bridge-session',
        sessionId,
        bridgeSessionId: '',
        lastSequenceNum: 0,
    }) + '\n'
}

/** The `/remote-control` invocation itself, which says nothing about the result. */
function slashRemoteControl(uuid: string) {
    return JSON.stringify({
        type: 'system',
        subtype: 'local_command',
        uuid,
        sessionId,
        content: '<command-name>/remote-control</command-name>\n            <command-message>remote-control</command-message>\n            <command-args></command-args>',
    }) + '\n'
}

/**
 * An ordinary turn, used only as a marker (DROVE-68).
 *
 * A pass that is meant to report NOTHING leaves no trace to wait for, and
 * sleeping through it cannot tell "read it and stayed quiet" from "has not
 * looked yet". Appending one of these gives that pass something the scanner
 * hands straight to onMessage, so the quiet is provably a decision.
 */
function turn(uuid: string) {
    return JSON.stringify({
        type: 'assistant',
        uuid,
        sessionId,
        message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'ok' }] },
    }) + '\n'
}

/** The DROVE-37 teardown notice that precedes the empty record. */
function accountChangedNotice(uuid: string) {
    return JSON.stringify({
        type: 'system',
        subtype: 'informational',
        uuid,
        sessionId,
        content: 'Remote Control disconnected — signed-in claude.ai account or organization changed on this machine — run /remote-control to start a session for the current account, or /login to switch back',
    }) + '\n'
}

describe('sessionScanner reports whether Remote Control is on', () => {
    let testDir: string
    let projectDir: string
    let file: string
    let states: boolean[]
    let seen: number
    let scanner: Awaited<ReturnType<typeof createSessionScanner>> | null = null

    /**
     * Wait for the scanner to have reported exactly this (DROVE-68).
     *
     * It used to sleep 200 ms after each write and read `states` once, so a
     * poll that had not come round yet failed as a wrong answer rather than a
     * late one. Same assertion, waited for instead of guessed at: an extra
     * report or a missing one still fails, with the same diff.
     */
    async function reports(expected: boolean[]): Promise<void> {
        await vi.waitFor(() => expect(states).toEqual(expected), { timeout: 2_000, interval: 10 })
    }

    /** Wait for the scanner to have delivered n records to onMessage. */
    async function delivered(n: number): Promise<void> {
        await vi.waitFor(() => expect(seen).toBeGreaterThanOrEqual(n), { timeout: 2_000, interval: 10 })
    }

    beforeEach(async () => {
        // Nothing here may reach the real drover bus.
        process.env.DROVER_URL = 'http://127.0.0.1:1'
        testDir = join(tmpdir(), `scanner-rc-${Date.now()}-${Math.random().toString(36).slice(2)}`)
        await mkdir(testDir, { recursive: true })
        projectDir = getProjectPath(testDir)
        await mkdir(projectDir, { recursive: true })
        file = join(projectDir, `${sessionId}.jsonl`)
        states = []
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
            onRemoteControlObserved: (active) => states.push(active),
        })
    }

    it('seeds from whatever the transcript already says, without waiting for a change', async () => {
        // The whole point of seeding: the app reconnects to a session that has
        // had Remote Control on for an hour and must show it as on now, not
        // after the next toggle.
        await writeFile(file, bridgeUp('cse_016JvrzhFqBofbFYxKr2kewj'))
        await start()
        await reports([true])
    })

    it('says nothing at all when the transcript has no bridge record', async () => {
        // Unknown is not off. A toggle typed on a guess can silence the very
        // session the button was meant to wake, so the scanner refuses to
        // guess and the launcher refuses to act.
        await writeFile(file, slashRemoteControl('u1'))
        await start()

        // A marker turn behind the bare /remote-control line, so the pass that
        // had nothing to go on is one this test can wait for instead of sleep
        // through. Still empty afterwards is the assertion: the scanner did
        // not guess "off" from a command with no record after it.
        await writeFile(file, slashRemoteControl('u1') + turn('u9'))
        await delivered(1)
        expect(states).toEqual([])
    })

    it('reports the disconnect when /remote-control is typed in the terminal', async () => {
        // Clay's acceptance criterion, mirrored from DROVE-45: running the
        // command in the pane has to reach the app without a restart.
        await writeFile(file, bridgeUp('cse_016JvrzhFqBofbFYxKr2kewj'))
        await start()
        await reports([true])

        await writeFile(file,
            bridgeUp('cse_016JvrzhFqBofbFYxKr2kewj')
            + slashRemoteControl('u1')
            + bridgeDown())
        await reports([true, false])
    })

    it('reports it coming back on, which a per-record dedupe would have eaten', async () => {
        await writeFile(file, bridgeUp('cse_01aaa'))
        await start()
        await reports([true])
        await writeFile(file, bridgeUp('cse_01aaa') + bridgeDown())
        await reports([true, false])
        await writeFile(file, bridgeUp('cse_01aaa') + bridgeDown() + bridgeUp('cse_01bbb'))
        await reports([true, false, true])
    })

    it('reads a reconnect as still on, not as a disconnect', async () => {
        // Measured: a reconnect writes the empty record and the new one back to
        // back (lines 1829/1830 of one of Clay's transcripts). Reading the
        // FIRST record in the pass rather than the newest would report off.
        await writeFile(file, bridgeUp('cse_01aaa'))
        await start()
        await reports([true])

        // The reconnect arrives in ONE write, as it does on the wire, with a
        // marker turn behind it: waiting for that turn to be delivered is
        // waiting for the pass that read the pair, so `[true]` here is the
        // scanner having looked and stayed quiet rather than not having looked.
        await writeFile(file,
            bridgeUp('cse_01aaa') + bridgeDown() + bridgeUp('cse_01bbb') + turn('u9'))
        await delivered(1)
        expect(states).toEqual([true])
    })

    it('reports the DROVE-37 teardown that nobody typed', async () => {
        // This is the case the button exists for: a flip bound the machine to
        // another account and Claude Code tore the bridge down on its own. The
        // app has to notice, or the toggle still shows on for a session that
        // has gone quiet.
        await writeFile(file, bridgeUp('cse_01aaa'))
        await start()
        await reports([true])

        await writeFile(file,
            bridgeUp('cse_01aaa')
            + accountChangedNotice('u1')
            + bridgeDown())
        await reports([true, false])
    })

    it('does not repeat itself while the bridge keeps rewriting its own record', async () => {
        // A live bridge rewrites the record as it goes. Reporting each one
        // would be a metadata write per line, which is what the title path had
        // to be taught not to do (DROVE-15).
        await writeFile(file, bridgeUp('cse_01aaa'))
        await start()
        await reports([true])
        // The rewrites go in with a marker turn behind them, so the pass that
        // read all three is one this test waits for. Still a single report
        // afterwards is the proof none of them was repeated.
        await writeFile(file, bridgeUp('cse_01aaa').repeat(3) + turn('u9'))
        await delivered(1)
        expect(states).toEqual([true])
    })
})
