import { describe, expect, it } from 'vitest'

import { answerPaneCreditsRow, type CreditsAnswerIo } from './paneCreditsAnswer'
import { paneComposerIsEmpty, paneConfirmDialog } from './paneCommandOutcome'
import { creditsSafeRow, paneCreditsDialog, paneCreditsDialogTitle } from './paneCreditsDialog'

/**
 * A pane that behaves the way 2.1.252's credits dialog behaves (DROVE-279).
 *
 * It renders the same two-column step the real one does, moves the pointer on
 * Down / Up, and closes on Enter or Escape — recording WHICH ROW the Enter
 * took, which is the fact every test below is really about. `refuseFirst`
 * reproduces the component's own 150ms `refuseInput` window, where a keystroke
 * is swallowed and the window restarts.
 */
function fakePane(
    title: string,
    rows: string[],
    opts: { focused?: number; refuseFirst?: number } = {},
) {
    let focused = opts.focused ?? 0
    let refusals = opts.refuseFirst ?? 0
    let closed: { how: 'enter'; label: string } | { how: 'escape' } | null = null
    const keys: string[] = []

    const render = (): string => {
        if (closed) return ['⏺ back at the transcript', '─'.repeat(40), '❯ ', '─'.repeat(40)].join('\n')
        return [
            '⏺ the turn above',
            '▔'.repeat(40),
            `   ${title}`,
            '   Fable 5 runs on usage credits.',
            '',
            ...rows.map((label, i) => `   ${i === focused ? '❯' : ' '} ${label}`),
        ].join('\n')
    }

    const io: CreditsAnswerIo = {
        capture: async () => render(),
        press: async (key) => {
            keys.push(key)
            if (refusals > 0) {
                // Swallowed, exactly as the real dialog swallows a keystroke
                // inside its refuse window. Nothing moves.
                refusals--
                return true
            }
            if (closed) return true
            if (key === 'Down') focused = Math.min(rows.length - 1, focused + 1)
            else if (key === 'Up') focused = Math.max(0, focused - 1)
            else if (key === 'Enter') closed = { how: 'enter', label: rows[focused] }
            else if (key === 'Escape') closed = { how: 'escape' }
            return true
        },
        // No real waiting: the loop's correctness comes from re-reading, not
        // from the delay, and a test that slept would only prove the clock.
        settle: async () => { },
    }
    return {
        io,
        keys,
        get closed() { return closed },
        get screen() { return render() },
    }
}

const picker = 'Switch to Fable 5?'
const declineRow = 'No, keep my current model'
const buyRow = 'Yes, buy usage credits'

describe('answerPaneCreditsRow', () => {
    it('walks the pointer to the chosen row and takes THAT row', async () => {
        const pane = fakePane(picker, [declineRow, buyRow])
        const result = await answerPaneCreditsRow(pane.io, buyRow)
        expect(result).toEqual({ state: 'typed', label: buyRow })
        // The human named the purchase, so the purchase is what was typed.
        expect(pane.closed).toEqual({ how: 'enter', label: buyRow })
        expect(pane.keys).toEqual(['Down', 'Enter'])
    })

    it('walks UP when the pointer is below the chosen row', async () => {
        const pane = fakePane(picker, [declineRow, buyRow], { focused: 1 })
        const result = await answerPaneCreditsRow(pane.io, declineRow)
        expect(result).toEqual({ state: 'typed', label: declineRow })
        expect(pane.keys).toEqual(['Up', 'Enter'])
        expect(pane.closed).toEqual({ how: 'enter', label: declineRow })
    })

    it('never presses Enter while the pointer is on a row it was not asked for', async () => {
        // THE INVARIANT. Three rows, the money row in the middle, the target
        // at the bottom: every intermediate state has the pointer on a row we
        // must not take, and the only Enter in the transcript is the last key.
        const pane = fakePane(picker, [declineRow, buyRow, 'Upgrade to Max'])
        const result = await answerPaneCreditsRow(pane.io, 'Upgrade to Max')
        expect(result).toEqual({ state: 'typed', label: 'Upgrade to Max' })
        expect(pane.keys).toEqual(['Down', 'Down', 'Enter'])
        expect(pane.keys.indexOf('Enter')).toBe(pane.keys.length - 1)
        expect(pane.closed).toEqual({ how: 'enter', label: 'Upgrade to Max' })
    })

    it('survives the refuse window by pressing again, not by pressing harder', async () => {
        // The real dialog swallows the first keystrokes and restarts its own
        // 150ms window. A computed key sequence would land two rows out; this
        // loop just re-reads and presses the same key again.
        const pane = fakePane(picker, [declineRow, buyRow], { refuseFirst: 2 })
        const result = await answerPaneCreditsRow(pane.io, buyRow)
        expect(result).toEqual({ state: 'typed', label: buyRow })
        expect(pane.closed).toEqual({ how: 'enter', label: buyRow })
        expect(pane.keys).toEqual(['Down', 'Down', 'Down', 'Enter'])
    })

    it('escapes rather than typing when there is no row it may take', async () => {
        const pane = fakePane(picker, [declineRow, buyRow])
        const result = await answerPaneCreditsRow(pane.io, null)
        expect(result.state).toBe('dismissed')
        expect(pane.closed).toEqual({ how: 'escape' })
        expect(pane.keys).toEqual(['Escape'])
    })

    it('escapes when the row it was told to take is no longer on screen', async () => {
        const pane = fakePane(picker, [declineRow, buyRow])
        const result = await answerPaneCreditsRow(pane.io, 'Continue with Fable 5')
        expect(result.state).toBe('dismissed')
        expect(pane.closed).toEqual({ how: 'escape' })
        // Not one Enter anywhere: an answer to a question that has changed is
        // not an answer to the question on screen.
        expect(pane.keys).toEqual(['Escape'])
    })

    it('escapes when two rows read the same, because the pointer cannot name one', async () => {
        const pane = fakePane(picker, [buyRow, buyRow])
        const result = await answerPaneCreditsRow(pane.io, buyRow)
        expect(result.state).toBe('dismissed')
        expect(pane.keys).toEqual(['Escape'])
    })

    it('says the dialog went, rather than typing at whatever replaced it', async () => {
        const io: CreditsAnswerIo = {
            capture: async () => '⏺ back at the transcript\n' + '─'.repeat(40) + '\n❯ \n' + '─'.repeat(40),
            press: async () => { throw new Error('nothing may be pressed at a pane with no dialog on it') },
            settle: async () => { },
        }
        expect(await answerPaneCreditsRow(io, declineRow)).toEqual({ state: 'gone' })
    })

    it('types nothing at a pane it cannot read', async () => {
        const io: CreditsAnswerIo = {
            capture: async () => null,
            press: async () => { throw new Error('nothing may be pressed blind') },
            settle: async () => { },
        }
        const result = await answerPaneCreditsRow(io, declineRow)
        expect(result.state).toBe('stuck')
    })
})

describe('the pane queue after an answer', () => {
    /**
     * The three predicates `paneAcceptsCommand` reads off the capture. The bus
     * and registry halves of that gate are IO; these three are the screen, and
     * the screen is what this ticket changed.
     */
    const screenAcceptsCommand = (capture: string) =>
        paneConfirmDialog(capture) === null &&
        paneCreditsDialogTitle(capture) === null &&
        paneComposerIsEmpty(capture)

    it('is blocked while the dialog is up and open again once a row is typed', async () => {
        const pane = fakePane(picker, [declineRow, buyRow])
        expect(screenAcceptsCommand(pane.screen)).toBe(false)
        await answerPaneCreditsRow(pane.io, buyRow)
        expect(screenAcceptsCommand(pane.screen)).toBe(true)
    })

    it('opens again on the timeout arm too — the safe row unblocks it just the same', async () => {
        const pane = fakePane(picker, [declineRow, buyRow])
        const safe = creditsSafeRow(paneCreditsDialog(pane.screen)!)
        expect(safe!.label).toBe(declineRow)
        const result = await answerPaneCreditsRow(pane.io, safe!.label)
        expect(result).toEqual({ state: 'typed', label: declineRow })
        // The safe row was taken, nothing was bought, and the queue is free.
        expect(pane.closed).toEqual({ how: 'enter', label: declineRow })
        expect(screenAcceptsCommand(pane.screen)).toBe(true)
    })

    it('opens again when even Escape is the only thing left', async () => {
        const pane = fakePane(picker, ['Maybe later', 'Continue with Fable 5'])
        expect(creditsSafeRow(paneCreditsDialog(pane.screen)!)).toBeNull()
        await answerPaneCreditsRow(pane.io, null)
        expect(pane.closed).toEqual({ how: 'escape' })
        expect(screenAcceptsCommand(pane.screen)).toBe(true)
    })
})
