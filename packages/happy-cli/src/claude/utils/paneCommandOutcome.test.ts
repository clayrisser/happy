import { describe, expect, it } from 'vitest'

import {
    paneCommandKind,
    paneCommandOutcome,
    paneComposerIsEmpty,
    paneComposerText,
    paneConfirmDialog,
    paneUltracodeActive,
} from './paneCommandOutcome'

/**
 * Every fixture below is a `tmux capture-pane -p` of Claude Code 2.1.251 on
 * `claude-opus-5[1m]`, trimmed to the rows that matter and with the rules cut
 * to a width a test file can hold. DROVE-164.
 */
const rule = '─'.repeat(40)

function screen(...lines: string[]): string {
    return lines.join('\n')
}

const idle = screen(
    '⏺ banana',
    '',
    '✻ Cogitated for 3s · done 8:10 AM',
    rule,
    '❯ ',
    rule,
    '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
)

const drafted = screen(
    '⏺ banana',
    rule,
    '❯ my half typed draft',
    rule,
    '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
)

const fresh = screen(
    '  ▝▝ ▝▝    /private/tmp/effort-test',
    rule,
    '❯ Try "fix typecheck errors"',
    rule,
    '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
)

const ultracode = screen(
    '  ⎿  Set effort level to ultracode (this session only): xhigh + dynamic workflow orchestration',
    `${rule} ultracode ─`,
    '❯ ',
    rule,
    '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
)

const confirming = screen(
    '❯ Write 60 haiku about the sea',
    '▔'.repeat(40),
    '   Change effort level?',
    '   Your next response will be slower and use more tokens',
    '',
    '   This conversation is cached for the current effort level. Switching to xhigh means the full history gets re-read on your next message.',
    '',
    '   ❯ 1. Yes, switch to xhigh',
    '     2. No, go back',
)

describe('paneComposerText', () => {
    it('reads what is typed in the input box', () => {
        expect(paneComposerText(drafted)).toBe('my half typed draft')
        expect(paneComposerText(idle)).toBe('')
    })

    it('answers null rather than "empty" when there is no box to read', () => {
        expect(paneComposerText('a shell prompt\n$ ')).toBeNull()
        expect(paneComposerText('')).toBeNull()
    })
})

describe('paneComposerIsEmpty', () => {
    it('is the gate a picker command passes', () => {
        expect(paneComposerIsEmpty(idle)).toBe(true)
        expect(paneComposerIsEmpty(ultracode)).toBe(true)
        // The placeholder occupies the box on a session nobody has typed into.
        expect(paneComposerIsEmpty(fresh)).toBe(true)
    })

    it('holds the command rather than joining a half-typed line', () => {
        expect(paneComposerIsEmpty(drafted)).toBe(false)
        // Unreadable is not empty. The cost of the false is two seconds.
        expect(paneComposerIsEmpty('nothing that looks like a TUI')).toBe(false)
    })
})

describe('paneConfirmDialog', () => {
    it('recognises both spellings of the same component', () => {
        expect(paneConfirmDialog(confirming)).toBe('effort')
        expect(paneConfirmDialog('   Switch model?\n   ❯ 1. Yes, switch to Fable 5')).toBe('model')
        expect(paneConfirmDialog(idle)).toBeNull()
    })
})

describe('paneUltracodeActive', () => {
    it('reads the one place ultracode is written down', () => {
        // The transcript records ultracode as `xhigh`; the composer's top rule
        // is the only surface that says the word.
        expect(paneUltracodeActive(ultracode)).toBe(true)
        expect(paneUltracodeActive(idle)).toBe(false)
        expect(paneUltracodeActive('')).toBe(false)
    })
})

describe('paneCommandOutcome', () => {
    it('sees the confirmation that used to swallow every effort pick', () => {
        expect(paneCommandOutcome(idle, confirming, 'effort')).toEqual({ state: 'confirm' })
    })

    it('does not re-answer a confirmation that was already up', () => {
        expect(paneCommandOutcome(confirming, confirming, 'effort')).toEqual({ state: 'pending' })
    })

    it('reads the level the pane says it settled on', () => {
        expect(paneCommandOutcome(idle, ultracode, 'effort'))
            .toEqual({ state: 'applied', value: 'ultracode' })
    })

    it('reports a refusal in Claude Code\'s own words', () => {
        const refused = screen(
            "  ⎿  Ultracode runs at xhigh effort, which claude-opus-4-6 doesn't support — switch to an xhigh-capable model (Fable 5, Opus 4.7+, Sonnet 5). Valid options are: low, medium, high, max, auto",
            rule,
            '❯ ',
            rule,
        )
        const outcome = paneCommandOutcome(idle, refused, 'effort')
        expect(outcome.state).toBe('refused')
        expect(outcome).toMatchObject({ message: expect.stringContaining("doesn't support") })
    })

    it('reports an unknown level as refused rather than applied', () => {
        const refused = screen('  ⎿  Invalid argument: turbo. Valid options are: low, medium, high, xhigh, max, ultracode, auto', rule, '❯ ', rule)
        expect(paneCommandOutcome(idle, refused, 'effort'))
            .toMatchObject({ state: 'refused', message: expect.stringContaining('Invalid argument: turbo') })
    })

    it('ignores a result line that was already on screen before we typed', () => {
        // A pane keeps its scrollback. "Set effort level to high" from ten
        // minutes ago is not an answer about the command just sent.
        const before = screen('  ⎿  Set effort level to high (this session only)', rule, '❯ ', rule)
        expect(paneCommandOutcome(before, before, 'effort')).toEqual({ state: 'pending' })
    })

    it('reads the NEWEST result, not the one still in the scrollback', () => {
        // Measured on a real session: `/effort max` typed after `/effort low`
        // came back as "no answer from the pane", because the first match on
        // screen was the previous command's and it was in both captures.
        const before = screen('  ⎿  Set effort level to low (saved as your default)', rule, '❯ ', rule)
        const after = screen(
            '  ⎿  Set effort level to low (saved as your default)',
            '❯ /effort max',
            '  ⎿  Set effort level to max (this session only): Maximum capability with deepest',
            '     reasoning.',
            rule, '❯ ', rule,
        )
        expect(paneCommandOutcome(before, after, 'effort')).toEqual({ state: 'applied', value: 'max' })
    })

    it('still sees the newest result when its predecessor scrolled off the top', () => {
        const before = screen('  ⎿  Set effort level to low (saved as your default)', rule, '❯ ', rule)
        const after = screen('  ⎿  Set effort level to max (this session only)', rule, '❯ ', rule)
        expect(paneCommandOutcome(before, after, 'effort')).toEqual({ state: 'applied', value: 'max' })
    })

    it('waits rather than guessing while nothing has appeared', () => {
        expect(paneCommandOutcome(idle, idle, 'effort')).toEqual({ state: 'pending' })
    })

    it('reads a model switch too', () => {
        const applied = screen('  ⎿  Set model to Fable 5 (claude-fable-5)', rule, '❯ ', rule)
        expect(paneCommandOutcome(idle, applied, 'model'))
            .toEqual({ state: 'applied', value: 'Set model to Fable 5'.slice('Set model to '.length) })
    })

    it('stops at the model, not at the end of the sentence (DROVE-191)', () => {
        // A pick that lands at an IDLE prompt is also saved as the machine's
        // global default, and Claude Code says so on the same line. The regex
        // ran to the end of it, so `paneModel` held the whole clause and the
        // app drew a menu row and a pill named "Sonnet 5 and saved as your
        // default for new sessions".
        const applied = screen(
            '  \u23bf  Set model to Sonnet 5 and saved as your default for new sessions',
            rule, '\u276f ', rule,
        )
        expect(paneCommandOutcome(idle, applied, 'model')).toEqual({ state: 'applied', value: 'Sonnet 5' })
    })

    it('marks a model the pane KEPT, which is the model we were leaving', () => {
        const kept = screen('  \u23bf  Kept model as Opus 5', rule, '\u276f ', rule)
        expect(paneCommandOutcome(idle, kept, 'model'))
            .toEqual({ state: 'applied', value: 'Opus 5', kept: true })
    })
})

describe('paneCommandKind', () => {
    it('routes only the two commands with an outcome worth reading', () => {
        expect(paneCommandKind('/effort ultracode')).toBe('effort')
        expect(paneCommandKind('/model claude-opus-5[1m]')).toBe('model')
        expect(paneCommandKind('/clear')).toBeNull()
        expect(paneCommandKind('/remote-control')).toBeNull()
    })
})
