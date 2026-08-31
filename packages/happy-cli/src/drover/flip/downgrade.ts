/**
 * Dropping a rung down the model ladder when no account can carry the one the
 * session is on (DROVE-187).
 *
 * The flip machinery already did everything up to the last step. Clay's 3:25am
 * transcript, verbatim:
 *
 *     Cattle Drover: main hit its Fable limit. Flipping.
 *     Cattle Drover: every other account is out of headroom, so staying on
 *     main. Nothing has Fable headroom, so switch models with `/model` or the
 *     next turn hits the same wall.
 *
 * Detection right, flip attempt right, and then a sentence asking him to type
 * `/model` while he was asleep. The session sat dead until he read it. So the
 * last step happens here instead: pick the next family down, check some account
 * can actually run it, and say which policy chose.
 *
 * THE LADDER IS CLAY'S OWN, out of his global config: Fable 5 for the hardest
 * reasoning, Opus 4.8/5 for implementation and taste, Sonnet 5 for mechanical
 * grunt, Haiku never. So Fable falls to Opus and then Sonnet, Opus falls to
 * Sonnet, and Sonnet is the floor. `haiku` is filtered out of every chain no
 * matter what the settings store says, because "Haiku: never" is not a default
 * to be overridden by a stale familyFallback row — it is the rule.
 *
 * ACCOUNT BEFORE MODEL. Flipping to another login keeps the model Clay asked
 * for and costs nothing but a relaunch; dropping the model changes the answers
 * he gets. So the caller tries the current family across every account first
 * (pickTarget already does exactly that) and only reaches this file when that
 * came back empty. `planDowngrade` walks the ladder in order and takes the
 * FIRST family something can run, which is the smallest drop available.
 */

import { familyLabel } from './limits'

/**
 * What the Account switching screen is set to (DROVE-160 named that screen).
 *
 * Carried on the existing `onFamilyExhausted` key rather than a second one.
 * That key already had a store, an RPC, a metadata channel and a row on the
 * screen — and nothing at all read it, so it was a setting that did nothing.
 * Its two old values map onto two of the four: `fallback` was always "swap the
 * model when you have to" and `stop` was always "never swap it".
 */
export type SwitchPolicy = 'flip-then-downgrade' | 'flip-only' | 'downgrade-only' | 'nothing'

/** What a policy is called in a sentence Clay reads. */
export const switchPolicyLabel: Record<SwitchPolicy, string> = {
    'flip-then-downgrade': 'flip then downgrade',
    'flip-only': 'flip only',
    'downgrade-only': 'downgrade only',
    nothing: 'do nothing',
}

const canonical = new Set<string>([
    'flip-then-downgrade',
    'flip-only',
    'downgrade-only',
    'nothing',
])

/**
 * Read the stored value, whatever vintage it is.
 *
 * The default is `flip-then-downgrade`, which is the whole point of the ticket:
 * an unattended session must keep working. Anything unrecognised falls to the
 * default too — a value written by a newer client must not wedge an older CLI
 * into doing nothing, which is the one outcome Clay is complaining about.
 */
export function switchPolicyOf(value: unknown): SwitchPolicy {
    if (typeof value !== 'string') return 'flip-then-downgrade'
    if (canonical.has(value)) return value as SwitchPolicy
    // The two values the store shipped with before this ticket.
    if (value === 'stop') return 'flip-only'
    if (value === 'fallback') return 'flip-then-downgrade'
    return 'flip-then-downgrade'
}

export function mayFlipAccount(policy: SwitchPolicy): boolean {
    return policy === 'flip-then-downgrade' || policy === 'flip-only'
}

export function mayDowngradeModel(policy: SwitchPolicy): boolean {
    return policy === 'flip-then-downgrade' || policy === 'downgrade-only'
}

/**
 * The shipped ladder, by family. Matches engine/settings.js's familyFallback
 * defaults, which is the layer Clay can edit; this copy is what a session runs
 * on when the bus is not answering, not a second source of truth.
 */
export const builtInLadder: Readonly<Record<string, readonly string[]>> = Object.freeze({
    fable: ['opus', 'sonnet'],
    mythos: ['opus', 'sonnet'],
    opus: ['sonnet'],
})

/**
 * The families to try below `family`, best first.
 *
 * Haiku is stripped here and not in the store, so a familyFallback row that
 * still names it (an old settings file, a hand-edit) cannot land a session on
 * it. The current family is stripped too: a chain that loops back on itself
 * would re-offer the model that just ran out.
 */
export function ladderFor(
    family: string | undefined,
    familyFallback?: Record<string, string[]> | null,
): string[] {
    if (!family) return []
    const chain = familyFallback?.[family] ?? builtInLadder[family] ?? []
    const seen = new Set<string>([family, 'haiku'])
    const out: string[] = []
    for (const next of chain) {
        const f = String(next).trim().toLowerCase()
        if (!f || seen.has(f)) continue
        seen.add(f)
        out.push(f)
    }
    return out
}

/**
 * The model id to type at `/model` for a family.
 *
 * Full ids, never the short aliases: the aliases resolve at runtime and
 * `opusplan` means two different models depending on the mode, which is
 * precisely the ambiguity paneModelSync's comment warns about. Unknown family
 * returns null and the caller skips that rung rather than typing a guess.
 */
const modelIdByFamily: Record<string, string> = {
    fable: 'claude-fable-5',
    opus: 'claude-opus-5',
    sonnet: 'claude-sonnet-5',
}

/**
 * `claude-opus-5[1m]` is the 1M-context variant of the same model, and Claude
 * Code takes the bracket on `fable[1m]`, `opus[1m]` and `sonnet[1m]` alike. A
 * session Clay put on a 1M context keeps it across a downgrade: dropping it
 * silently would truncate the conversation he is in the middle of.
 */
export function modelIdFor(family: string, currentModel?: string | null): string | null {
    const base = modelIdByFamily[family]
    if (!base) return null
    const bracket = typeof currentModel === 'string' ? currentModel.match(/\[(1|2)m\]$/i) : null
    return bracket ? `${base}${bracket[0].toLowerCase()}` : base
}

// --- effort ------------------------------------------------------------------
//
// DROVE-164 settled this and it is easy to get backwards, so it is written out
// once: the xhigh gate is a DENY list, not an allow list. `X2(model)` in Claude
// Code 2.1.251 names the models that CANNOT reach xhigh, and everything absent
// from it can. DROVE-101 wrote the same table as an allow list from
// documentation, got Opus 5 wrong, and greyed out the level Clay had been
// asking for since June. An allow list also cripples every model shipped after
// the table was written, which is the failure mode that cannot be noticed.
//
// This is the same set the app's modelModeOptions.ts holds. Two copies, because
// the app cannot import from the CLI and the CLI cannot import from the app,
// and a downgrade decided in the CLI has to clamp effort before it types it.

const noXhighModels: ReadonlySet<string> = new Set([
    'claude-opus-4-0',
    'claude-opus-4-1',
    'claude-opus-4-5',
    'claude-opus-4-6',
    'claude-sonnet-4-0',
    'claude-sonnet-4-5',
    'claude-sonnet-4-6',
    'claude-haiku-4-5',
])

/** Every `claude-3-*` is below the xhigh line too, and there are many. */
const legacyPrefix = 'claude-3-'

/** The SDK's scale, in order, plus `ultracode` (xhigh with workflows). */
const effortScale = ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'] as const

function baseModelKey(model: string | null | undefined): string {
    if (!model) return ''
    const bracket = model.indexOf('[')
    return bracket > 0 ? model.slice(0, bracket) : model
}

export function reachesXhigh(model: string | null | undefined): boolean {
    const base = baseModelKey(model)
    // No model named is not a model that cannot: an unresolved id keeps the
    // whole scale rather than being trimmed on a guess.
    if (base.length === 0) return true
    if (base.startsWith(legacyPrefix)) return false
    return !noXhighModels.has(base)
}

/**
 * The effort a model will actually take, given the one the session is on.
 *
 * Null in means null out: nothing was picked, so there is nothing to clamp. A
 * level the model accepts is returned unchanged. Otherwise the nearest accepted
 * level STEPPING DOWN — `ultracode` becomes `max`, `xhigh` becomes `high` —
 * because the alternative is stepping up into a level Clay never asked for.
 * Claude Code would silently downgrade this itself; the point of doing it here
 * is that the message can say so.
 */
export function nearestEffort(model: string | null | undefined, effort: string | null | undefined): string | null {
    if (typeof effort !== 'string' || effort.length === 0) return null
    if (reachesXhigh(model)) return effort
    const gated = new Set(['xhigh', 'ultracode'])
    if (!gated.has(effort)) return effort
    const at = effortScale.indexOf(effort as (typeof effortScale)[number])
    if (at < 0) return effort
    for (let i = at - 1; i >= 0; i--) {
        const level = effortScale[i]
        if (!gated.has(level)) return level
    }
    return 'low'
}

// --- the plan ----------------------------------------------------------------

export interface DowngradePlan {
    /** The family that ran out. */
    from: string
    /** The family we are dropping to. */
    to: string
    /** The full model id to type at `/model`. */
    model: string
    /**
     * The effort to type at `/effort`, only when the new model cannot take the
     * one the session is on. Null means leave effort alone.
     */
    effort: string | null
    /** The effort we were on, for the sentence that explains the change. */
    previousEffort: string | null
}

export interface PlanDowngradeOptions {
    /** The family that just ran out. */
    family: string | undefined
    /** The model id the session is on, for the `[1m]` variant and the effort ceiling. */
    model?: string | null
    /** The effort the session is on, if anything picked one. */
    effort?: string | null
    /** The store's chain, when the bus answered. Falls back to the built-in ladder. */
    familyFallback?: Record<string, string[]> | null
    /**
     * Can anything actually run this family right now? The caller answers from
     * pickTarget, so headroom is read in exactly one place and a downgrade can
     * never land on a family that is itself exhausted.
     */
    runnable: (family: string) => boolean
}

/**
 * The smallest drop that gets the session working again, or null.
 *
 * Null has two causes and they are not the same: no ladder below this family
 * (Sonnet is the floor), or every rung below is out of headroom too. Both mean
 * the caller falls back to what it did before — park, or stay put and say so —
 * so they do not need telling apart here.
 */
export function planDowngrade(opts: PlanDowngradeOptions): DowngradePlan | null {
    const { family, model, effort, familyFallback, runnable } = opts
    if (!family) return null
    for (const to of ladderFor(family, familyFallback)) {
        if (!runnable(to)) continue
        const id = modelIdFor(to, model)
        if (!id) continue
        const wanted = typeof effort === 'string' && effort.length > 0 ? effort : null
        const allowed = nearestEffort(id, wanted)
        return {
            from: family,
            to,
            model: id,
            effort: allowed !== null && allowed !== wanted ? allowed : null,
            previousEffort: wanted,
        }
    }
    return null
}

/**
 * The sentence a downgrade prints.
 *
 * It names the POLICY that chose, every time. Clay's complaint is not only that
 * nothing happened, it is that he could not tell what was supposed to happen —
 * so "no account has Fable headroom, so dropped to Opus 5 (account switching:
 * flip then downgrade)" is the shape every one of these takes.
 */
export function downgradeNote(plan: DowngradePlan, policy: SwitchPolicy): string {
    const parts = [
        `Cattle Drover: no account has ${familyLabel(plan.from)} headroom, so dropped to ` +
            `${familyLabel(plan.to)} (${plan.model})`,
    ]
    if (plan.effort) {
        parts.push(
            `. ${familyLabel(plan.to)} does not take ${plan.previousEffort} effort, so effort is ` +
                `${plan.effort} — the nearest it accepts`,
        )
    }
    parts.push(` (account switching: ${switchPolicyLabel[policy]}).`)
    return parts.join('')
}

/** What a policy that REFUSED to act says, so the refusal is never a mystery. */
export function policySuffix(policy: SwitchPolicy): string {
    return ` (account switching: ${switchPolicyLabel[policy]})`
}
