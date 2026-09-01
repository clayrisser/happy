/**
 * Putting the session's model and effort back after a flip (DROVE-272).
 *
 * Clay: "when I switch accounts it doesn't flip back to whatever the model and
 * effort I had originally had ... you probably have to explicitly flip it if
 * it's not matching when you go to it."
 *
 * Two halves, like downgrade.test.ts beside it. `planRestore` is pure — the
 * account's headroom arrives as an injected `runnable`, so nothing here can
 * read this machine — and the controller half runs against a real registry in
 * a tmpdir, because "the account you named is out of Fable but has Opus" is
 * the state the bug lives in and it is not one a live run can be asked for.
 *
 * NOTHING IN THIS FILE TOUCHES THE LIVE MACHINE. `flip.test.ts` has one test
 * that points CLAUDE_CONFIG_DIR at the real `~/.claude` and asserts on whatever
 * account is logged in there; that pattern is not copied. Every path below is
 * either injected or under `root`.
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { planRestore, restoreNote } from './restore'

let root: string

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'drover-restore-'))
    process.env.XDG_STATE_HOME = join(root, 'state')
    process.env.DROVER_ACCOUNTS = join(root, 'accounts.json')
    delete process.env.DROVER_FLIP_PROMPT
    delete process.env.DROVER_ACCOUNT
    delete process.env.CLAUDE_CONFIG_DIR
})

afterEach(() => {
    rmSync(root, { recursive: true, force: true })
})

/** "this account runs everything except the families named". */
function without(...families: string[]): (family: string) => boolean {
    const out = new Set(families)
    return (family) => !out.has(family)
}

const runsEverything = () => true

// --- the decision -----------------------------------------------------------

describe('what a flipped session must come up on', () => {
    it('is a NO-OP when the account being joined runs what was set', () => {
        // The whole point of not writing anything here: DROVE-232 already puts
        // `modelMode` and `effortLevel` on the replacement child's argv, so a
        // rewrite would set a value to itself and the retype would buy nothing
        // but Claude Code's "Switch model?" dialog.
        const plan = planRestore({
            remembered: { model: 'claude-fable-5', effort: 'max' },
            runnable: runsEverything,
        })
        expect(plan).toEqual({
            model: 'claude-fable-5',
            effort: null,
            keptEffort: 'max',
            rewrite: false,
        })
        expect(plan!.substitution).toBeUndefined()
        expect(restoreNote(plan, 'alt')).toBeNull()
    })

    it('has nothing to put back when nothing was ever picked', () => {
        expect(planRestore({ remembered: {}, runnable: runsEverything })).toBeNull()
        expect(
            planRestore({ remembered: { model: '', effort: null }, runnable: runsEverything }),
        ).toBeNull()
    })

    it('keeps the EFFORT and takes the account\'s best model when the model is cooling', () => {
        // The ticket's second trap, in one assertion. Restoring Fable onto an
        // account whose Fable week is spent pins the session to the one model
        // that account cannot run, and the next turn hits the wall the flip was
        // supposed to escape.
        const plan = planRestore({
            remembered: { model: 'claude-fable-5', effort: 'max' },
            runnable: without('fable'),
        })
        expect(plan).toMatchObject({
            model: 'claude-opus-5',
            // Null is this codebase's word for "leave effort alone", and Opus 5
            // takes max, so max is what the session keeps.
            effort: null,
            keptEffort: 'max',
            rewrite: true,
            substitution: { instead: 'claude-fable-5', withoutModel: 'fable' },
        })
    })

    it('keeps a 1M context across the substitution', () => {
        const plan = planRestore({
            remembered: { model: 'claude-fable-5[1m]', effort: 'high' },
            runnable: without('fable'),
        })
        expect(plan!.model).toBe('claude-opus-5[1m]')
        expect(plan!.keptEffort).toBe('high')
    })

    it('walks past a rung the account is also out of', () => {
        const plan = planRestore({
            remembered: { model: 'claude-fable-5', effort: 'high' },
            runnable: without('fable', 'opus'),
        })
        expect(plan!.model).toBe('claude-sonnet-5')
        expect(plan!.substitution).toMatchObject({ instead: 'claude-fable-5', withoutModel: 'fable' })
    })

    it('follows the store\'s own chain when the bus answered with one', () => {
        const plan = planRestore({
            remembered: { model: 'claude-fable-5', effort: 'high' },
            runnable: without('fable'),
            familyFallback: { fable: ['sonnet'] },
        })
        expect(plan!.model).toBe('claude-sonnet-5')
    })

    it('leaves the model standing, and SAYS so, when nothing lower runs there either', () => {
        const plan = planRestore({
            remembered: { model: 'claude-fable-5', effort: 'max' },
            runnable: () => false,
        })
        expect(plan).toMatchObject({
            model: 'claude-fable-5',
            rewrite: false,
            keptEffort: 'max',
            substitution: { instead: 'claude-fable-5', withoutModel: 'fable', stood: 'no lower model' },
        })
    })

    it('does not overrule the Account switching setting, it reports it', () => {
        // `flip-only` is Clay saying "move the account, leave the model alone".
        // A restore is not the place to quietly reverse that — but the wall is
        // still coming, so it is stated either way.
        const plan = planRestore({
            remembered: { model: 'claude-fable-5', effort: 'max' },
            runnable: without('fable'),
            mayChangeModel: false,
        })
        expect(plan).toMatchObject({
            model: 'claude-fable-5',
            rewrite: false,
            substitution: { stood: 'policy' },
        })
    })

    it('makes no claim about a model it cannot reduce to a family', () => {
        // An id from a newer app, or a provider spelling this CLI has not seen.
        // Declaring it unrunnable would substitute a model over a guess.
        const plan = planRestore({
            remembered: { model: 'some-future-model', effort: 'high' },
            runnable: () => false,
        })
        expect(plan).toMatchObject({ model: 'some-future-model', rewrite: false })
        expect(plan!.substitution).toBeUndefined()
    })

    it('restores an effort even when no model was ever picked', () => {
        const plan = planRestore({ remembered: { effort: 'xhigh' }, runnable: runsEverything })
        expect(plan).toMatchObject({ model: null, keptEffort: 'xhigh', rewrite: false })
    })
})

// --- what the arrival prompt says -------------------------------------------

describe('what the flipped session is told about its model', () => {
    it('names the account, the family it is out of, and both models', () => {
        const plan = planRestore({
            remembered: { model: 'claude-fable-5', effort: 'max' },
            runnable: without('fable'),
        })
        const note = restoreNote(plan, 'jamrizzi')!
        expect(note).toContain('jamrizzi is out of Fable')
        expect(note).toContain('came up on claude-opus-5')
        expect(note).toContain('rather than the claude-fable-5 it was set to')
        expect(note).toContain('Your effort (max) was kept')
        expect(note).toContain('once Fable resets')
    })

    it('says the wall is still there when the model had to stand', () => {
        const plan = planRestore({
            remembered: { model: 'claude-fable-5', effort: 'max' },
            runnable: () => false,
        })
        const note = restoreNote(plan, 'alt')!
        expect(note).toContain('alt is out of Fable')
        expect(note).toContain('no lower model has headroom there either')
        expect(note).toContain('hit the same wall')
    })

    it('names the setting when the setting is what stopped it', () => {
        const plan = planRestore({
            remembered: { model: 'claude-fable-5', effort: 'high' },
            runnable: without('fable'),
            mayChangeModel: false,
        })
        expect(restoreNote(plan, 'alt')).toContain('Account switching is set to')
    })

    it('says nothing at all when the session got back exactly what it had', () => {
        expect(
            restoreNote(
                planRestore({
                    remembered: { model: 'claude-opus-5', effort: 'high' },
                    runnable: runsEverything,
                }),
                'alt',
            ),
        ).toBeNull()
        expect(restoreNote(null, 'alt')).toBeNull()
        expect(restoreNote(undefined, 'alt')).toBeNull()
    })
})

// --- the controller, against a real registry in a tmpdir --------------------

function writeAccounts(accounts: { name: string; configDir: string }[]): void {
    writeFileSync(process.env.DROVER_ACCOUNTS!, JSON.stringify(accounts))
    for (const a of accounts) {
        mkdirSync(a.configDir, { recursive: true })
        writeFileSync(
            join(a.configDir, '.claude.json'),
            JSON.stringify({
                hasCompletedOnboarding: true,
                oauthAccount: { emailAddress: `${a.name}@example.com` },
            }),
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

/** A row `percent` used, scoped to one family, resetting in an hour. */
function limit(percent: number, family: string): UsageRow {
    return {
        kind: 'weekly',
        percent,
        resets_at: new Date(Date.now() + 3_600_000).toISOString(),
        scope: { model: { id: null as null, display_name: family } },
    }
}

async function controllerOn(account: string) {
    process.env.DROVER_ACCOUNT = account
    const { FlipController } = await import('./controller')
    return new FlipController(join(root, 'work'), () => {}, {
        toTerminal: () => {},
        toPane: () => {},
    })
}

/** Put the controller on a model family without a real transcript. */
function running(flip: { noteTranscriptMessage: (m: unknown) => void }, model: string): void {
    flip.noteTranscriptMessage({ type: 'assistant', message: { role: 'assistant', model, content: 'hi' } })
}

describe('the controller restoring a pick across the flip', () => {
    beforeEach(() => {
        writeAccounts([
            { name: 'main', configDir: join(root, 'r-main') },
            { name: 'alt', configDir: join(root, 'r-alt') },
        ])
    })

    it('substitutes, keeps the effort and says so when the ACCOUNT HE NAMED is out of the model', async () => {
        // Clay's own sentence — "when I switch accounts" — is an explicit flip,
        // and that is the hole. pickTarget's `wanted` branch overrides the
        // cooldown ledger on purpose (a human overruling a heuristic) and never
        // computes `withoutModel`, and `auto` is false so the downgrade block
        // is skipped entirely. Nothing before DROVE-272 noticed alt had no
        // Fable, and the carry passed `--model claude-fable-5` to a child that
        // could not run a turn with it.
        writeUsage(join(root, 'r-main'), [limit(5, 'Fable')])
        writeUsage(join(root, 'r-alt'), [limit(100, 'Fable'), limit(5, 'Opus')])
        const flip = await controllerOn('main')
        running(flip, 'claude-fable-5')
        flip.setSelectionProbe(() => ({ model: 'claude-fable-5', effort: 'max' }))

        const result = flip.apply({ account: 'alt', reason: 'manual', by: 'clay' }, null)
        expect(result.kind).toBe('flipped')
        expect(result.kind === 'flipped' && result.account.name).toBe('alt')
        expect(result.kind === 'flipped' && result.restore).toMatchObject({
            model: 'claude-opus-5',
            keptEffort: 'max',
            rewrite: true,
            substitution: { instead: 'claude-fable-5', withoutModel: 'fable' },
        })
        // The pane is told, once — the same one-shot the downgrade uses, which
        // is what reads and answers Claude Code's "Switch model?" confirmation
        // rather than stranding an unattended terminal on it (DROVE-164/271).
        expect(flip.takeDowngradePick()).toEqual({ model: 'claude-opus-5', effort: null })
        expect(flip.takeDowngradePick()).toBeNull()
        // And it is stated where the session arriving can read it.
        expect(result.kind === 'flipped' && result.prompt).toContain('alt is out of Fable')
        expect(result.kind === 'flipped' && result.prompt).toContain('claude-opus-5')
    })

    it('changes nothing when the account being joined can run what was set', async () => {
        writeUsage(join(root, 'r-main'), [limit(100, 'Fable')])
        writeUsage(join(root, 'r-alt'), [limit(5, 'Fable')])
        const flip = await controllerOn('main')
        running(flip, 'claude-fable-5')
        flip.setSelectionProbe(() => ({ model: 'claude-fable-5', effort: 'max' }))

        const result = flip.apply({ account: null, reason: 'usage limit', by: 'auto' }, null)
        expect(result.kind === 'flipped' && result.account.name).toBe('alt')
        expect(result.kind === 'flipped' && result.restore).toMatchObject({
            model: 'claude-fable-5',
            keptEffort: 'max',
            rewrite: false,
        })
        expect(flip.takeDowngradePick()).toBeNull()
        expect(result.kind === 'flipped' && result.prompt).not.toContain('is out of Fable')
    })

    it('leaves the decision to the downgrade when a downgrade already made it', async () => {
        // Two writers of `pendingPick` would be one of them silently losing,
        // and the downgrade is the better-informed of the two: it searched the
        // registry and then chose where to go.
        writeUsage(join(root, 'r-main'), [limit(100, 'Fable'), limit(5, 'Opus')])
        writeUsage(join(root, 'r-alt'), [limit(100, 'Fable'), limit(5, 'Opus')])
        const flip = await controllerOn('main')
        running(flip, 'claude-fable-5')
        flip.setSelectionProbe(() => ({ model: 'claude-fable-5', effort: 'max' }))

        const result = flip.apply({ account: null, reason: 'usage limit', by: 'auto' }, null)
        expect(result.downgrade).toMatchObject({ from: 'fable', to: 'opus', model: 'claude-opus-5' })
        expect(result.kind === 'flipped' && result.restore).toBeUndefined()
        expect(flip.takeDowngradePick()).toEqual({ model: 'claude-opus-5', effort: null })
    })

    it('asks about the TARGET account, not about the registry', async () => {
        // The distinction the whole file turns on. `main` has Fable headroom,
        // so "is Fable runnable anywhere" is yes — and it is the wrong
        // question, because the session is landing on `alt`.
        writeUsage(join(root, 'r-main'), [limit(5, 'Fable')])
        writeUsage(join(root, 'r-alt'), [limit(100, 'Fable'), limit(5, 'Opus')])
        const flip = await controllerOn('main')
        running(flip, 'claude-fable-5')
        flip.setSelectionProbe(() => ({ model: 'claude-fable-5', effort: 'xhigh' }))

        const result = flip.apply({ account: 'alt', reason: 'manual', by: 'clay' }, null)
        expect(result.kind === 'flipped' && result.restore?.model).toBe('claude-opus-5')
        expect(result.kind === 'flipped' && result.restore?.keptEffort).toBe('xhigh')
    })

    it('honours flip-only by saying the wall is coming rather than moving the model', async () => {
        writeUsage(join(root, 'r-main'), [limit(5, 'Fable')])
        writeUsage(join(root, 'r-alt'), [limit(100, 'Fable'), limit(5, 'Opus')])
        const flip = await controllerOn('main')
        flip.setPolicy({ onFamilyExhausted: 'flip-only' })
        running(flip, 'claude-fable-5')
        flip.setSelectionProbe(() => ({ model: 'claude-fable-5', effort: 'max' }))

        const result = flip.apply({ account: 'alt', reason: 'manual', by: 'clay' }, null)
        expect(result.kind === 'flipped' && result.restore).toMatchObject({
            model: 'claude-fable-5',
            rewrite: false,
            substitution: { stood: 'policy' },
        })
        expect(flip.takeDowngradePick()).toBeNull()
        expect(result.kind === 'flipped' && result.prompt).toContain('Account switching is set to')
    })
})
