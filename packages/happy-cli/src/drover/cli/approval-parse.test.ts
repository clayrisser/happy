/**
 * The port measured against the shell it replaces (DROVE-315).
 *
 * The fixtures are the ones tests/approval.bats drives — real
 * `tmux capture-pane -p` output from Claude Code 2.1.251 — and the goldens
 * beside them are the BYTES `libexec/drover-approval-parse` wrote for each. So
 * this is not "the port produces a plausible object"; it is the same JSON, key
 * order and escaping included, or the test fails.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { approvalLimits, parseApproval } from './approval-parse'

const fixtures = fileURLToPath(new URL('./__fixtures__/approval', import.meta.url))
const read = (name: string): string => readFileSync(join(fixtures, name), 'utf8')

/** The shell's defaults, so a machine with these exported cannot skew a run. */
const defaults = approvalLimits({})

describe('approval-parse: byte for byte against the shell', () => {
    // The five captures tests/approval.bats drives the parser on: the four
    // recorded panes plus the two it derives in setup_file (an out-of-sequence
    // list, and a live dialog scrolled off the bottom).
    const captures = ['bash-three', 'bash-four', 'write-create', 'no-dialog', 'out-of-sequence', 'scrolled-away']

    // 120 is the width approval.bats runs the parser at, and it is the branch
    // that matters: a 119-column ASCII line was broken MID-TOKEN, so rejoining
    // it with a space would put one inside a path.
    for (const name of captures) {
        it(`${name} at width 120 reads exactly as libexec/drover-approval-parse did`, () => {
            const got = JSON.stringify(parseApproval(read(`${name}.txt`), { ...defaults, width: 120 })) + '\n'
            expect(got).toBe(read(`${name}.w120.json`))
        })
    }

    // And with the width unknown, which takes the other joining branch.
    for (const name of captures) {
        it(`${name} at unknown width reads exactly as libexec/drover-approval-parse did`, () => {
            const got = JSON.stringify(parseApproval(read(`${name}.txt`), defaults)) + '\n'
            expect(got).toBe(read(`${name}.w0.json`))
        })
    }
})

describe('approval-parse: the seven parser cases tests/approval.bats asserts', () => {
    const w120 = { ...defaults, width: 120 }

    it('the four option approval Clay lost is read whole, auto mode included', () => {
        const out = parseApproval(read('bash-four.txt'), w120)
        expect(out.shape).toBe('numbered')
        expect(out.title).toBe('Bash command')
        expect(out.question).toBe('Do you want to proceed?')
        expect(out.options).toHaveLength(4)
        expect(out.options[0].label).toBe('Yes')
        expect(out.options[3].label).toBe('No')
        expect(out.options[1].label).toContain("don't ask again")
        expect(out.options[2].label).toContain('switch to auto mode')
    })

    it('a wrapped option is rejoined without a space inside the path', () => {
        const out = parseApproval(read('bash-four.txt'), w120)
        expect(out.options[1].label).toMatch(/\/scratchpad\/sandbox$/)
        expect(out.options[1].label).not.toContain('-cla yrisser')
    })

    it('the three option shape still reads, so nothing was traded for the new one', () => {
        const out = parseApproval(read('bash-three.txt'), w120)
        expect(out.options).toHaveLength(3)
        expect(out.options[2].label).toBe('No')
    })

    it('a Write approval reads too: neither the header nor the question is Bash\'s', () => {
        const out = parseApproval(read('write-create.txt'), w120)
        expect(out.shape).toBe('numbered')
        expect(out.title).toBe('Create file')
        expect(out.question).toMatch(/^Do you want to create /)
        expect(out.options).toHaveLength(3)
        expect(out.options[1].label).toContain('and always allow access')
    })

    it('options out of sequence are refused whole, never offered in part', () => {
        const out = parseApproval(read('out-of-sequence.txt'), w120)
        expect(out.shape).toBe('unknown')
        expect(out.options).toHaveLength(0)
        expect(out.preview.length).toBeGreaterThan(0)
    })

    it('an answered dialog scrolled up the pane is not a live prompt', () => {
        expect(parseApproval(read('scrolled-away.txt'), w120).shape).toBe('unknown')
    })

    it('a pane with no dialog on it reads as unknown, not as an empty list', () => {
        const out = parseApproval(read('no-dialog.txt'), w120)
        expect(out.shape).toBe('unknown')
        expect(out.options).toHaveLength(0)
    })
})

describe('approval-parse: the whitespace rules the two previews do not share', () => {
    it('an unknown preview keeps the pane\'s own indentation', () => {
        // rtrim only, so a leading two spaces survives. The card has to look
        // like the terminal it came from.
        const out = parseApproval('  indented\n> \n', defaults)
        expect(out.shape).toBe('unknown')
        expect(out.preview).toBe('  indented\n>')
    })

    it('an unknown preview strips only the trailing space, tab and CR', () => {
        // The no-dialog capture ends a line with U+00A0, and it must survive:
        // a trimEnd() would eat it and the bytes would stop matching.
        expect(parseApproval(read('no-dialog.txt'), defaults).preview).toContain('\u00a0')
    })

    it('a numbered preview trims both sides and collapses blank runs to one', () => {
        const out = parseApproval('title\n  body one\n\n\n  body two\nProceed?\n1. Yes\n2. No\n', defaults)
        expect(out.shape).toBe('numbered')
        expect(out.preview).toBe('body one\n\nbody two\nProceed?')
    })
})

describe('approval-parse: the rules the shape test is made of', () => {
    it('takes however many options there are rather than a known list', () => {
        expect(parseApproval(read('bash-four.txt'), defaults).options).toHaveLength(4)
        expect(parseApproval(read('bash-three.txt'), defaults).options).toHaveLength(3)
    })

    it('a pane with no dialog is unknown, and carries the pane text anyway', () => {
        const out = parseApproval(read('no-dialog.txt'), defaults)
        expect(out.shape).toBe('unknown')
        expect(out.options).toEqual([])
        // The whole point of `unknown`: silence is the bug, so the text still
        // reaches a human.
        expect(out.preview.length).toBeGreaterThan(0)
    })

    it('refuses the whole read when the numbers are out of order', () => {
        const out = parseApproval('Do you want to proceed?\n  1. Yes\n  3. No\n', defaults)
        expect(out.shape).toBe('unknown')
        expect(out.options).toEqual([])
    })

    it('a lone numbered line is not a choice', () => {
        expect(parseApproval('1. Yes\n', defaults).shape).toBe('unknown')
    })

    it('"3.14 is pi" is not an option line', () => {
        expect(parseApproval('3.14 is pi\n', defaults).shape).toBe('unknown')
    })

    it('an answered dialog scrolled past the tail window is not a live prompt', () => {
        const scrolled = 'Do you want to proceed?\n1. Yes\n2. No\n' + 'x\n'.repeat(40)
        expect(parseApproval(scrolled, defaults).shape).toBe('unknown')
        expect(parseApproval(scrolled, { ...defaults, tail: 60 }).shape).toBe('numbered')
    })

    it('a mid-token wrap rejoins with no space when the line filled the pane', () => {
        // 20 columns: the first line is 19 wide, so it was broken mid-token.
        const pane = 'Do you want to proceed?\n1. /a/very/long/path\n   /tail\n2. No\n'
        expect(parseApproval(pane, { ...defaults, width: 20 }).options[0].label)
            .toBe('/a/very/long/path/tail')
        // Width unknown joins at a space, which is right for every word wrap.
        expect(parseApproval(pane, defaults).options[0].label)
            .toBe('/a/very/long/path /tail')
    })

    it('strips the selection caret without eating the number', () => {
        const out = parseApproval('Proceed?\n❯ 1. Yes\n  2. No\n', defaults)
        expect(out.shape).toBe('numbered')
        expect(out.options).toEqual([{ id: '1', label: 'Yes' }, { id: '2', label: 'No' }])
    })

    it('an empty capture is unknown with nothing to show', () => {
        expect(parseApproval('', defaults)).toEqual({
            shape: 'unknown', title: '', question: '', preview: '', options: [],
        })
    })
})

describe('approval-parse: the limits come from the env the shell reads', () => {
    it('defaults match libexec/drover-approval-parse', () => {
        expect(approvalLimits({})).toEqual({ context: 40, tail: 30, raw: 24, width: 0 })
    })

    it('each one is overridable by its own variable', () => {
        expect(approvalLimits({
            DROVER_APPROVAL_CONTEXT: '5',
            DROVER_APPROVAL_TAIL: '6',
            DROVER_APPROVAL_RAW_LINES: '7',
            DROVER_APPROVAL_WIDTH: '200',
        })).toEqual({ context: 5, tail: 6, raw: 7, width: 200 })
    })
})
