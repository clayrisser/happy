import { describe, expect, it } from 'vitest'

import {
    modeCarryArgs,
    modeReconcileCommands,
    paneHoldsRequest,
    permissionModeFlagArgument,
} from './modeCarry'

describe('modeCarryArgs', () => {
    it('puts the session picks on the child argv so it boots on them', () => {
        expect(modeCarryArgs([], { modelMode: 'claude-opus-5', effortLevel: 'max' }))
            .toEqual(['--model', 'claude-opus-5', '--effort', 'max'])
    })

    it('carries the [1m] variant verbatim', () => {
        expect(modeCarryArgs([], { modelMode: 'claude-opus-5[1m]' }))
            .toEqual(['--model', 'claude-opus-5[1m]'])
    })

    it('carries nothing for a pick that was never made or was reset', () => {
        expect(modeCarryArgs(['--foo'], {})).toEqual(['--foo'])
        expect(modeCarryArgs(['--foo'], { modelMode: null, effortLevel: null, permissionMode: null }))
            .toEqual(['--foo'])
    })

    it('leaves what Clay typed on the command line alone', () => {
        const existing = ['--model', 'claude-sonnet-5', '--effort', 'low']
        expect(modeCarryArgs(existing, { modelMode: 'claude-opus-5', effortLevel: 'max' }))
            .toEqual(existing)
    })

    it('honours the =value spelling of an existing flag', () => {
        expect(modeCarryArgs(['--effort=low'], { effortLevel: 'max' })).toEqual(['--effort=low'])
    })

    it('never mutates the argv it was handed', () => {
        const existing = ['--dangerously-skip-permissions']
        modeCarryArgs(existing, { permissionMode: 'plan' })
        expect(existing).toEqual(['--dangerously-skip-permissions'])
    })

    it('refuses a value that could be read as another flag', () => {
        expect(modeCarryArgs([], { effortLevel: '--append-system-prompt' })).toEqual([])
        expect(modeCarryArgs([], { modelMode: 'a b' })).toEqual([])
    })

    describe('the permission mode, which is the field that can end the session', () => {
        it('drops --dangerously-skip-permissions so a narrower request is heard', () => {
            // Measured on 2.1.251: the skip flag beats --permission-mode.
            expect(modeCarryArgs(['--dangerously-skip-permissions'], { permissionMode: 'plan' }))
                .toEqual(['--permission-mode', 'plan'])
        })

        it('folds an app key to the Claude mode the flag takes', () => {
            expect(modeCarryArgs([], { permissionMode: 'yolo' }))
                .toEqual(['--permission-mode', 'bypassPermissions'])
            expect(modeCarryArgs([], { permissionMode: 'read-only' }))
                .toEqual(['--permission-mode', 'default'])
        })

        it('says bypass once, and leaves the skip flag to say it', () => {
            expect(modeCarryArgs(['--dangerously-skip-permissions'], { permissionMode: 'yolo' }))
                .toEqual(['--dangerously-skip-permissions'])
        })

        it('carries nothing for a mode this CLI does not know', () => {
            // --permission-mode with an unknown value makes commander refuse
            // the invocation, so the process would never start.
            expect(modeCarryArgs([], { permissionMode: 'from-a-newer-app' })).toEqual([])
            expect(permissionModeFlagArgument('from-a-newer-app')).toBeNull()
        })

        it('carries nothing when the argv already names one', () => {
            expect(modeCarryArgs(['--permission-mode', 'plan'], { permissionMode: 'yolo' }))
                .toEqual(['--permission-mode', 'plan'])
        })
    })
})

describe('paneHoldsRequest', () => {
    it('does not call the bracket variant a disagreement', () => {
        expect(paneHoldsRequest('model', { modelMode: 'claude-opus-5[1m]' }, { model: 'claude-opus-5' }))
            .toBe(true)
    })

    it('sees a model the pane really is not on', () => {
        expect(paneHoldsRequest('model', { modelMode: 'claude-fable-5' }, { model: 'claude-opus-5' }))
            .toBe(false)
    })

    it('folds the permission vocabularies', () => {
        expect(paneHoldsRequest('permissionMode', { permissionMode: 'yolo' }, { permissionMode: 'bypassPermissions' }))
            .toBe(true)
        expect(paneHoldsRequest('permissionMode', { permissionMode: null }, { permissionMode: 'default' }))
            .toBe(true)
        expect(paneHoldsRequest('permissionMode', { permissionMode: 'plan' }, { permissionMode: 'default' }))
            .toBe(false)
    })
})

describe('modeReconcileCommands', () => {
    it('is the whole of DROVE-232: a flip landed on the account default', () => {
        expect(modeReconcileCommands(
            { modelMode: 'claude-opus-5', effortLevel: 'max', permissionMode: 'yolo' },
            { model: 'claude-opus-5', effort: 'high', permissionMode: 'bypassPermissions' },
        )).toEqual(['/effort max'])
    })

    it('says nothing when the argv carry already landed', () => {
        expect(modeReconcileCommands(
            { modelMode: 'claude-opus-5', effortLevel: 'max', permissionMode: 'yolo' },
            { model: 'claude-opus-5', effort: 'max', permissionMode: 'bypassPermissions' },
        )).toEqual([])
    })

    it('puts the permission mode first and the model before the effort', () => {
        expect(modeReconcileCommands(
            { modelMode: 'claude-fable-5', effortLevel: 'ultracode', permissionMode: 'plan' },
            { model: 'claude-opus-5', effort: 'high', permissionMode: 'default' },
        )).toEqual(['#permission-mode plan', '/model claude-fable-5', '/effort ultracode'])
    })

    it('waits for an observation rather than guessing the pane is on default', () => {
        expect(modeReconcileCommands({ effortLevel: 'max', permissionMode: 'plan' }, {})).toEqual([])
    })

    it('resets the permission mode when the request was cleared', () => {
        expect(modeReconcileCommands({ permissionMode: null }, { permissionMode: 'plan' }))
            .toEqual(['#permission-mode default'])
    })

    it('does not retype a model the request never named', () => {
        expect(modeReconcileCommands({ effortLevel: 'max' }, { model: 'claude-sonnet-5', effort: 'max' }))
            .toEqual([])
    })
})
