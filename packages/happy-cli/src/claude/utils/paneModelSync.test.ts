import { beforeEach, describe, expect, it } from 'vitest'

import { createPaneCommandQueue, paneCommandsForSelection } from './paneModelSync'

beforeEach(() => {
    // Never let a unit test reach the real drover bus.
    process.env.DROVER_URL = 'http://127.0.0.1:1'
})

describe('paneCommandsForSelection', () => {
    it('turns a model pick into the /model command Claude Code takes', () => {
        expect(paneCommandsForSelection(
            { modelMode: 'claude-opus-5' },
            { modelMode: 'claude-sonnet-5' },
        )).toEqual(['/model claude-sonnet-5'])
    })

    it('turns an effort pick into /effort', () => {
        expect(paneCommandsForSelection(
            { effortLevel: 'high' },
            { effortLevel: 'xhigh' },
        )).toEqual(['/effort xhigh'])
    })

    it('sends the model first when both changed, because effort is capped by the model', () => {
        expect(paneCommandsForSelection(
            { modelMode: 'claude-opus-5', effortLevel: 'high' },
            { modelMode: 'claude-fable-5', effortLevel: 'xhigh' },
        )).toEqual(['/model claude-fable-5', '/effort xhigh'])
    })

    it('says nothing when nothing changed', () => {
        const same = { modelMode: 'claude-opus-5', effortLevel: 'xhigh' }
        expect(paneCommandsForSelection(same, { ...same })).toEqual([])
    })

    it('says nothing on the first sight of a selection the pane was already launched with', () => {
        // prev is seeded from the metadata the launcher booted with, so an
        // unchanged reconnect must not retype /model at the prompt.
        expect(paneCommandsForSelection(
            { modelMode: 'claude-opus-5' },
            { modelMode: 'claude-opus-5' },
        )).toEqual([])
    })

    it('reads an explicit null as a reset, which each command spells differently', () => {
        // MetadataSchema: explicit null means "reset to default", absent means
        // "never picked". /model has `default`; /effort has `auto`.
        expect(paneCommandsForSelection(
            { modelMode: 'claude-opus-5', effortLevel: 'xhigh' },
            { modelMode: null, effortLevel: null },
        )).toEqual(['/model default', '/effort auto'])
    })

    it('ignores a field going absent — that is not a pick, it is a metadata write that dropped it', () => {
        expect(paneCommandsForSelection(
            { modelMode: 'claude-opus-5', effortLevel: 'xhigh' },
            {},
        )).toEqual([])
    })

    it('refuses a value that is not a plain command argument', () => {
        // The string is typed at a live keyboard. A newline would submit half
        // of it as its own turn and run the rest as a prompt.
        expect(paneCommandsForSelection({}, { modelMode: 'claude-opus-5\nrm -rf /' })).toEqual([])
        expect(paneCommandsForSelection({}, { effortLevel: 'high; echo pwned' })).toEqual([])
    })

    it('turns a permission pick into the pseudo command the launcher interprets', () => {
        // NOT a slash command: 2.1.251 has none for the permission mode, so
        // this one is carried out by cycling shift+tab. The `#` is what tells
        // the launcher's send not to type it.
        expect(paneCommandsForSelection(
            { permissionMode: 'default' },
            { permissionMode: 'bypassPermissions' },
        )).toEqual(['#permission-mode bypassPermissions'])
    })

    it('resets the permission mode to default, which is what a null means here', () => {
        expect(paneCommandsForSelection(
            { permissionMode: 'plan' },
            { permissionMode: null },
        )).toEqual(['#permission-mode default'])
    })

    it('sets the permission mode before touching model or effort', () => {
        // Its carrier reads the pane's footer back after every keystroke, so
        // it has to run while the prompt is still the plain prompt — before a
        // /model that might open a consent dialog.
        expect(paneCommandsForSelection(
            { modelMode: 'claude-opus-5', effortLevel: 'high', permissionMode: 'default' },
            { modelMode: 'claude-fable-5', effortLevel: 'xhigh', permissionMode: 'bypassPermissions' },
        )).toEqual([
            '#permission-mode bypassPermissions',
            '/model claude-fable-5',
            '/effort xhigh',
        ])
    })

    it('keeps the bracket variant Claude Code accepts as part of a model id', () => {
        expect(paneCommandsForSelection({}, { modelMode: 'claude-opus-5[1m]' }))
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

    it('collapses repeated permission picks the same way, by kind', async () => {
        const sent: string[] = []
        const queue = createPaneCommandQueue({
            isIdle: async () => true,
            send: async (command) => { sent.push(command); return true },
        })

        // Yolo, then a change of mind to Plan, while the pane was mid-turn.
        // Two cycles at the prompt would leave the TUI walking a ring twice.
        queue.request(['#permission-mode bypassPermissions'])
        queue.request(['#permission-mode plan'])
        await queue.flush()

        expect(sent).toEqual(['#permission-mode plan'])
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
