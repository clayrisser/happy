/**
 * Channel 0 for a pane session (DROVE-1): finding the inbox of the Claude that
 * owns the pane, and writing one message into it.
 *
 * Both halves are wire-and-disk contracts with a program we do not control, so
 * they are tested against a REAL unix socket and a REAL registry directory
 * whose files are byte-for-byte the shape a live `~/.claude/sessions` holds.
 * A mock would prove only that we can call our own functions.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { findInbox, sendToInbox } from './inboxSocket'

const sessionId = 'e495e6e8-43f6-4699-a984-ff19f5ab4551'
const token = 'peer-token-not-to-be-logged'
/** The real digest is sha256 of the socket path; we glob, so any hex will do. */
const keyHash = 'df9c341b8ad768dcbffc7eb0c653bbe1bcca7c8148a32184b77ddaff0336ba40'

let dirs: string[] = []
let servers: Server[] = []

afterEach(async () => {
    for (const server of servers) await new Promise<void>((r) => server.close(() => r()))
    servers = []
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
    dirs = []
})

function makeConfigDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'inbox-cfg-'))
    dirs.push(dir)
    mkdirSync(join(dir, 'sessions'))
    return dir
}

/** The record an interactive claude writes, with the fields we actually read. */
function writeRecord(configDir: string, opts: {
    pid: number
    sessionId?: string
    tmux?: string
    socketPath: string
    token?: string | null
}) {
    const sessions = join(configDir, 'sessions')
    writeFileSync(join(sessions, `${opts.pid}.json`), JSON.stringify({
        pid: opts.pid,
        sessionId: opts.sessionId ?? sessionId,
        cwd: '/Users/clayrisser/Projects/bitspur/cattle-drover',
        tmux: opts.tmux ?? 'selfhosted-cloud:@1.%50',
        messagingSocketPath: opts.socketPath,
        status: 'idle',
    }))
    if (opts.token !== null) {
        writeFileSync(
            join(sessions, `${opts.pid}.${keyHash}.key`),
            JSON.stringify({ peerToken: opts.token ?? token, pidDomain: 'darwin', procStart: 'x' }),
            { mode: 0o600 },
        )
    }
}

/** A listener on `path` that keeps every byte it is sent. */
async function listen(path: string): Promise<{ frames: () => string[]; closed: Promise<void> }> {
    let received = ''
    let resolveClosed!: () => void
    const closed = new Promise<void>((r) => { resolveClosed = r })
    const server = createServer((socket) => {
        socket.on('data', (chunk) => { received += chunk.toString('utf8') })
        socket.on('end', () => resolveClosed())
    })
    servers.push(server)
    await new Promise<void>((r) => server.listen(path, r))
    return {
        frames: () => received.split('\n').filter((line) => line.length > 0),
        closed,
    }
}

/** Short, because a unix socket path is capped near 104 bytes on macOS. */
function socketPath(): string {
    const path = join(tmpdir(), `ib-${Math.random().toString(36).slice(2, 8)}.sock`)
    rmSync(path, { force: true })
    return path
}

describe('findInbox', () => {
    it('finds the record whose sessionId matches and reads its peer token', async () => {
        const configDir = makeConfigDir()
        writeRecord(configDir, { pid: 4242, socketPath: '/tmp/cc-socks/4242.sock' })

        const inbox = await findInbox(configDir, sessionId, '%50')

        expect(inbox).toEqual({
            pid: 4242,
            sessionId,
            socketPath: '/tmp/cc-socks/4242.sock',
            token,
        })
    })

    it('breaks a tie on the tmux pane, so a stale record for the same session loses', async () => {
        const configDir = makeConfigDir()
        writeRecord(configDir, { pid: 111, tmux: 'other:@9.%9', socketPath: '/tmp/cc-socks/111.sock' })
        writeRecord(configDir, { pid: 222, tmux: 'selfhosted-cloud:@1.%50', socketPath: '/tmp/cc-socks/222.sock' })

        expect((await findInbox(configDir, sessionId, '%50'))?.pid).toBe(222)
    })

    it('returns null when no record claims this session, and when there is no registry at all', async () => {
        const configDir = makeConfigDir()
        writeRecord(configDir, { pid: 4242, sessionId: 'someone-else', socketPath: '/tmp/cc-socks/4242.sock' })

        expect(await findInbox(configDir, sessionId, '%50')).toBeNull()
        expect(await findInbox(join(configDir, 'nope'), sessionId, '%50')).toBeNull()
        expect(await findInbox(configDir, null, '%50')).toBeNull()
    })

    it('returns null when the key file is missing — a socket with no token is unusable', async () => {
        const configDir = makeConfigDir()
        writeRecord(configDir, { pid: 4242, socketPath: '/tmp/cc-socks/4242.sock', token: null })

        expect(await findInbox(configDir, sessionId, '%50')).toBeNull()
    })
})

describe('sendToInbox', () => {
    it('writes the auth line first, then the user frame carrying the session id', async () => {
        const path = socketPath()
        const server = await listen(path)

        const result = await sendToInbox(
            { pid: 4242, sessionId, socketPath: path, token },
            'from the phone',
        )
        await server.closed

        expect(result).toBe('ok')
        expect(server.frames().map((line) => JSON.parse(line))).toEqual([
            { type: 'auth', token },
            {
                type: 'user',
                message: { role: 'user', content: 'from the phone' },
                session_id: sessionId,
            },
        ])
    })

    it('reports "gone" when nothing is behind the socket', async () => {
        const result = await sendToInbox(
            { pid: 4242, sessionId, socketPath: socketPath(), token },
            'from the phone',
        )

        expect(result).toBe('gone')
    })
})
