/**
 * Cattle Drover flip (BASED-98) — the decisions that must not be guessed.
 *
 * The live end-to-end run proves the flip happens. These prove the parts a
 * live run cannot reach on demand: a real usage limit arrives when it arrives,
 * and "every account is cooling" is not a state anyone can wait around for.
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { detectLimit, textOfTranscriptMessage } from './limits'
import { renderFlipPrompt, resolveFlipPrompt, defaultFlipPrompt } from './prompt'
import { carryTranscript, projectDirFor } from './transcript'
import { parseFlipCommand } from './controller'

let root: string

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'drover-flip-'))
    process.env.XDG_STATE_HOME = join(root, 'state')
    process.env.DROVER_ACCOUNTS = join(root, 'accounts.json')
    delete process.env.DROVER_FLIP_PROMPT
    delete process.env.DROVER_ACCOUNT
    delete process.env.CLAUDE_CONFIG_DIR
})

afterEach(() => {
    rmSync(root, { recursive: true, force: true })
})

function writeAccounts(accounts: unknown[]): void {
    writeFileSync(process.env.DROVER_ACCOUNTS!, JSON.stringify(accounts))
}

/** Fresh import per test: the modules read env at call time, but pickTarget's
 *  ledger is a file, so the state dir must be re-read each time. */
async function accountsModule() {
    return await import('./accounts')
}

describe('limit detection', () => {
    it('recognises the shapes Claude actually uses', () => {
        for (const text of [
            'Claude usage limit reached. Your limit will reset at 3pm.',
            "You've reached your usage limit",
            '5-hour limit reached',
            'API error: rate_limit_error',
        ]) {
            expect(detectLimit(text), text).not.toBeNull()
        }
    })

    it('does not fire on ordinary talk about limits', () => {
        for (const text of [
            'Let me raise the rate limit in the config',
            'The limit is 100 requests per minute',
            'I hit a limit on how much I can infer here',
            'usage of the limiter is documented above',
        ]) {
            expect(detectLimit(text), text).toBeNull()
        }
    })

    it('reads a reset time when one is given, and says so when not', () => {
        const now = Date.parse('2026-08-28T10:00:00')
        const withTime = detectLimit('Claude usage limit reached. Resets at 3pm.', now)
        expect(withTime?.resetsAt).toBe(Date.parse('2026-08-28T15:00:00'))

        const withoutTime = detectLimit('Claude usage limit reached.', now)
        expect(withoutTime).not.toBeNull()
        expect(withoutTime?.resetsAt).toBeNull()
    })

    it('rolls a reset time that has already passed into tomorrow', () => {
        const now = Date.parse('2026-08-28T22:00:00')
        const hit = detectLimit('Claude usage limit reached. Resets at 9am.', now)
        expect(hit?.resetsAt).toBe(Date.parse('2026-08-29T09:00:00'))
    })

    it('matches the message a real limit actually produced', () => {
        // Captured verbatim from a live session on 2026-08-28, mid-build.
        const real = "You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model."
        expect(detectLimit(real)).not.toBeNull()
    })

    it('ignores the user quoting a limit message back at Claude', () => {
        const userTurn = { type: 'user', message: { role: 'user', content: 'Claude usage limit reached — why?' } }
        expect(textOfTranscriptMessage(userTurn)).toBeNull()
    })

    it('marks the harness own notices synthetic, and ordinary answers not', () => {
        // The exact entry shape Claude Code wrote for the real limit above.
        const synthetic = {
            type: 'assistant',
            message: {
                role: 'assistant',
                model: '<synthetic>',
                content: [{ type: 'text', text: "You've reached your Fable 5 limit." }],
            },
        }
        const read = textOfTranscriptMessage(synthetic)
        expect(read?.synthetic).toBe(true)
        expect(detectLimit(read!.text)).not.toBeNull()

        // Claude merely TALKING about a limit is not synthetic, so the
        // controller will not auto-flip on it even though the words match.
        const prose = {
            type: 'assistant',
            message: {
                role: 'assistant',
                model: 'claude-opus-5',
                content: [{ type: 'text', text: "If you've reached your usage limit, wait for the reset." }],
            },
        }
        expect(textOfTranscriptMessage(prose)?.synthetic).toBe(false)
    })
})

describe('cooldown ledger', () => {
    it('records a cooldown and reports it as active until it expires', async () => {
        const { setCooldown, isCooling } = await accountsModule()
        const until = Date.now() + 60_000
        setCooldown('main', until, 'usage limit')
        expect(isCooling('main')).toBe(true)
        expect(isCooling('main', until + 1)).toBe(false)
    })

    it('never shortens an existing cooldown', async () => {
        const { setCooldown, readLedger } = await accountsModule()
        const long = Date.now() + 3_600_000
        setCooldown('main', long, 'limit with a reset time')
        setCooldown('main', Date.now() + 1_000, 'limit with no reset time')
        expect(readLedger().main.until).toBe(long)
    })
})

describe('choosing where to flip', () => {
    it('takes the first account with headroom, in registry order', async () => {
        writeAccounts([
            { name: 'main', configDir: join(root, 'main') },
            { name: 'alt', configDir: join(root, 'alt') },
            { name: 'third', configDir: join(root, 'third') },
        ])
        const { pickTarget } = await accountsModule()
        const choice = pickTarget('main')
        expect(choice.kind).toBe('account')
        expect(choice.kind === 'account' && choice.account.name).toBe('alt')
    })

    it('skips an account that is cooling', async () => {
        writeAccounts([
            { name: 'main', configDir: join(root, 'main') },
            { name: 'alt', configDir: join(root, 'alt') },
            { name: 'third', configDir: join(root, 'third') },
        ])
        const { pickTarget, setCooldown } = await accountsModule()
        setCooldown('alt', Date.now() + 60_000, 'usage limit')
        const choice = pickTarget('main')
        expect(choice.kind === 'account' && choice.account.name).toBe('third')
    })

    it('parks — never flips onto a limited account — when everything is cooling', async () => {
        writeAccounts([
            { name: 'main', configDir: join(root, 'main') },
            { name: 'alt', configDir: join(root, 'alt') },
        ])
        const { pickTarget, setCooldown } = await accountsModule()
        const soon = Date.now() + 30_000
        setCooldown('main', Date.now() + 90_000, 'limit')
        setCooldown('alt', soon, 'limit')
        const choice = pickTarget('main')
        expect(choice.kind).toBe('parked')
        // Parked until the SOONEST account returns, and resumes on that one.
        expect(choice.kind === 'parked' && choice.until).toBe(soon)
        expect(choice.kind === 'parked' && choice.account.name).toBe('alt')
    })

    it('honours an explicit account even when it is cooling — a human overrides the ledger', async () => {
        writeAccounts([
            { name: 'main', configDir: join(root, 'main') },
            { name: 'alt', configDir: join(root, 'alt') },
        ])
        const { pickTarget, setCooldown } = await accountsModule()
        setCooldown('alt', Date.now() + 60_000, 'limit')
        const choice = pickTarget('main', 'alt')
        expect(choice.kind === 'account' && choice.account.name).toBe('alt')
    })

    it('refuses an account that is not in the registry', async () => {
        writeAccounts([{ name: 'main', configDir: join(root, 'main') }])
        const { pickTarget } = await accountsModule()
        expect(pickTarget('main', 'nope').kind).toBe('none')
    })
})

describe('the arrival prompt', () => {
    it('defaults to Clay wording', () => {
        const ctx = { to: 'alt', reason: 'usage limit', cwd: '/work/thing' }
        expect(resolveFlipPrompt(ctx)).toBe(defaultFlipPrompt)
    })

    it('prefers session over account over global', () => {
        process.env.DROVER_FLIP_PROMPT = 'global one'
        const account = { name: 'alt', configDir: '/x', flipPrompt: 'account one' }
        const base = { to: 'alt', reason: 'manual', cwd: '/work/thing' }

        expect(resolveFlipPrompt({ ...base })).toBe('global one')
        expect(resolveFlipPrompt({ ...base, account })).toBe('account one')
        expect(resolveFlipPrompt({ ...base, account, override: 'session one' })).toBe('session one')
    })

    it('substitutes template vars and leaves unknown braces alone', () => {
        const out = renderFlipPrompt('{from} -> {to} because {reason} in {project}; keep {braces}', {
            from: 'main',
            to: 'alt',
            reason: 'usage limit',
            cwd: '/work/thing',
        })
        expect(out).toBe('main -> alt because usage limit in thing; keep {braces}')
    })
})

describe('carrying the transcript', () => {
    it('copies the session and its subagents into the target account', () => {
        const from = join(root, 'cfg-main')
        const to = join(root, 'cfg-alt')
        const cwd = join(root, 'work')
        const id = '11111111-2222-3333-4444-555555555555'

        const srcProject = projectDirFor(from, cwd)
        mkdirSync(join(srcProject, id, 'subagents'), { recursive: true })
        writeFileSync(join(srcProject, `${id}.jsonl`), '{"type":"user"}\n')
        writeFileSync(join(srcProject, id, 'subagents', 'agent-1.jsonl'), '{"type":"assistant"}\n')

        const result = carryTranscript({ sessionId: id, workingDirectory: cwd, fromConfigDir: from, toConfigDir: to })
        expect(result.ok).toBe(true)
        expect(result.subagents).toBe(true)

        const dstProject = projectDirFor(to, cwd)
        expect(readFileSync(join(dstProject, `${id}.jsonl`), 'utf8')).toBe('{"type":"user"}\n')
        expect(readFileSync(join(dstProject, id, 'subagents', 'agent-1.jsonl'), 'utf8')).toBe('{"type":"assistant"}\n')
        // The source keeps its copy: a flip is reversible.
        expect(readFileSync(join(srcProject, `${id}.jsonl`), 'utf8')).toBe('{"type":"user"}\n')
    })

    it('reports a session with no transcript as nothing to carry, not a failure', () => {
        // Claude allocates a session id at startup but writes the file only on
        // the first turn, so this is what an untouched session looks like. It
        // must flip and start clean, never refuse over an empty conversation.
        const result = carryTranscript({
            sessionId: 'missing',
            workingDirectory: join(root, 'work'),
            fromConfigDir: join(root, 'cfg-main'),
            toConfigDir: join(root, 'cfg-alt'),
        })
        expect(result.ok).toBe(true)
        expect(result.nothingToCarry).toBe(true)
    })
})

describe('/flip from the app', () => {
    it('parses the forms a human would type', () => {
        expect(parseFlipCommand('/flip')).toMatchObject({ account: null })
        expect(parseFlipCommand('/flip alt')).toMatchObject({ account: 'alt' })
        expect(parseFlipCommand('/flip alt carry on with the tests')).toMatchObject({
            account: 'alt',
            prompt: 'carry on with the tests',
        })
        expect(parseFlipCommand('/flip -- just the prompt')).toMatchObject({
            account: null,
            prompt: 'just the prompt',
        })
    })

    it('is not confused by ordinary messages', () => {
        expect(parseFlipCommand('flip the table')).toBeNull()
        expect(parseFlipCommand('can you /flip it?')).toBeNull()
        expect(parseFlipCommand('')).toBeNull()
    })
})
