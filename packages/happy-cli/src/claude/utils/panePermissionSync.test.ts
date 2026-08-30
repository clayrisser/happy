import { beforeEach, describe, expect, it } from 'vitest'

import { cyclePaneMode, paneModeFromCapture, type PaneMode } from './panePermissionSync'

beforeEach(() => {
    // Never let a unit test reach the real drover bus.
    process.env.DROVER_URL = 'http://127.0.0.1:1'
})

/**
 * The real thing, captured off Clay's pane on 2026-08-30 with
 * `tmux capture-pane -p`. Kept verbatim — the point of these tests is that the
 * parse survives the footer as Claude Code actually draws it, truncation and
 * separators included, not a tidied-up version of it.
 */
const liveFooter = [
    '⏺ Running 1 shell command…',
    '',
    '✻ Catapulting… (29s · ↓ 1.3k tokens)',
    '',
    '────────────────────────────────────────────────────────────── DROVER ─',
    '❯ ',
    '───────────────────────────────────────────────────────────────────────',
    '  ⏵⏵ bypass permissions on · 2 shells · esc to interrupt · ← for agents · ↓ …',
].join('\n')

describe('paneModeFromCapture', () => {
    it('reads the mode off a live pane footer', () => {
        expect(paneModeFromCapture(liveFooter)).toBe('bypassPermissions')
    })

    it.each<[string, PaneMode]>([
        ['  ⏵⏵ accept edits on · ? for shortcuts', 'acceptEdits'],
        ['  ⏸ plan mode on · ? for shortcuts', 'plan'],
        ['  ⏵⏵ auto mode on · ? for shortcuts', 'auto'],
        ["  ⏵⏵ don't ask on · ? for shortcuts", 'dontAsk'],
        ['  ⏸ manual mode on · ? for shortcuts', 'default'],
    ])('reads %s', (footer, expected) => {
        expect(paneModeFromCapture(`❯ \n${footer}`)).toBe(expected)
    })

    it('reads a footer with no mode chip as manual mode', () => {
        // Manual mode is the one Claude Code may draw no chip for, so the
        // prompt marker is what makes an absent chip mean something.
        expect(paneModeFromCapture('❯ \n  ? for shortcuts')).toBe('default')
    })

    it('refuses to guess when there is no prompt on screen', () => {
        // A shell, a full-screen dialog, a pane that scrolled the footer away.
        // Anything but null here would have us press shift+tab at whatever is
        // there — the exact keystroke-on-a-dialog failure the idle gate exists
        // to prevent.
        expect(paneModeFromCapture('$ ls\nREADME.md\n')).toBeNull()
        expect(paneModeFromCapture('')).toBeNull()
    })

    it('does not mistake the shortcut tip for the footer chip', () => {
        // Claude Code prints this tip in the conversation, above the prompt.
        // It names every mode and none of them is the current one.
        const tip = '  ⎿  Tip: Hit shift+tab to cycle between manual mode, auto-accept edit mode,\n'
            + '     and plan mode\n❯ \n  ? for shortcuts'
        expect(paneModeFromCapture(tip)).toBe('default')
    })
})

/** A fake pane that walks a fixed ring, the way Claude Code's own cycle does. */
function fakePane(ring: PaneMode[], start: PaneMode) {
    let index = ring.indexOf(start)
    const presses: number[] = []
    return {
        presses,
        at: () => ring[index],
        read: async () => ring[index] as PaneMode | null,
        press: async () => {
            presses.push(1)
            index = (index + 1) % ring.length
            return true
        },
        settle: async () => { },
    }
}

describe('cyclePaneMode', () => {
    it('does nothing when the pane is already in the mode asked for', async () => {
        const pane = fakePane(['plan', 'default', 'acceptEdits'], 'default')
        expect(await cyclePaneMode('default', pane)).toBe('applied')
        expect(pane.presses).toHaveLength(0)
    })

    it('presses shift+tab until the footer says the mode it was asked for', async () => {
        // The full ring, in Claude Code's own order (measured from the binary:
        // plan, default, acceptEdits, then auto and bypassPermissions when
        // each is available).
        const pane = fakePane(['plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions'], 'default')
        expect(await cyclePaneMode('bypassPermissions', pane)).toBe('applied')
        expect(pane.at()).toBe('bypassPermissions')
        expect(pane.presses).toHaveLength(3)
    })

    it('walks the pane back where it started when the mode is not in this session\'s ring', async () => {
        // Bypass disabled by settings, so it is simply absent from the cycle.
        // Landing on whatever the last press reached would change a mode
        // nobody picked, which is worse than not trying.
        const pane = fakePane(['plan', 'default', 'acceptEdits'], 'acceptEdits')
        expect(await cyclePaneMode('bypassPermissions', pane)).toBe('unreachable')
        expect(pane.at()).toBe('acceptEdits')
    })

    it('presses nothing at all when it cannot see the prompt', async () => {
        let presses = 0
        expect(await cyclePaneMode('bypassPermissions', {
            read: async () => null,
            press: async () => { presses++; return true },
            settle: async () => { },
        })).toBe('unreadable')
        expect(presses).toBe(0)
    })

    it('stops the moment the prompt goes away mid-cycle', async () => {
        // A turn started, or a dialog opened, between two presses. Pressing on
        // would aim at whatever is there now.
        let reads = 0
        let presses = 0
        expect(await cyclePaneMode('bypassPermissions', {
            read: async () => (reads++ === 0 ? 'default' : null),
            press: async () => { presses++; return true },
            settle: async () => { },
        })).toBe('unreadable')
        expect(presses).toBe(1)
    })

    it('reports a keystroke that did not go in, so the caller can retry', async () => {
        expect(await cyclePaneMode('plan', {
            read: async () => 'default',
            press: async () => false,
            settle: async () => { },
        })).toBe('refused')
    })

    it('gives up rather than spin when a press leaves the mode where it was', async () => {
        // A pane that takes the keystroke and does nothing with it: not a ring
        // at all, so no number of presses reaches the target.
        let presses = 0
        expect(await cyclePaneMode('plan', {
            read: async () => 'default',
            press: async () => { presses++; return true },
            settle: async () => { },
        })).toBe('unreachable')
        expect(presses).toBe(1)
    })
})
