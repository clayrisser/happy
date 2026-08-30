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

    it('gives a to-do its own card, not the permission card anything can approve', () => {
        // DROVE-69. On the permission card, every generic approve path in the
        // app closed it — the phone's Allow, the wrist's Allow, the voice
        // tool — and event 4c3f5082 was acked with nobody touching it.
        const card = requestForEvent(todo)
        expect(card.tool).toBe('DroverTodo')
        expect(card.arguments).toMatchObject({
            title: 'push the release',
            reason: 'the lane is blocked on it (by 10:00)',
            command: 'git push origin lane/DROVE-53',
            options: [{ id: 'done', label: 'Done' }, { id: 'drop', label: 'Drop it' }],
        })
    })

    it('carries the bus event on every card so the inbox can group and age them', () => {
        // DROVE-71. The card shapes are chosen to RENDER — a Bash card packs
        // title and reason into one description string — so an inbox had
        // nothing to read back but a display string.
        expect(requestForEvent({ ...todo, createdAt: 1788131047730 }).droverEvent).toEqual({
            kind: 'todo',
            title: 'push the release',
            reason: 'the lane is blocked on it (by 10:00)',
            command: 'git push origin lane/DROVE-53',
            createdAt: 1788131047730,
        })
        expect(requestForEvent(permission).droverEvent).toMatchObject({ kind: 'permission' })
        expect(requestForEvent(question).droverEvent).toMatchObject({ kind: 'question' })
    })

    it('uses the BUS createdAt, so a bridge restart does not reset an age', () => {
        // The bridge re-mirrors every pending event on restart and the card
        // stamps its own createdAt then, so a to-do raised an hour before a
        // launchd roll read as one minute old. A to-do never expires, so it is
        // the kind most likely to outlive several restarts.
        const card = requestForEvent({ ...todo, createdAt: 1 })
        expect(card.droverEvent.createdAt).toBe(1)
        expect(card.createdAt).not.toBe(1)
    })

    it('keeps a permission on the Bash card with its cwd', () => {
        const card = requestForEvent(permission)
        expect(card.tool).toBe('Bash')
        expect(card.arguments).toMatchObject({ command: 'rm -rf build', cwd: '/Users/clay/Projects/thing' })
    })

    // Every gate is mirrored into ONE bridge session per machine, so without
    // this the app cannot tell which of five running agents stopped and the
    // session view has nothing of its own to present (DROVE-19).
    it('names the session that raised a question, so the app can present it there', () => {
        const card = requestForEvent({
            ...question,
            origin: {
                harness: 'claude-code',
                sessionId: 'e495e6e8-43f6-4699-a984-ff19f5ab4551',
                cwd: '/Users/clay/Projects/bitspur/cattle-drover',
            },
        })
        expect(card.droverOrigin).toEqual({
            sessionId: 'e495e6e8-43f6-4699-a984-ff19f5ab4551',
            cwd: '/Users/clay/Projects/bitspur/cattle-drover',
        })
    })

    it('names it on a permission too', () => {
        const card = requestForEvent({
            ...permission,
            origin: { harness: 'claude-code', sessionId: 'sess-9', cwd: '/Users/clay/Projects/thing' },
        })
        expect(card.droverOrigin).toEqual({ sessionId: 'sess-9', cwd: '/Users/clay/Projects/thing' })
    })

    // An event with no origin gets no origin key rather than an empty one: the
    // app treats a missing origin as "this gate belongs to nobody in
    // particular" and leaves it on the bridge session, which is the truth.
    it('leaves the key off entirely when the bus event carries no origin', () => {
        expect(requestForEvent(question).droverOrigin).toBeUndefined()
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

    it('closes a to-do only when a button on it was actually named', () => {
        expect(busResolutionFor(todo, {
            id: 'ev-4', approved: true, updatedInput: { optionId: 'done' },
        })).toEqual({ action: 'option', optionId: 'done', by: 'happy' })
        // By LABEL too: the phone submits labels, the wrist submits ids.
        expect(busResolutionFor(todo, {
            id: 'ev-4', approved: true, updatedInput: { optionId: 'Drop it' },
        })).toEqual({ action: 'option', optionId: 'drop', by: 'happy' })
    })

    it('leaves a to-do PENDING when the answer names no button at all', () => {
        // DROVE-69, the whole ticket. `approved ? done : drop` meant any
        // affirmative closed it, so a to-do could be acked by anything in the
        // app that can approve a permission. Event 4c3f5082 was resolved that
        // way 257 seconds after it was raised, `by happy`, while Clay was
        // asking where the to-do list was. A gate left open blocks a session;
        // a to-do left open is just a to-do, so pending is the safe direction.
        expect(busResolutionFor(todo, { id: 'ev-4', approved: true })).toBeNull()
        expect(busResolutionFor(todo, { id: 'ev-4', approved: false })).toBeNull()
        // Not even the "allow and stop asking" spellings, which is how the
        // voice tool and a bypass-mode tap would arrive.
        expect(busResolutionFor(todo, {
            id: 'ev-4', approved: true, decision: 'approved_for_session',
        })).toBeNull()
        expect(busResolutionFor(todo, {
            id: 'ev-4', approved: true, allowTools: ['Bash(git push)'],
        })).toBeNull()
        // An option that is not on THIS to-do is not an answer to it either.
        expect(busResolutionFor(todo, {
            id: 'ev-4', approved: true, updatedInput: { optionId: 'allow' },
        })).toBeNull()
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

// --- adding a Claude account from the phone (DROVE-61) -----------------------

const login: DroverEvent = {
    id: 'ev-3',
    kind: 'question',
    state: 'pending',
    title: 'Log in to Claude for account-2',
    reason: 'Open this in a browser, sign in, then send back the code it shows.',
    preview: 'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a&state=abc',
    options: [{ id: 'cancel', label: 'Cancel the login' }],
    origin: { harness: 'drover', gate: 'account-login', cwd: '/Users/clay' },
}

describe('the account-login card', () => {
    it('gets its own tool, because it is a link and a code, not a choice', () => {
        // Mirrored through the generic question card this could only ever be
        // cancelled: that card renders options as buttons and has nowhere to
        // type, and the code is not one of the options.
        const card = requestForEvent(login)
        expect(card.tool).toBe('DroverAccountLogin')
        expect(card.arguments).toMatchObject({
            url: login.preview,
            header: login.title,
            cancelLabel: 'Cancel the login',
        })
    })

    it('leaves the FAILED card of the same gate as an ordinary question', () => {
        // `drover account login` posts its failure under the same gate with a
        // sentence and no link. That one has nothing to share and nothing to
        // type into, so it stays a plain one-option question.
        const failed: DroverEvent = {
            ...login,
            title: 'Claude login for account-2 failed',
            preview: 'cancelled from the phone',
            options: [{ id: 'ok', label: 'OK' }],
        }
        expect(requestForEvent(failed).tool).toBe('AskUserQuestion')
    })

    it('is not claimed by a question that merely has a URL in it', () => {
        expect(requestForEvent({ ...question, preview: 'https://example.com' }).tool)
            .toBe('AskUserQuestion')
    })

    it('sends the pasted code back as a text resolution, whole', () => {
        // An OAuth code is one opaque string. The multi-select path splits an
        // answer on commas to recover the labels it joined, and doing that to
        // a code would send the bus the part before the first comma.
        expect(busResolutionFor(login, {
            id: 'ev-3',
            approved: true,
            updatedInput: { code: 'AbC,123#state' },
        })).toEqual({ action: 'text', text: 'AbC,123#state', by: 'happy' })
    })

    it('sends Cancel back as the option it is, so the login ends now', () => {
        expect(busResolutionFor(login, {
            id: 'ev-3',
            approved: true,
            updatedInput: { optionId: 'cancel' },
        })).toEqual({ action: 'option', optionId: 'cancel', by: 'happy' })
    })
})
