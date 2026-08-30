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
import packageJson from '../../package.json'

const DROVER_URL = process.env.DROVER_URL || 'http://127.0.0.1:7970'

export interface DroverOption {
    id: string
    label: string
    description?: string
}

export interface DroverEvent {
    id: string
    kind: 'permission' | 'question' | 'idle' | 'expiry'
    state: string
    title: string
    reason?: string
    preview?: string
    options?: DroverOption[] | null
    origin?: {
        harness?: string
        /** Which gate fired. `account-login` is the phone login (DROVE-61). */
        gate?: string | null
        sessionId?: string | null
        cwd?: string | null
        account?: string | null
    }
    resolution?: { action: string; optionId?: string; text?: string; by: string } | null
}

/** What the app sends back over the `permission` RPC when a card is answered. */
export interface PermissionAnswer {
    id: string
    approved: boolean
    reason?: string
    /** AskUserQuestion answers ride here: `{ answers: { [question]: label } }`. */
    updatedInput?: Record<string, unknown>
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

export function requestForEvent(ev: DroverEvent) {
    // Render through the app's existing permission-card path: a Bash-shaped
    // request carries the command preview; anything else goes descriptive.
    const description = [ev.title, ev.reason].filter(Boolean).join(' — ')
    const loginUrl = accountLoginUrl(ev)
    if (loginUrl) {
        // Its own card, because this one is a LINK and a CODE, not a choice.
        // The generic question card renders options as buttons and has nowhere
        // to type, so a login mirrored through it could only ever be
        // cancelled. The app's DroverAccountLogin view hands the URL to the
        // iOS share sheet and takes the code in a text field.
        return {
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
                        multiSelect: false,
                    },
                ],
            },
            createdAt: Date.now(),
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
        }
    }
    return {
        tool: 'Bash',
        arguments: {
            command: ev.preview || ev.title,
            description,
        },
        createdAt: Date.now(),
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
        | { answers?: Record<string, unknown>; optionId?: unknown; code?: unknown }
        | undefined
    const raw: string[] = []
    // The login card submits the pasted code under its own key: it is not one
    // of the options, and it must not be shredded on commas the way a
    // multi-select label list is — an OAuth code is one opaque string.
    if (typeof input?.code === 'string' && input.code.trim()) return [input.code.trim()]
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
    if (ev?.kind === 'question') {
        // There is no "no" for a question. Denying one would resolve it for
        // every other surface with no answer to hand back.
        if (!answer.approved) return null
        const candidates = answerCandidates(answer)
        for (const candidate of candidates) {
            const option = (ev.options ?? []).find((o) => o.id === candidate || o.label === candidate)
            if (option) return { action: 'option', optionId: option.id, by: 'happy' }
        }
        if (candidates.length) return { action: 'text', text: candidates[0], by: 'happy' }
        return null
    }
    return {
        action: answer.approved ? 'allow' : 'deny',
        by: 'happy',
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
function pushMetadata(metadata: Metadata | null, ev: DroverEvent): Metadata {
    const project = ev.origin?.cwd?.split('/').filter(Boolean).pop()
    const text = [ev.title, project].filter(Boolean).join(' · ')
    return { ...(metadata ?? ({} as Metadata)), summary: { text, updatedAt: Date.now() } }
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
    // The event itself, not just its id: answering a question needs the option
    // list to turn the label the app sends back into the id the bus wants.
    const mirrored = new Map<string, DroverEvent>()

    // App answer -> bus resolve. A 409 means another surface won first; the
    // resolved broadcast below cleans the card up, nothing else to do.
    client.rpcHandlerManager.registerHandler<PermissionAnswer, void>(
        'permission',
        async (message) => {
            const body = busResolutionFor(mirrored.get(message.id), message)
            if (!body) {
                logger.debug(`[drover] app answered ${message.id} with nothing the bus takes; left pending`)
                return
            }
            const status = await resolveOnBus(message.id, body)
            logger.debug(`[drover] app answered ${message.id}: ${JSON.stringify(body)} (bus ${status})`)
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
        api.push().sendSessionNotification({
            // A question is not a permission request, and the push title is
            // picked off this ("Clarification needed" vs "Permission request").
            kind: ev.kind === 'question' ? 'question' : 'permission',
            // The body is the session summary, and the bridge holds ONE session
            // for the whole machine, so every push read the same fixed line and
            // said nothing about what was being asked or by which agent.
            metadata: pushMetadata(client.getMetadata(), ev),
            data: {
                sessionId: client.sessionId,
                requestId: ev.id,
                tool: card.tool,
                type: 'permission_request',
                provider: 'claude',
            },
        })
        // The alert buzzes the phone; this wakes the app's JS so the WRIST
        // learns about the gate while the app is suspended. Throttling,
        // coalescing and the direct-to-Expo send all live in the push client.
        api.push().sendBackgroundWake('gate-raised')
        logger.debug(`[drover] mirrored ${ev.kind} ${ev.id}: ${ev.title}`)
    }

    // Not gated on `mirrored`: a bridge restart empties that map while the
    // session on the phone still holds every card it was shown, and a card the
    // bridge refuses to retire is a prompt that sits on the screen forever.
    const removeCard = (ev: DroverEvent) => {
        mirrored.delete(ev.id)
        client.updateAgentState((s) => {
            const requests = { ...(s.requests ?? {}) }
            const card = requests[ev.id]
            if (!card) return s
            delete requests[ev.id]
            const reason = completedReasonFor(ev)
            return {
                ...s,
                requests,
                completedRequests: {
                    ...(s.completedRequests ?? {}),
                    [ev.id]: {
                        ...card,
                        completedAt: Date.now(),
                        status: completedStatusFor(ev),
                        ...(reason ? { reason } : {}),
                    },
                },
            }
        })
        // A wake and no alert, deliberately. The wrist has to hear that the
        // gate went away; buzzing someone to say a question is gone is worse
        // than silence.
        api.push().sendBackgroundWake('gate-resolved')
        logger.debug(`[drover] dismissed ${ev.id} (${ev.state}${ev.resolution ? ` by ${ev.resolution.by}` : ''})`)
    }

    /**
     * Retire cards the bus has no pending event for.
     *
     * The bridge's session outlives the bridge process, so anything that
     * resolved while the service was down came back to a phone still showing
     * it, with no broadcast left to dismiss it. Both sources are consulted: the
     * bus's own pending list, and what the replay has already re-mirrored, so
     * an event created between the two is never mistaken for a dead one.
     */
    const reconcile = async () => {
        let live: Set<string>
        try {
            const res = await fetch(`${DROVER_URL}/v1/events?state=pending`)
            if (!res.ok) return
            const body = (await res.json()) as { events?: DroverEvent[] }
            live = new Set((body.events ?? []).map((e) => e.id))
        } catch (err) {
            logger.debug('[drover] could not list pending events to reconcile', err)
            return
        }
        client.updateAgentState((s) => {
            const requests = { ...(s.requests ?? {}) }
            const completedRequests = { ...(s.completedRequests ?? {}) }
            let dropped = 0
            for (const [id, card] of Object.entries(requests)) {
                if (live.has(id) || mirrored.has(id)) continue
                delete requests[id]
                completedRequests[id] = { ...card, completedAt: Date.now(), status: 'canceled', reason: 'gone from the bus' }
                dropped++
            }
            if (!dropped) return s
            logger.debug(`[drover] retired ${dropped} card(s) the bus no longer has`)
            return { ...s, requests, completedRequests }
        })
    }

    // Bus stream: replay of pending events on connect, then live. Reconnect
    // forever — the bridge is a surface, never a gate.
    for (;;) {
        try {
            const res = await fetch(`${DROVER_URL}/v1/stream`, { headers: { Accept: 'text/event-stream' } })
            if (!res.ok || !res.body) throw new Error(`stream ${res.status}`)
            logger.debug(`[drover] connected to bus at ${DROVER_URL}`)
            await reconcile()
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
                        if (eventType === 'created' && ev.state === 'pending'
                            && (ev.kind === 'permission' || ev.kind === 'question')) {
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
