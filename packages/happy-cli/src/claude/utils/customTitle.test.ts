import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { findCustomTitle } from './customTitle'
import { getProjectPath } from './path'

// DROVE-15. The name Claude Code shows lives in
// <configDir>/projects/<munged-cwd>/<sessionId>/custom-title.json, and drover
// moves a session between config dirs, so "which file" is the whole question.
describe('findCustomTitle', () => {
    const sessionId = '9ae61ba4-8a3b-452f-a294-da49d0019c79'
    let root: string
    let cwd: string
    let savedConfigDir: string | undefined
    let savedRegistry: string | undefined

    function writeTitle(configDir: string, title: string) {
        const dir = join(getProjectPath(cwd, configDir), sessionId)
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, 'custom-title.json'), JSON.stringify({ customTitle: title }))
    }

    function writeTranscript(configDir: string, mtimeSeconds: number) {
        const dir = getProjectPath(cwd, configDir)
        mkdirSync(dir, { recursive: true })
        const file = join(dir, `${sessionId}.jsonl`)
        writeFileSync(file, '{}\n')
        utimesSync(file, mtimeSeconds, mtimeSeconds)
    }

    beforeEach(() => {
        process.env.DROVER_URL = 'http://127.0.0.1:1'
        root = join(tmpdir(), `custom-title-${Date.now()}-${Math.random().toString(36).slice(2)}`)
        cwd = join(root, 'work')
        mkdirSync(cwd, { recursive: true })
        savedConfigDir = process.env.CLAUDE_CONFIG_DIR
        savedRegistry = process.env.DROVER_ACCOUNTS
        process.env.CLAUDE_CONFIG_DIR = join(root, 'ambient')
        // An empty registry by default, so a test that does not care about
        // accounts never reads the real one off Clay's disk.
        process.env.DROVER_ACCOUNTS = join(root, 'accounts.json')
    })

    afterEach(() => {
        if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
        else process.env.CLAUDE_CONFIG_DIR = savedConfigDir
        if (savedRegistry === undefined) delete process.env.DROVER_ACCOUNTS
        else process.env.DROVER_ACCOUNTS = savedRegistry
        rmSync(root, { recursive: true, force: true })
    })

    it('reads the title Claude Code wrote for this session', () => {
        writeTitle(join(root, 'ambient'), 'DROVER')
        expect(findCustomTitle({ sessionId, workingDirectory: cwd })).toBe('DROVER')
    })

    it('is null when the session was never renamed', () => {
        expect(findCustomTitle({ sessionId, workingDirectory: cwd })).toBeNull()
    })

    it('is null when the file is empty, malformed or half-written', () => {
        const dir = join(getProjectPath(cwd, join(root, 'ambient')), sessionId)
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, 'custom-title.json'), '{"customTi')
        expect(findCustomTitle({ sessionId, workingDirectory: cwd })).toBeNull()
    })

    it('prefers the account the session is actually writing to', () => {
        // The premise of engine/registry.js titleFileFor: one session id can
        // own several custom-title.json files at once, one per account it has
        // been flipped onto, and only the newest transcript names the live one.
        const stale = join(root, 'acct-stale')
        const live = join(root, 'acct-live')
        writeFileSync(process.env.DROVER_ACCOUNTS!, JSON.stringify([
            { name: 'stale', configDir: stale },
            { name: 'live', configDir: live },
        ]))
        writeTranscript(stale, 1_700_000_000)
        writeTranscript(live, 1_800_000_000)
        writeTitle(stale, 'hi')
        writeTitle(live, 'DROVER')

        expect(findCustomTitle({ sessionId, workingDirectory: cwd })).toBe('DROVER')
    })

    it('falls back to another account when the live one has no title of its own', () => {
        // A flip carries the transcript before the sidecar exists in the new
        // account, and a session that has never been renamed there still has
        // the name it was given where it came from.
        const older = join(root, 'acct-older')
        const newer = join(root, 'acct-newer')
        writeFileSync(process.env.DROVER_ACCOUNTS!, JSON.stringify([
            { name: 'older', configDir: older },
            { name: 'newer', configDir: newer },
        ]))
        writeTranscript(older, 1_700_000_000)
        writeTranscript(newer, 1_800_000_000)
        writeTitle(older, 'DROVER')

        expect(findCustomTitle({ sessionId, workingDirectory: cwd })).toBe('DROVER')
    })

    it('reads through a projects/ store the accounts share by symlink', () => {
        // DROVE-40 points every account's projects/ at ~/.claude-shared, so
        // the path resolution has to survive a symlinked directory rather than
        // insisting on a real one.
        const shared = join(root, 'shared-projects')
        const account = join(root, 'acct-symlinked')
        mkdirSync(account, { recursive: true })
        mkdirSync(shared, { recursive: true })
        symlinkSync(shared, join(account, 'projects'))
        writeTitle(account, 'DROVER')

        expect(findCustomTitle({ sessionId, workingDirectory: cwd, claudeConfigDir: account }))
            .toBe('DROVER')
    })
})
