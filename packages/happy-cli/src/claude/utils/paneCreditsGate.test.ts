import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { gateLedgerPath } from '@/drover/gateLedger'
import { paneCreditsDialog } from './paneCreditsDialog'
import { creditsLedgerVerdict, openPaneCreditsGate } from './paneCreditsGate'

/**
 * The credits gate on a fake bus (DROVE-279).
 *
 * Everything here is about what happens when a human does NOT answer, because
 * that is the arm with the money on it. The one happy path is included to pin
 * the wire shape the phone and the watch read.
 */

const capture = [
    '⏺ the turn above',
    '▔'.repeat(40),
    '   Switch to Fable 5?',
    '   Fable 5 runs on usage credits — you have $4.20 in credits.',
    '',
    '   ❯ No, keep my current model',
    '     Yes, buy usage credits',
].join('\n')

const dialog = paneCreditsDialog(capture)!

const request = {
    dialog,
    sessionId: 'claude-session-uuid',
    cwd: '/Users/clay/Projects/thing',
    account: 'personal',
    surface: '%7',
}

type Call = { url: string; init?: RequestInit }

/** A bus that answers each call from a scripted list, recording every request. */
function fakeBus(replies: Array<{ status: number; body?: unknown }>) {
    const calls: Call[] = []
    let n = 0
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
        calls.push({ url: String(url), init })
        const reply = replies[Math.min(n++, replies.length - 1)]
        return {
            ok: reply.status >= 200 && reply.status < 300,
            status: reply.status,
            json: async () => {
                if (reply.body === undefined) throw new Error('no body on this reply')
                return reply.body
            },
        }
    }) as unknown as typeof fetch
    return { fetchImpl, calls }
}

const published = { id: 'ev-1' }

let stateDir: string
let previousStateDir: string | undefined

beforeEach(() => {
    // The ledger is a real append to a real file. Point it somewhere
    // disposable rather than at the machine's own published.log.
    previousStateDir = process.env.STATE_DIR
    stateDir = mkdtempSync(join(tmpdir(), 'drove279-'))
    process.env.STATE_DIR = stateDir
})

afterEach(() => {
    if (previousStateDir === undefined) delete process.env.STATE_DIR
    else process.env.STATE_DIR = previousStateDir
})

function ledger(): string[] {
    try {
        return readFileSync(gateLedgerPath(), 'utf8').trim().split('\n').filter(Boolean)
    } catch {
        return []
    }
}

/** Everything after the timestamp: kind, gate, verdict. */
function verdicts(): string[] {
    return ledger().map((line) => line.split('\t').slice(1).join('\t'))
}

const opts = (fetchImpl: typeof fetch) => ({
    bus: 'http://bus',
    fetchImpl,
    env: {} as NodeJS.ProcessEnv,
    timeoutMs: 1000,
})

describe('openPaneCreditsGate', () => {
    it('publishes a QUESTION carrying the rows the pane drew', async () => {
        const bus = fakeBus([
            { status: 200, body: published },
            {
                status: 200,
                body: {
                    state: 'resolved',
                    resolution: { action: 'option', optionId: 'row-1', by: 'watch' },
                },
            },
        ])
        const outcome = await openPaneCreditsGate(request, opts(bus.fetchImpl))
        expect(outcome).toEqual({ pick: 'row', label: 'Yes, buy usage credits', by: 'watch' })

        const body = JSON.parse(String(bus.calls[0].init!.body))
        // A QUESTION, not a permission. That single word is what makes
        // DROVE-277's auto-accept refuse it (`kind !== 'permission'`) and what
        // makes busResolutionFor refuse to turn a bare approve into an option.
        expect(body.kind).toBe('question')
        expect(body.title).toBe('Switch to Fable 5?')
        expect(body.preview).toBe('Fable 5 runs on usage credits — you have $4.20 in credits.')
        // The rows go out as the PANE's own text, not as anything this side
        // invented, so what Clay taps is what is on his terminal.
        expect(body.options).toEqual([
            { id: 'row-0', label: 'No, keep my current model' },
            { id: 'row-1', label: 'Yes, buy usage credits' },
        ])
        // Carrying options is the SECOND thing that makes auto-accept refuse.
        expect(body.options.length).toBeGreaterThan(0)
        expect(body.origin).toMatchObject({
            harness: 'claude-code',
            gate: 'fable-credits',
            sessionId: 'claude-session-uuid',
            surface: '%7',
        })
    })

    it('takes the safe arm and NAMES ITSELF on the withdrawal when nobody answers', async () => {
        // 204 is the long-poll's own timeout: still pending, no body.
        const bus = fakeBus([{ status: 200, body: published }, { status: 204 }])
        const outcome = await openPaneCreditsGate(request, opts(bus.fetchImpl))
        expect(outcome.pick).toBe('safe')

        // DROVE-239: an expiry has to say who ended it as clearly as an answer
        // does, or the audit trail is honest in one direction only.
        const cancel = bus.calls.find((c) => c.url.endsWith('/cancel'))
        expect(cancel).toBeDefined()
        expect(JSON.parse(String(cancel!.init!.body))).toEqual({
            by: 'gate-timeout:fable-credits',
        })
        // And the same fact on the ledger, in the vocabulary drover status greps.
        expect(verdicts()).toEqual([
            'question\tfable-credits\tpublished ev-1',
            'question\tfable-credits\tunanswered-safe-row',
        ])
    })

    it('takes the safe arm when the card was withdrawn rather than answered', async () => {
        // A phone Stop lands here: paneInject withdraws every open gate rather
        // than answering one (DROVE-80).
        const bus = fakeBus([
            { status: 200, body: published },
            { status: 200, body: { state: 'canceled', resolution: null } },
        ])
        const outcome = await openPaneCreditsGate(request, opts(bus.fetchImpl))
        expect(outcome.pick).toBe('safe')
        expect(verdicts()).toContain('question\tfable-credits\twithdrawn-safe-row canceled')
    })

    it('never carries free text to a dialog whose second row is a purchase', async () => {
        const bus = fakeBus([
            { status: 200, body: published },
            {
                status: 200,
                body: { state: 'resolved', resolution: { action: 'text', text: 'sure go ahead', by: 'phone' } },
            },
        ])
        const outcome = await openPaneCreditsGate(request, opts(bus.fetchImpl))
        expect(outcome).toEqual({
            pick: 'safe',
            reason: 'the answer was text, not one of the rows',
        })
    })

    it('takes the safe arm for an option id that names no row', async () => {
        const bus = fakeBus([
            { status: 200, body: published },
            {
                status: 200,
                body: { state: 'resolved', resolution: { action: 'option', optionId: 'row-9', by: 'push' } },
            },
        ])
        expect((await openPaneCreditsGate(request, opts(bus.fetchImpl))).pick).toBe('safe')
        expect(verdicts()).toContain('question\tfable-credits\tanswered-unmatched-safe-row')
    })

    it('takes the safe arm, not the confirming one, when the bus cannot be asked at all', async () => {
        // openCodexGate fails OPEN here, because a Codex approval still has the
        // app's own card behind it. This dialog has nothing behind it: it is
        // holding a tmux pane. So an unasked money question answers no.
        const dead = (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
        const outcome = await openPaneCreditsGate(request, opts(dead))
        expect(outcome).toEqual({ pick: 'safe', reason: 'the bus could not be reached' })
        expect(verdicts()[0]).toContain('publish-failed')
    })

    it('takes the safe arm when the bus refuses the publish', async () => {
        const bus = fakeBus([{ status: 500 }])
        const outcome = await openPaneCreditsGate(request, opts(bus.fetchImpl))
        expect(outcome.pick).toBe('safe')
        // Nothing to withdraw: there is no event.
        expect(bus.calls).toHaveLength(1)
        expect(verdicts()).toEqual(['question\tfable-credits\tpublish-failed http 500'])
    })
})

describe('creditsLedgerVerdict', () => {
    it('says -remotely only when a human decided', () => {
        expect(
            creditsLedgerVerdict(
                { pick: 'row', label: 'Yes, buy usage credits', by: 'watch' },
                { state: 'typed', label: 'Yes, buy usage credits' },
            ),
        ).toBe('typed-remotely by watch')
    })

    it('never says -remotely for a row this side chose', () => {
        // The whole point of DROVE-239: "nobody answered and we took the safe
        // row" must not read like "Clay read it and picked the safe row".
        const verdict = creditsLedgerVerdict(
            { pick: 'safe', reason: 'nobody answered inside the budget' },
            { state: 'typed', label: 'No, keep my current model' },
        )
        expect(verdict).toBe('typed-safe-row')
        expect(verdict).not.toContain('remotely')
    })

    it('distinguishes the three ways nothing was typed', () => {
        const safe = { pick: 'safe', reason: 'nobody answered' } as const
        expect(creditsLedgerVerdict(safe, { state: 'dismissed', reason: 'no safe row' }))
            .toBe('dismissed-nothing-bought')
        expect(creditsLedgerVerdict(safe, { state: 'gone' })).toBe('closed-elsewhere')
        expect(creditsLedgerVerdict(safe, { state: 'stuck', reason: 'tmux said no' }))
            .toBe('stuck-nothing-typed')
    })
})
