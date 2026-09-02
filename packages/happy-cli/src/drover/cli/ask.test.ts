/**
 * `drover ask`, measured against the shell it replaces (DROVE-315).
 *
 * The goldens under __fixtures__/ask are the BYTES the shell's own `jq -n`
 * wrote for the same four command lines — the filter was lifted verbatim out
 * of libexec/drover-ask to make them. So the card that reaches the phone is
 * the same card, key order included; a reordered object is a different string
 * and this fails.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { AskUsageError, answerOf, buildAskPayload, parseAskArgs, parseAskOption } from './ask'

const fixtures = fileURLToPath(new URL('./__fixtures__/ask', import.meta.url))
const golden = (name: string): string => readFileSync(join(fixtures, `${name}.json`), 'utf8').trimEnd()

/** Parse a command line the way the verb does, from a fixed cwd. */
const args = (argv: string[]) => {
    const parsed = parseAskArgs(argv, '/tmp/work')
    if (parsed === 'help') throw new Error('expected arguments, got --help')
    return parsed
}

describe('ask: the card is byte for byte the shell\'s', () => {
    it('the one-liner, three bare options', () => {
        const payload = buildAskPayload(args(['Which region?', 'use1', 'euw1', 'apse1']), '')
        expect(JSON.stringify(payload)).toBe(golden('one-liner'))
    })

    it('--confirm is a permission with no options of its own', () => {
        const payload = buildAskPayload(
            args(['--confirm', 'Roll the stack?', '--reason', 'keycloak, prod', '--preview', './roll.sh --yes']),
            'clayrisser@gmail.com',
        )
        expect(JSON.stringify(payload)).toBe(golden('confirm'))
    })

    it('labels, descriptions, multi, gate, session and account together', () => {
        const payload = buildAskPayload(args([
            'Pick one',
            '--reason', 'why you are asking',
            '--preview', 'the thing about to happen',
            '--option', 'prod:Production:The real one',
            '--option', 'dev:Dev only',
            '--option', 'raw',
            '--multi',
            '--gate', 'account-login',
            '--harness', 'drover',
            '--session', 'sess-42',
            '--timeout', '900',
        ]), 'alt')
        expect(JSON.stringify(payload)).toBe(golden('full'))
    })

    it('--timeout 0 is ttlMs 0, which is never expire', () => {
        const payload = buildAskPayload(args(['Wait forever', 'a', 'b', '--timeout', '0']), '')
        expect(JSON.stringify(payload)).toBe(golden('no-expiry'))
    })
})

describe('ask: id:label[:description]', () => {
    it('a bare word is its own id and label', () => {
        expect(parseAskOption('use1')).toEqual({ id: 'use1', label: 'use1' })
    })

    it('two fields are id and label, with no description', () => {
        expect(parseAskOption('prod:Production')).toEqual({ id: 'prod', label: 'Production' })
    })

    it('three fields carry the description', () => {
        expect(parseAskOption('prod:Production:The real one'))
            .toEqual({ id: 'prod', label: 'Production', description: 'The real one' })
    })

    it('a colon inside the description is kept', () => {
        expect(parseAskOption('a:b:c:d')).toEqual({ id: 'a', label: 'b', description: 'c:d' })
    })

    it('an empty label falls back to the id', () => {
        expect(parseAskOption('a:')).toEqual({ id: 'a', label: 'a' })
    })

    it('an option with no id is a bad argument, exit 2', () => {
        expect(() => parseAskOption(':label')).toThrowError(
            expect.objectContaining({ code: 2, message: "drover ask: an option needs an id (got ':label')" }),
        )
    })
})

describe('ask: the refusals, and the exit code each one carries', () => {
    const refuses = (argv: string[], code: number, first: string) => {
        try {
            parseAskArgs(argv, '/tmp/work')
        } catch (error) {
            expect(error).toBeInstanceOf(AskUsageError)
            expect((error as AskUsageError).code).toBe(code)
            expect((error as AskUsageError).lines[0]).toBe(first)
            return
        }
        throw new Error(`expected ${argv.join(' ')} to be refused`)
    }

    it('no title', () => refuses([], 2, 'drover ask: a question needs a title (try --help)'))

    it('a timeout that is not whole seconds', () =>
        refuses(['Q', 'a', '--timeout', '1.5'], 2, 'drover ask: --timeout takes whole seconds'))

    it('a negative timeout is not whole seconds either', () =>
        refuses(['Q', 'a', '--timeout', '-1'], 2, 'drover ask: --timeout takes whole seconds'))

    it('--confirm with --multi', () =>
        refuses(['--confirm', '--multi', 'Q'], 2, 'drover ask: --confirm is yes/no; --multi needs a list of choices'))

    it('a question with no choices names the one-liner that would work', () => {
        try {
            parseAskArgs(['Q'], '/tmp/work')
            throw new Error('expected a refusal')
        } catch (error) {
            expect((error as AskUsageError).lines).toEqual([
                'drover ask: a question needs at least one choice, or use --confirm',
                '  drover ask "Which region?" use1 euw1',
            ])
        }
    })

    it('an unknown flag', () =>
        refuses(['Q', 'a', '--nope'], 2, "drover ask: unknown option '--nope' (try --help)"))

    it('a two-argument flag with nothing after it names itself', () =>
        refuses(['Q', 'a', '--reason'], 2, 'drover ask: --reason needs a value'))

    it('-h and --help are the usage, not a refusal', () => {
        expect(parseAskArgs(['-h'])).toBe('help')
        expect(parseAskArgs(['--help'])).toBe('help')
    })
})

describe('ask: the answer, in the one vocabulary a caller has to learn', () => {
    it('a text answer prints the text', () => {
        expect(answerOf({ resolution: { action: 'text', text: 'good-code#state' } })).toBe('good-code#state')
    })

    it('a multi-select prints one id per line, so `while read` works', () => {
        expect(answerOf({ resolution: { action: 'option', optionIds: ['use1', 'euw1'] } })).toBe('use1\neuw1')
    })

    it('a single option prints its id', () => {
        expect(answerOf({ resolution: { action: 'option', optionId: 'cancel' } })).toBe('cancel')
    })

    it('a permission answered by the injected buttons prints the action', () => {
        expect(answerOf({ resolution: { action: 'allow' } })).toBe('allow')
        expect(answerOf({ resolution: { action: 'deny' } })).toBe('deny')
    })
})

describe('ask: defaults match etc/drover.env and the shell usage', () => {
    it('600 seconds, harness shell, cwd $PWD, no gate and no session', () => {
        const a = args(['Q', 'a'])
        expect(a.timeoutS).toBe(600)
        expect(a.harness).toBe('shell')
        expect(a.cwd).toBe('/tmp/work')
        expect(a.gate).toBe('')
        expect(a.session).toBe('')
        expect(a.multi).toBe(false)
        expect(a.json).toBe(false)
    })

    it('the first positional is the title and the rest are choices', () => {
        const a = args(['Which region?', 'use1', 'euw1'])
        expect(a.title).toBe('Which region?')
        expect(a.options).toEqual([{ id: 'use1', label: 'use1' }, { id: 'euw1', label: 'euw1' }])
    })
})
