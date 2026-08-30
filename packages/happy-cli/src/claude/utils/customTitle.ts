/**
 * The name Claude Code is showing for a session, read off disk (DROVE-15).
 *
 * `/rename DROVER` writes `{"customTitle":"DROVER"}` to
 * `<configDir>/projects/<munged-cwd>/<sessionId>/custom-title.json` and the
 * terminal reads it back on every start, so that file — not anything the
 * wrapper remembers — is the session's name across runs. Clay renamed a
 * session DROVER, quit drover, started it again with --resume, and the app
 * header said "cattle-drover": the cwd basename, because the startup default
 * was the only thing that had ever named the Happy session.
 *
 * WHICH file is the whole question, and it is the same one engine/registry.js
 * answers in titleFileFor: drover moves a session between accounts, each
 * account is its own CLAUDE_CONFIG_DIR with its own projects tree, so ONE
 * session id can own several custom-title.json files at once. Session 9ae61ba4
 * had three, saying "drover", "hi" and "hi". Deriving the directory from the
 * cwd alone always reads ~/.claude, which for a flipped session is a name it
 * was given under some other account, or nothing at all. The transcript is
 * where the session is writing NOW, so the account holding the newest one is
 * asked first.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { logger } from '@/ui/logger'
import { accountByNewestTranscript, readAccounts } from '@/drover/flip/accounts'
import { getProjectPath, resolveClaudeConfigDir } from './path'

/** Where Claude Code keeps one session's title under a given config dir. */
export function customTitleFile(
    workingDirectory: string,
    sessionId: string,
    claudeConfigDir?: string | null,
): string {
    return join(getProjectPath(workingDirectory, claudeConfigDir), sessionId, 'custom-title.json')
}

function readTitleFile(file: string): string | null {
    let raw: string
    try {
        raw = readFileSync(file, 'utf-8')
    } catch {
        // Not renamed, or renamed under a different account. Not an error.
        return null
    }
    try {
        const parsed = JSON.parse(raw)
        const title = typeof parsed?.customTitle === 'string' ? parsed.customTitle.trim() : ''
        return title.length > 0 ? title : null
    } catch {
        // Malformed or caught half-written. A title is a nicety and must never
        // be the reason a session fails to start, so this stays quiet.
        logger.debug(`[customTitle] unreadable title file ${file}`)
        return null
    }
}

/**
 * The title this session is running under, or null if it was never renamed.
 *
 * Asked in the order the answer is most likely to be true: the account holding
 * the newest transcript, then whichever config dir the caller named, then
 * every other account. The last group is what covers a flip whose destination
 * has the carried transcript but not yet a title of its own — a session keeps
 * the name it was given wherever it was given it.
 */
export function findCustomTitle(opts: {
    sessionId: string
    workingDirectory: string
    claudeConfigDir?: string | null
}): string | null {
    const { sessionId, workingDirectory } = opts
    if (!sessionId) return null

    const configDirs: string[] = []
    const consider = (dir: string | undefined | null) => {
        if (dir && !configDirs.includes(dir)) configDirs.push(dir)
    }
    try {
        consider(accountByNewestTranscript(sessionId, workingDirectory)?.configDir)
    } catch (err) {
        logger.debug('[customTitle] could not read the account registry', err)
    }
    consider(resolveClaudeConfigDir(opts.claudeConfigDir))
    for (const account of readAccounts()) consider(account.configDir)

    for (const configDir of configDirs) {
        const title = readTitleFile(customTitleFile(workingDirectory, sessionId, configDir))
        if (title) return title
    }
    return null
}
