import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ debug: vi.fn() }))
vi.mock('@/ui/logger', () => ({ logger: { debug: mocks.debug } }))

import { startRelaunchGate } from './gate'
import type { StaleWatcher } from './staleWatcher'

function watcher(stale: boolean): StaleWatcher {
    let latched = stale
    return {
        tick: () => { const first = latched; latched = stale; return first && stale },
        stale: () => latched,
        loaded: () => null,
        pending: () => null,
    }
}

const transcriptId = '19c2f0a8-f803-4cb8-8bee-c68b6773e412'

function gateOver(over: {
    stale: boolean
    busy?: boolean
    turnIsOver?: () => Promise<boolean>
    childAlive?: boolean
    claudeSessionId?: string | null
    supervised?: boolean
    quietPolls?: number
}) {
    const abortChild = vi.fn()
    const announce = vi.fn()
    const gate = startRelaunchGate({
        watcher: watcher(over.stale),
        claudeSessionId: () => (over.claudeSessionId === undefined ? transcriptId : over.claudeSessionId),
        isBusy: () => over.busy ?? false,
        turnIsOver: over.turnIsOver ?? (async () => true),
        childAlive: () => over.childAlive ?? true,
        abortChild,
        announce,
        supervised: over.supervised ?? true,
        // One quiet poll unless a test says otherwise: the streak has its own
        // tests below, and every other case here is about a different rule.
        quietPolls: over.quietPolls ?? 1,
        pollMs: 60_000,
    })
    return { gate, abortChild, announce }
}

describe('startRelaunchGate', () => {
    beforeEach(() => vi.clearAllMocks())

    it('does nothing while the bundle is the one we loaded', async () => {
        const { gate, abortChild, announce } = gateOver({ stale: false })
        await gate.poll()
        expect(gate.requested()).toBe(false)
        expect(abortChild).not.toHaveBeenCalled()
        expect(announce).not.toHaveBeenCalled()
        gate.stop()
    })

    it('stops the child once the bundle is stale and the turn is over', async () => {
        const { gate, abortChild, announce } = gateOver({ stale: true })
        await gate.poll()
        expect(gate.requested()).toBe(true)
        expect(abortChild).toHaveBeenCalledTimes(1)
        expect(announce).toHaveBeenCalledWith(expect.stringContaining('resumed, not restarted'))
        gate.stop()
    })

    it('never stops a session whose fetch is in flight', async () => {
        // A stop is a SIGTERM and async subagents live inside that process
        // (BASED-135). It waits, with no timeout and no override.
        const { gate, abortChild, announce } = gateOver({ stale: true, busy: true })
        await gate.poll()
        await gate.poll()
        await gate.poll()
        expect(gate.requested()).toBe(false)
        expect(abortChild).not.toHaveBeenCalled()
        expect(announce).toHaveBeenCalledWith(expect.stringContaining('as soon as the current turn ends'))
        gate.stop()
    })

    it('never stops a session running a tool, however quiet the fetch counter is', async () => {
        // THE regression this gate shipped with and a live run caught
        // (2026-08-31). `isBusy` is the fd3 fetch counter, and a turn spends a
        // long tool call with no fetch in flight: a `sleep 150` in the pane
        // read quiet for every second of it, the streak filled in fifteen
        // seconds, and the bash tool was killed mid-run. The registry knows.
        const { gate, abortChild, announce } = gateOver({
            stale: true,
            busy: false,
            turnIsOver: async () => false,
            quietPolls: 1,
        })
        await gate.poll()
        await gate.poll()
        await gate.poll()
        expect(gate.requested()).toBe(false)
        expect(abortChild).not.toHaveBeenCalled()
        expect(announce).toHaveBeenCalledWith(expect.stringContaining('as soon as the current turn ends'))
        gate.stop()
    })

    it('treats a probe that throws as busy', async () => {
        // Unknown is never permission to stop a child that may be halfway
        // through a tool call.
        const { gate, abortChild } = gateOver({
            stale: true,
            turnIsOver: async () => { throw new Error('tmux went away') },
        })
        await gate.poll()
        await gate.poll()
        expect(gate.requested()).toBe(false)
        expect(abortChild).not.toHaveBeenCalled()
        gate.stop()
    })

    it('picks the relaunch up on the first poll after the turn ends', async () => {
        let over = false
        const abortChild = vi.fn()
        const gate = startRelaunchGate({
            watcher: watcher(true),
            claudeSessionId: () => transcriptId,
            isBusy: () => false,
            turnIsOver: async () => over,
            childAlive: () => true,
            abortChild,
            announce: () => { },
            supervised: true,
            quietPolls: 1,
            pollMs: 60_000,
        })
        await gate.poll()
        expect(abortChild).not.toHaveBeenCalled()
        over = true
        await gate.poll()
        expect(abortChild).toHaveBeenCalledTimes(1)
        expect(gate.requested()).toBe(true)
        gate.stop()
    })

    it('says so and gives up when nothing is supervising the process', async () => {
        // Exiting would end the session instead of continuing it.
        const { gate, abortChild, announce } = gateOver({ stale: true, supervised: false })
        await gate.poll()
        expect(gate.requested()).toBe(false)
        expect(abortChild).not.toHaveBeenCalled()
        expect(announce).toHaveBeenCalledWith(expect.stringContaining('older build of the CLI'))
        gate.stop()
    })

    it('waits rather than relaunching before the transcript has an id', async () => {
        // `--resume <id>` is the whole mechanism for keeping the conversation.
        const { gate, abortChild } = gateOver({ stale: true, claudeSessionId: null })
        await gate.poll()
        await gate.poll()
        expect(gate.requested()).toBe(false)
        expect(abortChild).not.toHaveBeenCalled()
        gate.stop()
    })

    it('waits when there is no child in the pane to stop', async () => {
        const { gate, abortChild } = gateOver({ stale: true, childAlive: false })
        await gate.poll()
        expect(gate.requested()).toBe(false)
        expect(abortChild).not.toHaveBeenCalled()
        gate.stop()
    })

    it('asks once, however many times it is polled afterwards', async () => {
        const { gate, abortChild } = gateOver({ stale: true })
        await gate.poll()
        await gate.poll()
        await gate.poll()
        expect(abortChild).toHaveBeenCalledTimes(1)
        gate.stop()
    })
})

describe('the quiet streak', () => {
    beforeEach(() => vi.clearAllMocks())

    it('waits for consecutive idle polls before stopping the child', async () => {
        // The registry is a file the child rewrites, so one sample can catch a
        // gap between two records. Three in a row is fifteen seconds.
        const { gate, abortChild } = gateOver({ stale: true, quietPolls: 3 })
        await gate.poll()
        await gate.poll()
        expect(abortChild).not.toHaveBeenCalled()
        await gate.poll()
        expect(abortChild).toHaveBeenCalledTimes(1)
        gate.stop()
    })

    it('a busy poll resets the streak', async () => {
        let over = true
        const abortChild = vi.fn()
        const gate = startRelaunchGate({
            watcher: watcher(true),
            claudeSessionId: () => transcriptId,
            isBusy: () => false,
            turnIsOver: async () => over,
            childAlive: () => true,
            abortChild,
            announce: vi.fn(),
            supervised: true,
            quietPolls: 3,
            pollMs: 60_000,
        })
        await gate.poll()
        await gate.poll()
        over = false
        await gate.poll()
        over = true
        await gate.poll()
        await gate.poll()
        expect(abortChild).not.toHaveBeenCalled()
        await gate.poll()
        expect(abortChild).toHaveBeenCalledTimes(1)
        gate.stop()
    })

    it('a poll that lands while another is still in flight is dropped, not counted', async () => {
        // The probe reads files and shells out to tmux, so a poll can outlive
        // its interval. Two overlapping polls would turn fifteen seconds of
        // required idle into five.
        let release: (() => void) | null = null
        let held = false
        const abortChild = vi.fn()
        const gate = startRelaunchGate({
            watcher: watcher(true),
            claudeSessionId: () => transcriptId,
            isBusy: () => false,
            // The first probe hangs until released; every one after it answers
            // at once, so the test is about the overlap and nothing else.
            turnIsOver: () => {
                if (held) return Promise.resolve(true)
                held = true
                return new Promise<boolean>((r) => { release = () => r(true) })
            },
            childAlive: () => true,
            abortChild,
            announce: vi.fn(),
            supervised: true,
            quietPolls: 2,
            pollMs: 60_000,
        })
        const first = gate.poll()
        await gate.poll()
        await gate.poll()
        release!()
        await first
        expect(abortChild).not.toHaveBeenCalled()
        await gate.poll()
        expect(abortChild).toHaveBeenCalledTimes(1)
        gate.stop()
    })
})
