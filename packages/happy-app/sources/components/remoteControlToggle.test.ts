/**
 * The rule the Remote Control control lives or dies by (DROVE-63): it shows
 * what the pane reported, never what was last tapped. Clay's complaint about
 * the model picker was exactly this shape — the chip read "Fable 5" while the
 * pane ran Opus — and a toggle that lies is worse, because acting on it turns
 * the wrong thing off.
 */

import { describe, expect, it } from 'vitest'

import {
    atRiskListMaxAgeMs,
    findSessionForAtRisk,
    isAtRiskListFresh,
    parseRemoteControlAsk,
    resolveRemoteControlState,
    supportsRemoteControlToggle,
} from './remoteControlToggle'

describe('supportsRemoteControlToggle', () => {
    it('offers the control only for a session that is a Claude Code TUI in a pane', () => {
        expect(supportsRemoteControlToggle({ metadata: { hasPane: true } })).toBe(true)
    })

    it('hides it where there is no terminal for the command to reach', () => {
        expect(supportsRemoteControlToggle({ metadata: {} })).toBe(false)
        expect(supportsRemoteControlToggle({ metadata: null })).toBe(false)
        expect(supportsRemoteControlToggle(null)).toBe(false)
    })
})

describe('resolveRemoteControlState', () => {
    it('shows what the pane reported', () => {
        expect(resolveRemoteControlState({ metadata: { hasPane: true, paneRemoteControl: true } }))
            .toEqual({ value: true, pending: false, next: 'off' })
        expect(resolveRemoteControlState({ metadata: { hasPane: true, paneRemoteControl: false } }))
            .toEqual({ value: false, pending: false, next: 'on' })
    })

    it('keeps showing off while an on ask is still in flight', () => {
        // The pane may be mid-turn: a slash command waits for an idle prompt,
        // which can be minutes. Flipping the switch on the tap alone would say
        // the session is reachable when it is not.
        expect(resolveRemoteControlState({
            remoteControl: 'on',
            metadata: { hasPane: true, paneRemoteControl: false },
        })).toEqual({ value: false, pending: true, next: 'on' })
    })

    it('stops saying pending once the pane agrees', () => {
        expect(resolveRemoteControlState({
            remoteControl: 'on',
            metadata: { hasPane: true, paneRemoteControl: true },
        })).toEqual({ value: true, pending: false, next: 'off' })
    })

    it('treats a terminal-side change as the truth, ask or no ask', () => {
        // `/remote-control` typed in the pane while the app's last ask was
        // `off`. The transcript wins, and the control's next tap is the one
        // that undoes what the terminal just did.
        expect(resolveRemoteControlState({
            remoteControl: 'off',
            metadata: { hasPane: true, paneRemoteControl: true },
        })).toEqual({ value: true, pending: true, next: 'off' })
    })

    it('is unknown, not off, before the pane has said anything', () => {
        expect(resolveRemoteControlState({ metadata: { hasPane: true } }))
            .toEqual({ value: null, pending: false, next: 'on' })
    })

    it('reports an unanswered ask as pending even with nothing to show yet', () => {
        expect(resolveRemoteControlState({ remoteControl: 'on', metadata: { hasPane: true } }))
            .toEqual({ value: null, pending: true, next: null })
    })

    it('falls back to synced metadata for a session this device never touched', () => {
        // The local mirror is only populated once this client writes or
        // receives the pick; another device's ask arrives in metadata alone.
        expect(resolveRemoteControlState({
            metadata: { hasPane: true, paneRemoteControl: false, remoteControl: 'on' },
        })).toEqual({ value: false, pending: true, next: 'on' })
    })
})

describe('parseRemoteControlAsk', () => {
    it('reads the strings the pick transport carries', () => {
        expect(parseRemoteControlAsk('on')).toBe(true)
        expect(parseRemoteControlAsk('off')).toBe(false)
    })

    it('reads a cleared or unknown pick as no ask', () => {
        expect(parseRemoteControlAsk(null)).toBeNull()
        expect(parseRemoteControlAsk(undefined)).toBeNull()
        expect(parseRemoteControlAsk('maybe')).toBeNull()
    })
})

describe('findSessionForAtRisk', () => {
    const row = { id: '19c2f0a8-f803-4cb8-8bee-c68b6773e412', label: 'employees', account: 'main' }

    it('matches on the CLAUDE session id, which is what the bus reports', () => {
        // Measured against the live bus: its rows are keyed by the transcript's
        // uuid, not by the Happy session id. Matching on session.id alone finds
        // nothing, and the button would do nothing with no way to tell.
        const sessions = [
            { id: 'happy-a', metadata: { claudeSessionId: 'someone-else' } },
            { id: 'happy-b', metadata: { claudeSessionId: row.id } },
        ]
        expect(findSessionForAtRisk(sessions, row)?.id).toBe('happy-b')
    })

    it('still accepts a Happy id, so a bus that changes does not need this changed twice', () => {
        const sessions = [{ id: row.id, metadata: { claudeSessionId: 'other' } }]
        expect(findSessionForAtRisk(sessions, row)?.id).toBe(row.id)
    })

    it('returns null when the session is not on this device', () => {
        expect(findSessionForAtRisk([{ id: 'happy-a', metadata: {} }], row)).toBeNull()
    })
})

describe('isAtRiskListFresh', () => {
    const now = 1_700_000_000_000

    it('keeps the list while the flip is still the reason for the quiet', () => {
        expect(isAtRiskListFresh(now - 60_000, now)).toBe(true)
    })

    it('drops it once it is older than the sitting it belongs to', () => {
        expect(isAtRiskListFresh(now - atRiskListMaxAgeMs - 1, now)).toBe(false)
    })

    it('shows a list an older CLI wrote without a timestamp', () => {
        // Fold, never drop: an unknown age is not a reason to hide something
        // that names sessions Clay may still be missing.
        expect(isAtRiskListFresh(undefined, now)).toBe(true)
        expect(isAtRiskListFresh(null, now)).toBe(true)
    })
})
