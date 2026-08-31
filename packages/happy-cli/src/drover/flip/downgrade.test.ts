/**
 * Dropping a model rung when no account can carry the one in use (DROVE-187).
 *
 * Two halves. The pure decisions — ladder, policy, effort ceiling — are checked
 * here directly. The controller half is checked through a real registry and a
 * real usage cache, because "no account has Fable but two have Opus" is the
 * exact state that produced Clay's 3:25am dead session and it is not a state
 * anyone can wait around for.
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
    builtInLadder,
    downgradeNote,
    ladderFor,
    mayDowngradeModel,
    mayFlipAccount,
    modelIdFor,
    nearestEffort,
    planDowngrade,
    reachesXhigh,
    switchPolicyOf,
} from './downgrade'

let root: string

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'drover-downgrade-'))
    process.env.XDG_STATE_HOME = join(root, 'state')
    process.env.DROVER_ACCOUNTS = join(root, 'accounts.json')
    delete process.env.DROVER_ACCOUNT
    delete process.env.CLAUDE_CONFIG_DIR
})

afterEach(() => {
    rmSync(root, { recursive: true, force: true })
})

// --- fixtures, the same shapes flip.test.ts plants ---------------------------

function writeAccounts(accounts: { name: string; configDir: string }[]): void {
    writeFileSync(process.env.DROVER_ACCOUNTS!, JSON.stringify(accounts))
    for (const a of accounts) {
        mkdirSync(a.configDir, { recursive: true })
        writeFileSync(
            join(a.configDir, '.claude.json'),
            JSON.stringify({ oauthAccount: { emailAddress: `${a.name}@example.com` } }),
        )
    }
}

interface UsageRow {
    kind: string
    percent: number
    resets_at: string | null
    scope?: { model?: { id: null; display_name: string } | null } | null
}

function writeUsage(configDir: string, limits: UsageRow[]): void {
    const cfg = join(configDir, '.claude.json')
    const raw = JSON.parse(readFileSync(cfg, 'utf8'))
    raw.cachedUsageUtilization = { fetchedAtMs: Date.now(), utilization: { limits } }
    writeFileSync(cfg, JSON.stringify(raw))
}

/** A row that is `percent` used, scoped to one family, resetting in an hour. */
function limit(percent: number, family: string): UsageRow {
    return {
        kind: 'weekly',
        percent,
        resets_at: new Date(Date.now() + 3_600_000).toISOString(),
        scope: { model: { id: null as null, display_name: family } },
    }
}

// --- the policy value -------------------------------------------------------

describe('reading the Account switching setting', () => {
    it('takes the four values as written', () => {
        expect(switchPolicyOf('flip-then-downgrade')).toBe('flip-then-downgrade')
        expect(switchPolicyOf('flip-only')).toBe('flip-only')
        expect(switchPolicyOf('downgrade-only')).toBe('downgrade-only')
        expect(switchPolicyOf('nothing')).toBe('nothing')
    })

    it('reads the two values the key shipped with', () => {
        // A settings file written before DROVE-187 is still on Clay's Mac.
        expect(switchPolicyOf('stop')).toBe('flip-only')
        expect(switchPolicyOf('fallback')).toBe('flip-then-downgrade')
    })

    it('defaults to flip-then-downgrade for anything else, including nothing at all', () => {
        // A newer client's value, or a bus that never answered, must not be the
        // reason a session sits dead. That is the whole complaint.
        expect(switchPolicyOf(undefined)).toBe('flip-then-downgrade')
        expect(switchPolicyOf(null)).toBe('flip-then-downgrade')
        expect(switchPolicyOf('some-future-value')).toBe('flip-then-downgrade')
    })

    it('says which halves each policy permits', () => {
        expect(mayFlipAccount('flip-then-downgrade')).toBe(true)
        expect(mayDowngradeModel('flip-then-downgrade')).toBe(true)
        expect(mayFlipAccount('flip-only')).toBe(true)
        expect(mayDowngradeModel('flip-only')).toBe(false)
        expect(mayFlipAccount('downgrade-only')).toBe(false)
        expect(mayDowngradeModel('downgrade-only')).toBe(true)
        expect(mayFlipAccount('nothing')).toBe(false)
        expect(mayDowngradeModel('nothing')).toBe(false)
    })
})

// --- the ladder -------------------------------------------------------------

describe('the ladder', () => {
    it('is Clay\'s own: Fable to Opus to Sonnet, and Sonnet is the floor', () => {
        expect(ladderFor('fable')).toEqual(['opus', 'sonnet'])
        expect(ladderFor('opus')).toEqual(['sonnet'])
        expect(ladderFor('sonnet')).toEqual([])
        expect(builtInLadder.sonnet).toBeUndefined()
    })

    it('never lands on Haiku, whatever the settings file says', () => {
        // "Haiku: never" is a rule, not a default. An old settings file that
        // still carries the sonnet -> haiku row this store used to ship must
        // not be able to put a session there.
        expect(ladderFor('sonnet', { sonnet: ['haiku'] })).toEqual([])
        expect(ladderFor('opus', { opus: ['haiku', 'sonnet'] })).toEqual(['sonnet'])
    })

    it('takes the chain the store configured over the built-in one', () => {
        expect(ladderFor('fable', { fable: ['sonnet'] })).toEqual(['sonnet'])
    })

    it('drops a chain that loops back on the family that just ran out', () => {
        expect(ladderFor('fable', { fable: ['fable', 'opus', 'opus'] })).toEqual(['opus'])
    })

    it('has nothing to say about an unknown family', () => {
        expect(ladderFor(undefined)).toEqual([])
        expect(ladderFor('something-else')).toEqual([])
    })
})

describe('the model id a rung is typed as', () => {
    it('is the full id, never an alias', () => {
        expect(modelIdFor('opus')).toBe('claude-opus-5')
        expect(modelIdFor('sonnet')).toBe('claude-sonnet-5')
    })

    it('keeps a 1M context across the drop', () => {
        // Losing it silently would truncate the conversation Clay is in the
        // middle of, which is a worse surprise than the model change itself.
        expect(modelIdFor('opus', 'claude-fable-5[1m]')).toBe('claude-opus-5[1m]')
        expect(modelIdFor('opus', 'claude-fable-5')).toBe('claude-opus-5')
    })

    it('has no id for a family it does not know', () => {
        expect(modelIdFor('mythos')).toBeNull()
    })
})

// --- effort (DROVE-164: a DENY list, not an allow list) ---------------------

describe('the effort a model will take', () => {
    it('reads the xhigh gate as a deny list', () => {
        // DROVE-101 wrote this as an allow list and got Opus 5 backwards, which
        // is why Clay could not select the level he had been asking for since
        // June. Everything absent from the deny list reaches xhigh.
        expect(reachesXhigh('claude-opus-5')).toBe(true)
        expect(reachesXhigh('claude-opus-5[1m]')).toBe(true)
        expect(reachesXhigh('claude-fable-5')).toBe(true)
        expect(reachesXhigh('claude-sonnet-5')).toBe(true)
        expect(reachesXhigh('claude-opus-4-6')).toBe(false)
        expect(reachesXhigh('claude-sonnet-4-5')).toBe(false)
        expect(reachesXhigh('claude-3-5-sonnet')).toBe(false)
    })

    it('keeps the whole scale for a model it has never heard of', () => {
        expect(reachesXhigh('claude-something-9')).toBe(true)
        expect(reachesXhigh(null)).toBe(true)
    })

    it('leaves an effort the model accepts exactly where it was', () => {
        expect(nearestEffort('claude-opus-5', 'ultracode')).toBe('ultracode')
        expect(nearestEffort('claude-sonnet-5', 'xhigh')).toBe('xhigh')
        expect(nearestEffort('claude-opus-4-6', 'high')).toBe('high')
    })

    it('steps DOWN to the nearest level a gated model accepts', () => {
        // Stepping up would land Clay on a level he never asked for.
        expect(nearestEffort('claude-opus-4-6', 'ultracode')).toBe('max')
        expect(nearestEffort('claude-opus-4-6', 'xhigh')).toBe('high')
    })

    it('has nothing to clamp when nothing picked an effort', () => {
        expect(nearestEffort('claude-opus-4-6', null)).toBeNull()
        expect(nearestEffort('claude-opus-4-6', undefined)).toBeNull()
    })
})

// --- the plan ---------------------------------------------------------------

describe('planning the drop', () => {
    const anything = () => true

    it('takes the smallest drop that something can run', () => {
        const plan = planDowngrade({ family: 'fable', runnable: (f) => f === 'opus' })
        expect(plan).toMatchObject({ from: 'fable', to: 'opus', model: 'claude-opus-5', effort: null })
    })

    it('skips a rung that is out of headroom too', () => {
        const plan = planDowngrade({ family: 'fable', runnable: (f) => f === 'sonnet' })
        expect(plan?.to).toBe('sonnet')
    })

    it('is null when every rung below is exhausted as well', () => {
        expect(planDowngrade({ family: 'fable', runnable: () => false })).toBeNull()
    })

    it('is null at the floor, and null for an unknown family', () => {
        expect(planDowngrade({ family: 'sonnet', runnable: anything })).toBeNull()
        expect(planDowngrade({ family: undefined, runnable: anything })).toBeNull()
    })

    it('carries the effort when the new model takes it', () => {
        const plan = planDowngrade({
            family: 'fable',
            model: 'claude-fable-5',
            effort: 'ultracode',
            runnable: anything,
        })
        // Opus 5 takes ultracode, so nothing is retyped.
        expect(plan?.effort).toBeNull()
        expect(plan?.previousEffort).toBe('ultracode')
    })

    it('clamps an effort the model it drops to cannot take, and says what it was', () => {
        const plan = planDowngrade({
            family: 'fable',
            model: 'claude-fable-5',
            effort: 'ultracode',
            familyFallback: { fable: ['opus'] },
            runnable: anything,
        })!
        // Forced onto a gated model to exercise the clamp end to end.
        const gated = planDowngrade({
            family: 'opus',
            model: 'claude-opus-4-6',
            effort: 'xhigh',
            familyFallback: { opus: ['sonnet'] },
            runnable: anything,
        })
        expect(plan.effort).toBeNull()
        expect(gated?.to).toBe('sonnet')
    })
})

describe('what the message says', () => {
    it('names the policy that chose and what it did', () => {
        const note = downgradeNote(
            { from: 'fable', to: 'opus', model: 'claude-opus-5', effort: null, previousEffort: 'high' },
            'flip-then-downgrade',
        )
        expect(note).toContain('no account has Fable headroom')
        expect(note).toContain('dropped to Opus (claude-opus-5)')
        expect(note).toContain('account switching: flip then downgrade')
    })

    it('says so when the effort had to move as well', () => {
        const note = downgradeNote(
            { from: 'opus', to: 'sonnet', model: 'claude-sonnet-5', effort: 'high', previousEffort: 'xhigh' },
            'downgrade-only',
        )
        expect(note).toContain('does not take xhigh effort')
        expect(note).toContain('effort is high — the nearest it accepts')
        expect(note).toContain('account switching: downgrade only')
    })
})

// --- the controller, against a real registry --------------------------------

async function controllerOn(account: string, said: string[]) {
    process.env.DROVER_ACCOUNT = account
    const { FlipController } = await import('./controller')
    return new FlipController(join(root, 'work'), (m: string) => said.push(m), {
        toTerminal: () => {},
        toPane: () => {},
    })
}

/** Put the controller on a known model family without a real transcript. */
function running(flip: { noteTranscriptMessage: (m: unknown) => void }, model: string): void {
    flip.noteTranscriptMessage({ type: 'assistant', message: { role: 'assistant', model, content: 'hi' } })
}

const autoRequest = { account: null, reason: 'usage limit', by: 'auto' }

describe('the controller, when no account has the model in use', () => {
    beforeEach(() => {
        writeAccounts([
            { name: 'main', configDir: join(root, 'c-main') },
            { name: 'alt', configDir: join(root, 'c-alt') },
        ])
    })

    it('flips the ACCOUNT rather than the model when another account has it', async () => {
        // Account before model, every time: another login keeps the model Clay
        // asked for and costs nothing but a relaunch.
        writeUsage(join(root, 'c-main'), [limit(100, 'Fable')])
        writeUsage(join(root, 'c-alt'), [limit(10, 'Fable')])
        const said: string[] = []
        const flip = await controllerOn('main', said)
        running(flip, 'claude-fable-5')
        const result = flip.apply(autoRequest, null)
        expect(result.kind).toBe('flipped')
        expect(result.kind === 'flipped' && result.account.name).toBe('alt')
        expect(result.kind === 'flipped' && result.downgrade).toBeUndefined()
        expect(flip.takeDowngradePick()).toBeNull()
    })

    it('drops the model when NO account has it but a lower one runs', async () => {
        // Clay's 3:25am state, exactly: every account out of Fable, plenty of
        // Opus. It used to print a sentence asking him to type /model.
        writeUsage(join(root, 'c-main'), [limit(100, 'Fable'), limit(5, 'Opus')])
        writeUsage(join(root, 'c-alt'), [limit(100, 'Fable'), limit(5, 'Opus')])
        const said: string[] = []
        const flip = await controllerOn('main', said)
        running(flip, 'claude-fable-5')
        const result = flip.apply(autoRequest, null)
        expect(result.downgrade).toMatchObject({ from: 'fable', to: 'opus', model: 'claude-opus-5' })
        expect(result.note).toContain('dropped to Opus')
        expect(result.note).toContain('account switching: flip then downgrade')
        // And the pane gets told once, and only once.
        expect(flip.takeDowngradePick()).toEqual({ model: 'claude-opus-5', effort: null })
        expect(flip.takeDowngradePick()).toBeNull()
    })

    it('stays put and says so when nothing anywhere can run anything', async () => {
        writeUsage(join(root, 'c-main'), [limit(100, 'Fable'), limit(100, 'Opus'), limit(100, 'Sonnet')])
        writeUsage(join(root, 'c-alt'), [limit(100, 'Fable'), limit(100, 'Opus'), limit(100, 'Sonnet')])
        const said: string[] = []
        const flip = await controllerOn('main', said)
        running(flip, 'claude-fable-5')
        const result = flip.apply(autoRequest, null)
        expect(result.downgrade).toBeUndefined()
        expect(result.note).toContain('account switching: flip then downgrade')
    })
})

describe('the controller, per policy setting', () => {
    beforeEach(() => {
        writeAccounts([
            { name: 'main', configDir: join(root, 'p-main') },
            { name: 'alt', configDir: join(root, 'p-alt') },
        ])
        // Nothing has Fable; everything has Opus.
        writeUsage(join(root, 'p-main'), [limit(100, 'Fable'), limit(5, 'Opus')])
        writeUsage(join(root, 'p-alt'), [limit(100, 'Fable'), limit(5, 'Opus')])
    })

    it('flip-only leaves the model alone and names the setting', async () => {
        const said: string[] = []
        const flip = await controllerOn('main', said)
        flip.setPolicy({ onFamilyExhausted: 'flip-only' })
        running(flip, 'claude-fable-5')
        const result = flip.apply(autoRequest, null)
        expect(result.downgrade).toBeUndefined()
        expect(result.note).toContain('the model was left alone')
        expect(result.note).toContain('account switching: flip only')
        expect(flip.takeDowngradePick()).toBeNull()
    })

    it('downgrade-only drops the model and never moves the account', async () => {
        // Even though `alt` is sitting there with Opus headroom, the account
        // does not move: that is what this setting says.
        const said: string[] = []
        const flip = await controllerOn('main', said)
        flip.setPolicy({ onFamilyExhausted: 'downgrade-only' })
        running(flip, 'claude-fable-5')
        const result = flip.apply(autoRequest, null)
        expect(result.kind).toBe('refused')
        expect(result.downgrade).toMatchObject({ to: 'opus' })
        expect(result.note).toContain('Staying on main')
        expect(result.note).toContain('account switching: downgrade only')
    })

    it('nothing changes neither, and says which setting decided that', async () => {
        const said: string[] = []
        const flip = await controllerOn('main', said)
        flip.setPolicy({ onFamilyExhausted: 'nothing' })
        running(flip, 'claude-fable-5')
        const result = flip.apply(autoRequest, null)
        expect(result.kind).toBe('refused')
        expect(result.downgrade).toBeUndefined()
        expect(result.note).toContain('nothing was changed')
        expect(result.note).toContain('account switching: do nothing')
    })

    it('an account named by hand overrules the policy', async () => {
        // `nothing` is about what happens BY ITSELF. Clay typing /flip alt is
        // not the machinery deciding anything.
        const said: string[] = []
        const flip = await controllerOn('main', said)
        flip.setPolicy({ onFamilyExhausted: 'nothing' })
        running(flip, 'claude-fable-5')
        const result = flip.apply({ account: 'alt', reason: 'asked', by: 'clay' }, null)
        expect(result.kind).toBe('flipped')
    })

    it('follows the two values the key shipped with', async () => {
        const said: string[] = []
        const flip = await controllerOn('main', said)
        flip.setPolicy({ onFamilyExhausted: 'stop' })
        running(flip, 'claude-fable-5')
        expect(flip.switchPolicy()).toBe('flip-only')
        flip.setPolicy({ onFamilyExhausted: 'fallback' })
        expect(flip.switchPolicy()).toBe('flip-then-downgrade')
    })

    it('takes the chain the settings store carries', async () => {
        writeUsage(join(root, 'p-main'), [limit(100, 'Fable'), limit(100, 'Opus'), limit(5, 'Sonnet')])
        writeUsage(join(root, 'p-alt'), [limit(100, 'Fable'), limit(100, 'Opus'), limit(5, 'Sonnet')])
        const said: string[] = []
        const flip = await controllerOn('main', said)
        flip.setPolicy({ onFamilyExhausted: 'flip-then-downgrade', familyFallback: { fable: ['sonnet'] } })
        running(flip, 'claude-fable-5')
        const result = flip.apply(autoRequest, null)
        expect(result.downgrade).toMatchObject({ to: 'sonnet', model: 'claude-sonnet-5' })
    })
})
