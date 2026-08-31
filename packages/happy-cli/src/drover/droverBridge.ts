/**
 * Cattle Drover bridge (BASED-98).
 *
 * Makes Happy a surface on the Cattle Drover prompt bus. The drover bus
 * (loopback :7970) is the single local arbiter for every pending agent
 * interaction — gum popups in tmux already race through it. This bridge adds
 * the phone/web side: it holds one dedicated Happy session per machine,
 * mirrors every pending bus event into that session's agentState.requests
 * (a permission becomes a Bash card with Allow/Deny, a question becomes the
 * app's AskUserQuestion card with the real options), and translates the app's
 * `permission` RPC answer back into a bus resolve. When any other surface wins
 * the race, the bus broadcast removes the card — mutual dismiss in both
 * directions, first answer wins, all bus semantics.
 */

import os from 'node:os'
import { randomUUID } from 'node:crypto'

import { readCredentials, readSettings, writeSettings } from '@/persistence'
import { ApiClient } from '@/api/api'
import type { AgentState, Metadata } from '@/api/types'
import { configuration } from '@/configuration'
import { projectPath } from '@/projectPath'
import { logger } from '@/ui/logger'
import { getOrCreateBridgeSession } from './bridgeSession'
import { gateActionsFor, legendFor, overflowNoteFor, type GateActionPlan } from './gateActions'
import { createOriginRegistry } from './originSession'
import { isDroverDemoId } from './demo'
import packageJson from '../../package.json'

const DROVER_URL = process.env.DROVER_URL || 'http://127.0.0.1:7970'

export interface DroverOption {
    id: string
    label: string
    description?: string
}

export interface DroverEvent {
    id: string
    /** `todo` is the needs-you record (DROVE-53): an ACTION, not an answer. */
    kind: 'permission' | 'question' | 'idle' | 'expiry' | 'todo'
    state: string
    /**
     * When the BUS raised it, which is the only honest age (DROVE-71).
     *
     * The mirrored card stamps its own `createdAt` at mirror time, and the
     * bridge re-mirrors every pending event on each restart, so a to-do raised
     * an hour before a launchd roll would read as one minute old on the phone.
     * A to-do never expires, so it is the kind most likely to outlive several
     * restarts and the kind whose age matters most.
     */
    createdAt?: number
    title: string
    reason?: string
    preview?: string
    options?: DroverOption[] | null
    /** Questions only. The human may pick more than one of the options. */
    multiSelect?: boolean
    origin?: {
        harness?: string
        /** Which gate fired. `account-login` is the phone login (DROVE-61). */
        gate?: string | null
        sessionId?: string | null
        cwd?: string | null
        account?: string | null
        /**
         * The tmux pane the prompt is ON, when there is one.
         *
         * On the wire since the first gate adapter and typed here only now, so
         * it silently vanished from every event this file touched. It matters
         * from DROVE-198 on: a terminal approval is answered by pressing a key
         * into that exact pane, and the pane is the binding that makes it this
         * session's prompt rather than whichever one a surface happened to
         * name.
         */
        surface?: string | null
    }
    /**
     * Which channels ANNOUNCE this event and which may ANSWER it (DROVE-72).
     *
     * Stamped by the bus from the settings store; the bridge reads this and
     * never a setting. Absent on an event that came off a journal older than
     * the field, which reads as announced on a screen and answered on one.
     */
    delivery?: DroverDelivery | null
    resolution?: {
        action: string
        optionId?: string
        optionIds?: string[]
        text?: string
        by: string
        /** `visual` or `audio`: which channel carried the answer (DROVE-72). */
        channel?: string
    } | null
}

export interface DroverDelivery {
    announce: ('visual' | 'haptic' | 'audio')[]
    answer: ('visual' | 'audio')[]
    audioInput: 'click' | 'speech' | 'both' | null
}

/** What an event with no `delivery` reads as: every subscriber's old assumption. */
const LEGACY_DELIVERY: DroverDelivery = { announce: ['visual'], answer: ['visual'], audioInput: null }

export function deliveryOf(ev: Pick<DroverEvent, 'delivery'>): DroverDelivery {
    return ev.delivery ?? LEGACY_DELIVERY
}

/**
 * What the bridge FIRES for a new card, off `delivery.announce` alone (DROVE-72).
 *
 * The card itself is always mirrored: it is the inbox and the answer surface,
 * and DROVE-74's rule is that visual-off must not hide it. What the toggle
 * gates is the ALERT push — the one with a title, a body and a sound, the
 * thing that lights the lock screen — and the sound on it is audio's half.
 * The silent background wake is transport, not an announcement: it carries
 * the card and the dismissal to the wrist and shows nothing, so it always
 * goes. Pure, so the decision is tested without a bus or a phone.
 */
export function announcePlanFor(ev: Pick<DroverEvent, 'delivery'>): { alert: boolean; sound: boolean } {
    const announce = deliveryOf(ev).announce
    return { alert: announce.includes('visual'), sound: announce.includes('audio') }
}

/** What the app sends back over the `permission` RPC when a card is answered. */
export interface PermissionAnswer {
    id: string
    approved: boolean
    reason?: string
    /** AskUserQuestion answers ride here: `{ answers: { [question]: label } }`. */
    updatedInput?: Record<string, unknown>
    /**
     * "Allow, and stop asking" — the two spellings the app already uses.
     *
     * PermissionFooter.tsx has had that button all along: the Claude flavour
     * calls sessionAllow with allowTools ["Bash(<command>)"] and the Codex one
     * passes decision 'approved_for_session'. This interface read neither, so
     * both were dropped on the floor, the bus stored a plain one-shot allow,
     * and the very next identical gate fired again. Clay tapped it and was
     * asked again immediately (DROVE-53).
     */
    allowTools?: string[]
    decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort'
}

/**
 * The URL a login question is carrying, or null when this is not one.
 *
 * Keyed on `origin.gate`, which the bus carries end to end, rather than on the
 * shape of the text: `drover account login` stamps `account-login` on every
 * card it raises, and the preview of that card is the OAuth link. The URL is
 * checked as well as the gate because the same gate also raises the FAILED
 * card, which carries a sentence and no link (docs/hitl.md).
 */
export function accountLoginUrl(ev: DroverEvent): string | null {
    if (ev.origin?.gate !== 'account-login') return null
    const preview = (ev.preview ?? '').trim()
    return preview.startsWith('https://') ? preview : null
}

/**
 * Where the gate was actually raised, carried on the mirrored card (DROVE-19).
 *
 * Every bus gate is mirrored into ONE bridge session per machine, so the app's
 * copy of it belongs to the bridge and not to the agent that stopped. That is
 * the whole of "a prompt raised by the session already on screen does not
 * present in place": the session view held nothing of its own to show, so the
 * only copy was on the home screen and you had to go and find it.
 *
 * The Claude session uuid is the join. The app already stores it on a pane
 * session as `metadata.claudeSessionId`, and the bus event carries the same
 * uuid in `origin.sessionId` — measured on the live bus, e.g. event
 * 580fed9e-db4b-42e1-b6f9-1d0033708461 origin.sessionId
 * e495e6e8-43f6-4699-a984-ff19f5ab4551.
 *
 * `cwd` rides along for reading, never for matching. Several lanes share one
 * checkout here, so matching on cwd would drop one lane's question onto
 * another lane's screen, which is exactly the hijack this must not do.
 */
function droverOriginFor(ev: DroverEvent): { droverOrigin?: { sessionId?: string; cwd?: string } } {
    const sessionId = ev.origin?.sessionId
    const cwd = ev.origin?.cwd
    if (!sessionId && !cwd) return {}
    return {
        droverOrigin: {
            ...(sessionId ? { sessionId } : {}),
            ...(cwd ? { cwd } : {}),
        },
    }
}

/**
 * The bus event's own facts, carried on the card so a surface can read them
 * back without unpicking the rendering (DROVE-71).
 *
 * The card shapes are chosen to render — a Bash card packs title and reason
 * into one `description` string, a question card puts the title in a header —
 * so an inbox that has to GROUP prompts apart from to-dos, print the real
 * reason on its own line and show a true age had nothing to read. It would
 * have had to parse a display string back into fields, which is the thing that
 * breaks the first time an em-dash appears in a title.
 *
 * `kind` here is also what makes a to-do refusable in busResolutionFor: the
 * card it rides is a permission card, and without a kind on it there is no way
 * for either side to tell "you must DO something" from "a session is stopped
 * waiting on you".
 */
function droverEventFor(ev: DroverEvent) {
    return {
        droverEvent: {
            kind: ev.kind,
            title: ev.title,
            ...(ev.reason ? { reason: ev.reason } : {}),
            ...(ev.preview ? { command: ev.preview } : {}),
            ...(typeof ev.createdAt === 'number' ? { createdAt: ev.createdAt } : {}),
            // Which channels announce and may answer, verbatim off the bus
            // (DROVE-72). The phone buzzes and speaks off THIS, never off a
            // setting of its own, so the card is the whole contract.
            ...(ev.delivery ? { delivery: ev.delivery } : {}),
        },
    }
}

export function requestForEvent(ev: DroverEvent) {
    // Render through the app's existing permission-card path: a Bash-shaped
    // request carries the command preview; anything else goes descriptive.
    const description = [ev.title, ev.reason].filter(Boolean).join(' — ')
    // Computed before the login branch returns: DROVE-19 requires every
    // mirrored card to name the session it was raised in, and an account
    // login gate belongs to a session like any other.
    const origin = { ...droverOriginFor(ev), ...droverEventFor(ev) }
    const loginUrl = accountLoginUrl(ev)
    if (loginUrl) {
        // Its own card, because this one is a LINK and a CODE, not a choice.
        // The generic question card renders options as buttons and has nowhere
        // to type, so a login mirrored through it could only ever be
        // cancelled. The app's DroverAccountLogin view hands the URL to the
        // iOS share sheet and takes the code in a text field.
        return {
            ...origin,
            tool: 'DroverAccountLogin',
            arguments: {
                url: loginUrl,
                header: ev.title,
                reason: ev.reason ?? '',
                cancelLabel: (ev.options ?? []).find((o) => o.id === 'cancel')?.label ?? 'Cancel',
            },
            createdAt: Date.now(),
        }
    }
    if (ev.kind === 'question') {
        // The phone renders a question through the same AskUserQuestion card
        // Claude's own tool uses, and that card reads ONE thing: `questions[]`,
        // each with a header, a body, and options carrying label AND
        // description. This used to send the body as `command` and flatten the
        // options to a bare array of labels, so `input.questions` was empty,
        // AskUserQuestionView returned null, and the phone drew a card with
        // nothing inside it. Bus event "Step 1 order" (2026-08-29) is the one
        // Clay hit: answered on the watch, invisible on the phone.
        return {
            tool: 'AskUserQuestion',
            arguments: {
                questions: [
                    {
                        header: ev.title,
                        question: ev.preview || ev.title,
                        options: (ev.options ?? []).map((o) => ({
                            label: o.label,
                            ...(o.description ? { description: o.description } : {}),
                        })),
                        // Off the EVENT, not hardcoded false (DROVE-53). It was
                        // false here for every mirrored question, so a "pick as
                        // many as apply" drew radio buttons on the phone and one
                        // pick became the whole answer, with nothing on the
                        // screen saying so.
                        multiSelect: ev.multiSelect === true,
                    },
                ],
            },
            createdAt: Date.now(),
            ...origin,
        }
    }
    if (ev.kind === 'todo') {
        // A TO-DO GETS ITS OWN CARD (DROVE-69). It used to ride the permission
        // card, on the reasoning that Done is the approve and Drop is the deny
        // and no new vocabulary was needed. That reasoning had a hole: a
        // permission card is answerable by every generic approve path in the
        // app, on the wrist and in the voice tool, and busResolutionFor turned
        // a bare `approved: true` into optionId "done" with nobody having
        // chosen anything. Bus event 4c3f5082 went from raised to
        // {"action":"ack","optionId":"done","by":"happy"} while Clay was
        // asking where the list was — an ack he never made, which is the whole
        // of DROVE-69.
        //
        // A gate owes its caller a decision, so leaving one unanswered is the
        // expensive state and any answer is progress. A to-do owes nobody
        // anything: it stays open until it is DONE, so a spurious answer is
        // pure loss and the card must be answerable only by its own two
        // buttons. The card carries the options explicitly for the same
        // reason — an answer to this card names which button was pressed, and
        // busResolutionFor refuses anything that names neither.
        return {
            tool: 'DroverTodo',
            arguments: {
                title: ev.title,
                reason: ev.reason ?? '',
                command: ev.preview ?? '',
                ...(ev.origin?.cwd ? { cwd: ev.origin.cwd } : {}),
                options: (ev.options ?? []).map((o) => ({ id: o.id, label: o.label })),
            },
            createdAt: Date.now(),
            ...origin,
        }
    }
    if (ev.kind === 'permission') {
        return {
            tool: 'Bash',
            arguments: {
                command: ev.preview || ev.title,
                description,
                ...(ev.origin?.cwd ? { cwd: ev.origin.cwd } : {}),
            },
            createdAt: Date.now(),
            ...origin,
        }
    }
    return {
        tool: 'Bash',
        arguments: {
            command: ev.preview || ev.title,
            description,
        },
        createdAt: Date.now(),
        ...origin,
    }
}

/**
 * Every string the app could have meant as the chosen option.
 *
 * The question card submits labels keyed by question text; the watch sends the
 * option straight through as `optionId`. A multi-select joins its labels with
 * ", ", so each whole value is tried before its comma-separated parts — a
 * label with a comma in it must not be shredded before it gets to match.
 */
function answerCandidates(answer: PermissionAnswer): string[] {
    const input = answer.updatedInput as
        | { answers?: Record<string, unknown>; optionId?: unknown; optionIds?: unknown; code?: unknown }
        | undefined
    const raw: string[] = []
    // The login card submits the pasted code under its own key: it is not one
    // of the options, and it must not be shredded on commas the way a
    // multi-select label list is — an OAuth code is one opaque string. It is
    // checked first because it short-circuits: a login card carries no options
    // at all, so nothing below it could ever match.
    if (typeof input?.code === 'string' && input.code.trim()) return [input.code.trim()]
    // `optionIds` FIRST of the option keys: the wrist sends the whole selection
    // under that key for a multi-select, and reading optionId alone took one
    // tick of three (DROVE-53). Order matters because the single-select path
    // below returns on the first match.
    if (Array.isArray(input?.optionIds)) {
        for (const v of input.optionIds) if (typeof v === 'string') raw.push(v)
    }
    if (typeof input?.optionId === 'string') raw.push(input.optionId)
    for (const value of Object.values(input?.answers ?? {})) {
        if (typeof value === 'string') raw.push(value)
        else if (Array.isArray(value)) for (const v of value) if (typeof v === 'string') raw.push(v)
    }
    const out: string[] = []
    const push = (s: string) => {
        const trimmed = s.trim()
        if (trimmed && !out.includes(trimmed)) out.push(trimmed)
    }
    for (const value of raw) push(value)
    for (const value of raw) for (const part of value.split(',')) push(part)
    return out
}

/**
 * Which surface answered and over which channel, read off the answer's own
 * stamps (DROVE-72). `via: 'watch'` is what droverWatchFeed puts on a wrist
 * answer; `via: 'push'` is a button on the notification banner itself
 * (DROVE-207), which is neither the app nor the wrist and has to read as its
 * own surface or "who won the race" is unanswerable on the ledger;
 * `channel: 'audio'` is what the phone's audio answerer puts on a headphone
 * click or a dictated pick. Anything else is a thumb on the phone.
 */
function answererOf(answer: PermissionAnswer): { by: string; channel: 'visual' | 'audio' } {
    const input = answer.updatedInput as { via?: unknown; channel?: unknown } | undefined
    const by = input?.via === 'watch' ? 'watch' : input?.via === 'push' ? 'push' : 'phone'
    return {
        by,
        channel: input?.channel === 'audio' ? 'audio' : 'visual',
    }
}

/**
 * The bus resolution an app answer means for THIS event, or null when it means
 * nothing the bus will take.
 *
 * A question is ANSWERED, never approved. Sending `allow` fails two ways
 * depending on which bus you are talking to, and both were measured on
 * 2026-08-29: a bus running server.js from c256c38 or later answers 409 ("a
 * question needs an option or text") so the card never dismisses anywhere,
 * while an older one takes the allow and records a resolution with no answer —
 * every surface dismisses, the waiting hook finds nothing to inject, and Claude
 * asks again in the terminal. Event "Step 1 order" in the bus log, action
 * allow, by happy, is that second one, from a watch tap that travelled the
 * whole way and still lost the answer. So the chosen label is matched back to
 * the option it came from and sent as action=option; anything unmatched goes
 * as free text.
 */
export function busResolutionFor(
    ev: DroverEvent | undefined,
    answer: PermissionAnswer
): Record<string, unknown> | null {
    // A demo card's answer means nothing the bus will take, by construction
    // (DROVE-75). The phone already refuses to send one; this is the Mac's
    // own refusal for the same namespace, so no event and no answer shape can
    // make a demo id resolve anything.
    if (isDroverDemoId(answer.id) || isDroverDemoId(ev?.id)) return null
    // WHO and OVER WHICH CHANNEL (DROVE-72). This sent `...who` for every
    // answer, so the bus could not tell a wrist from a thumb on the phone —
    // which made "two channels answering the same event" unprovable on the
    // ledger. The wrist stamps `via: 'watch'` on its answer; the audio
    // answerer (headphone click, dictation) stamps `channel: 'audio'`;
    // everything else is a thumb on a screen.
    const who = answererOf(answer)
    if (ev?.kind === 'question') {
        // There is no "no" for a question. Denying one would resolve it for
        // every other surface with no answer to hand back.
        if (!answer.approved) return null
        const candidates = answerCandidates(answer)
        // MULTI-SELECT: every candidate that matches an option, not the first.
        //
        // The phone joins its picks with ", " and the watch sends them as an
        // array, and this used to stop at the first match either way — so
        // ticking three boxes sent one word to the session, at HTTP 200, with
        // nothing on any screen saying the rest had gone (DROVE-53). The bus
        // takes `optionIds` now; `optionId` still carries the first pick so a
        // reader that predates the key is unaffected.
        if (ev.multiSelect === true) {
            const ids: string[] = []
            for (const candidate of candidates) {
                const option = (ev.options ?? []).find((o) => o.id === candidate || o.label === candidate)
                if (option && !ids.includes(option.id)) ids.push(option.id)
            }
            if (ids.length > 1) {
                return { action: 'option', optionId: ids[0], optionIds: ids, ...who }
            }
        }
        for (const candidate of candidates) {
            const option = (ev.options ?? []).find((o) => o.id === candidate || o.label === candidate)
            if (option) return { action: 'option', optionId: option.id, ...who }
        }
        if (candidates.length) return { action: 'text', text: candidates[0], ...who }
        return null
    }
    if (ev?.kind === 'todo') {
        // A NAMED BUTTON, OR NOTHING (DROVE-69).
        //
        // This used to read `answer.approved ? 'done' : 'drop'`, so ANY
        // affirmative answer to the card closed the to-do: the phone's generic
        // Allow, the wrist's Allow, the realtime voice tool's
        // processPermissionRequest, or anything else that can approve a
        // permission. Event 4c3f5082 was acked that way with nobody having
        // touched it — resolved 257 seconds after it was raised, `by happy`,
        // while Clay was asking where the to-do list was.
        //
        // A to-do is answered by pressing Done or Drop it, and an answer that
        // names neither is not a person having decided. Returning null leaves
        // the to-do PENDING, which is the safe direction for this kind: a gate
        // left open blocks a session, a to-do left open is just a to-do.
        // DroverTodoView and the inbox both send the option id, and the wrist
        // sends it too now that the card carries real options.
        const chosen = (ev.options ?? []).find((o) =>
            answerCandidates(answer).some((c) => c === o.id || c === o.label)
        )
        if (chosen) return { action: 'option', optionId: chosen.id, ...who }
        return null
    }
    // ALLOW, AND STOP ASKING. Both of the app's spellings mean it: the Claude
    // flavour of PermissionFooter sends allowTools ["Bash(<command>)"] and the
    // Codex one sends decision 'approved_for_session'. Neither reached the bus
    // before, so the button worked on screen and changed nothing — the next
    // identical gate fired again. lib/drover-gate.sh is what honours the scope.
    const forSession =
        answer.approved &&
        ((answer.allowTools?.length ?? 0) > 0 || answer.decision === 'approved_for_session')
    return {
        action: answer.approved ? 'allow' : 'deny',
        ...who,
        ...(forSession ? { scope: 'session' } : {}),
        ...(answer.reason ? { text: answer.reason } : {}),
    }
}

/**
 * How a resolved event reads on the card it leaves behind.
 *
 * `allow` is not the only affirmative — a question resolves with `option` or
 * `text` — so keying "approved" off the allow action alone filed every answered
 * question under denied.
 */
export function completedStatusFor(ev: DroverEvent): 'approved' | 'denied' | 'canceled' {
    if (ev.state !== 'resolved') return 'canceled'
    return ev.resolution?.action === 'deny' ? 'denied' : 'approved'
}

/** "Popup stayed open · by watch" — what was chosen, and where. */
export function completedReasonFor(ev: DroverEvent): string | undefined {
    if (!ev.resolution) return undefined
    const chosen = ev.resolution.optionId || ev.resolution.text
    return [chosen, `by ${ev.resolution.by}`].filter(Boolean).join(' · ')
}

/**
 * Metadata carrying THIS event's summary, because the push body is read off
 * `summary.text` and the bridge session's own summary is a constant. A phone
 * that buzzes without naming the prompt or the project is barely better than
 * one that stays quiet: nothing tells you which of five running agents stopped.
 */
export function pushMetadata(metadata: Metadata | null, ev: DroverEvent, plan?: GateActionPlan): Metadata {
    const project = ev.origin?.cwd?.split('/').filter(Boolean).pop()
    // The REASON, which never left the Mac (DROVE-53). A gate's reason is the
    // only part that says WHY it fired — "this command deletes files outside
    // the repo" — and the push body was title plus project, so the one line
    // that decides the answer was the one line the phone did not show. Trimmed
    // hard: a notification body is two lines on a lock screen and one on a
    // wrist, and a truncated reason reads worse than a short one.
    const reason = ev.reason?.trim()
    const short = reason && reason.length > 90 ? `${reason.slice(0, 89)}…` : reason
    // The legend and the overflow note come LAST, after the reason, because
    // they are only readable on an expanded banner and that is exactly where
    // the buttons they explain are (DROVE-207). A numbered banner without its
    // legend is a row of digits meaning nothing; an overflowing one without
    // its note is a banner claiming to show every choice.
    const legend = plan ? legendFor(ev, plan) : ''
    const overflow = plan ? overflowNoteFor(plan) : ''
    const text = [ev.title, short, project, legend, overflow].filter(Boolean).join(' · ')
    return { ...(metadata ?? ({} as Metadata)), summary: { text, updatedAt: Date.now() } }
}

/** The push kind a bus event sends as. The push TITLE is picked off this. */
export function pushKindFor(ev: DroverEvent): 'question' | 'todo' | 'permission' {
    return ev.kind === 'question' ? 'question' : ev.kind === 'todo' ? 'todo' : 'permission'
}

/**
 * What a gate push carries, so a tap can land on the gate (DROVE-94).
 *
 * `sessionId` is the happy session that RAISED the gate, when the registry
 * knows it, and absent otherwise. It used to be the bridge session, the one
 * thread every gate on the machine is mirrored into, so a tap opened that
 * mirror and not the agent that stopped. With no raising session the app
 * routes the tap to the inbox with the gate focused, which is why the key is
 * left off rather than filled with the bridge's id: a wrong session is worse
 * than no session.
 *
 * `gateId` is the bus event id, which is also the request id the card is
 * filed under on the phone. `kind` is the bus kind, so the phone can tell a
 * to-do from a prompt before the store has caught up.
 *
 * `answerSessionId` is the session HOLDING the card, which is the bridge
 * session and never the raising one (DROVE-207). A button on the banner
 * answers through the app's own sessionAllow, and that is addressed to the
 * holder; `sessionId` above is where a TAP navigates. The two were the same
 * key until a tap needed the raising session, and a button needs the other
 * one, so both travel and neither is inferred.
 *
 * `actions` is the bus option id each button slot answers with, in order, as
 * JSON. The button itself carries only its slot, so nothing on either side
 * ever matches a label back to an option.
 */
export function gatePushData(
    ev: DroverEvent,
    tool: string,
    raisingSessionId: string | null,
    answerSessionId?: string | null,
    plan?: GateActionPlan,
): Record<string, string> {
    return {
        ...(raisingSessionId ? { sessionId: raisingSessionId } : {}),
        ...(answerSessionId ? { answerSessionId } : {}),
        gateId: ev.id,
        kind: pushKindFor(ev),
        requestId: ev.id,
        tool,
        type: 'permission_request',
        provider: 'claude',
        ...(plan?.categoryId
            ? {
                  categoryId: plan.categoryId,
                  actions: JSON.stringify(plan.optionIds),
                  optionCount: String(plan.total),
                  ...(plan.overflow ? { overflow: '1' } : {}),
              }
            : {}),
    }
}

async function resolveOnBus(id: string, body: Record<string, unknown>): Promise<number> {
    try {
        const res = await fetch(`${DROVER_URL}/v1/events/${id}/resolve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        })
        return res.status
    } catch (err) {
        logger.debug('[drover] resolve failed', err)
        return 0
    }
}

/**
 * WITHDRAW a prompt. Never an answer (DROVE-218).
 *
 * `POST /v1/events/:id/cancel` calls terminate(ev, "canceled", by, "cancel"),
 * and cancel is the one terminal transition that leaves `resolution` NULL. So
 * nothing downstream can read a dismissal as a decision: the producer's
 * `/wait` returns a canceled event with no action to apply, and lib's gate
 * writes its DENY body for a gate that ended without a resolution. That null
 * is the whole safety property — DROVE-203 is a gate that resolved `allow`
 * with nobody there, and this path cannot produce that shape at all, because
 * it never touches /resolve.
 */
async function cancelOnBus(id: string, by: string): Promise<number> {
    try {
        const res = await fetch(`${DROVER_URL}/v1/events/${id}/cancel`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ by }),
        })
        return res.status
    } catch (err) {
        logger.debug('[drover] cancel failed', err)
        return 0
    }
}

/**
 * How many answered cards the bridge session carries, and why there is a cap
 * at all (DROVE-218).
 *
 * `completedRequests` is the receipt drawer behind the inbox, and it used to
 * grow for the life of the session — one entry per gate, forever. The whole
 * agentState is re-encrypted and re-sent on EVERY update, so the frame grew
 * with it. Measured on Clay's machine at 18:20 on 2026-08-31: 1006 completed
 * entries, 747,852 bytes of plaintext, 999,276 bytes encrypted. The next card
 * pushed the frame past the socket's limit, and an oversized frame does not
 * come back as an error — it CLOSES the socket (DROVE-211). The update is then
 * retried, closes the socket again, and the session's state is frozen for good:
 * 994 backoff retries over 32 minutes, and two gates the bus had CANCELED at
 * 17:49:24 and 17:50:05 still on the phone at 18:08 because the delete that
 * retired them could never commit.
 *
 * So the cap is not tidiness. It is the difference between a bridge that can
 * write and one that cannot. Sixty is well past what the receipts list shows
 * and two orders of magnitude short of the frame limit.
 */
const MAX_COMPLETED = 60

/**
 * The newest `MAX_COMPLETED` receipts, oldest dropped.
 *
 * Sorted by `completedAt`, with an entry that never stamped one treated as
 * oldest: a missing timestamp must not win a place over a card that has one.
 */
export function trimCompleted<T extends { completedAt?: number }>(
    completed: Record<string, T>,
    max: number = MAX_COMPLETED,
): Record<string, T> {
    const ids = Object.keys(completed)
    if (ids.length <= max) return completed
    const keep = ids
        .sort((a, b) => (completed[b].completedAt ?? 0) - (completed[a].completedAt ?? 0))
        .slice(0, max)
    const out: Record<string, T> = {}
    for (const id of keep) out[id] = completed[id]
    return out
}

/** Only the two maps the card bookkeeping touches; the rest of AgentState rides along. */
type CardState = {
    requests?: Record<string, Record<string, unknown>> | null
    completedRequests?: Record<string, Record<string, unknown>> | null
} & Record<string, unknown>

/**
 * One card retired, whatever ended it.
 *
 * Resolved, canceled and expired all land here and all leave the same shape.
 * That is the point: a cancel carries a NULL resolution, and a retirement path
 * written around reading the answer off the event skips exactly the events
 * Clay's two stuck cards were (DROVE-218). Unchanged state back when the
 * session is not showing the card, so a duplicate terminal frame writes
 * nothing.
 */
export function retireCard(state: CardState, ev: DroverEvent, now: number = Date.now()): CardState {
    const requests = { ...(state.requests ?? {}) }
    const card = requests[ev.id]
    if (!card) return state
    delete requests[ev.id]
    const reason = completedReasonFor(ev)
    return {
        ...state,
        requests,
        completedRequests: trimCompleted({
            ...(state.completedRequests ?? {}),
            [ev.id]: {
                ...card,
                completedAt: now,
                status: completedStatusFor(ev),
                ...(reason ? { reason } : {}),
            },
        }),
    }
}

/**
 * The session's cards REPLACED by the bus's pending set (DROVE-218).
 *
 * Anything the session holds that is not in `live` is removed. Not updated,
 * not skipped because some in-memory map still remembers mirroring it —
 * removed. That is what "authoritative" means in the bus's own header, and
 * applying its snapshot any other way leaves a card that can outlive its
 * event.
 */
export function applyPendingSnapshot(
    state: CardState,
    live: ReadonlySet<string>,
    now: number = Date.now(),
): CardState {
    const requests = { ...(state.requests ?? {}) }
    const completedRequests = { ...(state.completedRequests ?? {}) }
    let dropped = 0
    for (const [id, card] of Object.entries(requests)) {
        if (live.has(id)) continue
        delete requests[id]
        completedRequests[id] = { ...card, completedAt: now, status: 'canceled', reason: 'gone from the bus' }
        dropped++
    }
    if (!dropped) return state
    return { ...state, requests, completedRequests: trimCompleted(completedRequests) }
}

export async function runDroverBridge(): Promise<void> {
    const credentials = await readCredentials()
    if (!credentials) {
        throw new Error('Not authenticated with a Happy server. Run `happy` once to log in.')
    }
    const settings = await readSettings()
    let machineId = settings?.machineId
    if (!machineId) {
        machineId = randomUUID()
        await writeSettings({ ...settings, machineId })
    }

    const api = await ApiClient.create(credentials)
    const metadata: Metadata = {
        path: process.cwd(),
        host: os.hostname(),
        version: packageJson.version,
        os: os.platform(),
        machineId,
        homeDir: os.homedir(),
        happyHomeDir: configuration.happyHomeDir,
        happyLibDir: projectPath(),
        startedFromDaemon: false,
        hostPid: process.pid,
        startedBy: 'terminal',
        lifecycleState: 'running',
        lifecycleStateSince: Date.now(),
        flavor: 'claude',
        summary: { text: 'Cattle Drover — pending gates from every local agent', updatedAt: Date.now() },
        // Not a conversation, and the app must be told so rather than left to
        // work it out (DROVE-238). Without this the bridge is one more row in
        // the session list: never active, so always archived, and opening it
        // says "This session is inactive." Clay found his login code field
        // inside it, having started the login on the Accounts screen.
        droverBridge: true,
    } as Metadata

    // One long-lived session per machine, re-attached on every restart. The
    // stable tag is the whole point (the phone shows one Cattle Drover thread,
    // not a graveyard) and is also what made this crash for months — see
    // bridgeSession.ts for the key-pinning that fixes it.
    const session = await getOrCreateBridgeSession({
        api,
        machineId,
        metadata,
        state: { requests: {}, completedRequests: {} } as unknown as AgentState,
    })
    const client = api.sessionSyncClient(session)
    // The flag onto the session that ALREADY exists (DROVE-238). The tag is
    // stable by design, so `getOrCreateSession` hands back the record minted on
    // the very first run with the metadata it had then — a new field set above
    // would otherwise only ever reach a machine that had never bridged before.
    // Idempotent, and one write per start.
    if (!(session.metadata as { droverBridge?: boolean } | null)?.droverBridge) {
        client.updateMetadata((meta) => ({ ...meta, droverBridge: true }))
    }
    // The event itself, not just its id: answering a question needs the option
    // list to turn the label the app sends back into the id the bus wants.
    const mirrored = new Map<string, DroverEvent>()
    // Claude session uuid -> the happy session the phone shows it as, for the
    // push a gate sends (DROVE-94). See originSession.ts for where it reads.
    const originRegistry = createOriginRegistry()

    // App answer -> bus resolve. A 409 means another surface won first; the
    // resolved broadcast below cleans the card up, nothing else to do.
    client.rpcHandlerManager.registerHandler<PermissionAnswer, void>(
        'permission',
        async (message) => {
            // The demo wall, Mac side (DROVE-75). Named in the log as a demo
            // so a refused demo answer is never read as a real answer that
            // went missing. busResolutionFor refuses it too; this is so the
            // line says WHY rather than "answered with nothing the bus takes".
            if (isDroverDemoId(message.id)) {
                logger.debug(`[drover-demo] refused app answer for demo card ${message.id}; nothing resolved`)
                return
            }
            const body = busResolutionFor(mirrored.get(message.id), message)
            if (!body) {
                // Named, because for a to-do this is now a REFUSAL rather than
                // a shrug: an answer that pressed neither Done nor Drop it
                // leaves it open on purpose (DROVE-69), and that has to read
                // differently in the log from a question answered with nothing.
                const kind = mirrored.get(message.id)?.kind ?? 'unknown'
                logger.debug(
                    `[drover] app answered ${kind} ${message.id} with nothing the bus takes; left pending`
                )
                return
            }
            const status = await resolveOnBus(message.id, body)
            logger.debug(`[drover] app answered ${message.id}: ${JSON.stringify(body)} (bus ${status})`)
        }
    )

    /**
     * Clay withdrawing a stuck card himself, from the phone (DROVE-218).
     *
     * "get the ability for me to get things unstuck like prompts stuck" — a
     * card he can clear without waiting for anyone to diagnose it. It goes to
     * /cancel and NEVER to /resolve, so it cannot carry an action, cannot be
     * read as an approval, and leaves `resolution` null however the producer
     * reads the event afterwards. If the gate really is still pending, the
     * honest outcome is that it goes away and the producer learns its gate
     * went away; the alternative — a dismissal that quietly allowed something —
     * is DROVE-203, and this path has no way to express it.
     *
     * The card is retired locally whatever the bus says. A 404 means the event
     * is already gone, a 409 means another surface ended it first, and both are
     * reasons the card should not still be on the screen.
     */
    client.rpcHandlerManager.registerHandler<{ id: string }, { canceled: boolean; status: number }>(
        'drover-dismiss',
        async (message) => {
            if (isDroverDemoId(message.id)) {
                logger.debug(`[drover-demo] refused dismiss for demo card ${message.id}`)
                return { canceled: false, status: 0 }
            }
            const status = await cancelOnBus(message.id, 'happy')
            logger.debug(`[drover] app dismissed ${message.id} (bus ${status})`)
            removeCard({
                id: message.id,
                kind: mirrored.get(message.id)?.kind ?? 'permission',
                state: 'canceled',
                title: mirrored.get(message.id)?.title ?? '',
                resolution: null,
            })
            return { canceled: status === 200, status }
        }
    )

    const addCard = (ev: DroverEvent) => {
        if (mirrored.has(ev.id)) return
        mirrored.set(ev.id, ev)
        const card = requestForEvent(ev)
        client.updateAgentState((s) => ({
            ...s,
            requests: { ...(s.requests ?? {}), [ev.id]: card },
        }))
        // The card ALWAYS mirrors, whatever the toggles say: it is the inbox
        // and the answer surface. What `delivery.announce` gates is the alert
        // push below, visual's half of the announcement, and the sound on it,
        // which is audio's (DROVE-72). Nothing here reads a setting.
        const announce = announcePlanFor(ev)
        if (!announce.alert) {
            logger.debug(`[drover] no alert push for ${ev.id}: visual announce is off`)
        } else {
            // The push waits on one registry read so it can name the session that
            // RAISED the gate (DROVE-94); the card above does not, so the phone's
            // list is current whether or not the registry answers. The wake below
            // does not wait either: the wrist reads the gate off the snapshot, not
            // off the push.
            // The buttons the banner will carry, decided here so the payload
            // and the body agree (DROVE-207). Pure and logged, because a gate
            // that silently fell back to no buttons is indistinguishable on a
            // phone from one that never got the feature.
            const plan = gateActionsFor(ev)
            logger.debug(
                plan.categoryId
                    ? `[drover] ${ev.id} banner ${plan.categoryId} answers ${JSON.stringify(plan.optionIds)}${plan.overflow ? ` (${plan.total - plan.shown} more in the app)` : ''}`
                    : `[drover] ${ev.id} banner has no buttons (${plan.total} option(s)); tap opens the app`
            )
            void originRegistry.happySessionIdFor(ev.origin?.sessionId).then((raising) => {
                if (ev.origin?.sessionId && !raising) {
                    logger.debug(`[drover] no happy session for origin ${ev.origin.sessionId}; push routes to the inbox`)
                }
                api.push().sendSessionNotification({
                    // A question is not a permission request, and a to-do is neither.
                    // The push TITLE is picked off this ("Clarification needed" /
                    // "Needs you" / "Permission request"), which on a lock screen is
                    // most of what you get to read.
                    kind: pushKindFor(ev),
                    // The body is the session summary, and the bridge holds ONE session
                    // for the whole machine, so every push read the same fixed line and
                    // said nothing about what was being asked or by which agent.
                    metadata: pushMetadata(client.getMetadata(), ev, plan),
                    data: gatePushData(ev, card.tool, raising, session.id, plan),
                    sound: announce.sound,
                    // The category is what makes iOS draw buttons at all, and
                    // it is also what forces this push off the server's
                    // push-event route, which has no field for it (DROVE-207).
                    ...(plan.categoryId ? { categoryId: plan.categoryId } : {}),
                })
            })
        }
        // Transport, never an announcement, so it ALWAYS fires: this wakes the
        // app's JS so the WRIST learns about the gate while the app is
        // suspended, and it shows nothing on its own. Throttling, coalescing
        // and the direct-to-Expo send all live in the push client.
        api.push().sendBackgroundWake('gate-raised')
        logger.debug(`[drover] mirrored ${ev.kind} ${ev.id}: ${ev.title}`)
    }

    // Not gated on `mirrored`: a bridge restart empties that map while the
    // session on the phone still holds every card it was shown, and a card the
    // bridge refuses to retire is a prompt that sits on the screen forever.
    //
    // Every terminal state retires the same way — resolved, canceled, expired.
    // A cancel carries a NULL resolution, so anything shaped around reading an
    // answer off the event skips it, and both of the cards Clay was still being
    // shown twenty minutes after the bus killed them were cancels (DROVE-218).
    const removeCard = (ev: DroverEvent) => {
        mirrored.delete(ev.id)
        client.updateAgentState((s) => retireCard(s as CardState, ev) as AgentState)
        // A wake and no alert, deliberately. The wrist has to hear that the
        // gate went away; buzzing someone to say a question is gone is worse
        // than silence.
        api.push().sendBackgroundWake('gate-resolved')
        logger.debug(`[drover] dismissed ${ev.id} (${ev.state}${ev.resolution ? ` by ${ev.resolution.by}` : ''})`)
    }

    /**
     * THE authoritative pending set, applied as an authority (DROVE-218).
     *
     * The bus writes one `snapshot` frame as the first thing on every
     * /v1/stream connection, and its header says why in as many words: a
     * surface that was offline when a terminal frame went out otherwise has no
     * way to learn its card is dead. Happy had no handler for that frame at
     * all. Its stand-in was a `reconcile()` that listed pending events over a
     * SECOND request and then skipped any card still in `mirrored` — and
     * `mirrored` is only ever cleared by removeCard, so a card whose terminal
     * frame was missed stayed in the map and reconcile refused to retire it,
     * for the life of the process. A merge guarded by the very memory a missed
     * frame corrupts is not a reconciliation.
     *
     * So this REPLACES. Anything the session holds that is not in the snapshot
     * is gone — no second request, no memory to consult, no way for a card to
     * outlive its event. `mirrored` is rebuilt from the frame for the same
     * reason: it is a cache of the bus's set, not a record of what this process
     * happens to remember.
     *
     * There is no race with `created`. The snapshot is written before any live
     * frame on the same stream, in order, so an event raised a millisecond
     * later arrives after it and is added, never mistaken for a dead one.
     */
    const applySnapshot = (pending: DroverEvent[]) => {
        const live = new Map(pending.map((ev) => [ev.id, ev]))
        for (const id of [...mirrored.keys()]) {
            if (!live.has(id)) mirrored.delete(id)
        }
        client.updateAgentState((s) => {
            const next = applyPendingSnapshot(s as CardState, new Set(live.keys()))
            if (next !== s) {
                const before = Object.keys(s.requests ?? {}).length
                const after = Object.keys(next.requests ?? {}).length
                logger.debug(`[drover] snapshot retired ${before - after} card(s) the bus no longer has`)
            }
            return next as AgentState
        })
        // Then the other half: anything pending the session is NOT showing.
        // addCard is a no-op for one already mirrored, so a snapshot that
        // agrees with the session costs nothing.
        for (const ev of live.values()) {
            if (ev.kind === 'permission' || ev.kind === 'question' || ev.kind === 'todo') addCard(ev)
        }
    }

    // Bus stream: replay of pending events on connect, then live. Reconnect
    // forever — the bridge is a surface, never a gate.
    for (;;) {
        try {
            const res = await fetch(`${DROVER_URL}/v1/stream`, { headers: { Accept: 'text/event-stream' } })
            if (!res.ok || !res.body) throw new Error(`stream ${res.status}`)
            logger.debug(`[drover] connected to bus at ${DROVER_URL}`)
            const reader = res.body.getReader()
            const decoder = new TextDecoder()
            let buf = ''
            let eventType = ''
            for (;;) {
                const { done, value } = await reader.read()
                if (done) break
                buf += decoder.decode(value, { stream: true })
                let idx
                while ((idx = buf.indexOf('\n')) !== -1) {
                    const line = buf.slice(0, idx)
                    buf = buf.slice(idx + 1)
                    if (line.startsWith('event: ')) eventType = line.slice(7).trim()
                    else if (line.startsWith('data: ')) {
                        let ev: DroverEvent
                        try {
                            ev = JSON.parse(line.slice(6))
                        } catch {
                            continue
                        }
                        // A toggle moved (DROVE-72). Mirrored into the bridge
                        // session's state so the phone and the wrist SEE the
                        // machine's channels without polling the bus they
                        // cannot reach; the app reads it out of the store it
                        // already subscribes to.
                        // THE authoritative pending set, first frame on every
                        // connection (DROVE-218). Applied before any `created`
                        // frame the bus replays behind it, so the session ends
                        // this instant holding exactly what the bus holds.
                        if (eventType === 'snapshot') {
                            const frame = ev as unknown as { pending?: DroverEvent[] }
                            applySnapshot(Array.isArray(frame.pending) ? frame.pending : [])
                            continue
                        }
                        if (eventType === 'settings') {
                            const frame = ev as unknown as { at?: number; defaults?: Record<string, unknown> }
                            if (frame.defaults) {
                                const droverSettings = { capturedAt: frame.at ?? Date.now(), ...frame.defaults }
                                client.updateAgentState((s) => ({ ...s, droverSettings }))
                                logger.debug('[drover] mirrored a settings change into the bridge session')
                            }
                            continue
                        }
                        // `todo` joins the two kinds that get a card (DROVE-53).
                        // idle and expiry stay out: they are notices, and a card
                        // for them is a card nobody can retire.
                        if (eventType === 'created' && ev.state === 'pending'
                            && (ev.kind === 'permission' || ev.kind === 'question' || ev.kind === 'todo')) {
                            addCard(ev)
                        } else if (['resolved', 'canceled', 'expired'].includes(eventType)) {
                            removeCard(ev)
                        }
                    }
                }
            }
        } catch (err) {
            logger.debug('[drover] bus stream dropped, retrying in 3s', err)
        }
        await new Promise((r) => setTimeout(r, 3000))
    }
}
