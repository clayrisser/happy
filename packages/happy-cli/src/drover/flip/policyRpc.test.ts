/**
 * What the app's toggle actually does when it reaches the machine (DROVE-3).
 *
 * The handler is a forwarder, so the things worth pinning are the choices it
 * makes on its own: which key the write lands under, session versus machine
 * scope, and what happens before Claude has named the session. The bus itself
 * is stubbed here; policy.test.ts and a run against a real bus cover the
 * contract with engine/settings.js.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { registerDroverPolicyHandler, type DroverPolicyRequest, type DroverPolicyResponse } from './policyRpc'
import * as policy from './policy'

type Handler = (req: DroverPolicyRequest) => Promise<DroverPolicyResponse>

function managerStub() {
    const handlers = new Map<string, Handler>()
    return {
        manager: { registerHandler: (m: string, h: Handler) => handlers.set(m, h) } as never,
        call: (req: DroverPolicyRequest) => handlers.get('drover-policy')!(req),
    }
}

const empty = {
    capturedAt: 1,
    sessionId: null,
    effective: {},
    overrides: {},
    defaults: {},
    machine: {},
    builtIn: {},
    updatedAt: null,
    updatedBy: null,
}

describe('the drover-policy RPC (DROVE-3)', () => {
    const previousUrl = process.env.DROVER_URL

    beforeEach(() => {
        // Nothing here may reach a real bus; every call is stubbed below.
        process.env.DROVER_URL = 'http://127.0.0.1:1'
    })

    afterEach(() => {
        vi.restoreAllMocks()
        if (previousUrl === undefined) delete process.env.DROVER_URL
        else process.env.DROVER_URL = previousUrl
    })

    it('writes under the CLAUDE session id, which is the key the terminal uses', async () => {
        const write = vi.spyOn(policy, 'writeSessionPolicy').mockResolvedValue({ ok: true, policy: empty })
        const { manager, call } = managerStub()
        registerDroverPolicyHandler(manager, () => 'claude-session-id')

        await call({ scope: 'session', action: 'set', patch: { onLimit: 'auto' }, by: 'phone' })

        expect(write).toHaveBeenCalledWith('claude-session-id', { onLimit: 'auto' }, 'phone')
    })

    it('sends a defaults write to the machine layer, not the session', async () => {
        const defaults = vi.spyOn(policy, 'writeDefaultPolicy').mockResolvedValue({ ok: true, policy: empty })
        const session = vi.spyOn(policy, 'writeSessionPolicy')
        const { manager, call } = managerStub()
        registerDroverPolicyHandler(manager, () => 'claude-session-id')

        await call({ scope: 'defaults', action: 'set', patch: { onLimit: 'auto' }, by: 'phone' })

        expect(defaults).toHaveBeenCalledWith({ onLimit: 'auto' }, 'phone', 'claude-session-id')
        expect(session).not.toHaveBeenCalled()
    })

    it('refuses a session write before Claude has named the session', async () => {
        const write = vi.spyOn(policy, 'writeSessionPolicy')
        vi.spyOn(policy, 'readPolicy').mockResolvedValue(empty)
        const { manager, call } = managerStub()
        registerDroverPolicyHandler(manager, () => null)

        const result = await call({ scope: 'session', action: 'set', patch: { onLimit: 'auto' } })

        // Never written under the HAPPY id instead: a row the terminal cannot
        // see is worse than a clear "not yet".
        expect(write).not.toHaveBeenCalled()
        expect(result.ok).toBe(false)
        expect(result.error).toContain('no Claude Code session id yet')
    })

    it('still serves the machine defaults with no session at all — the daemon case', async () => {
        const defaults = vi.spyOn(policy, 'writeDefaultPolicy').mockResolvedValue({ ok: true, policy: empty })
        const { manager, call } = managerStub()
        registerDroverPolicyHandler(manager, () => null)

        const result = await call({ scope: 'defaults', action: 'set', patch: { onFamilyExhausted: 'fallback' } })

        expect(defaults).toHaveBeenCalledWith({ onFamilyExhausted: 'fallback' }, 'app', null)
        expect(result.ok).toBe(true)
    })

    it('clearing the defaults nulls the named keys, since there is no delete for them', async () => {
        const defaults = vi.spyOn(policy, 'writeDefaultPolicy').mockResolvedValue({ ok: true, policy: empty })
        const { manager, call } = managerStub()
        registerDroverPolicyHandler(manager, () => null)

        await call({ scope: 'defaults', action: 'clear', patch: { onLimit: 'auto' } })

        expect(defaults).toHaveBeenCalledWith({ onLimit: null }, 'app', null)
    })

    it('re-publishes so the app sees its own change without waiting for the poll', async () => {
        vi.spyOn(policy, 'writeSessionPolicy').mockResolvedValue({ ok: true, policy: { ...empty, effective: { onLimit: 'auto' } } })
        const seen: unknown[] = []
        const { manager, call } = managerStub()
        registerDroverPolicyHandler(manager, () => 'claude-session-id', (p) => seen.push(p))

        await call({ scope: 'session', action: 'set', patch: { onLimit: 'auto' } })

        expect(seen).toHaveLength(1)
    })
})
