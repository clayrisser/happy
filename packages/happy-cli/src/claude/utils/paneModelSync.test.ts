import { beforeEach, describe, expect, it } from 'vitest'

import { createPaneCommandQueue, parseRemoteControlRequest, remoteControlCommand, slashCommandsForSelection } from './paneModelSync'

beforeEach(() => {
    // Never let a unit test reach the real drover bus.
    process.env.DROVER_URL = 'http://127.0.0.1:1'
})

describe('slashCommandsForSelection', () => {
    it('turns a model pick into the /model command Claude Code takes', () => {
        expect(slashCommandsForSelection(
            { modelMode: 'claude-opus-5' },
            { modelMode: 'claude-sonnet-5' },
        )).toEqual(['/model claude-sonnet-5'])
    })

    it('turns an effort pick into /effort', () => {
        expect(slashCommandsForSelection(
            { effortLevel: 'high' },
            { effortLevel: 'xhigh' },
        )).toEqual(['/effort xhigh'])
    })

    it('sends the model first when both changed, because effort is capped by the model', () => {
        expect(slashCommandsForSelection(
            { modelMode: 'claude-opus-5', effortLevel: 'high' },
            { modelMode: 'claude-fable-5', effortLevel: 'xhigh' },
        )).toEqual(['/model claude-fable-5', '/effort xhigh'])
    })

    it('says nothing when nothing changed', () => {
        const same = { modelMode: 'claude-opus-5', effortLevel: 'xhigh' }
        expect(slashCommandsForSelection(same, { ...same })).toEqual([])
    })

    it('says nothing on the first sight of a selection the pane was already launched with', () => {
        // prev is seeded from the metadata the launcher booted with, so an
        // unchanged reconnect must not retype /model at the prompt.
        expect(slashCommandsForSelection(
            { modelMode: 'claude-opus-5' },
            { modelMode: 'claude-opus-5' },
        )).toEqual([])
    })

    it('reads an explicit null as a reset, which each command spells differently', () => {
        // MetadataSchema: explicit null means "reset to default", absent means
        // "never picked". /model has `default`; /effort has `auto`.
        expect(slashCommandsForSelection(
            { modelMode: 'claude-opus-5', effortLevel: 'xhigh' },
            { modelMode: null, effortLevel: null },
        )).toEqual(['/model default', '/effort auto'])
    })

    it('ignores a field going absent — that is not a pick, it is a metadata write that dropped it', () => {
        expect(slashCommandsForSelection(
            { modelMode: 'claude-opus-5', effortLevel: 'xhigh' },
            {},
        )).toEqual([])
    })

    it('refuses a value that is not a plain command argument', () => {
        // The string is typed at a live keyboard. A newline would submit half
        // of it as its own turn and run the rest as a prompt.
        expect(slashCommandsForSelection({}, { modelMode: 'claude-opus-5\nrm -rf /' })).toEqual([])
        expect(slashCommandsForSelection({}, { effortLevel: 'high; echo pwned' })).toEqual([])
    })

    it('keeps the bracket variant Claude Code accepts as part of a model id', () => {
        expect(slashCommandsForSelection({}, { modelMode: 'claude-opus-5[1m]' }))
            .toEqual(['/model claude-opus-5[1m]'])
    })
})

describe('createPaneCommandQueue', () => {
    it('holds a command until the prompt is idle, then types it once', async () => {
        let idle = false
        const sent: string[] = []
        const queue = createPaneCommandQueue({
            isIdle: async () => idle,
            send: async (command) => { sent.push(command); return true },
        })

        queue.request(['/model claude-sonnet-5'])
        await queue.flush()
        expect(sent).toEqual([])
        expect(queue.pending()).toEqual(['/model claude-sonnet-5'])

        idle = true
        await queue.flush()
        expect(sent).toEqual(['/model claude-sonnet-5'])
        expect(queue.pending()).toEqual([])

        // And it does not retype it on the next tick.
        await queue.flush()
        expect(sent).toEqual(['/model claude-sonnet-5'])
    })

    it('keeps a command that failed to reach the pane', async () => {
        const sent: string[] = []
        let ok = false
        const queue = createPaneCommandQueue({
            isIdle: async () => true,
            send: async (command) => { sent.push(command); return ok },
        })

        queue.request(['/effort xhigh'])
        await queue.flush()
        expect(queue.pending()).toEqual(['/effort xhigh'])

        ok = true
        await queue.flush()
        expect(sent).toEqual(['/effort xhigh', '/effort xhigh'])
        expect(queue.pending()).toEqual([])
    })

    it('collapses a rethink into one command per kind — the last pick wins', async () => {
        const sent: string[] = []
        const queue = createPaneCommandQueue({
            isIdle: async () => true,
            send: async (command) => { sent.push(command); return true },
        })

        // Three taps while the pane was mid-turn.
        queue.request(['/model claude-sonnet-5'])
        queue.request(['/model claude-fable-5'])
        queue.request(['/model claude-opus-5'])
        await queue.flush()

        expect(sent).toEqual(['/model claude-opus-5'])
    })

    it('stops after the first command that could not go in, so ordering holds', async () => {
        const sent: string[] = []
        const queue = createPaneCommandQueue({
            isIdle: async () => true,
            send: async (command) => { sent.push(command); return command.startsWith('/model') },
        })

        queue.request(['/model claude-fable-5', '/effort xhigh'])
        await queue.flush()

        expect(sent).toEqual(['/model claude-fable-5', '/effort xhigh'])
        expect(queue.pending()).toEqual(['/effort xhigh'])
    })

    it('never runs two flushes at once', async () => {
        let inFlight = 0
        let overlapped = false
        const queue = createPaneCommandQueue({
            isIdle: async () => true,
            send: async () => {
                inFlight++
                if (inFlight > 1) overlapped = true
                await new Promise((r) => setTimeout(r, 10))
                inFlight--
                return true
            },
        })

        queue.request(['/model claude-opus-5'])
        await Promise.all([queue.flush(), queue.flush(), queue.flush()])
        expect(overlapped).toBe(false)
    })
})

/**
 * DROVE-63. `/remote-control` is a toggle, so the decision to send it is a
 * decision about the pane's CURRENT state, not about the previous request.
 * Measured on 2.1.251: the command's own description flips to "Disconnect
 * Remote Control" while it is active, its only argument is an optional name
 * offered when it is off, and Clay running it twice three seconds apart
 * produced `Remote Control disconnected.` and then a fresh `cse_` bridge.
 */
describe('remoteControlCommand', () => {
    it('types the toggle when the pane is off and the app asked for on', () => {
        expect(remoteControlCommand(false, true)).toBe('/remote-control')
    })

    it('types the same one command to turn it off', () => {
        expect(remoteControlCommand(true, false)).toBe('/remote-control')
    })

    it('types nothing when the pane is already where the app asked', () => {
        expect(remoteControlCommand(true, true)).toBeNull()
        expect(remoteControlCommand(false, false)).toBeNull()
    })

    it('types nothing while the pane state is unknown', () => {
        // The one that would hurt: sending a toggle on a guess can silence the
        // session the tap was meant to wake.
        expect(remoteControlCommand(null, true)).toBeNull()
        expect(remoteControlCommand(null, false)).toBeNull()
    })

    it('treats no ask, and a withdrawn ask, as nothing to do', () => {
        expect(remoteControlCommand(false, undefined)).toBeNull()
        expect(remoteControlCommand(false, null)).toBeNull()
    })
})

describe('parseRemoteControlRequest', () => {
    it('reads the on/off strings the app writes', () => {
        expect(parseRemoteControlRequest('on')).toBe(true)
        expect(parseRemoteControlRequest('off')).toBe(false)
    })

    it('accepts a boolean, in case another client writes one', () => {
        expect(parseRemoteControlRequest(true)).toBe(true)
        expect(parseRemoteControlRequest(false)).toBe(false)
    })

    it('reads anything else as no request at all', () => {
        expect(parseRemoteControlRequest(null)).toBeNull()
        expect(parseRemoteControlRequest(undefined)).toBeNull()
        expect(parseRemoteControlRequest('yes')).toBeNull()
    })
})

describe('the queue can drop a command that stopped being right', () => {
    it('cancels a held toggle without touching a queued /model', async () => {
        const sent: string[] = []
        const queue = createPaneCommandQueue({
            isIdle: async () => true,
            send: async (command) => { sent.push(command); return true },
        })

        queue.request(['/model claude-opus-5', '/remote-control'])
        queue.cancel('/remote-control')
        await queue.flush()

        expect(sent).toEqual(['/model claude-opus-5'])
    })

    it('is a no-op when nothing of that kind is waiting', async () => {
        const queue = createPaneCommandQueue({
            isIdle: async () => true,
            send: async () => true,
        })
        queue.cancel('/remote-control')
        expect(queue.pending()).toEqual([])
    })
})
