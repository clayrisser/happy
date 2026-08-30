import { describe, expect, it } from 'vitest'

import {
    busResolutionFor,
    completedReasonFor,
    completedStatusFor,
    pushMetadata,
    requestForEvent,
    type DroverEvent,
} from './droverBridge'
import type { Metadata } from '@/api/types'

const question: DroverEvent = {
    id: 'ev-1',
    kind: 'question',
    state: 'pending',
    title: 'Dismiss test',
    reason: 'AskUserQuestion',
    preview: 'What happened on the Mac right after the tap?',
    options: [
        { id: 'stayed', label: 'Popup stayed open', description: 'It was still showing' },
        { id: 'closed', label: 'Popup closed, nothing else' },
    ],
}

const permission: DroverEvent = {
    id: 'ev-2',
    kind: 'permission',
    state: 'pending',
    title: 'Destructive Bash command',
    preview: 'rm -rf build',
    options: [
        { id: 'allow', label: 'Allow' },
        { id: 'deny', label: 'Deny' },
    ],
    origin: { harness: 'claude-code', cwd: '/Users/clay/Projects/thing' },
}

describe('requestForEvent', () => {
    it('gives a question the questions[] shape the app card actually reads', () => {
        const card = requestForEvent(question)
        expect(card.tool).toBe('AskUserQuestion')
        const questions = (card.arguments as { questions: unknown[] }).questions
        expect(questions).toEqual([
            {
                header: 'Dismiss test',
                question: 'What happened on the Mac right after the tap?',
                options: [
                    { label: 'Popup stayed open', description: 'It was still showing' },
                    { label: 'Popup closed, nothing else' },
                ],
                multiSelect: false,
            },
        ])
    })

    it('reads multiSelect off the event instead of hardcoding it false', () => {
        const questions = (requestForEvent(multi).arguments as { questions: { multiSelect: boolean }[] }).questions
        expect(questions[0].multiSelect).toBe(true)
    })

    it('renders a to-do through the permission card, which already has buttons', () => {
        const card = requestForEvent(todo)
        expect(card.tool).toBe('Bash')
        expect(card.arguments).toMatchObject({
            command: 'git push origin lane/DROVE-53',
            description: 'push the release \u2014 the lane is blocked on it (by 10:00)',
        })
    })

    it('keeps a permission on the Bash card with its cwd', () => {
        const card = requestForEvent(permission)
        expect(card.tool).toBe('Bash')
        expect(card.arguments).toMatchObject({ command: 'rm -rf build', cwd: '/Users/clay/Projects/thing' })
    })
})

// DROVE-53. A question Claude meant as "pick as many as apply", and the
// needs-you record that asks for an ACTION instead of an answer.
const multi: DroverEvent = {
    ...question,
    id: 'ev-3',
    multiSelect: true,
    options: [
        { id: 'a', label: 'Alpha' },
        { id: 'b', label: 'Beta' },
        { id: 'c', label: 'Gamma' },
    ],
}

const todo: DroverEvent = {
    id: 'ev-4',
    kind: 'todo',
    state: 'pending',
    title: 'push the release',
    reason: 'the lane is blocked on it (by 10:00)',
    preview: 'git push origin lane/DROVE-53',
    options: [
        { id: 'done', label: 'Done' },
        { id: 'drop', label: 'Drop it' },
    ],
    origin: { harness: 'claude-code', cwd: '/Users/clay/Projects/thing' },
}

describe('busResolutionFor', () => {
    it('turns the label the card submits back into the option id', () => {
        expect(busResolutionFor(question, {
            id: 'ev-1',
            approved: true,
            updatedInput: { answers: { 'What happened on the Mac right after the tap?': 'Popup stayed open' } },
        })).toEqual({ action: 'option', optionId: 'stayed', by: 'happy' })
    })

    it('takes an option id straight through, which is what the wrist sends', () => {
        expect(busResolutionFor(question, {
            id: 'ev-1',
            approved: true,
            updatedInput: { optionId: 'closed' },
        })).toEqual({ action: 'option', optionId: 'closed', by: 'happy' })
    })

    it('never answers a question with allow — the bus 409s that on purpose', () => {
        expect(busResolutionFor(question, { id: 'ev-1', approved: true })).toBeNull()
        expect(busResolutionFor(question, { id: 'ev-1', approved: false })).toBeNull()
    })

    it('sends an unmatched answer as free text rather than dropping it', () => {
        expect(busResolutionFor(question, {
            id: 'ev-1',
            approved: true,
            updatedInput: { answers: { q: 'something nobody offered' } },
        })).toEqual({ action: 'text', text: 'something nobody offered', by: 'happy' })
    })

    it('matches a whole multi-select value before splitting it on commas', () => {
        const commas: DroverEvent = {
            ...question,
            options: [{ id: 'both', label: 'Popup closed, nothing else' }],
        }
        expect(busResolutionFor(commas, {
            id: 'ev-1',
            approved: true,
            updatedInput: { answers: { q: 'Popup closed, nothing else' } },
        })).toEqual({ action: 'option', optionId: 'both', by: 'happy' })
    })

    it('leaves a permission on allow and deny', () => {
        expect(busResolutionFor(permission, { id: 'ev-2', approved: true }))
            .toEqual({ action: 'allow', by: 'happy' })
        expect(busResolutionFor(permission, { id: 'ev-2', approved: false, reason: 'no' }))
            .toEqual({ action: 'deny', by: 'happy', text: 'no' })
    })

    it('keeps every pick on a multi-select instead of the first one', () => {
        // The phone joins its picks with ", " and this used to stop at the
        // first match, so three ticks reached the session as one word at
        // HTTP 200 with nothing anywhere saying the rest had gone.
        expect(busResolutionFor(multi, {
            id: 'ev-3',
            approved: true,
            updatedInput: { answers: { q: 'Alpha, Gamma' } },
        })).toEqual({ action: 'option', optionId: 'a', optionIds: ['a', 'c'], by: 'happy' })
    })

    it("takes the wrist's optionIds array, and still fills optionId", () => {
        expect(busResolutionFor(multi, {
            id: 'ev-3',
            approved: true,
            updatedInput: { optionIds: ['b', 'c'], optionId: 'b' },
        })).toEqual({ action: 'option', optionId: 'b', optionIds: ['b', 'c'], by: 'happy' })
    })

    it('sends one pick as one optionId even on a multi-select question', () => {
        // An array where a reader expects a string is how a pick-one answer
        // starts arriving as a list nobody asked for.
        expect(busResolutionFor(multi, {
            id: 'ev-3',
            approved: true,
            updatedInput: { answers: { q: 'Beta' } },
        })).toEqual({ action: 'option', optionId: 'b', by: 'happy' })
    })

    it('closes a to-do with done or drop, never with a bare allow', () => {
        expect(busResolutionFor(todo, { id: 'ev-4', approved: true }))
            .toEqual({ action: 'option', optionId: 'done', by: 'happy' })
        expect(busResolutionFor(todo, { id: 'ev-4', approved: false }))
            .toEqual({ action: 'option', optionId: 'drop', by: 'happy' })
    })

    it('carries allow-for-session through, in both spellings the app uses', () => {
        // The Claude flavour of PermissionFooter sends allowTools; the Codex
        // one sends decision. Both were dropped here, so the button worked on
        // screen and the next identical gate fired again anyway.
        expect(busResolutionFor(permission, {
            id: 'ev-2',
            approved: true,
            allowTools: ['Bash(make clean)'],
        })).toEqual({ action: 'allow', by: 'happy', scope: 'session' })
        expect(busResolutionFor(permission, {
            id: 'ev-2',
            approved: true,
            decision: 'approved_for_session',
        })).toEqual({ action: 'allow', by: 'happy', scope: 'session' })
    })

    it('does not invent a scope on a plain allow or on a deny', () => {
        expect(busResolutionFor(permission, { id: 'ev-2', approved: true, allowTools: [] }))
            .toEqual({ action: 'allow', by: 'happy' })
        expect(busResolutionFor(permission, {
            id: 'ev-2',
            approved: false,
            allowTools: ['Bash(make clean)'],
        })).toEqual({ action: 'deny', by: 'happy' })
    })

    it('falls back to allow/deny for an event the bridge never saw', () => {
        expect(busResolutionFor(undefined, { id: 'gone', approved: true }))
            .toEqual({ action: 'allow', by: 'happy' })
    })
})

describe('the push body', () => {
    it('carries the reason, which never left the Mac before', () => {
        // The body was title plus project, so the one line that says WHY a gate
        // fired was the line the phone did not show.
        const md = pushMetadata(null, {
            ...permission,
            reason: 'this deletes files outside the repo',
        })
        expect(md.summary?.text).toBe('Destructive Bash command \u00b7 this deletes files outside the repo \u00b7 thing')
    })

    it('trims a long reason rather than letting it run off a lock screen', () => {
        const md = pushMetadata(null, { ...permission, reason: 'x'.repeat(200) })
        expect((md.summary?.text ?? '').length).toBeLessThan(140)
        expect(md.summary?.text).toContain('\u2026')
    })

    it('says nothing extra when there is no reason', () => {
        const md = pushMetadata({} as Metadata, { ...permission, reason: '' })
        expect(md.summary?.text).toBe('Destructive Bash command \u00b7 thing')
    })
})

describe('the card a resolved event leaves behind', () => {
    it('files an answered question under approved, not denied', () => {
        const answered: DroverEvent = {
            ...question,
            state: 'resolved',
            resolution: { action: 'option', optionId: 'stayed', by: 'watch' },
        }
        expect(completedStatusFor(answered)).toBe('approved')
        expect(completedReasonFor(answered)).toBe('stayed · by watch')
    })

    it('files a done to-do under approved, since ack is not allow', () => {
        expect(completedStatusFor({
            ...todo,
            state: 'resolved',
            resolution: { action: 'ack', optionId: 'done', by: 'watch' },
        })).toBe('approved')
    })

    it('keeps a denied permission denied and a canceled event canceled', () => {
        expect(completedStatusFor({
            ...permission,
            state: 'resolved',
            resolution: { action: 'deny', by: 'tmux-gum' },
        })).toBe('denied')
        expect(completedStatusFor({ ...permission, state: 'canceled' })).toBe('canceled')
    })
})
