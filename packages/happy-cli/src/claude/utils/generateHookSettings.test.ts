import { readFileSync, rmSync } from 'node:fs'

import { afterEach, describe, expect, it } from 'vitest'

import { cleanupHookSettingsFile, generateHookSettingsFile } from './generateHookSettings'
import { preCompactHookPath, sessionStartHookPath } from './startHookServer'

/**
 * DROVE-257 lives or dies on this registration.
 *
 * `PreCompact` is the ONLY signal that a compaction has started: nothing is
 * written to the transcript for the whole pass, and the fd 3 fetch counter
 * drops at the response headers while the summary streams for another two
 * minutes. Lose the hook and the phone's dot is green again, which is the bug
 * Clay photographed.
 */
describe('generateHookSettingsFile', () => {
    let written: string | null = null

    afterEach(() => {
        if (written) {
            cleanupHookSettingsFile(written)
            rmSync(written, { force: true })
        }
        written = null
    })

    const settings = (): Record<string, Array<{ matcher: string; hooks: Array<{ command: string }> }>> => {
        written = generateHookSettingsFile(45_678)
        return JSON.parse(readFileSync(written, 'utf8')).hooks
    }

    it('registers PreCompact against its own endpoint', () => {
        const hooks = settings()
        const command = hooks.PreCompact?.[0]?.hooks?.[0]?.command ?? ''
        expect(command).toContain('session_hook_forwarder.cjs')
        expect(command).toContain('45678')
        expect(command).toContain(preCompactHookPath)
    })

    it('leaves SessionStart on its own endpoint, explicitly', () => {
        // The forwarder's default is the session-start path, so this would
        // pass even if the argument were dropped. It is asserted anyway
        // because the two registrations now differ ONLY by that argument.
        const command = settings().SessionStart?.[0]?.hooks?.[0]?.command ?? ''
        expect(command).toContain(sessionStartHookPath)
        expect(command).not.toContain(preCompactHookPath)
    })

    it('matches both compaction triggers, since the dot means the same for either', () => {
        expect(settings().PreCompact?.[0]?.matcher).toBe('*')
    })
})
