/**
 * Cattle Drover bridge (BASED-98).
 *
 * Makes Happy a surface on the Cattle Drover prompt bus. The drover bus
 * (loopback :7970) is the single local arbiter for every pending agent
 * interaction — gum popups in tmux already race through it. This bridge adds
 * the phone/web side: it holds one dedicated Happy session per machine,
 * mirrors every pending bus event into that session's agentState.requests
 * (the app renders them as permission cards and gets a push), and translates
 * the app's `permission` RPC answer back into a bus resolve. When any other
 * surface wins the race, the bus broadcast removes the card — mutual dismiss
 * in both directions, first answer wins, all bus semantics.
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

interface DroverEvent {
    id: string
    kind: 'permission' | 'question' | 'idle' | 'expiry'
    state: string
    title: string
    reason?: string
    preview?: string
    options?: { id: string; label: string; description?: string }[] | null
    origin?: { harness?: string; sessionId?: string | null; cwd?: string | null; account?: string | null }
    resolution?: { action: string; by: string } | null
}

function requestForEvent(ev: DroverEvent) {
    // Render through the app's existing permission-card path: a Bash-shaped
    // request carries the command preview; anything else goes descriptive.
    const description = [ev.title, ev.reason].filter(Boolean).join(' — ')
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
        tool: ev.kind === 'question' ? 'AskUserQuestion' : 'Bash',
        arguments: {
            command: ev.preview || ev.title,
            description,
            ...(ev.options ? { options: ev.options.map((o) => o.label) } : {}),
        },
        createdAt: Date.now(),
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
    const mirrored = new Set<string>()

    // App answer -> bus resolve. A 409 means another surface won first; the
    // resolved broadcast below cleans the card up, nothing else to do.
    client.rpcHandlerManager.registerHandler<{ id: string; approved: boolean; reason?: string }, void>(
        'permission',
        async (message) => {
            const status = await resolveOnBus(message.id, {
                action: message.approved ? 'allow' : 'deny',
                by: 'happy',
                ...(message.reason ? { text: message.reason } : {}),
            })
            logger.debug(`[drover] app answered ${message.id}: ${message.approved} (bus ${status})`)
        }
    )

    const addCard = (ev: DroverEvent) => {
        if (mirrored.has(ev.id)) return
        mirrored.add(ev.id)
        client.updateAgentState((s) => ({
            ...s,
            requests: { ...(s.requests ?? {}), [ev.id]: requestForEvent(ev) },
        }))
        api.push().sendSessionNotification({
            kind: 'permission',
            metadata: client.getMetadata(),
            data: {
                sessionId: client.sessionId,
                requestId: ev.id,
                tool: requestForEvent(ev).tool,
                type: 'permission_request',
                provider: 'claude',
            },
        })
        logger.debug(`[drover] mirrored ${ev.kind} ${ev.id}: ${ev.title}`)
    }

    const removeCard = (ev: DroverEvent) => {
        if (!mirrored.has(ev.id)) return
        mirrored.delete(ev.id)
        client.updateAgentState((s) => {
            const requests = { ...(s.requests ?? {}) }
            const card = requests[ev.id]
            if (!card) return s
            delete requests[ev.id]
            const status = ev.resolution?.action === 'allow' ? 'approved' : 'denied'
            return {
                ...s,
                requests,
                completedRequests: {
                    ...(s.completedRequests ?? {}),
                    [ev.id]: {
                        ...card,
                        completedAt: Date.now(),
                        status: ev.state === 'resolved' ? status : 'canceled',
                        ...(ev.resolution?.by ? { reason: `by ${ev.resolution.by}` } : {}),
                    },
                },
            }
        })
        logger.debug(`[drover] dismissed ${ev.id} (${ev.state}${ev.resolution ? ` by ${ev.resolution.by}` : ''})`)
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
