import { describe, expect, it } from 'vitest'

import {
    creditsRowSpends,
    creditsSafeRow,
    paneCreditsDialog,
    paneCreditsDialogTitle,
    paneCreditsTitles,
} from './paneCreditsDialog'

/**
 * Every fixture is shaped like a `tmux capture-pane -p` of Claude Code 2.1.252
 * with the credits dialog up. The row labels are the component's own strings,
 * lifted from the 2.1.252 binary rather than invented: `fe` for the first row,
 * `ye` for the second, and `X` for the optional upsell (DROVE-279).
 *
 * The dialog is drawn at a three-column indent with its rows stepped two
 * further, so the pointer sits in the prose's own column. That step IS the
 * parse, and it is the same one the "Change effort level?" fixture in
 * paneCommandOutcome.test.ts shows.
 */
const rule = '─'.repeat(40)

function screen(...lines: string[]): string {
    return lines.join('\n')
}

/** The picker variant: `/model claude-fable-5` at an idle prompt. */
const picker = screen(
    '❯ Write me a poem',
    '▔'.repeat(40),
    '   Switch to Fable 5?',
    '   Fable 5 runs on usage credits — you have $4.20 in credits.',
    '',
    '   ❯ No, keep my current model',
    '     Continue with Fable 5',
)

/** The mid-session variant Clay actually hits: the week's usage ran out. */
const midSession = screen(
    '⏺ Reading the file',
    '▔'.repeat(40),
    "   You've reached your Fable 5 limit",
    "   You've used your included Fable 5 usage for this week. Continuing on Fable 5 uses usage credits, purchased separately from your plan.",
    '   You don\'t have usage credits yet.',
    '',
    '   ❯ Switch to Opus 4.8 and continue',
    '     Yes, buy usage credits',
)

/** Three rows: the upsell `X` is appended after `confirm`. */
const withUpsell = screen(
    '   Fable 5 now uses usage credits',
    '   Fable 5 runs on usage credits, purchased separately from your plan.',
    '',
    '     Not now',
    '   ❯ Buy usage credits',
    '     Upgrade to Max and get Fable 5 included',
)

/** The state it OPENS in. A title, a spinner, and no rows to read. */
const loading = screen(
    '   Switch to Fable 5?',
    '   Checking usage credits…',
)

/** An ordinary session with nothing of the sort on screen. */
const idle = screen(
    '⏺ banana',
    rule,
    '❯ ',
    rule,
    '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
)

describe('paneCreditsDialogTitle', () => {
    it('knows all three spellings, including the one with no rows yet', () => {
        expect(paneCreditsDialogTitle(picker)).toBe('Switch to Fable 5?')
        expect(paneCreditsDialogTitle(midSession)).toBe("You've reached your Fable 5 limit")
        expect(paneCreditsDialogTitle(withUpsell)).toBe('Fable 5 now uses usage credits')
        // The spinner step still holds the keyboard, so the gate still has to
        // refuse — which is why this is a separate, cheaper check than the
        // full read.
        expect(paneCreditsDialogTitle(loading)).toBe('Switch to Fable 5?')
        expect(paneCreditsDialogTitle(idle)).toBeNull()
    })

    it('carries the three titles measured in the 2.1.252 binary', () => {
        expect([...paneCreditsTitles]).toEqual([
            'Switch to Fable 5?',
            "You've reached your Fable 5 limit",
            'Fable 5 now uses usage credits',
        ])
    })
})

describe('paneCreditsDialog', () => {
    it('reads the rows the pane actually drew, in order, with the pointer', () => {
        const dialog = paneCreditsDialog(picker)
        expect(dialog).not.toBeNull()
        expect(dialog!.title).toBe('Switch to Fable 5?')
        expect(dialog!.rows).toEqual([
            { index: 0, label: 'No, keep my current model', focused: true },
            { index: 1, label: 'Continue with Fable 5', focused: false },
        ])
        expect(dialog!.focusedIndex).toBe(0)
    })

    it('keeps the prose out of the rows, and the rows out of the prose', () => {
        const dialog = paneCreditsDialog(picker)!
        expect(dialog.body).toBe('Fable 5 runs on usage credits — you have $4.20 in credits.')
        expect(dialog.rows.map((r) => r.label)).not.toContain(dialog.body)
    })

    it('reads a third row, and a pointer that is not on the first', () => {
        const dialog = paneCreditsDialog(withUpsell)!
        expect(dialog.rows.map((r) => r.label)).toEqual([
            'Not now',
            'Buy usage credits',
            'Upgrade to Max and get Fable 5 included',
        ])
        expect(dialog.focusedIndex).toBe(1)
    })

    it('answers null for a screen with nothing answerable on it', () => {
        expect(paneCreditsDialog(idle)).toBeNull()
        // The spinner step: the title is up, the rows are not. Null here means
        // "look again in a moment", never "there is no dialog".
        expect(paneCreditsDialog(loading)).toBeNull()
        expect(paneCreditsDialog('')).toBeNull()
    })

    it('refuses a half-drawn screen rather than reading it as a choice', () => {
        // No pointer at all: the component always focuses a row, so a read
        // that finds none has caught a repaint.
        const noPointer = screen(
            '   Switch to Fable 5?',
            '     No, keep my current model',
            '     Continue with Fable 5',
        )
        expect(paneCreditsDialog(noPointer)).toBeNull()
        // One row only: not this component, which always draws switch AND
        // confirm.
        const oneRow = screen('   Switch to Fable 5?', '   ❯ No, keep my current model')
        expect(paneCreditsDialog(oneRow)).toBeNull()
    })

    it('does not read the composer below the dialog as a row', () => {
        const withComposer = screen(
            '   Switch to Fable 5?',
            '   Fable 5 runs on usage credits.',
            '',
            '   ❯ No, keep my current model',
            '     Continue with Fable 5',
            rule,
            '❯ a half typed line',
            rule,
        )
        const dialog = paneCreditsDialog(withComposer)!
        expect(dialog.rows.map((r) => r.label)).toEqual([
            'No, keep my current model',
            'Continue with Fable 5',
        ])
    })
})

describe('creditsRowSpends', () => {
    it('names every confirming row the 2.1.252 component can draw', () => {
        for (const label of [
            'Continue with Fable 5',
            'Yes, re-enable and continue',
            'Yes, buy usage credits',
            'Buy usage credits',
            'Set up usage credits on claude.ai',
            'Manage usage credits on claude.ai',
            'Request usage credits from your admin',
            'Request more from your admin',
        ]) {
            expect(creditsRowSpends(label), label).toBe(true)
        }
    })

    it('does not name a decline', () => {
        expect(creditsRowSpends('No, keep my current model')).toBe(false)
        expect(creditsRowSpends('Not now')).toBe(false)
        expect(creditsRowSpends('Switch to Opus 4.8 and continue')).toBe(false)
    })
})

describe('creditsSafeRow', () => {
    it('finds the decline in each of its three spellings', () => {
        expect(creditsSafeRow(paneCreditsDialog(picker)!)!.label).toBe('No, keep my current model')
        expect(creditsSafeRow(paneCreditsDialog(midSession)!)!.label).toBe(
            'Switch to Opus 4.8 and continue',
        )
        expect(creditsSafeRow(paneCreditsDialog(withUpsell)!)!.label).toBe('Not now')
    })

    it('never names a row that spends, whatever position it is in', () => {
        // The rows the wrong way up. Position is not the test; the text is.
        const inverted = screen(
            '   Switch to Fable 5?',
            '   Fable 5 runs on usage credits.',
            '',
            '   ❯ Yes, buy usage credits',
            '     No, keep my current model',
        )
        expect(creditsSafeRow(paneCreditsDialog(inverted)!)!.label).toBe('No, keep my current model')
    })

    it('refuses a row that reads as a decline AND spends, which is the only case the spend check decides', () => {
        // THE GUARD THIS PINS is `if (creditsRowSpends(row.label)) continue`,
        // and before this test nothing reached it: every spending label the
        // component ships today ("Yes, buy usage credits") matches no
        // declining pattern, so the declining test alone already skipped it.
        // Delete the spend check and the whole suite still passed — measured.
        //
        // It bites on an OVERLAP, which a rewording can produce without anyone
        // noticing: `^switch to .+ and continue$` is a decline, `usage credits`
        // spends, and one label can satisfy both. Taking it would buy credits
        // on a timeout nobody saw. Null is the right answer — the caller
        // presses Escape, which buys nothing.
        const overlapping = screen(
            '   Switch to Fable 5?',
            '   Fable 5 runs on usage credits.',
            '',
            '   ❯ Switch to Fable 5 with usage credits and continue',
            '     Yes, buy usage credits',
        )
        const dialog = paneCreditsDialog(overlapping)!
        // Both rows spend, so neither may be taken, decline-shaped or not.
        expect(creditsRowSpends('Switch to Fable 5 with usage credits and continue')).toBe(true)
        expect(creditsSafeRow(dialog)).toBeNull()
    })

    it('answers null rather than guessing when no row reads as a decline', () => {
        // A build that renames the decline is a build this file has not been
        // measured against. Null sends the caller to Escape, which buys
        // nothing either; a guess here would be the one that spends.
        const unknown = screen(
            '   Switch to Fable 5?',
            '   Fable 5 runs on usage credits.',
            '',
            '   ❯ Maybe later, I suppose',
            '     Continue with Fable 5',
        )
        expect(creditsSafeRow(paneCreditsDialog(unknown)!)).toBeNull()
    })
})
