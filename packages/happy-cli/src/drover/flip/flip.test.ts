/**
 * Cattle Drover flip (BASED-98) — the decisions that must not be guessed.
 *
 * The live end-to-end run proves the flip happens. These prove the parts a
 * live run cannot reach on demand: a real usage limit arrives when it arrives,
 * and "every account is cooling" is not a state anyone can wait around for.
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
    detectLimit,
    familyOf,
    familyOfDisplayName,
    familyOfLimitText,
    modelOfTranscriptMessage,
    textOfTranscriptMessage,
} from './limits'
import { renderFlipPrompt, resolveFlipPrompt, defaultFlipPrompt } from './prompt'
import { carryTranscript, projectDirFor } from './transcript'
import { parseFlipCommand } from './controller'

let root: string
let realHome: string | undefined

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'drover-flip-'))
    process.env.XDG_STATE_HOME = join(root, 'state')
    process.env.DROVER_ACCOUNTS = join(root, 'accounts.json')
    // HOME is the throwaway too (DROVE-342). An AMBIENT registry row — one with
    // no configDir, which is what `two()` below writes — resolves its login and
    // its usage cache to join(homedir(), '.claude.json'), so on this machine the
    // DROVE-31 case read Clay's REAL Claude usage record: `isCooling('main')`
    // answered true whenever his main account happened to be at its limit and
    // false the rest of the day. Same disease the DROVE-336 fence cures one
    // variable over, so the cure is the same: point it at a throwaway and let
    // writeAccounts plant the fixture record there.
    realHome = process.env.HOME
    process.env.HOME = root
    delete process.env.DROVER_FLIP_PROMPT
    delete process.env.DROVER_ACCOUNT
    delete process.env.CLAUDE_CONFIG_DIR
})

afterEach(() => {
    if (realHome === undefined) delete process.env.HOME
    else process.env.HOME = realHome
    rmSync(root, { recursive: true, force: true })
})

/**
 * Write the registry AND log every account in.
 *
 * An account with no credential is not a flip candidate at all, so a fixture
 * that only writes accounts.json describes a machine where nothing can be
 * flipped to and every choosing test answers `none`.
 */
function writeAccounts(accounts: { name: string; configDir?: string }[]): void {
    writeFileSync(process.env.DROVER_ACCOUNTS!, JSON.stringify(accounts))
    for (const a of accounts) {
        // No configDir is the AMBIENT account, and its login lives at
        // ~/.claude.json rather than under a config dir. HOME is the throwaway
        // above, so this writes the fixture that used to be Clay's real record.
        const cfg = a.configDir ? join(a.configDir, '.claude.json') : join(homedir(), '.claude.json')
        mkdirSync(dirname(cfg), { recursive: true })
        writeFileSync(cfg, JSON.stringify({ hasCompletedOnboarding: true, oauthAccount: { emailAddress: `${a.name}@example.com` } }))
    }
}

/**
 * Plant Claude Code's own usage cache in an account's config, as it writes it.
 *
 * `scope` is the shape measured on disk: `{model: {id: null, display_name:
 * "Fable"}}`. The id really is null on every scoped row that has ever appeared
 * on this machine, which is why nothing can join on it.
 */
interface UsageRow {
    kind: string
    percent: number
    resets_at: string | null
    scope?: { model?: { id: null; display_name: string } | null; surface?: unknown } | null
}

function writeUsage(configDir: string, limits: UsageRow[]): void {
    const cfg = join(configDir, '.claude.json')
    const raw = JSON.parse(readFileSync(cfg, 'utf8'))
    raw.cachedUsageUtilization = { fetchedAtMs: Date.now(), utilization: { limits } }
    writeFileSync(cfg, JSON.stringify(raw))
}

/** A limit row scoped to one model family, the only scoped shape observed. */
function scopedTo(displayName: string) {
    return { model: { id: null as null, display_name: displayName } }
}

/** Fresh import per test: the modules read env at call time, but pickTarget's
 *  ledger is a file, so the state dir must be re-read each time. */
async function accountsModule() {
    return await import('./accounts')
}

/**
 * The production loop in miniature: choose, move, choose again.
 *
 * Each hop here is a real relaunch of Claude with the flip prompt
 * auto-submitted, so the length of this trail is the number of times a session
 * gets torn down and rebuilt. Three things end it, and they are the three ways
 * production stops asking:
 *
 *   - a choice naming the account we are ALREADY on, which the controller
 *     turns into a refusal: the session stays put and nothing relaunches;
 *   - a park;
 *   - a landing that CAN run the model. The session gets its turn, nothing
 *     hits a wall, and no further flip is requested. Only a landing carrying
 *     `withoutModel` comes straight back here, because that session's next
 *     turn runs the same exhausted model into the same limit.
 *
 * The state is held still on purpose. A hop that does consume real headroom
 * writes a cooldown and changes the registry's answer, and there are finitely
 * many accounts to empty; the loop that matters is the one where nothing
 * changes and the choice cycles anyway.
 */
async function walkFlips(start: string, family?: string, steps = 12): Promise<string[]> {
    const { pickTarget } = await accountsModule()
    const trail: string[] = []
    let current = start
    for (let i = 0; i < steps; i++) {
        const choice = pickTarget(current, null, Date.now(), family)
        if (choice.kind !== 'account') {
            trail.push(`(${choice.kind})`)
            break
        }
        if (choice.account.name === current) {
            trail.push(`(stay on ${current})`)
            break
        }
        current = choice.account.name
        trail.push(current)
        if (!choice.withoutModel) {
            trail.push(`(running on ${current})`)
            break
        }
    }
    return trail
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

    it('matches the phrasing 2.1.251 actually blocks with (DROVE-59)', () => {
        // The one that got away. Clay watched a session sit at its limit all
        // evening, announcing itself over and over, while auto-flip never
        // fired — and 47 transcripts in the shared store carry this sentence.
        //
        // Claude Code builds it from `You've hit your ${window} limit`, and
        // its own hard-block prefix table (RTt in the 2.1.251 bundle) leads
        // with BOTH voices:
        //
        //   ["You've hit your", "You've reached your", "You're out of usage
        //    credits", ...]
        //
        // Only the second was here. "reached" is what the API says; "hit" is
        // what the subscription TUI says, which is the entire local path this
        // file exists to read.
        const now = Date.parse('2026-08-30T19:53:00')
        const real = "You've hit your session limit · resets 9:20pm (Europe/London)"
        const hit = detectLimit(real, now)
        expect(hit).not.toBeNull()
        expect(hit?.resetsAt).toBe(Date.parse('2026-08-30T21:20:00'))

        for (const text of [
            "You've hit your limit",
            "You've hit your weekly limit",
            "You've hit your monthly limit \u00b7 raise it below, or it resets next month.",
            "You've hit your fast limit · resets in 12m",
            "You're out of usage credits",
            "You're out of extra usage",
        ]) {
            expect(detectLimit(text), text).not.toBeNull()
        }
    })

    it('does not read a limit WINDOW as the model that ran out (DROVE-59)', () => {
        // The window name sits exactly where the model name sits, so widening
        // the pattern to "hit" put "session" and "weekly" in the family slot.
        // A family is only a family if it IS one — otherwise null, which
        // blocks the account for every model. Conservative on purpose: a
        // wrong family unparks an account that has nothing left.
        expect(detectLimit("You've hit your session limit")?.family).toBeNull()
        expect(detectLimit("You've hit your weekly limit")?.family).toBeNull()
        expect(detectLimit("You've hit your monthly limit")?.family).toBeNull()
        expect(detectLimit("You've hit your fast limit")?.family).toBeNull()
        // ...but a model named in the same breath still reads as one.
        expect(detectLimit("You've hit your Fable 5 limit")?.family).toBe('fable')
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

describe('reducing a model to its family', () => {
    it('reads every id shape that has appeared on disk', () => {
        expect(familyOf('claude-opus-5')).toBe('opus')
        expect(familyOf('claude-fable-5[1m]')).toBe('fable')
        expect(familyOf('opus[1m]')).toBe('opus')
        expect(familyOf('fable')).toBe('fable')
        // A trailing date, and a family that is NOT the second segment.
        expect(familyOf('claude-haiku-4-5-20251001')).toBe('haiku')
        expect(familyOf('claude-3-5-sonnet')).toBe('sonnet')
        // A Bedrock/Vertex prefix is not part of the name.
        expect(familyOf('us.anthropic.claude-fable-5')).toBe('fable')
    })

    it('refuses the aliases that only resolve at runtime', () => {
        // opusplan is Opus in plan mode and Sonnet outside it; `best` is
        // whatever the server picks; the bare `haiku` alias falls back to
        // sonnet — Claude Code's own qde("haiku") returns "sonnet". Guessing
        // any of them makes an account look more available than it is.
        expect(familyOf('opusplan')).toBeUndefined()
        expect(familyOf('best')).toBeUndefined()
        expect(familyOf('haiku')).toBeUndefined()
        // The harness's own notices are not a model this session ran.
        expect(familyOf('<synthetic>')).toBeUndefined()
        expect(familyOf(undefined)).toBeUndefined()
    })

    it('makes a scope display name and a model id agree', () => {
        // The crux: the cache writes the FAMILY capitalized, the catalog
        // writes "Fable 5". Matching those two strings directly always fails.
        expect(familyOfDisplayName('Fable')).toBe('fable')
        expect(familyOfDisplayName('Fable 5')).toBe('fable')
        expect(familyOfDisplayName('Fable')).toBe(familyOf('claude-fable-5'))
        // A shape nobody has seen stays unknown, so callers keep blocking.
        expect(familyOfDisplayName('Claude Fable')).toBeUndefined()
    })

    it('takes the model off a real assistant entry, and off nothing else', () => {
        expect(
            modelOfTranscriptMessage({ type: 'assistant', message: { model: 'claude-opus-5' } }),
        ).toBe('claude-opus-5')
        // A tool-use-only turn has no text block; its model must still count,
        // which is why this reads the entry rather than going through
        // textOfTranscriptMessage.
        expect(
            modelOfTranscriptMessage({
                type: 'assistant',
                message: { model: 'claude-fable-5', content: [{ type: 'tool_use', name: 'Bash' }] },
            }),
        ).toBe('claude-fable-5')
        // A subagent's model is not the session's. Two of main's 53
        // transcripts carry haiku and opus-4-5 entries exactly this way.
        expect(
            modelOfTranscriptMessage({ type: 'assistant', isSidechain: true, message: { model: 'claude-haiku-4-5' } }),
        ).toBeUndefined()
        expect(modelOfTranscriptMessage({ type: 'assistant', message: { model: '<synthetic>' } })).toBeUndefined()
        expect(modelOfTranscriptMessage({ type: 'user', message: { model: 'claude-opus-5' } })).toBeUndefined()
    })

    it('reads the family back out of a notice, which is where an old ledger keeps it', () => {
        // A cooldown's `reason` IS the verbatim notice — controller.ts passes
        // hit.quote straight to setCooldown — so an entry written before the
        // family field existed still says which model ran out, in English.
        expect(familyOfLimitText("You've reached your Fable 5 limit.")).toBe('fable')
        expect(familyOfLimitText("You've reached your Opus limit. Run /usage-credits.")).toBe('opus')
        // A generic notice names nothing, and nothing is what keeps a real
        // account-wide cooldown blocking every model.
        expect(familyOfLimitText('Claude usage limit reached.')).toBeUndefined()
        expect(familyOfLimitText("You've reached your usage limit")).toBeUndefined()
        expect(familyOfLimitText('out entirely')).toBeUndefined()
        expect(familyOfLimitText(undefined)).toBeUndefined()
        // The usage cache's own sentence is not a notice and must not be read
        // as one: it is written by describeLimit, not by the harness.
        expect(familyOfLimitText("Fable weekly limit at 100% (Claude Code's own usage cache)")).toBeUndefined()
    })

    it('captures the model out of the limit notice that names one', () => {
        // Verbatim, 2026-08-22T16:13:43.233Z, model "<synthetic>". The harness
        // saying which model ran out, at the instant the cooldown is recorded.
        const real = "You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model."
        expect(detectLimit(real)?.family).toBe('fable')
        // A generic notice names nothing, and null means "the whole account".
        expect(detectLimit('Claude usage limit reached.')?.family).toBeNull()
        expect(detectLimit("You've reached your usage limit")?.family).toBeNull()
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

    // The reported bug: the ledger had never seen `alt` run out, because it
    // was emptied outside any drover session. Registry order then sent three
    // flips in a row onto it.
    it('skips an account Claude Code itself has recorded at 100%, with no ledger entry', async () => {
        writeAccounts([
            { name: 'main', configDir: join(root, 'main') },
            { name: 'alt', configDir: join(root, 'alt') },
            { name: 'third', configDir: join(root, 'third') },
        ])
        writeUsage(join(root, 'alt'), [
            { kind: 'weekly_all', percent: 100, resets_at: new Date(Date.now() + 3_600_000).toISOString() },
        ])
        const { pickTarget, readLedger } = await accountsModule()
        expect(readLedger()).toEqual({})
        const choice = pickTarget('main')
        expect(choice.kind === 'account' && choice.account.name).toBe('third')
    })

    it('ignores a usage limit that has already reset, and one below 100%', async () => {
        writeAccounts([
            { name: 'main', configDir: join(root, 'main') },
            { name: 'alt', configDir: join(root, 'alt') },
        ])
        writeUsage(join(root, 'alt'), [
            { kind: 'weekly_all', percent: 100, resets_at: new Date(Date.now() - 1_000).toISOString() },
            { kind: 'session', percent: 99, resets_at: new Date(Date.now() + 3_600_000).toISOString() },
        ])
        const { pickTarget } = await accountsModule()
        const choice = pickTarget('main')
        expect(choice.kind === 'account' && choice.account.name).toBe('alt')
    })

    it('parks until the LAST maxed-out limit clears, not the first', async () => {
        writeAccounts([
            { name: 'main', configDir: join(root, 'main') },
            { name: 'alt', configDir: join(root, 'alt') },
        ])
        const soon = Date.now() + 30_000
        const late = Date.now() + 90_000
        writeUsage(join(root, 'alt'), [
            { kind: 'session', percent: 100, resets_at: new Date(soon).toISOString() },
            { kind: 'weekly_all', percent: 100, resets_at: new Date(late).toISOString() },
        ])
        const { pickTarget, setCooldown } = await accountsModule()
        setCooldown('main', Date.now() + 600_000, 'limit')
        const choice = pickTarget('main')
        expect(choice.kind).toBe('parked')
        expect(choice.kind === 'parked' && choice.until).toBe(late)
    })

    it('says WHY it stayed put when nothing else has headroom', async () => {
        writeAccounts([
            { name: 'main', configDir: join(root, 'main') },
            { name: 'alt', configDir: join(root, 'alt') },
        ])
        writeUsage(join(root, 'alt'), [
            { kind: 'weekly_all', percent: 100, resets_at: new Date(Date.now() + 3_600_000).toISOString() },
        ])
        const { pickTarget } = await accountsModule()
        const choice = pickTarget('main')
        expect(choice.kind === 'account' && choice.account.name).toBe('main')
        expect(choice.kind === 'account' && choice.onlyOption).toBe(true)
    })

    it('lists every cooling account and why, so a park can be read', async () => {
        writeAccounts([
            { name: 'main', configDir: join(root, 'main') },
            { name: 'alt', configDir: join(root, 'alt') },
        ])
        const { pickTarget, setCooldown } = await accountsModule()
        setCooldown('main', Date.now() + 90_000, 'limit with a reset time')
        setCooldown('alt', Date.now() + 30_000, 'the other limit')
        const choice = pickTarget('main')
        expect(choice.kind).toBe('parked')
        if (choice.kind !== 'parked') return
        // Wake-up order, with a reason each — the whole park note is built
        // from this and there was no way to see any of it from the terminal.
        expect(choice.cooling.map((c) => c.name)).toEqual(['alt', 'main'])
        expect(choice.cooling[0].reason).toBe('the other limit')
    })
})

// Clay's ask, verbatim: "when auto flipping if using fable you first try to
// flip to something that has fable". The reason it matters is measured — on
// 2026-08-29 all five accounts read as unusable and every single reason was
// Fable, while main sat at five_hour 2% and would have run Opus that minute.
describe('choosing where to flip when the MODEL is what ran out', () => {
    const soon = () => new Date(Date.now() + 3_600_000).toISOString()

    function threeAccounts() {
        writeAccounts([
            { name: 'main', configDir: join(root, 'main') },
            { name: 'alt', configDir: join(root, 'alt') },
            { name: 'third', configDir: join(root, 'third') },
        ])
    }

    it('skips an account whose FABLE weekly is maxed when the session is on Fable', async () => {
        threeAccounts()
        writeUsage(join(root, 'alt'), [
            { kind: 'weekly_scoped', percent: 100, resets_at: soon(), scope: scopedTo('Fable') },
        ])
        const { pickTarget } = await accountsModule()
        expect(pickTarget('main', null, Date.now(), 'fable')).toMatchObject({
            kind: 'account',
            account: { name: 'third' },
        })
    })

    it('takes that same account for an Opus session — a Fable row is not evidence about Opus', async () => {
        threeAccounts()
        writeUsage(join(root, 'alt'), [
            { kind: 'weekly_scoped', percent: 100, resets_at: soon(), scope: scopedTo('Fable') },
        ])
        const { pickTarget } = await accountsModule()
        expect(pickTarget('main', null, Date.now(), 'opus')).toMatchObject({
            kind: 'account',
            account: { name: 'alt' },
        })
    })

    it('still lets an UNSCOPED limit rule the account out for every model', async () => {
        threeAccounts()
        writeUsage(join(root, 'alt'), [
            { kind: 'weekly_all', percent: 100, resets_at: soon() },
        ])
        const { pickTarget } = await accountsModule()
        expect(pickTarget('main', null, Date.now(), 'opus')).toMatchObject({
            kind: 'account',
            account: { name: 'third' },
        })
    })

    // The single most important constraint: a wrong model guess that parks a
    // healthy session is far worse than no model awareness at all.
    it('behaves EXACTLY as it did before when the model is unknown', async () => {
        threeAccounts()
        writeUsage(join(root, 'alt'), [
            { kind: 'weekly_scoped', percent: 100, resets_at: soon(), scope: scopedTo('Fable') },
        ])
        const { pickTarget } = await accountsModule()
        // No family: the scoped row blocks, same as it always has.
        expect(pickTarget('main')).toMatchObject({ kind: 'account', account: { name: 'third' } })
        // And a display name that reduces to no family blocks too, so a shape
        // Anthropic has not shipped yet cannot unpark an exhausted account.
        writeUsage(join(root, 'alt'), [
            { kind: 'weekly_scoped', percent: 100, resets_at: soon(), scope: scopedTo('Claude Fable') },
        ])
        expect(pickTarget('main', null, Date.now(), 'opus')).toMatchObject({
            kind: 'account',
            account: { name: 'third' },
        })
    })

    it('falls back to an account with headroom for SOME model, and names the one that is out', async () => {
        writeAccounts([
            { name: 'main', configDir: join(root, 'main') },
            { name: 'alt', configDir: join(root, 'alt') },
        ])
        writeUsage(join(root, 'alt'), [
            { kind: 'weekly_scoped', percent: 100, resets_at: soon(), scope: scopedTo('Fable') },
        ])
        const { pickTarget, setCooldown } = await accountsModule()
        setCooldown('main', Date.now() + 3_600_000, 'out entirely')
        const choice = pickTarget('main', null, Date.now(), 'fable')
        // A live session on another model beats five hours of nothing, as
        // long as the answer says which model has to change.
        expect(choice).toMatchObject({ kind: 'account', account: { name: 'alt' }, withoutModel: 'fable' })
    })

    // PING-PONG. The first cut of that fallback took the first OTHER account
    // with headroom for some model, which has no fixed point: measured by an
    // adversarial pass on 2026-08-29, three accounts each carrying a
    // Fable-scoped cooldown answered {kind:'account', withoutModel:'fable'}
    // twelve calls running, main -> alt -> main -> alt, and never parked. In
    // production every one of those hops relaunches Claude with the flip
    // prompt auto-submitted, so the session burns a turn per hop for as long
    // as it is left alone. An unbounded relaunch loop is strictly worse than
    // the wedge the model-aware flip was built to fix.
    it('does not ping-pong between accounts that are all out of the SAME model', async () => {
        threeAccounts()
        const { setCooldown } = await accountsModule()
        const hour = Date.now() + 3_600_000
        for (const name of ['main', 'alt', 'third']) {
            setCooldown(name, hour, "You've reached your Fable 5 limit.", 'fable')
        }
        // Nowhere to run Fable, but every account still runs Opus. The answer
        // is to stay put and switch models, not to tour the registry.
        expect(await walkFlips('main', 'fable')).toEqual(['(stay on main)'])
        expect(await walkFlips('alt', 'fable')).toEqual(['(stay on alt)'])
    })

    it('does not ping-pong on the usage cache either, with no ledger at all', async () => {
        writeAccounts([
            { name: 'main', configDir: join(root, 'main') },
            { name: 'alt', configDir: join(root, 'alt') },
        ])
        for (const dir of ['main', 'alt']) {
            writeUsage(join(root, dir), [
                { kind: 'weekly_scoped', percent: 100, resets_at: soon(), scope: scopedTo('Fable') },
            ])
        }
        const { readLedger } = await accountsModule()
        expect(readLedger()).toEqual({})
        expect(await walkFlips('main', 'fable')).toEqual(['(stay on main)'])
        expect(await walkFlips('alt', 'fable')).toEqual(['(stay on alt)'])
    })

    it('parks on that identical registry when the model is unknown', async () => {
        threeAccounts()
        const { setCooldown } = await accountsModule()
        const hour = Date.now() + 3_600_000
        for (const name of ['main', 'alt', 'third']) {
            setCooldown(name, hour, "You've reached your Fable 5 limit.", 'fable')
        }
        // The control the ping-pong was found by: the same accounts, the same
        // cooldowns, no family — a park, because an unscoped read blocks
        // everything. Model awareness must change WHERE a session goes, never
        // whether the choice terminates.
        expect(await walkFlips('main')).toEqual(['(parked)'])
    })

    // Termination by exhaustion rather than by example. Every registry of
    // three accounts, each independently free / out of Fable / out of Fable
    // with the family only in the reason / out entirely, from every starting
    // account, read through BOTH sources — the usage cache for the scoped
    // ones, the ledger for the rest. 64 registries, 384 walks, and not one of
    // them may loop.
    //
    // The bound is two entries: at most one move, then a stay or a park. That
    // is the fixed-point argument stated as a test, so a later fallback that
    // reintroduces a cycle fails here even if nobody thinks to write the
    // fixture that shows it.
    it('terminates from every account of every three-account registry', async () => {
        const states = ['free', 'fable', 'legacy', 'dead'] as const
        const names = ['main', 'alt', 'third']
        const { setCooldown, clearCooldown } = await accountsModule()
        for (const a of states) {
            for (const b of states) {
                for (const c of states) {
                    threeAccounts()
                    for (const name of names) clearCooldown(name)
                    ;[a, b, c].forEach((state, i) => {
                        if (state === 'fable') {
                            writeUsage(join(root, names[i]), [
                                { kind: 'weekly_scoped', percent: 100, resets_at: soon(), scope: scopedTo('Fable') },
                            ])
                        } else if (state === 'legacy') {
                            // The live-ledger shape: scoped in the reason only.
                            setCooldown(names[i], Date.now() + 3_600_000, "You've reached your Fable 5 limit.")
                        } else if (state === 'dead') {
                            setCooldown(names[i], Date.now() + 3_600_000, 'out entirely')
                        }
                    })
                    for (const start of names) {
                        for (const family of ['fable', undefined]) {
                            const trail = await walkFlips(start, family)
                            const where = `${a}/${b}/${c} from ${start} as ${family ?? 'unknown'}`
                            expect(trail.length, `${where}: ${trail.join(' -> ')}`).toBeLessThanOrEqual(2)
                            expect(trail[trail.length - 1], where).toMatch(/^\(/)
                        }
                    }
                }
            }
        }
        // 30s because the sweep writes a real registry, four .claude.json
        // files and a ledger per registry, and 64 of them do not fit vitest's
        // 5s default. Narrowing the sweep to fit would be the wrong trade:
        // the whole value of this test is that it is exhaustive.
    }, 30_000)

    // The fallback still moves when moving is the only thing that helps: this
    // account can run nothing at all, and one that can run Opus is next door.
    // Bounded at a single hop, because the account it lands on answers itself.
    it('moves ONCE to an account that can still run something, then settles', async () => {
        threeAccounts()
        const { setCooldown } = await accountsModule()
        const hour = Date.now() + 3_600_000
        setCooldown('main', hour, 'out entirely')
        setCooldown('alt', hour, "You've reached your Fable 5 limit.", 'fable')
        setCooldown('third', hour, "You've reached your Fable 5 limit.", 'fable')
        expect(await walkFlips('main', 'fable')).toEqual(['alt', '(stay on alt)'])
    })

    it('parks when nothing can run ANY model, and says the park is about the model', async () => {
        writeAccounts([
            { name: 'main', configDir: join(root, 'main') },
            { name: 'alt', configDir: join(root, 'alt') },
        ])
        const { pickTarget, setCooldown } = await accountsModule()
        const soonest = Date.now() + 30_000
        setCooldown('main', Date.now() + 90_000, 'out entirely')
        setCooldown('alt', soonest, 'out entirely')
        const choice = pickTarget('main', null, Date.now(), 'fable')
        expect(choice.kind).toBe('parked')
        expect(choice.kind === 'parked' && choice.until).toBe(soonest)
        expect(choice.kind === 'parked' && choice.family).toBe('fable')
    })

    // The livelock guard, re-proved through the model-aware path: a park whose
    // deadline has already passed spins the launcher as fast as the event loop
    // allows. coolingState never returns a past deadline, so the only way to
    // reach `soonest.until <= now` is a candidate that is genuinely free.
    it('never returns a zero-length park, even with a family in play', async () => {
        writeAccounts([
            { name: 'main', configDir: join(root, 'main') },
            { name: 'alt', configDir: join(root, 'alt') },
        ])
        // alt is out for everything, so both passes fail and the park deadline
        // is measured against the loosest demand. main is out of Fable only,
        // so under that demand it is free RIGHT NOW — and a park until a time
        // already past is the livelock: the launcher parks for zero ms, wakes,
        // asks again, gets the same answer, and spins.
        writeUsage(join(root, 'main'), [
            { kind: 'weekly_scoped', percent: 100, resets_at: soon(), scope: scopedTo('Fable') },
        ])
        writeUsage(join(root, 'alt'), [{ kind: 'weekly_all', percent: 100, resets_at: soon() }])
        const { pickTarget } = await accountsModule()
        expect(pickTarget('main', null, Date.now(), 'fable')).toMatchObject({
            kind: 'account',
            account: { name: 'main' },
            onlyOption: true,
            withoutModel: 'fable',
        })
    })

    it('cools only the family the notice named, and keeps a blanket cooldown a blanket', async () => {
        writeAccounts([
            { name: 'main', configDir: join(root, 'main') },
            { name: 'alt', configDir: join(root, 'alt') },
        ])
        const { pickTarget, setCooldown, readLedger, clearCooldown } = await accountsModule()
        setCooldown('alt', Date.now() + 60_000, "You've reached your Fable 5 limit.", 'fable')
        expect(readLedger().alt.family).toBe('fable')
        // A Fable session stays on main, and that is the scoped entry being
        // read: alt is the only other account and its Fable is gone, while
        // main's is not. Flipping there anyway is what ping-ponged — it trades
        // a model that works for one that does not, and the account it left
        // then looks like the place to go next. So no withoutModel either:
        // Fable runs fine right here.
        const fable = pickTarget('main', null, Date.now(), 'fable')
        expect(fable).toMatchObject({ kind: 'account', account: { name: 'main' }, onlyOption: true })
        expect(fable.kind === 'account' && fable.withoutModel).toBeUndefined()
        // An Opus session is not held up by it at all.
        const opus = pickTarget('main', null, Date.now(), 'opus')
        expect(opus).toMatchObject({ kind: 'account', account: { name: 'alt' } })
        expect(opus.kind === 'account' && opus.withoutModel).toBeUndefined()

        // "Fable is out" must never be written over "everything is out": that
        // would make a dead account read as available for Opus.
        clearCooldown('alt')
        setCooldown('alt', Date.now() + 60_000, 'out entirely')
        setCooldown('alt', Date.now() + 90_000, "You've reached your Fable 5 limit.", 'fable')
        expect(readLedger().alt.family).toBeUndefined()
        expect(pickTarget('main', null, Date.now(), 'opus')).toMatchObject({
            kind: 'account',
            account: { name: 'main' },
            onlyOption: true,
        })
    })

    // THE RATCHET, measured against Clay's live ledger on 2026-08-29.
    //
    // Three entries, none carrying a family, each with the reason "You've
    // reached your Fable 5 limit." His session was on Opus; main's usage cache
    // read session 2%, weekly_all 60%, and its only 100% was the Fable weekly.
    // He was parked for five hours under a note whose four lines each named a
    // FABLE limit. That self-contradiction is the tell: an entry whose reason
    // names Fable was never account-wide, and treating it as one is the error.
    //
    // It could not heal itself either. `widened` asked the bare field, so
    // every later Fable notice re-recorded the entry, pushed the window out
    // and dropped the family again — the entry could never become scoped and
    // the account stayed dead for every model until the window ran out.
    describe('a cooldown whose family is only in its reason', () => {
        it('does not park a session on another model behind it', async () => {
            writeAccounts([
                { name: 'main', configDir: join(root, 'main') },
                { name: 'alt', configDir: join(root, 'alt') },
            ])
            const { pickTarget, setCooldown, readLedger } = await accountsModule()
            // Exactly the shape on disk: no family argument, and the notice
            // in the reason naming the model that actually ran out.
            setCooldown('alt', Date.now() + 3_600_000, "You've reached your Fable 5 limit.")
            expect(readLedger().alt.family).toBeUndefined()

            // Opus has headroom there and must be handed it.
            expect(pickTarget('main', null, Date.now(), 'opus')).toMatchObject({
                kind: 'account',
                account: { name: 'alt' },
            })
            // A Fable session still reads the entry as out, so it stays put
            // and switches models rather than touring the registry.
            expect(pickTarget('main', null, Date.now(), 'fable')).toMatchObject({
                kind: 'account',
                account: { name: 'main' },
                onlyOption: true,
            })
        })

        it('becomes scoped when the same limit is recorded again', async () => {
            const { setCooldown, readLedger } = await accountsModule()
            const first = Date.now() + 3_600_000
            setCooldown('main', first, "You've reached your Fable 5 limit.")
            expect(readLedger().main.family).toBeUndefined()
            setCooldown('main', first + 60_000, "You've reached your Fable 5 limit.", 'fable')
            // The ratchet was here: the window extended and the family was
            // dropped, every time, for as long as the account kept hitting it.
            expect(readLedger().main.family).toBe('fable')
            expect(readLedger().main.until).toBe(first + 60_000)
        })

        it('still lets a genuinely account-wide entry block everything', async () => {
            writeAccounts([
                { name: 'main', configDir: join(root, 'main') },
                { name: 'alt', configDir: join(root, 'alt') },
            ])
            const { pickTarget, setCooldown, readLedger } = await accountsModule()
            // Names no model, so it means the account — and widening it with a
            // Fable notice must not narrow it by the back door.
            setCooldown('alt', Date.now() + 60_000, 'Claude usage limit reached.')
            setCooldown('alt', Date.now() + 90_000, "You've reached your Fable 5 limit.", 'fable')
            const entry = readLedger().alt
            expect(entry.family).toBeUndefined()
            // The REASON is held back too, and that is load-bearing now: an
            // account-wide entry carrying a notice that names Fable is the
            // very shape read as scoped, so writing one here would put the
            // ratchet back the other way round.
            expect(entry.reason).toBe('Claude usage limit reached.')
            expect(entry.until).toBe(readLedger().alt.until)
            expect(pickTarget('main', null, Date.now(), 'opus')).toMatchObject({
                kind: 'account',
                account: { name: 'main' },
                onlyOption: true,
            })
        })

        it('does not ping-pong, and still parks when the model is unknown', async () => {
            threeAccounts()
            const { setCooldown } = await accountsModule()
            const hour = Date.now() + 3_600_000
            for (const name of ['main', 'alt', 'third']) {
                setCooldown(name, hour, "You've reached your Fable 5 limit.")
            }
            // Nowhere runs Fable, everywhere runs Opus: stay put and switch.
            expect(await walkFlips('main', 'fable')).toEqual(['(stay on main)'])
            expect(await walkFlips('alt', 'fable')).toEqual(['(stay on alt)'])
            // With no family known, an unscoped read blocks everything and the
            // strict park stands — the fixed point is unchanged by any of this.
            expect(await walkFlips('main')).toEqual(['(parked)'])
        })
    })

    it('blames the account-wide limit, not the scoped one that reset 252 microseconds later', async () => {
        writeAccounts([{ name: 'main', configDir: join(root, 'main') }])
        // jamrizzi, measured: weekly_all at 18:59:59.859969Z and the Fable
        // weekly at 18:59:59.860221Z. Taking "the latest" named the scoped row
        // and the table said "Fable weekly limit" when the blocker was the
        // whole week. Right verdict, wrong explanation — and the explanation
        // is what decides whether Clay switches model or waits.
        writeUsage(join(root, 'main'), [
            { kind: 'weekly_all', percent: 100, resets_at: '2099-01-01T18:59:59.859969Z' },
            {
                kind: 'weekly_scoped',
                percent: 100,
                resets_at: '2099-01-01T18:59:59.860221Z',
                scope: scopedTo('Fable'),
            },
        ])
        const { readUsageExhaustion, accountByName } = await accountsModule()
        const measured = readUsageExhaustion(accountByName('main')!)
        // Blocked until the LAST of them clears, which is still the scoped one.
        expect(measured?.until).toBe(Date.parse('2099-01-01T18:59:59.860221Z'))
        expect(measured?.reason).toContain('weekly limit at 100%')
        expect(measured?.reason).not.toContain('Fable')
    })
})

describe('where a session was left', () => {
    it('remembers across a wrapper restart, keyed by session id and cwd', async () => {
        const { rememberWhereabouts, recallWhereabouts } = await accountsModule()
        rememberWhereabouts('9ae61ba4', '/work/thing', 'jamrizzi')
        expect(recallWhereabouts('9ae61ba4', '/work/thing')).toBe('jamrizzi')
        // A different project is a different session however the id reads.
        expect(recallWhereabouts('9ae61ba4', '/work/other')).toBeUndefined()
        expect(recallWhereabouts('unknown', '/work/thing')).toBeUndefined()
    })

    it('records the newest flip, not the first', async () => {
        const { rememberWhereabouts, recallWhereabouts } = await accountsModule()
        rememberWhereabouts('s1', '/w', 'alt')
        rememberWhereabouts('s1', '/w', 'third')
        expect(recallWhereabouts('s1', '/w')).toBe('third')
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

describe('one name, two harnesses (DROVE-338)', () => {
    it('accountByName takes the Claude row when a cursor row shares the name, wherever it sits', async () => {
        // The registry on Clay's Mac held the cursor row FIRST. A first-match
        // by name would have said this session's account was a token with no
        // config dir, and every Claude question here — where am I, am I
        // cooling, what does an explicit flip target — would have been asked
        // of the wrong account.
        const { accountByName, currentAccount } = await accountsModule()
        const rows: { name: string; configDir?: string; harness?: string }[] = [
            { name: 'main', configDir: join(root, 'd338-main') },
            { name: 'clay', harness: 'cursor' },
            { name: 'clay', configDir: join(root, 'd338-clay') },
        ]
        writeAccounts(rows)
        expect(accountByName('clay')).toMatchObject({ name: 'clay', configDir: join(root, 'd338-clay') })
        expect(accountByName('clay')?.harness).toBeUndefined()
        process.env.DROVER_ACCOUNT = 'clay'
        try {
            expect(currentAccount()).toMatchObject({ name: 'clay', configDir: join(root, 'd338-clay') })
        } finally {
            delete process.env.DROVER_ACCOUNT
        }
        // A name only a cursor row answers to is still that row: it is not
        // invented as a Claude account.
        writeAccounts([{ name: 'main', configDir: join(root, 'd338-main') }, { name: 'tok', harness: 'cursor' }] as typeof rows)
        expect(accountByName('tok')).toMatchObject({ name: 'tok', harness: 'cursor', configDir: '' })
    })
})

describe('where the session actually is', () => {
    it('takes the growing transcript over a whereabouts record left by an old flip', async () => {
        // DROVE-43, Clay's exact case. He flipped to jamrizzi, quit drover,
        // started it again — which lands on the ambient account and updates
        // nothing — and then every flip to jamrizzi answered "already on
        // jamrizzi" and refused to move, locking him out of the only account
        // with headroom.
        const { accountByNewestTranscript, rememberWhereabouts, recallWhereabouts } =
            await import('./accounts')
        const cwd = join(root, 'work-drove43')
        const id = 'cccccccc-dddd-eeee-ffff-000000000000'
        // The registry has to know both accounts: this reads real config dirs.
        writeAccounts([
            { name: 'main', configDir: join(root, 'd43-main') },
            { name: 'alt', configDir: join(root, 'd43-alt') },
        ])

        // An old flip left a record saying alt...
        rememberWhereabouts(id, cwd, 'alt')
        expect(recallWhereabouts(id, cwd)).toBe('alt')

        // ...but the session is writing under main, and more recently.
        const altFile = join(projectDirFor(join(root, 'd43-alt'), cwd), `${id}.jsonl`)
        const mainFile = join(projectDirFor(join(root, 'd43-main'), cwd), `${id}.jsonl`)
        mkdirSync(dirname(altFile), { recursive: true })
        mkdirSync(dirname(mainFile), { recursive: true })
        writeFileSync(altFile, '{"type":"user"}\n')
        writeFileSync(mainFile, '{"type":"user"}\n')
        // Make main unambiguously the newer of the two.
        const later = new Date(Date.now() + 60_000)
        utimesSync(mainFile, later, later)

        expect(accountByNewestTranscript(id, cwd)?.name).toBe('main')
    })

    it('says nothing when every account is reading ONE shared store (DROVE-59)', async () => {
        // DROVE-40 pointed every account's projects/ at ~/.claude-shared so a
        // flip stops copying transcripts. That silently broke this function's
        // premise: "every account is its own CLAUDE_CONFIG_DIR with its own
        // projects tree". Six accounts now stat the SAME INODE, so six
        // identical mtimes come back, `mtime > bestMtime` is strict, and the
        // first registry row wins every time. That row is `main`.
        //
        // Measured tonight, twice, while the session was demonstrably on
        // jamrizzi (both /status and the whereabouts record said so):
        //
        //   [flip] transcript: 19c2f0a8… is writing under main, not jamrizzi
        //          — taking the transcript
        //
        // A shared transcript names no account, so the honest answer is that
        // it does not know. Confidently naming `main` is the same wrong answer
        // with the whereabouts record overruled on the way past.
        const { accountByNewestTranscript, rememberWhereabouts } = await import('./accounts')
        const cwd = join(root, 'work-shared')
        const id = 'dddddddd-eeee-ffff-0000-111111111111'
        const store = join(root, 'shared-store', 'projects')
        mkdirSync(store, { recursive: true })

        const dirs = ['s-main', 's-jam', 's-bits'].map((n) => join(root, n))
        for (const d of dirs) {
            mkdirSync(d, { recursive: true })
            symlinkSync(store, join(d, 'projects'))
        }
        writeAccounts([
            { name: 'main', configDir: dirs[0] },
            { name: 'jamrizzi', configDir: dirs[1] },
            { name: 'bitspur.com', configDir: dirs[2] },
        ])

        // One file, reachable as all three. Written through the first.
        const file = join(projectDirFor(dirs[0], cwd), `${id}.jsonl`)
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, '{"type":"user"}\n')

        expect(accountByNewestTranscript(id, cwd)).toBeUndefined()

        // ...so the record the session kept is what the caller falls back on,
        // instead of being overruled by a stat that knows nothing.
        rememberWhereabouts(id, cwd, 'jamrizzi')
        const { recallWhereabouts } = await import('./accounts')
        expect(recallWhereabouts(id, cwd)).toBe('jamrizzi')
    })

    it('still reads a private transcript when one account is off the store (DROVE-59)', async () => {
        // Half-shared is the real shape of the machine: a new account added
        // after the migration has its own projects/ until something links it
        // in. The shared inode names no single account, so it is not a
        // candidate — but the account holding the one private copy is.
        const { accountByNewestTranscript } = await import('./accounts')
        const cwd = join(root, 'work-half')
        const id = 'eeeeeeee-ffff-0000-1111-222222222222'
        const store = join(root, 'half-store', 'projects')
        mkdirSync(store, { recursive: true })

        const shared = ['h-main', 'h-jam'].map((n) => join(root, n))
        for (const d of shared) {
            mkdirSync(d, { recursive: true })
            symlinkSync(store, join(d, 'projects'))
        }
        const lone = join(root, 'h-new')
        mkdirSync(join(lone, 'projects'), { recursive: true })
        writeAccounts([
            { name: 'main', configDir: shared[0] },
            { name: 'jamrizzi', configDir: shared[1] },
            { name: 'newbie', configDir: lone },
        ])

        const sharedFile = join(projectDirFor(shared[0], cwd), `${id}.jsonl`)
        const loneFile = join(projectDirFor(lone, cwd), `${id}.jsonl`)
        mkdirSync(dirname(sharedFile), { recursive: true })
        mkdirSync(dirname(loneFile), { recursive: true })
        writeFileSync(sharedFile, '{"type":"user"}\n')
        writeFileSync(loneFile, '{"type":"user"}\n')
        // The shared copy is NEWER, and still loses: it names three accounts,
        // so it names none. Age cannot break a tie that identity already lost.
        const later = new Date(Date.now() + 60_000)
        utimesSync(sharedFile, later, later)

        expect(accountByNewestTranscript(id, cwd)?.name).toBe('newbie')
    })

    it('says nothing when no account holds a transcript, so a fresh session keeps its stamp', async () => {
        const { accountByNewestTranscript } = await import('./accounts')
        expect(accountByNewestTranscript('no-such-session', join(root, 'nowhere'))).toBeUndefined()
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

    it('copies nothing when both accounts already share one store', () => {
        // DROVE-40. Two accounts whose project dirs are the same directory on
        // disk. Copying here is at best pointless and at worst destructive:
        // copyFileSync onto its own source truncates before it reads.
        const from = join(root, 'cfg-share-a')
        const to = join(root, 'cfg-share-b')
        const cwd = join(root, 'work-shared')
        const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

        const shared = join(root, 'shared-store', 'projects', 'munged')
        mkdirSync(shared, { recursive: true })
        const body = '{"type":"user"}\n{"type":"assistant"}\n'
        writeFileSync(join(shared, `${id}.jsonl`), body)

        // Both accounts reach that one directory through a symlink.
        for (const cfg of [from, to]) {
            const project = projectDirFor(cfg, cwd)
            mkdirSync(dirname(project), { recursive: true })
            symlinkSync(shared, project)
        }

        const result = carryTranscript({ sessionId: id, workingDirectory: cwd, fromConfigDir: from, toConfigDir: to })
        expect(result.ok).toBe(true)
        expect(result.shared).toBe(true)
        expect(result.bytes).toBeUndefined()
        // The transcript is intact, not truncated by a copy onto itself.
        expect(readFileSync(join(shared, `${id}.jsonl`), 'utf8')).toBe(body)
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

    /**
     * DROVE-18 asked for a backup before the copy. The measurement below is
     * why there is none: on this machine the copy never runs.
     *
     * The shape here is the one that is actually deployed, and it is NOT the
     * shape the DROVE-40 test above uses. There the symlink is the munged
     * project dir; here it is `projects/` itself, which is what
     * `drover-share-sessions --apply` made and what `drover account add`
     * keeps making (join_shared_store in libexec/drover-account-edit). All
     * five accounts plus the ambient ~/.claude point one `projects/` at
     * ~/.claude-shared/projects, so projectDirFor lands every account on the
     * same directory and carryTranscript answers `shared` before it can
     * overwrite anything.
     *
     * The invariant that makes the destructive branch unreachable, rather
     * than merely unlikely: srcDir and dstDir ARE the same directory, so the
     * source transcript existing means the destination exists too, which
     * means samePlaceOnDisk has already returned. There is no ordering where
     * one is there and the other is not.
     */
    it('does not touch a transcript the target account already holds (DROVE-18)', () => {
        const store = join(root, 'claude-shared', 'projects')
        mkdirSync(store, { recursive: true })

        const cwd = join(root, 'work-18')
        const id = '11111111-2222-3333-4444-555555555555'

        // Every account's projects/ is one symlink into the store, exactly as
        // ~/.claude and the four under ~/.claude-accounts are today.
        const configs = ['cfg-main', 'cfg-jamrizzi', 'cfg-bitspur'].map((n) => join(root, n))
        for (const cfg of configs) {
            mkdirSync(cfg, { recursive: true })
            symlinkSync(store, join(cfg, 'projects'))
        }

        // A long conversation, already sitting where the flip would write.
        const lines = Array.from({ length: 400 }, (_, i) => `{"type":"user","n":${i}}`).join('\n') + '\n'
        mkdirSync(projectDirFor(configs[0], cwd), { recursive: true })
        writeFileSync(join(projectDirFor(configs[0], cwd), `${id}.jsonl`), lines)

        // The ticket's premise: the destination is NOT empty. Assert that
        // before flipping, or this test would pass for the wrong reason.
        const dstFile = join(projectDirFor(configs[1], cwd), `${id}.jsonl`)
        expect(readFileSync(dstFile, 'utf8')).toBe(lines)

        for (const to of configs.slice(1)) {
            const result = carryTranscript({
                sessionId: id,
                workingDirectory: cwd,
                fromConfigDir: configs[0],
                toConfigDir: to,
            })
            expect(result.ok).toBe(true)
            expect(result.shared).toBe(true)
            // No bytes reported means no copyFileSync ran at all.
            expect(result.bytes).toBeUndefined()
        }

        expect(readFileSync(dstFile, 'utf8')).toBe(lines)
        expect(readFileSync(dstFile, 'utf8').trimEnd().split('\n')).toHaveLength(400)
    })

    it('has nothing to carry when the shared store has never seen this cwd (DROVE-18)', () => {
        // The other half of the invariant. samePlaceOnDisk answers false when
        // the munged dir does not exist yet — realpathSync throws — so it
        // would be easy to assume the copy then runs. It cannot: the source
        // transcript is missing for the same reason, and the guard above
        // copyFileSync catches that first. Measured on the real machine for a
        // cwd with no project dir in ~/.claude-shared/projects.
        const store = join(root, 'claude-shared-empty', 'projects')
        mkdirSync(store, { recursive: true })

        const from = join(root, 'cfg-a-18')
        const to = join(root, 'cfg-b-18')
        for (const cfg of [from, to]) {
            mkdirSync(cfg, { recursive: true })
            symlinkSync(store, join(cfg, 'projects'))
        }

        const result = carryTranscript({
            sessionId: '99999999-8888-7777-6666-555555555555',
            workingDirectory: join(root, 'work-never-used'),
            fromConfigDir: from,
            toConfigDir: to,
        })
        expect(result.ok).toBe(true)
        expect(result.nothingToCarry).toBe(true)
        expect(result.shared).toBeUndefined()
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

describe('what a flip calls the session (DROVE-15)', () => {
    const cwd = '/Users/clay/Projects/bitspur/cattle-drover'

    it('keeps the name Claude Code is showing', async () => {
        // Clay renamed this session DROVER, flipped it, and the app called it
        // "[jamrizzi] cattle-drover". The account prefix is a default we stamp
        // when nothing better exists; a title the person typed is better.
        const { nameAfterFlip } = await import('./apply')
        expect(nameAfterFlip({
            metadata: { name: 'cattle-drover', summary: { text: 'cattle-drover', updatedAt: 1 } },
            workingDirectory: cwd,
            accountName: 'jamrizzi',
            customTitle: 'DROVER',
        })).toMatchObject({
            name: 'DROVER',
            summary: expect.objectContaining({ text: 'DROVER' }),
        })
    })

    it('stamps the account when the session has no name of its own', async () => {
        const { nameAfterFlip } = await import('./apply')
        expect(nameAfterFlip({
            metadata: { name: 'cattle-drover', summary: { text: 'cattle-drover', updatedAt: 1 } },
            workingDirectory: cwd,
            accountName: 'jamrizzi',
            customTitle: null,
        })).toMatchObject({
            name: '[jamrizzi] cattle-drover',
            summary: expect.objectContaining({ text: '[jamrizzi] cattle-drover' }),
        })
    })

    it('leaves a title the app wrote alone', async () => {
        const { nameAfterFlip } = await import('./apply')
        expect(nameAfterFlip({
            metadata: { name: 'titled by the app', summary: { text: 'titled by the app', updatedAt: 1 } },
            workingDirectory: cwd,
            accountName: 'jamrizzi',
            customTitle: null,
        })).toMatchObject({
            name: 'titled by the app',
            summary: { text: 'titled by the app', updatedAt: 1 },
        })
    })
})

// --- DROVE-21: the account a session STARTS on --------------------------------

/** A whereabouts file written by hand, so the `at` order is the test's to set. */
function writeWhereabouts(entries: Record<string, { account: string; cwd: string; at: number }>): void {
    const dir = join(process.env.XDG_STATE_HOME!, 'cattle-drover')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'whereabouts.json'), JSON.stringify(entries))
}

const inAnHour = () => new Date(Date.now() + 60 * 60 * 1000).toISOString()
const inADay = () => new Date(Date.now() + 26 * 60 * 60 * 1000).toISOString()

describe('one login wearing two names', () => {
    // main (~/.claude) and risserproperties both hold risserproperties@gmail.com:
    // one claude.ai login, two drover names, and until now two rows with two
    // separate headrooms for the same quota.
    function twoNames() {
        writeAccounts([
            { name: 'main', configDir: join(root, 'tw-main') },
            { name: 'alt', configDir: join(root, 'tw-alt') },
            { name: 'twin', configDir: join(root, 'tw-twin') },
        ])
        writeFileSync(join(root, 'tw-twin', '.claude.json'),
            JSON.stringify({ hasCompletedOnboarding: true, oauthAccount: { emailAddress: 'Main@example.com' } }))
    }

    it('names the duplicate after the first of its login in registry order', async () => {
        twoNames()
        const { readAccounts, sameLoginAs, loginTwins } = await accountsModule()
        const accounts = readAccounts()
        const by = (n: string) => accounts.find((a) => a.name === n)!
        expect(sameLoginAs(by('twin'), accounts)).toBe('main')
        expect(sameLoginAs(by('main'), accounts)).toBeUndefined()
        expect(sameLoginAs(by('alt'), accounts)).toBeUndefined()
        expect(loginTwins(by('main'), accounts).map((a) => a.name)).toEqual(['twin'])
    })

    it("reads a twin's exhaustion as this account's, and says whose cache saw it", async () => {
        twoNames()
        // The twin's cache is the fresh one: weekly_all at 100%. main's own
        // cache says nothing, which used to read as headroom.
        writeUsage(join(root, 'tw-twin'), [{ kind: 'weekly_all', percent: 100, resets_at: inAnHour() }])
        const { readAccounts, coolingState } = await accountsModule()
        const main = readAccounts().find((a) => a.name === 'main')!
        const state = coolingState(main, {})
        expect(state.until).toBeGreaterThan(0)
        expect(state.reason).toContain('seen on twin, the same login')
    })

    it('never flips onto a twin of the account it is leaving', async () => {
        twoNames()
        const { pickTarget } = await accountsModule()
        // Registry order would offer twin before alt; twin is the same login.
        const choice = pickTarget('main', null)
        expect(choice.kind).toBe('account')
        if (choice.kind === 'account') expect(choice.account.name).toBe('alt')
    })
})

describe('where the shared session store leaves the transcript', () => {
    it('names no account when every account reaches the same file (DROVE-40)', async () => {
        // Since DROVE-40 every projects/ is a symlink into one store, so the
        // "newest copy" is one inode under four names and the mtime tie fell to
        // whichever account the registry listed first. That is a guess, and it
        // overruled a whereabouts record that was right.
        const shared = join(root, 'shared-projects')
        mkdirSync(shared, { recursive: true })
        for (const n of ['s-main', 's-alt']) {
            mkdirSync(join(root, n), { recursive: true })
            symlinkSync(shared, join(root, n, 'projects'))
        }
        writeAccounts([
            { name: 'main', configDir: join(root, 's-main') },
            { name: 'alt', configDir: join(root, 's-alt') },
        ])
        const cwd = join(root, 'work-shared')
        const id = 'dddddddd-eeee-ffff-0000-111111111111'
        const file = join(projectDirFor(join(root, 's-main'), cwd), `${id}.jsonl`)
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, '{"type":"user"}\n')
        const { accountByNewestTranscript } = await accountsModule()
        expect(accountByNewestTranscript(id, cwd)).toBeUndefined()
    })
})

describe('the account a session starts on', () => {
    const cwd = '/work/thing'
    function three() {
        writeAccounts([
            { name: 'main', configDir: join(root, 'st-main') },
            { name: 'alt', configDir: join(root, 'st-alt') },
            { name: 'third', configDir: join(root, 'st-third') },
        ])
    }

    it('has no opinion without a registry', async () => {
        const { pickStartAccount } = await accountsModule()
        expect(pickStartAccount({ cwd })).toEqual({ via: 'none' })
    })

    it('falls back to the first account with headroom when nothing is remembered', async () => {
        three()
        const { pickStartAccount } = await accountsModule()
        const pick = pickStartAccount({ cwd })
        expect(pick.via).toBe('picker')
        expect(pick.account?.name).toBe('main')
        expect(pick.note).toContain('nothing remembered here')
    })

    it('starts on the account last used in this directory', async () => {
        // Clay's words: "when I restart it should always resume with the
        // account I was last using". The newest record for this cwd, whatever
        // session id it was under.
        three()
        writeWhereabouts({
            s1: { account: 'alt', cwd, at: 1000 },
            s2: { account: 'third', cwd, at: 2000 },
            s3: { account: 'main', cwd: '/work/other', at: 3000 },
        })
        const { pickStartAccount } = await accountsModule()
        const pick = pickStartAccount({ cwd })
        expect(pick.via).toBe('cwd')
        expect(pick.account?.name).toBe('third')
        expect(pick.note).toContain('last used in this directory')
    })

    it('prefers where the resumed session itself was left', async () => {
        three()
        writeWhereabouts({
            s1: { account: 'alt', cwd, at: 1000 },
            s2: { account: 'third', cwd, at: 2000 },
        })
        const { pickStartAccount } = await accountsModule()
        const pick = pickStartAccount({ cwd, sessionId: 's1' })
        expect(pick.via).toBe('session')
        expect(pick.account?.name).toBe('alt')
        // The same id in another directory is a different session.
        expect(pickStartAccount({ cwd: '/work/other', sessionId: 's1' }).via).toBe('picker')
    })

    it('falls through to the picker when the remembered account is cooling, and says so', async () => {
        three()
        writeWhereabouts({ s1: { account: 'alt', cwd, at: 1000 } })
        writeUsage(join(root, 'st-alt'), [{ kind: 'weekly_all', percent: 100, resets_at: inAnHour() }])
        const { pickStartAccount } = await accountsModule()
        const pick = pickStartAccount({ cwd })
        expect(pick.via).toBe('picker')
        expect(pick.account?.name).toBe('main')
        expect(pick.note).toMatch(/^alt is cooling: weekly limit at 100%/)
        expect(pick.note).toContain('Starting on main instead')
    })

    it('judges the memory against the model that will run there', async () => {
        three()
        writeWhereabouts({ s1: { account: 'alt', cwd, at: 1000 } })
        // Only Fable is out on alt.
        writeUsage(join(root, 'st-alt'), [
            { kind: 'weekly_scoped', percent: 100, resets_at: inAnHour(), scope: scopedTo('Fable') },
        ])
        const { pickStartAccount } = await accountsModule()
        // An Opus session stays put; a Fable one moves.
        expect(pickStartAccount({ cwd, model: 'claude-opus-5' }).account?.name).toBe('alt')
        expect(pickStartAccount({ cwd, model: 'claude-fable-5[1m]' }).account?.name).toBe('main')
        // With no flag the account's own settings.json is the seed...
        writeFileSync(join(root, 'st-alt', 'settings.json'), JSON.stringify({ model: 'opus[1m]' }))
        expect(pickStartAccount({ cwd }).account?.name).toBe('alt')
        // ...and with no seed either, unknown counts every limit.
        rmSync(join(root, 'st-alt', 'settings.json'))
        expect(pickStartAccount({ cwd }).account?.name).toBe('main')
    })

    it('stays on the memory when every account is cooling, rather than parking', async () => {
        three()
        writeWhereabouts({ s1: { account: 'alt', cwd, at: 1000 } })
        for (const d of ['st-main', 'st-alt', 'st-third']) {
            writeUsage(join(root, d), [{ kind: 'weekly_all', percent: 100, resets_at: inAnHour() }])
        }
        const { pickStartAccount } = await accountsModule()
        const pick = pickStartAccount({ cwd })
        expect(pick.via).toBe('cwd')
        expect(pick.account?.name).toBe('alt')
        expect(pick.note).toContain('Every account is cooling')
        // The account it STARTS is named (DROVE-262), and it is the account
        // stdout returns. Nothing here can run anything, so the next reset is
        // the one number left worth printing and it survives — spelled out as
        // a reset, and after the start, so it cannot be read as the choice.
        expect(pick.note).toContain('Starting on alt')
        expect(pick.note).not.toContain('Starting there')
        expect(pick.note).toMatch(/is the first to reset, at \d\d:\d\d/)
    })

    it('names the account it is starting, not the one that recovers first', async () => {
        // DROVE-262, and the fixture is the mix that exposed it: `alt` is out
        // of FABLE alone, so it runs everything else right now; `main` and
        // `third` are out of EVERYTHING and merely come back sooner. Staying
        // on alt was always the right pick. The sentence read
        //
        //   alt is cooling: Fable weekly limit at 100% (...), back Wed 14:59.
        //   Every account is cooling; main is back first. Starting there anyway
        //
        // so the last account it named was main and the session opened on alt.
        // "Back first" ranks time to FULL recovery; the pick ranks what can
        // run now, and this mix is precisely where those two orders disagree.
        three()
        writeWhereabouts({ s1: { account: 'alt', cwd, at: 1000 } })
        writeUsage(join(root, 'st-alt'), [
            { kind: 'weekly_scoped', percent: 100, resets_at: inADay(), scope: scopedTo('Fable') },
        ])
        for (const d of ['st-main', 'st-third']) {
            writeUsage(join(root, d), [{ kind: 'weekly_all', percent: 100, resets_at: inAnHour() }])
        }
        const { pickStartAccount } = await accountsModule()

        // No model anywhere: unknown counts every maxed row, so the picker
        // parks and this stays put. That is the run Clay reproduced.
        const blind = pickStartAccount({ cwd })
        expect(blind.account?.name).toBe('alt')
        expect(blind.note).toContain('Every account is cooling')

        // With the family known the picker settles on alt outright rather
        // than parking. Different path, same sentence, same account.
        const fable = pickStartAccount({ cwd, model: 'claude-fable-5[1m]' })
        expect(fable.account?.name).toBe('alt')

        for (const pick of [blind, fable]) {
            const note = pick.note!
            // It names what it starts, and says why that beat the others.
            expect(note).toContain('Starting on alt')
            expect(note).toContain('only model-scoped limits are out')
            expect(note).toContain('switch models with /model')
            // The recovery race is gone: neither the phrase nor either of the
            // accounts that would win it appears at all.
            expect(note).not.toContain('back first')
            expect(note).not.toContain('Starting there')
            expect(note).not.toContain('main')
            expect(note).not.toContain('third')
            // And the last account the line names is the one it returns —
            // the whole of the misreading was that it was not.
            const named = ['main', 'alt', 'third']
                .map((n) => ({ n, at: note.lastIndexOf(n) }))
                .filter((x) => x.at >= 0)
                .sort((a, b) => b.at - a.at)
            expect(named[0]!.n).toBe(pick.account!.name)
        }
    })

    it('skips a remembered account that has no login', async () => {
        three()
        writeWhereabouts({ s1: { account: 'alt', cwd, at: 1000 } })
        rmSync(join(root, 'st-alt', '.claude.json'))
        const { pickStartAccount } = await accountsModule()
        const pick = pickStartAccount({ cwd })
        expect(pick.via).toBe('picker')
        expect(pick.account?.name).toBe('main')
        expect(pick.note).toContain('alt has no login')
    })
})

describe('the controller remembers where a session was seen', () => {
    it('writes the stamped account when Claude reports the id, over an older record', async () => {
        // With bin/drover stamping every start from this very record (or from
        // -a), the stamp is the record or better; an older record must not
        // put the controller on one account while the child runs on another.
        writeAccounts([
            { name: 'main', configDir: join(root, 'c-main') },
            { name: 'alt', configDir: join(root, 'c-alt') },
        ])
        const { rememberWhereabouts, recallWhereabouts } = await accountsModule()
        const { FlipController } = await import('./controller')
        const cwd = join(root, 'work-ctl')
        rememberWhereabouts('s1', cwd, 'alt')
        const flip = new FlipController(cwd, () => {}, { toTerminal: () => {} })
        flip.startedOn('main')
        flip.sessionFound('s1')
        expect(recallWhereabouts('s1', cwd)).toBe('main')
    })

    it('lets the record win for an unstamped start, and refreshes it', async () => {
        writeAccounts([
            { name: 'main', configDir: join(root, 'u-main') },
            { name: 'alt', configDir: join(root, 'u-alt') },
        ])
        process.env.DROVER_ACCOUNT = 'main'
        const { rememberWhereabouts, recallWhereabouts, readWhereabouts } = await accountsModule()
        const { FlipController } = await import('./controller')
        const cwd = join(root, 'work-unstamped')
        rememberWhereabouts('s2', cwd, 'alt')
        const before = readWhereabouts().s2.at
        const flip = new FlipController(cwd, () => {}, { toTerminal: () => {} })
        flip.sessionFound('s2')
        expect(recallWhereabouts('s2', cwd)).toBe('alt')
        expect(readWhereabouts().s2.at).toBeGreaterThanOrEqual(before)
    })
})

describe('naming the account a session with no stamp is on (DROVE-31)', () => {
    // A bare `drover` with no -a exports no DROVER_ACCOUNT, and `happy` never
    // has, so most sessions arrive with only a config dir. Measured on Clay's
    // own live session 2026-08-30: pid 61366 carried DROVER_ORIGIN=terminal
    // and neither DROVER_ACCOUNT nor CLAUDE_CONFIG_DIR, so every event went
    // out with account null and the phone had nothing to render.
    function two() {
        writeAccounts([
            { name: 'main' },
            { name: 'alt', configDir: join(root, 'd31-alt') },
        ])
    }

    it('reads an unset config dir as the ambient account, not as nothing', async () => {
        two()
        const { currentAccount } = await accountsModule()
        expect(currentAccount()?.name).toBe('main')
    })

    it('matches a config dir with a trailing slash', async () => {
        two()
        process.env.CLAUDE_CONFIG_DIR = join(root, 'd31-alt') + '/'
        const { currentAccount } = await accountsModule()
        expect(currentAccount()?.name).toBe('alt')
    })

    it('reads ~/.claude spelled longhand as the ambient account', async () => {
        // Not a fourth registry row: the ambient account is reached by
        // UNSETTING the variable, and a session pointed at ~/.claude is the
        // one whose login lives in ~/.claude.json all the same.
        two()
        process.env.CLAUDE_CONFIG_DIR = join(homedir(), '.claude')
        const { currentAccount } = await accountsModule()
        expect(currentAccount()?.name).toBe('main')
    })

    it('names a config dir the registry does not hold by its login', async () => {
        two()
        const odd = join(root, 'd31-elsewhere')
        mkdirSync(odd, { recursive: true })
        writeFileSync(join(odd, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, oauthAccount: { emailAddress: 'alt@example.com' } }))
        process.env.CLAUDE_CONFIG_DIR = odd
        const { currentAccount } = await accountsModule()
        expect(currentAccount()?.name).toBe('alt')
    })

    it('says nothing rather than guessing for a dir with no login at all', async () => {
        two()
        const blank = join(root, 'd31-blank')
        mkdirSync(blank, { recursive: true })
        process.env.CLAUDE_CONFIG_DIR = blank
        const { currentAccount } = await accountsModule()
        expect(currentAccount()).toBeUndefined()
    })

    it('still lets the stamp win when a wrapper set one', async () => {
        two()
        process.env.DROVER_ACCOUNT = 'alt'
        const { currentAccount } = await accountsModule()
        expect(currentAccount()?.name).toBe('alt')
    })

    it('records a limit hit against the account the unstamped session is on', async () => {
        // The ledger is what stops the next flip landing straight back on a
        // maxed account. An unstamped session used to reach here with no
        // account at all, so the hit was detected, announced, and written
        // down nowhere.
        two()
        process.env.CLAUDE_CONFIG_DIR = join(root, 'd31-alt')
        const { isCooling, readLedger } = await accountsModule()
        const { FlipController } = await import('./controller')
        const flip = new FlipController(join(root, 'work-d31'), () => {}, { toTerminal: () => {} })
        flip.noteTranscriptMessage({
            type: 'assistant',
            message: { role: 'assistant', model: '<synthetic>', content: 'Claude usage limit reached.' },
        })
        expect(isCooling('alt')).toBe(true)
        expect(isCooling('main')).toBe(false)
        expect(Object.keys(readLedger())).toEqual(['alt'])
    })
})
