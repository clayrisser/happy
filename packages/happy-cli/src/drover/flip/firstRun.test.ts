/**
 * An account that is logged in and still cannot start a session (DROVE-246).
 *
 * Clay: "When I added accounts from the mobile app it actually showed they
 * added but when I tried to flip to them it actually got stuck on these
 * screens." The screens were Claude Code's FIRST-RUN ONBOARDING — the pig,
 * "Let's get started", "Choose the text style that looks best with your
 * terminal" — which is what a config dir that has never run interactively
 * shows before it does anything else.
 *
 * The credential was never the problem. Measured on the real directory:
 * ~/.claude-accounts/account-3 held an oauthAccount and `claude auth status`
 * reported `loggedIn: true, authMethod: "claude.ai"`, while its .claude.json
 * had no `hasCompletedOnboarding` at all. So `isLoggedIn` said yes, the row was
 * written, the list said ready, and every flip landed on a theme picker.
 *
 * These pin down the three things that had to become true: the state is
 * DETECTED, an explicit flip onto it is REFUSED rather than attempted, and the
 * automatic choice never picks it.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

let root: string

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'drover-firstrun-'))
    process.env.XDG_STATE_HOME = join(root, 'state')
    process.env.DROVER_ACCOUNTS = join(root, 'accounts.json')
    delete process.env.DROVER_ACCOUNT
    delete process.env.CLAUDE_CONFIG_DIR
})

afterEach(() => {
    rmSync(root, { recursive: true, force: true })
})

/**
 * `onboarded: false` is the account-3 shape: a real credential in a directory
 * that has never been through the wizard. `loggedIn: false` is the older,
 * already-handled shape — nothing there at all.
 */
function writeAccount(name: string, opts: { loggedIn?: boolean; onboarded?: boolean } = {}): void {
    const configDir = join(root, name)
    mkdirSync(configDir, { recursive: true })
    const raw: Record<string, unknown> = {}
    if (opts.onboarded !== false) raw.hasCompletedOnboarding = true
    if (opts.loggedIn !== false) raw.oauthAccount = { emailAddress: `${name}@example.com` }
    writeFileSync(join(configDir, '.claude.json'), JSON.stringify(raw))
    const path = process.env.DROVER_ACCOUNTS!
    const registry: { name: string; configDir: string }[] = existsSync(path)
        ? JSON.parse(readFileSync(path, 'utf8'))
        : []
    registry.push({ name, configDir })
    writeFileSync(path, JSON.stringify(registry))
}

const mod = async () => await import('./accounts')

describe('a config dir that has never been through Claude Code first run', () => {
    it('is logged in and still not able to start a session', async () => {
        writeAccount('phantom', { onboarded: false })
        const { readAccounts, isLoggedIn, isOnboarded, canStartSession } = await mod()
        const a = readAccounts().find((x) => x.name === 'phantom')!
        // Both halves, and the point is that they disagree. This is the exact
        // state account-3 was in while the registry called it ready.
        expect(isLoggedIn(a)).toBe(true)
        expect(isOnboarded(a)).toBe(false)
        expect(canStartSession(a)).toBe(false)
    })

    it('reads a settled dir as usable', async () => {
        writeAccount('fine')
        const { readAccounts, canStartSession } = await mod()
        expect(canStartSession(readAccounts().find((x) => x.name === 'fine')!)).toBe(true)
    })

    it('treats a MISSING config file as settled, not as broken', async () => {
        // Same fail-open rule isLoggedIn has: an unreadable file must not
        // strand a session. What must NOT fail open is a file that read fine
        // and simply lacks the key — that is the account this exists to catch.
        writeAccount('nofile')
        rmSync(join(root, 'nofile', '.claude.json'))
        const { readAccounts, isOnboarded } = await mod()
        expect(isOnboarded(readAccounts().find((x) => x.name === 'nofile')!)).toBe(true)
    })
})

describe('choosing where to flip', () => {
    it('refuses a flip NAMED at one, and says so as its own kind', async () => {
        // Its own kind and not `nologin`, because the fix is a different
        // command. Telling Clay to log in an account he had already logged in
        // is what made this take a day to understand.
        writeAccount('here')
        writeAccount('phantom', { onboarded: false })
        const { pickTarget } = await mod()
        expect(pickTarget('here', 'phantom', Date.now()).kind).toBe('neverrun')
    })

    it('never picks one automatically', async () => {
        writeAccount('here')
        writeAccount('phantom', { onboarded: false })
        const { pickTarget } = await mod()
        // The only other account cannot run, so there is nowhere to go — and
        // "nowhere" is the honest answer. Before this it picked phantom and
        // the session relaunched into a theme picker.
        expect(pickTarget('here', undefined, Date.now()).kind).toBe('none')
    })

    it('still picks a settled account beside a broken one', async () => {
        writeAccount('here')
        writeAccount('phantom', { onboarded: false })
        writeAccount('good')
        const { pickTarget } = await mod()
        const pick = pickTarget('here', undefined, Date.now())
        expect(pick.kind).toBe('account')
        expect(pick.kind === 'account' && pick.account.name).toBe('good')
    })
})

describe('the snapshot every surface reads', () => {
    it('carries onboarded beside loggedIn, so a phone can tell them apart', async () => {
        writeAccount('here')
        writeAccount('phantom', { onboarded: false })
        writeAccount('empty', { loggedIn: false })
        const { usageSnapshot } = await import('./usage')
        const rows = usageSnapshot('here').accounts
        const by = (n: string) => rows.find((r) => r.name === n)!
        expect(by('here')).toMatchObject({ loggedIn: true, onboarded: true })
        // The two failures are distinguishable, which is the whole reason
        // there are two fields rather than one `usable` boolean.
        expect(by('phantom')).toMatchObject({ loggedIn: true, onboarded: false })
        expect(by('empty')).toMatchObject({ loggedIn: false, onboarded: true })
    })
})
