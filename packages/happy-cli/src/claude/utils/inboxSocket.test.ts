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

import { appSenderName, findInbox, sendToInbox, wrapForPane } from './inboxSocket'

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

/**
 * DROVE-49. These are the bytes Claude Code's own peer sender writes, copied
 * out of 2.1.251 (`VMe` composing `r9`'s attribute list). The receiver
 * re-serialises what it parsed and compares (`SM`), and its TUI only strips the
 * "permission laundering" paragraph off a body it recognises as wrapped — so
 * this shape is a contract, not a preference, and the test spells it out
 * literally rather than rebuilding it from the same code under test.
 */
describe('wrapForPane', () => {
    it('emits from-name and nothing else, body on its own lines', () => {
        expect(wrapForPane('ship it', 'phone')).toBe(
            '<cross-session-message from-name="phone">\nship it\n</cross-session-message>',
        )
    })

    it('leaves an already-wrapped body alone, so a relayed peer note is not double-wrapped', () => {
        const already = '<cross-session-message from="uds:/tmp/cc-socks/1.sock" from-name="shc">\nhi\n</cross-session-message>'

        expect(wrapForPane(already)).toBe(already)
    })

    it('scrubs the name the way Claude Code does before it will accept the attribute', () => {
        // Quotes and angle brackets would break out of the attribute; control
        // characters are stripped by its `QS`; 64 code points is its cap.
        expect(wrapForPane('x', 'a"b<c>d')).toContain('from-name="abcd"')
        expect(wrapForPane('x', 'a\u0007b')).toContain('from-name="ab"')
        expect(wrapForPane('x', 'n'.repeat(80))).toContain(`from-name="${'n'.repeat(64)}"`)
    })

    it('sends the body unwrapped rather than with an empty name', () => {
        expect(wrapForPane('ship it', '   ')).toBe('ship it')
    })
})

describe('sendToInbox', () => {
    it('writes the auth line first, then the wrapped user frame carrying the session id', async () => {
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
                message: {
                    role: 'user',
                    content: `<cross-session-message from-name="${appSenderName}">\nfrom the phone\n</cross-session-message>`,
                },
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
