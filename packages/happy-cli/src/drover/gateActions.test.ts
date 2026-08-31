import { describe, expect, it } from 'vitest'

import {
    gateActionsFor,
    gateCategoryIds,
    gateCategoryRoles,
    isRiskyGate,
    legendFor,
    overflowNoteFor,
    roleForOption,
} from './gateActions'
import { busResolutionFor, gatePushData, pushMetadata } from './droverBridge'
import type { DroverEvent, DroverOption } from './droverBridge'

function event(over: Partial<DroverEvent> = {}): DroverEvent {
    return {
        id: 'e1',
        kind: 'permission',
        state: 'pending',
        title: 'Run Bash',
        ...over,
    } as DroverEvent
}

function options(...pairs: [string, string][]): DroverOption[] {
    return pairs.map(([id, label]) => ({ id, label }))
}

describe('the category bank', () => {
    // Pinned as a literal list because happy-app registers exactly these
    // identifiers and a push naming one the app never registered shows no
    // buttons at all, with no error anywhere. The app has the same list in
    // sources/sync/droverNotificationCategories.spec.ts.
    it('is the closed set both halves agree on', () => {
        expect(gateCategoryIds()).toEqual([
            'drover.allowdeny',
            'drover.allowdeny.risky',
            'drover.allowalwaysdeny',
            'drover.allowalwaysdeny.risky',
            'drover.allowalwaysautodeny',
            'drover.allowalwaysautodeny.risky',
            'drover.todo',
            'drover.keys',
            'drover.keys.risky',
            'drover.pick2',
            'drover.pick2.risky',
            'drover.pick3',
            'drover.pick3.risky',
            'drover.pick4',
            'drover.pick4.risky',
            'drover.pickmore',
            'drover.pickmore.risky',
        ])
    })

    it('never offers more buttons than iOS will draw', () => {
        for (const roles of Object.values(gateCategoryRoles)) {
            expect(roles.length).toBeLessThanOrEqual(4)
            expect(roles.length).toBeGreaterThanOrEqual(2)
        }
    })
})

describe('roleForOption', () => {
    it('reads the bus ids the bus itself injects', () => {
        expect(roleForOption({ id: 'allow', label: 'Allow' })).toBe('allow')
        expect(roleForOption({ id: 'deny', label: 'Deny' })).toBe('deny')
        expect(roleForOption({ id: 'done', label: 'Done' })).toBe('done')
        expect(roleForOption({ id: 'drop', label: 'Drop it' })).toBe('drop')
    })

    it('reads Claude Code\'s own four sentences, whose ids are only digits', () => {
        expect(roleForOption({ id: '1', label: 'Yes' })).toBe('allow')
        expect(
            roleForOption({
                id: '2',
                label: "Yes, and don't ask again for `tmux capture-pane` commands in /Users/clayrisser/x",
            })
        ).toBe('allow_always')
        expect(
            roleForOption({
                id: '3',
                label: 'Yes, and switch to auto mode - auto mode handles these prompts for you',
            })
        ).toBe('auto')
        expect(roleForOption({ id: '4', label: 'No' })).toBe('deny')
    })

    it('says null for a label the vocabulary has no word for', () => {
        expect(roleForOption({ id: 'a', label: 'Blue' })).toBeNull()
        expect(roleForOption({ id: 'b', label: '' })).toBeNull()
    })
})

describe('gateActionsFor', () => {
    it('gives a plain permission Allow and Deny', () => {
        const plan = gateActionsFor(event({ options: options(['allow', 'Allow'], ['deny', 'Deny']) }))
        expect(plan.categoryId).toBe('drover.allowdeny')
        expect(plan.optionIds).toEqual(['allow', 'deny'])
        expect(plan.overflow).toBe(false)
    })

    // The shape from DROVE-198, and the whole reason this ticket exists: a
    // two-button banner would discard the two options Clay most wants.
    it('carries all four of the terminal approval', () => {
        const plan = gateActionsFor(
            event({
                kind: 'question',
                options: options(
                    ['1', 'Yes'],
                    ['2', "Yes, and don't ask again for `git status` commands in /repo"],
                    ['3', 'Yes, and switch to auto mode - auto mode handles these prompts for you'],
                    ['4', 'No']
                ),
            })
        )
        expect(plan.categoryId).toBe('drover.allowalwaysautodeny')
        expect(plan.optionIds).toEqual(['1', '2', '3', '4'])
        expect(plan.shown).toBe(4)
    })

    it('numbers a question whose options are arbitrary', () => {
        const ev = event({
            kind: 'question',
            options: options(['a', 'Blue'], ['b', 'Green'], ['c', 'Red']),
        })
        const plan = gateActionsFor(ev)
        expect(plan.categoryId).toBe('drover.pick3')
        expect(plan.optionIds).toEqual(['a', 'b', 'c'])
        expect(legendFor(ev, plan)).toBe('1 Blue · 2 Green · 3 Red')
    })

    // The overflow rule stated in the ticket: reachable by opening the app,
    // and the banner must not claim the list is complete.
    it('shows three and says how many it is not showing', () => {
        const ev = event({
            kind: 'question',
            options: options(
                ['a', 'One'],
                ['b', 'Two'],
                ['c', 'Three'],
                ['d', 'Four'],
                ['e', 'Five'],
                ['f', 'Six']
            ),
        })
        const plan = gateActionsFor(ev)
        expect(plan.categoryId).toBe('drover.pickmore')
        expect(plan.optionIds).toEqual(['a', 'b', 'c', ''])
        expect(plan.shown).toBe(3)
        expect(plan.total).toBe(6)
        expect(plan.overflow).toBe(true)
        expect(overflowNoteFor(plan)).toBe('+3 more in the app')
        expect(pushMetadata(null, ev, plan).summary?.text).toContain('+3 more in the app')
    })

    it('gives a to-do its own two buttons and never a risky twin', () => {
        const plan = gateActionsFor(
            event({
                kind: 'todo',
                title: 'rm -rf the stale worktrees',
                options: options(['done', 'Done'], ['drop', 'Drop it']),
            })
        )
        expect(plan.categoryId).toBe('drover.todo')
        expect(plan.risky).toBe(false)
    })

    it('keeps the two keys of a dialog the pane parser could not read', () => {
        const plan = gateActionsFor(
            event({
                kind: 'question',
                options: options(
                    ['enter', 'Press Enter (take the highlighted choice)'],
                    ['esc', 'Press Esc (cancel)']
                ),
            })
        )
        expect(plan.categoryId).toBe('drover.keys')
    })

    it('offers nothing to a gate with fewer than two options', () => {
        expect(gateActionsFor(event({ options: options(['ok', 'OK']) })).categoryId).toBeNull()
        expect(gateActionsFor(event({ kind: 'idle', options: null })).categoryId).toBeNull()
        // An idle ding has nothing to answer even when the bus gave it two.
        expect(
            gateActionsFor(event({ kind: 'idle', options: options(['allow', 'Allow'], ['deny', 'Deny']) }))
                .categoryId
        ).toBeNull()
    })
})

describe('the risky variant', () => {
    it('is chosen by the gate that fired, before any regex', () => {
        expect(isRiskyGate({ origin: { gate: 'destructive-bash' } } as DroverEvent)).toBe(true)
        expect(isRiskyGate({ origin: { gate: 'pdf-overlay-image' } } as DroverEvent)).toBe(true)
        expect(isRiskyGate({ origin: { gate: 'selftest' } } as DroverEvent)).toBe(false)
    })

    it('is chosen by the command when the gate never declared itself', () => {
        expect(isRiskyGate({ preview: 'rm -rf /tmp/build' } as DroverEvent)).toBe(true)
        expect(isRiskyGate({ preview: 'git push --force origin main' } as DroverEvent)).toBe(true)
        expect(isRiskyGate({ preview: 'kubectl delete ns prod' } as DroverEvent)).toBe(true)
        expect(isRiskyGate({ preview: "tmux capture-pane -p | grep -v '^$'" } as DroverEvent)).toBe(false)
    })

    it('makes the allow buttons demand an unlock', () => {
        const plan = gateActionsFor(
            event({ preview: 'rm -rf ~/Projects', options: options(['allow', 'Allow'], ['deny', 'Deny']) })
        )
        expect(plan.categoryId).toBe('drover.allowdeny.risky')
        expect(plan.risky).toBe(true)
    })
})

describe('gatePushData', () => {
    it('names the holder for the buttons and the raiser for the tap', () => {
        const ev = event({ options: options(['allow', 'Allow'], ['deny', 'Deny']) })
        const plan = gateActionsFor(ev)
        const data = gatePushData(ev, 'Bash', 'raising-session', 'bridge-session', plan)
        // Two different sessions, and confusing them is what DROVE-94 fixed in
        // one direction and this ticket needs in the other.
        expect(data.sessionId).toBe('raising-session')
        expect(data.answerSessionId).toBe('bridge-session')
        expect(data.categoryId).toBe('drover.allowdeny')
        expect(JSON.parse(data.actions)).toEqual(['allow', 'deny'])
        expect(data.optionCount).toBe('2')
        expect(data.overflow).toBeUndefined()
    })

    it('carries no category when the gate has no buttons', () => {
        const ev = event({ kind: 'idle', options: null })
        const data = gatePushData(ev, 'Bash', null, 'bridge-session', gateActionsFor(ev))
        expect(data.categoryId).toBeUndefined()
        expect(data.actions).toBeUndefined()
    })

    it('is unchanged for a caller that passes no plan', () => {
        const data = gatePushData(event(), 'Bash', 'raising')
        expect(data).toEqual({
            sessionId: 'raising',
            gateId: 'e1',
            kind: 'permission',
            requestId: 'e1',
            tool: 'Bash',
            type: 'permission_request',
            provider: 'claude',
        })
    })
})

/**
 * ONE ANSWER, WHOEVER PRESSED IT.
 *
 * The bus is the arbiter and always was: the first resolve wins, the loser
 * gets 409, and the terminal frame it broadcasts is what dismisses the card,
 * the wrist and the popup. What this ticket adds is a fourth surface, so what
 * has to be pinned here is that a banner answer produces the SAME bus
 * resolution the app produces for the same choice, differing only in the `by`
 * stamp that says which surface got there first.
 */
describe('a banner answer, against the other surfaces', () => {
    const permission = event({ options: options(['allow', 'Allow'], ['deny', 'Deny']) })
    const question = event({
        kind: 'question',
        options: options(['1', 'Yes'], ['2', "Yes, and don't ask again for `x` in /r"], ['4', 'No']),
    })

    it('allows a permission exactly as the app does, and says the banner did it', () => {
        expect(busResolutionFor(permission, { id: 'e1', approved: true, updatedInput: { via: 'push', channel: 'visual' } }))
            .toEqual({ action: 'allow', by: 'push', channel: 'visual' })
        expect(busResolutionFor(permission, { id: 'e1', approved: true }))
            .toEqual({ action: 'allow', by: 'phone', channel: 'visual' })
        expect(busResolutionFor(permission, { id: 'e1', approved: true, updatedInput: { via: 'watch' } }))
            .toEqual({ action: 'allow', by: 'watch', channel: 'visual' })
    })

    it('denies a permission from the banner', () => {
        expect(busResolutionFor(permission, { id: 'e1', approved: false }))
            .toEqual({ action: 'deny', by: 'phone', channel: 'visual' })
    })

    // The option id the button carries is the bus's own id, so this is a
    // straight match rather than a label lookup — which is the whole reason
    // the slot is positional and the ids ride in the payload.
    it('names the option a numbered or named button chose', () => {
        expect(
            busResolutionFor(question, {
                id: 'e1',
                approved: true,
                updatedInput: { optionId: '2', via: 'push', channel: 'visual' },
            })
        ).toEqual({ action: 'option', optionId: '2', by: 'push', channel: 'visual' })
    })

    // A question has no "no", so a banner cannot deny one into a resolution
    // that hands the waiting hook nothing.
    it('refuses to turn a banner press into an unanswered question', () => {
        expect(busResolutionFor(question, { id: 'e1', approved: false, updatedInput: { via: 'push' } }))
            .toBeNull()
    })

    // DROVE-69: a to-do closes only by naming one of its own buttons.
    it('closes a to-do only by naming a button', () => {
        const todo = event({ kind: 'todo', options: options(['done', 'Done'], ['drop', 'Drop it']) })
        expect(
            busResolutionFor(todo, {
                id: 'e1',
                approved: true,
                updatedInput: { optionId: 'done', via: 'push', channel: 'visual' },
            })
        ).toEqual({ action: 'option', optionId: 'done', by: 'push', channel: 'visual' })
        expect(busResolutionFor(todo, { id: 'e1', approved: true, updatedInput: { via: 'push' } })).toBeNull()
    })
})

describe('the push body a numbered banner needs', () => {
    // "1 2 3" on its own is a row of buttons meaning nothing. The legend is
    // what makes the banner read the way the terminal does.
    it('lists the numbered options after the reason', () => {
        const ev = event({
            kind: 'question',
            title: 'Pick an order',
            reason: 'the migration runs in this order',
            options: options(['a', 'Schema first'], ['b', 'Data first']),
            origin: { cwd: '/Users/clay/Projects/bitspur/happy' },
        })
        const text = pushMetadata(null, ev, gateActionsFor(ev)).summary?.text ?? ''
        expect(text).toBe(
            'Pick an order · the migration runs in this order · happy · 1 Schema first · 2 Data first'
        )
    })

    it('adds no legend to a banner whose buttons already say what they do', () => {
        const ev = event({ title: 'Run Bash', options: options(['allow', 'Allow'], ['deny', 'Deny']) })
        expect(pushMetadata(null, ev, gateActionsFor(ev)).summary?.text).toBe('Run Bash')
    })
})
