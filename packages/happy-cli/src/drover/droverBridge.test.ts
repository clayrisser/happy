import { describe, expect, it } from 'vitest'

import {
    announcePlanFor,
    busResolutionFor,
    completedReasonFor,
    deliveryOf,
    completedStatusFor,
    gatePushData,
    pushMetadata,
    requestForEvent,
    applyPendingSnapshot,
    retireCard,
    trimCompleted,
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
        })).toEqual({ action: 'option', optionId: 'stayed', by: 'phone', channel: 'visual' })
    })

    it('takes an option id straight through, which is what the wrist sends', () => {
        expect(busResolutionFor(question, {
            id: 'ev-1',
            approved: true,
            updatedInput: { optionId: 'closed' },
        })).toEqual({ action: 'option', optionId: 'closed', by: 'phone', channel: 'visual' })
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
        })).toEqual({ action: 'text', text: 'something nobody offered', by: 'phone', channel: 'visual' })
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
        })).toEqual({ action: 'option', optionId: 'both', by: 'phone', channel: 'visual' })
    })

    it('leaves a permission on allow and deny', () => {
        expect(busResolutionFor(permission, { id: 'ev-2', approved: true }))
            .toEqual({ action: 'allow', by: 'phone', channel: 'visual' })
        expect(busResolutionFor(permission, { id: 'ev-2', approved: false, reason: 'no' }))
            .toEqual({ action: 'deny', by: 'phone', channel: 'visual', text: 'no' })
    })

    it('keeps every pick on a multi-select instead of the first one', () => {
        // The phone joins its picks with ", " and this used to stop at the
        // first match, so three ticks reached the session as one word at
        // HTTP 200 with nothing anywhere saying the rest had gone.
        expect(busResolutionFor(multi, {
            id: 'ev-3',
            approved: true,
            updatedInput: { answers: { q: 'Alpha, Gamma' } },
        })).toEqual({ action: 'option', optionId: 'a', optionIds: ['a', 'c'], by: 'phone', channel: 'visual' })
    })

    it("takes the wrist's optionIds array, and still fills optionId", () => {
        expect(busResolutionFor(multi, {
            id: 'ev-3',
            approved: true,
            updatedInput: { optionIds: ['b', 'c'], optionId: 'b' },
        })).toEqual({ action: 'option', optionId: 'b', optionIds: ['b', 'c'], by: 'phone', channel: 'visual' })
    })

    it('sends one pick as one optionId even on a multi-select question', () => {
        // An array where a reader expects a string is how a pick-one answer
        // starts arriving as a list nobody asked for.
        expect(busResolutionFor(multi, {
            id: 'ev-3',
            approved: true,
            updatedInput: { answers: { q: 'Beta' } },
        })).toEqual({ action: 'option', optionId: 'b', by: 'phone', channel: 'visual' })
    })

    it('closes a to-do only when a button on it was actually named', () => {
        expect(busResolutionFor(todo, {
            id: 'ev-4', approved: true, updatedInput: { optionId: 'done' },
        })).toEqual({ action: 'option', optionId: 'done', by: 'phone', channel: 'visual' })
        // By LABEL too: the phone submits labels, the wrist submits ids.
        expect(busResolutionFor(todo, {
            id: 'ev-4', approved: true, updatedInput: { optionId: 'Drop it' },
        })).toEqual({ action: 'option', optionId: 'drop', by: 'phone', channel: 'visual' })
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
        })).toEqual({ action: 'allow', by: 'phone', channel: 'visual', scope: 'session' })
        expect(busResolutionFor(permission, {
            id: 'ev-2',
            approved: true,
            decision: 'approved_for_session',
        })).toEqual({ action: 'allow', by: 'phone', channel: 'visual', scope: 'session' })
    })

    it('does not invent a scope on a plain allow or on a deny', () => {
        expect(busResolutionFor(permission, { id: 'ev-2', approved: true, allowTools: [] }))
            .toEqual({ action: 'allow', by: 'phone', channel: 'visual' })
        expect(busResolutionFor(permission, {
            id: 'ev-2',
            approved: false,
            allowTools: ['Bash(make clean)'],
        })).toEqual({ action: 'deny', by: 'phone', channel: 'visual' })
    })

    it('falls back to allow/deny for an event the bridge never saw', () => {
        expect(busResolutionFor(undefined, { id: 'gone', approved: true }))
            .toEqual({ action: 'allow', by: 'phone', channel: 'visual' })
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
        })).toEqual({ action: 'text', text: 'AbC,123#state', by: 'phone', channel: 'visual' })
    })

    it('sends Cancel back as the option it is, so the login ends now', () => {
        expect(busResolutionFor(login, {
            id: 'ev-3',
            approved: true,
            updatedInput: { optionId: 'cancel' },
        })).toEqual({ action: 'option', optionId: 'cancel', by: 'phone', channel: 'visual' })
    })
})

describe('the push data', () => {
    // DROVE-94. The push carried the bridge session, the one thread every
    // gate on the machine is mirrored into, so a tap opened that mirror and
    // not the agent that stopped.
    const raised: DroverEvent = {
        ...permission,
        origin: { harness: 'claude-code', sessionId: 'e495e6e8-43f6-4699-a984-ff19f5ab4551', cwd: '/Users/clay/Projects/thing' },
    }

    it('names the RAISING session when the registry knows it, plus the gate and its kind', () => {
        expect(gatePushData(raised, 'Bash', 'happy-a')).toEqual({
            sessionId: 'happy-a',
            gateId: 'ev-2',
            kind: 'permission',
            requestId: 'ev-2',
            tool: 'Bash',
            type: 'permission_request',
            provider: 'claude',
        })
    })

    it('leaves sessionId off entirely when the origin is unknown, so the tap goes to the inbox', () => {
        const data = gatePushData(raised, 'Bash', null)
        expect(data).not.toHaveProperty('sessionId')
        expect(data).toMatchObject({ gateId: 'ev-2', kind: 'permission' })
    })

    it('stamps the bus kind, not the card tool: a to-do is a to-do and a question a question', () => {
        expect(gatePushData(todo, 'DroverTodo', null).kind).toBe('todo')
        expect(gatePushData(question, 'AskUserQuestion', 'happy-a').kind).toBe('question')
    })
})

describe('delivery channels (DROVE-72)', () => {
    const eyesFree: DroverEvent = {
        ...question,
        id: 'ev-audio',
        delivery: { announce: ['audio'], answer: ['visual', 'audio'], audioInput: 'click' },
    }

    it('gates the alert push on visual and the sound on audio, off the event alone', () => {
        expect(announcePlanFor({ delivery: { announce: ['visual', 'haptic'], answer: ['visual'], audioInput: null } }))
            .toEqual({ alert: true, sound: false })
        expect(announcePlanFor({ delivery: { announce: ['visual', 'audio'], answer: ['visual'], audioInput: null } }))
            .toEqual({ alert: true, sound: true })
        expect(announcePlanFor({ delivery: { announce: ['haptic'], answer: ['visual'], audioInput: null } }))
            .toEqual({ alert: false, sound: false })
        expect(announcePlanFor({ delivery: { announce: [], answer: ['visual'], audioInput: null } }))
            .toEqual({ alert: false, sound: false })
    })

    it('reads an event with no delivery as announced on a screen, which is what every old bus did', () => {
        expect(deliveryOf({})).toEqual({ announce: ['visual'], answer: ['visual'], audioInput: null })
        expect(announcePlanFor({ delivery: null })).toEqual({ alert: true, sound: false })
    })

    it('carries delivery onto the card verbatim, so the phone reads one field and no setting', () => {
        const card = requestForEvent(eyesFree) as { droverEvent?: { delivery?: unknown } }
        expect(card.droverEvent?.delivery).toEqual(eyesFree.delivery)
        const legacy = requestForEvent(question) as { droverEvent?: { delivery?: unknown } }
        expect(legacy.droverEvent).not.toHaveProperty('delivery')
    })

    it('names the wrist when the answer says via watch, and the phone otherwise', () => {
        expect(busResolutionFor(permission, { id: 'ev-2', approved: true, updatedInput: { via: 'watch' } }))
            .toEqual({ action: 'allow', by: 'watch', channel: 'visual' })
        expect(busResolutionFor(permission, { id: 'ev-2', approved: true }))
            .toEqual({ action: 'allow', by: 'phone', channel: 'visual' })
    })

    it('passes an audio answer through as channel audio, on a question too', () => {
        expect(busResolutionFor(eyesFree, { id: 'ev-audio', approved: true, updatedInput: { optionId: 'closed', channel: 'audio' } }))
            .toEqual({ action: 'option', optionId: 'closed', by: 'phone', channel: 'audio' })
        expect(busResolutionFor(question, { id: 'ev-1', approved: true, updatedInput: { optionId: 'closed' } }))
            .toEqual({ action: 'option', optionId: 'closed', by: 'phone', channel: 'visual' })
    })
})

/**
 * The card that outlives its event (DROVE-218).
 *
 * Clay was looking at two Run Bash prompts the bus had CANCELED twenty minutes
 * earlier — `by: producer, via: cancel`, 17:49:24 and 17:50:05 — while
 * `/v1/status` said `pending: 0`. The bus had done its half twice over: one
 * terminal frame each, and a `snapshot` of the authoritative pending set on
 * every connect. Happy had no handler for the snapshot at all, and its
 * stand-in skipped any card still in an in-memory `mirrored` map, which is the
 * one thing a missed terminal frame leaves behind.
 */
describe('the snapshot is the authority, not a merge', () => {
    const held = {
        requests: {
            'gone-1': { tool: 'Bash', arguments: { command: 'rm -rf x' } },
            'gone-2': { tool: 'Bash', arguments: { command: 'rm -rf y' } },
            'still-here': { tool: 'Bash', arguments: { command: 'ls' } },
        },
        completedRequests: {},
    }

    it('REMOVES what the snapshot does not list, rather than leaving it updated', () => {
        const next = applyPendingSnapshot(held, new Set(['still-here']), 1000)
        expect(Object.keys(next.requests ?? {})).toEqual(['still-here'])
    })

    it('files what it removed as canceled, so the receipts say where the card went', () => {
        const next = applyPendingSnapshot(held, new Set(['still-here']), 1000)
        expect(next.completedRequests?.['gone-1']).toMatchObject({
            status: 'canceled',
            reason: 'gone from the bus',
            completedAt: 1000,
        })
    })

    it('retires a card the app never saw a terminal frame for, which is the whole point', () => {
        // No memory of these ids anywhere: the process that mirrored them is
        // gone, or its stream was down when the cancels went out.
        const next = applyPendingSnapshot(held, new Set(), 1000)
        expect(next.requests).toEqual({})
    })

    it('leaves the state alone when the session already agrees with the bus', () => {
        const agreed = { requests: { a: { tool: 'Bash' } }, completedRequests: {} }
        expect(applyPendingSnapshot(agreed, new Set(['a']))).toBe(agreed)
    })

    it('drops everything when the bus holds nothing pending', () => {
        const next = applyPendingSnapshot(held, new Set(), 1000)
        expect(Object.keys(next.completedRequests ?? {})).toHaveLength(3)
    })
})

/**
 * A cancel is terminal too, and it carries a NULL resolution — which is the
 * likely reason a resolution-shaped handler walked past both of Clay's cards.
 */
describe('a canceled event retires exactly like a resolved one', () => {
    const state = { requests: { 'ev-2': { tool: 'Bash' } }, completedRequests: {} }

    it('retires a cancel with no resolution at all', () => {
        const next = retireCard(state, { ...permission, state: 'canceled', resolution: null }, 7)
        expect(next.requests).toEqual({})
        expect(next.completedRequests?.['ev-2']).toMatchObject({ status: 'canceled', completedAt: 7 })
    })

    it('retires an expiry the same way', () => {
        const next = retireCard(state, { ...permission, state: 'expired' }, 7)
        expect(next.requests).toEqual({})
        expect(next.completedRequests?.['ev-2']).toMatchObject({ status: 'canceled' })
    })

    it('retires a resolve, and keeps who answered', () => {
        const next = retireCard(
            state,
            { ...permission, state: 'resolved', resolution: { action: 'allow', by: 'tmux-gum' } },
            7,
        )
        expect(next.requests).toEqual({})
        expect(next.completedRequests?.['ev-2']).toMatchObject({ status: 'approved', reason: 'by tmux-gum' })
    })

    it('writes nothing for a card the session is not showing, so a repeat frame is free', () => {
        const empty = { requests: {}, completedRequests: {} }
        expect(retireCard(empty, { ...permission, state: 'canceled' })).toBe(empty)
    })
})

/**
 * Why the receipts are capped (DROVE-218).
 *
 * Measured on Clay's machine: 1006 completed entries, 999,276 bytes encrypted,
 * one card short of the socket's frame limit. An oversized frame does not come
 * back as an error, it closes the socket, so the update retries and closes it
 * again — 994 retries over 32 minutes, and the two `canceled` retirements in
 * the queue behind it never committed. An unbounded receipts list is a session
 * that eventually cannot write at all.
 */
describe('the receipts list is bounded', () => {
    const many = Object.fromEntries(
        Array.from({ length: 200 }, (_, i) => [`c${i}`, { completedAt: i }]),
    )

    it('keeps the newest and drops the rest', () => {
        const kept = trimCompleted(many, 3)
        expect(Object.keys(kept).sort()).toEqual(['c197', 'c198', 'c199'])
    })

    it('returns the same object when nothing has to go', () => {
        const few = { a: { completedAt: 1 } }
        expect(trimCompleted(few, 3)).toBe(few)
    })

    it('treats an entry with no completedAt as the oldest, never evicting a stamped one for it', () => {
        const mixed = { old: {}, newer: { completedAt: 5 } }
        expect(Object.keys(trimCompleted(mixed, 1))).toEqual(['newer'])
    })

    it('caps what a retirement writes back, so the state cannot grow past the frame limit', () => {
        const state = { requests: { 'ev-2': { tool: 'Bash' } }, completedRequests: many }
        const next = retireCard(state, { ...permission, state: 'canceled' })
        expect(Object.keys(next.completedRequests ?? {}).length).toBeLessThanOrEqual(60)
    })
})
