import { describe, expect, it } from 'vitest'

import {
    busResolutionFor,
    completedReasonFor,
    completedStatusFor,
    requestForEvent,
    type DroverEvent,
} from './droverBridge'

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

    it('keeps a permission on the Bash card with its cwd', () => {
        const card = requestForEvent(permission)
        expect(card.tool).toBe('Bash')
        expect(card.arguments).toMatchObject({ command: 'rm -rf build', cwd: '/Users/clay/Projects/thing' })
    })
})

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

    it('falls back to allow/deny for an event the bridge never saw', () => {
        expect(busResolutionFor(undefined, { id: 'gone', approved: true }))
            .toEqual({ action: 'allow', by: 'happy' })
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

    it('keeps a denied permission denied and a canceled event canceled', () => {
        expect(completedStatusFor({
            ...permission,
            state: 'resolved',
            resolution: { action: 'deny', by: 'tmux-gum' },
        })).toBe('denied')
        expect(completedStatusFor({ ...permission, state: 'canceled' })).toBe('canceled')
    })
})
