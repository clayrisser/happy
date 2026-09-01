/**
 * Carrying out a pending flip, from whichever launcher is running (BASED-127).
 *
 * This lived inside claudeLocalLauncher, and that is exactly why a `/flip`
 * pressed in REMOTE mode was accepted and then never happened. The
 * interception moved up to runClaude (095204f) so both modes hear the request,
 * but only one of them could act on it: the request queued, `abortChild` was
 * either unset or a dead closure from a previous local launcher, and the flip
 * sat there until the session came back to local mode and its next child
 * exited. From the phone that is indistinguishable from a button that does
 * nothing.
 *
 * So the mechanism lives here, launcher-agnostic, and both launchers call it
 * with the two things that genuinely differ between them:
 *
 *   deliverPrompt   local hands the arrival prompt to the next spawn as
 *                   `pendingInitialPrompt`; remote has no spawn to hand it to,
 *                   so it puts it at the head of the message queue, which is
 *                   the only way to say something to an SDK `query()` loop.
 *   scanner         only the local launcher owns one. The remote launcher's
 *                   scanner belongs to runClaude and watches for prompts typed
 *                   into a parallel `claude --resume` terminal, which is not
 *                   this file's business.
 *
 * Everything it changes is process-local — CLAUDE_CONFIG_DIR for the next
 * spawn, the transcript on disk, the session's own metadata — so the Happy
 * server sees nothing but the same session continuing to send messages.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { defaultSessionName, isDefaultSessionName, type Session } from '@/claude/session'
import { findCustomTitle } from '@/claude/utils/customTitle'
import { logger } from '@/ui/logger'
import { remoteControlWarning, type BusSession } from './remoteControl'

import { ambientDataDir } from './accounts'
import type { DowngradePlan } from './downgrade'
import type { RestorePlan } from './restore'
import { projectDirFor } from './transcript'

/**
 * Where the transcript this session would resume lives, or null when there is
 * no session id yet.
 *
 * Answered against the account the NEXT spawn will use, which is the account
 * we are on right now: CLAUDE_CONFIG_DIR as the child will see it, with the
 * empty string meaning ambient (~/.claude), exactly as claudeLocal's env merge
 * reads it. Getting that wrong in either direction is worse than not checking
 * — a false negative throws away a real conversation.
 *
 * Recomputed per call rather than captured: a flip rewrites claudeEnvVars and
 * moves the file into another account's config dir mid-run.
 */
export function transcriptPathFor(session: Session): string | null {
    if (!session.sessionId) return null
    const configured = session.claudeEnvVars?.CLAUDE_CONFIG_DIR
    const configDir = configured && configured.length > 0 ? configured : ambientDataDir()
    return join(projectDirFor(configDir, session.path), `${session.sessionId}.jsonl`)
}

/** Does that transcript actually exist on disk? */
export function transcriptExists(session: Session): boolean {
    const path = transcriptPathFor(session)
    return path !== null && existsSync(path)
}

/**
 * What the app should call this session once it lands on the new account.
 *
 * `summary`, not just `name`: the phone's session title reads
 * metadata.summary.text and falls back to the literal "New chat" —
 * getSessionName in happy-app/sources/utils/sessionUtils.ts — so stamping only
 * `name` renamed the session everywhere EXCEPT the screen Clay was looking at.
 *
 * The account prefix is a DEFAULT, and it loses to any name that is not one of
 * ours: a title Claude Code or the app wrote outlives a flip instead of
 * collapsing back into a path. It also loses to the name Claude Code is
 * showing right now, which is the DROVE-15 half — Clay renamed this session
 * DROVER, flipped it, and the app called it "[jamrizzi] cattle-drover",
 * because the rename had never reached the metadata for the prefix to lose to.
 * carryTranscript brings the whole <sessionId>/ sidecar along, custom-title.json
 * included, so the name is on the new account's disk by the time we ask.
 */
export function nameAfterFlip(opts: {
    metadata: { name?: string; summary?: { text: string; updatedAt: number } }
    workingDirectory: string
    accountName: string
    customTitle: string | null
}): { name: string; summary: { text: string; updatedAt: number } | undefined } {
    const { metadata, workingDirectory, accountName, customTitle } = opts
    if (customTitle) {
        return { name: customTitle, summary: { text: customTitle, updatedAt: Date.now() } }
    }
    const flippedName = defaultSessionName(workingDirectory, accountName)
    return {
        name: isDefaultSessionName(metadata.name, workingDirectory) ? flippedName : metadata.name!,
        summary: isDefaultSessionName(metadata.summary?.text, workingDirectory)
            ? { text: flippedName, updatedAt: Date.now() }
            : metadata.summary,
    }
}

/**
 * Record a model downgrade where every surface can see it (DROVE-187).
 *
 * `modelMode` and `effortLevel` are the keys the phone's own pickers write, and
 * both launchers already read them — the SDK path hands them to query(), and
 * the pane path types `/model` and `/effort`. So a downgrade is spelled as the
 * pick Clay would have made himself, and the composer stops claiming Fable the
 * moment the session leaves it.
 *
 * `effort` null means the new model takes the effort we were on, so it is left
 * alone rather than rewritten to the same value.
 *
 * This write does NOT come back through the client's own `metadata` event —
 * apiSession only emits for changes that arrive from somebody else — so the
 * pane still has to be told separately. That is what the controller's
 * takeDowngradePick() is for, and the local launcher asks on its way back up.
 */
function applyDowngrade(session: Session, downgrade: DowngradePlan): void {
    session.client.updateMetadata((metadata) => ({
        ...metadata,
        modelMode: downgrade.model,
        ...(downgrade.effort ? { effortLevel: downgrade.effort } : {}),
    }))
    logger.debug(
        `[flip] downgraded ${downgrade.from} -> ${downgrade.to} (${downgrade.model})` +
            (downgrade.effort ? ` and effort ${downgrade.previousEffort} -> ${downgrade.effort}` : ''),
    )
}

/**
 * Record a restore-substitution the same way, and for the same reason
 * (DROVE-272).
 *
 * The session was set to a model the account it just landed on cannot run, so
 * something else was taken. `modelMode` is where the replacement child's argv
 * is read from (`modeCarryArgs`) and where the phone's picker draws from, so
 * writing it here is what stops the flip pinning the session to the one model
 * its new account is out of -- and what stops the launcher's own reconcile
 * typing that model back at the pane on every observation for the rest of the
 * session.
 *
 * `effort` null means the model taken holds the effort we were on, so it is
 * left standing: that is the half of the ticket that says KEEP THE EFFORT.
 *
 * Like applyDowngrade, this write does not come back through the client's own
 * `metadata` event, so the pane is told separately by takeDowngradePick().
 */
function applyRestore(session: Session, restore: RestorePlan): void {
    if (!restore.rewrite || !restore.model) return
    session.client.updateMetadata((metadata) => ({
        ...metadata,
        modelMode: restore.model,
        ...(restore.effort ? { effortLevel: restore.effort } : {}),
    }))
    logger.debug(
        `[flip] restored onto ${restore.model}` +
            (restore.substitution ? ` instead of ${restore.substitution.instead}` : '') +
            (restore.effort
                ? `, effort ${restore.keptEffort} -> ${restore.effort}`
                : restore.keptEffort
                    ? `, keeping effort ${restore.keptEffort}`
                    : ''),
    )
}

/** The one thing applyPendingFlip needs from a launcher's session scanner. */
interface ScannerLike {
    setClaudeConfigDir?: (claudeConfigDir: string | null | undefined) => void
}

export interface ApplyPendingFlipOptions {
    session: Session
    /**
     * Which launcher is asking. Only ever used to label the log lines, so a
     * flip that goes wrong still says which half of the session it went wrong
     * in.
     */
    mode: 'local' | 'remote'
    /**
     * How the arrival prompt reaches the Claude that comes back. There is no
     * default: the two launchers do genuinely different things here, and a
     * launcher that forgets is a flip that lands mute.
     */
    deliverPrompt: (prompt: string) => void
    /** The launcher's own transcript scanner, when it has one. */
    scanner?: ScannerLike | null
    /**
     * Re-arm whatever abort controller the launcher is about to reuse. An
     * aborted signal stays aborted, so a launcher that keeps one controller
     * across relaunches must replace it here or the replacement child dies on
     * spawn. Launchers that mint a fresh controller per iteration pass nothing.
     */
    resetAbort?: () => void
    /**
     * Who is live on this machine, for the Remote Control warning (DROVE-37).
     * Injected only by tests; the default asks the bus.
     */
    listSessions?: () => Promise<BusSession[]>
}

/**
 * Carry out a pending Cattle Drover flip (BASED-98), if there is one.
 *
 * Returns true when the caller should carry on rather than exit.
 */
export async function applyPendingFlip(opts: ApplyPendingFlipOptions): Promise<boolean> {
    const { session, mode, deliverPrompt, scanner, resetAbort } = opts
    const flip = session.flip
    let request = flip?.take()
    if (!flip || !request) return false

    // A park is resolved HERE, in a loop, rather than by queueing another
    // request for the next child to trip over. Queueing it meant the flip sat
    // pending for the whole of the next conversation, so when Clay eventually
    // quit claude the launcher found a stale request and relaunched instead of
    // exiting — a session that would not close.
    let result = flip.apply(request, session.sessionId)
    while (result.kind === 'parked') {
        // ONE emit, not two (DROVE-187). flip.say() is announce() plus the
        // terminal, and announce() IS session.sendSessionEvent — the callback
        // runClaude hands the controller. So the explicit sendSessionEvent that
        // used to stand here put the identical sentence in the transcript
        // twice; Clay's screenshot has the whole three-line notice printed
        // verbatim back to back. All three branches of this function had the
        // same pair.
        //
        // say(), not announce(): a park runs with NO claude child, so this
        // terminal is the one surface that can show anything for the next few
        // hours, and it was the one surface a park never wrote to. Every trip
        // round this loop says it again, and apply() words the repeat as an
        // answer to whoever asked — pressing prefix+F into a park used to
        // reprint the identical sentence, which reads as the key doing
        // nothing. That silence, not the parking, is what wedged Clay.
        flip.say(result.note)
        await flip.park(result.until, result.account.name)
        // The ledger has moved on, so ask again. `take()` first, in case a
        // human flipped by hand while we were parked — their choice wins.
        request = flip.take() ?? { account: null, reason: 'cooldown expired', by: 'auto' }
        result = flip.apply(request, session.sessionId)
    }

    if (result.kind === 'refused') {
        // Say why, in the session, and carry on where we are. A refused flip
        // must never take the session down with it. One emit: say() already
        // reaches the phone (DROVE-187).
        flip.say(result.note)

        // `refused` is "the account did not move", which is not the same as
        // "nothing happened". A downgrade stays on this account by design, so
        // it lands here (DROVE-187).
        if (result.downgrade) applyDowngrade(session, result.downgrade)

        // ...and it must not take the session down on the way back UP either.
        // The child has already been aborted by the time we get here — that is
        // how a flip announces itself — so a refusal still costs a relaunch,
        // and a relaunch carries --resume <id>. On a session where nothing was
        // ever said there is no transcript for that id, and Claude Code exits
        // immediately with `No conversation found with session ID: <id>`.
        //
        // Measured, not theorised: 22:29:05 in 2026-08-29-22-27-43-pid-16999
        // refused a flip to main (already on main) and relaunched with
        // --resume e6bb612b, which died on the spot. Opening a fresh drover
        // and pressing flip before typing anything killed the session every
        // time. The success path below has guarded this since it was written;
        // the refusal path never did, because a refusal was assumed to change
        // nothing — but the abort already happened, so it changes everything.
        //
        // Same guard, same reason: no transcript on disk means the next spawn
        // has to be a clean start rather than a --resume against a file that
        // is not there.
        if (session.sessionId && !transcriptExists(session)) {
            logger.debug(
                `[${mode}]: refused flip, and ${session.sessionId} has no transcript — starting clean instead of --resume`,
            )
            session.clearSessionId()
        }

        resetAbort?.()
        return true
    }

    // Point the next spawn at the new account. claudeLocal merges these over
    // process.env, so this is all it takes — and DROVER_ACCOUNT travels with
    // it so anything downstream reading the stamp agrees. Remote mode reaches
    // the same place by a different road: claudeRemote writes claudeEnvVars
    // straight into process.env before it starts the query.
    //
    // The AMBIENT account is reached by unsetting CLAUDE_CONFIG_DIR, not by
    // setting it to ~/.claude: Claude Code reads its global config from
    // `join(CLAUDE_CONFIG_DIR || homedir(), '.claude.json')`, so pointing the
    // variable at ~/.claude silently swaps the file holding the OAuth account
    // for an empty one and the flip lands in the first-run wizard. An empty
    // string is what claudeLocal's env merge understands as "not set" — see
    // the delete there — because `undefined` in a spread survives as a key,
    // and it is falsy, so the `||` above falls through to the home directory.
    const next: Record<string, string> = {
        ...session.claudeEnvVars,
        DROVER_ACCOUNT: result.account.name,
    }
    next.CLAUDE_CONFIG_DIR = result.account.ambient ? '' : result.account.configDir
    session.claudeEnvVars = next

    // The child is not the only thing that reads the transcript: the session
    // scanner polls it and is what the app actually sees. carryTranscript has
    // already copied the conversation into the new account, so point the
    // scanner at the copy or it keeps reading a file nothing writes to any
    // more, and the session goes mute in the app until it is dropped.
    //
    // account.configDir, NOT next.CLAUDE_CONFIG_DIR: the ambient account is
    // spelled as an empty string for the child (unsetting the variable is how
    // Claude Code finds its global config), but it still keeps transcripts in
    // ~/.claude, and account.configDir is always that real path.
    scanner?.setClaudeConfigDir?.(result.account.configDir)

    deliverPrompt(result.prompt)
    if (!result.resume) {
        // Nothing was ever said, so there is no transcript in the new account
        // to resume from. Clearing the id makes the next spawn a clean start
        // rather than a --resume against a file that does not exist there.
        session.clearSessionId()
    }

    // Keep the app honest about which account is doing the work now.
    const customTitle = session.sessionId
        ? findCustomTitle({
            sessionId: session.sessionId,
            workingDirectory: session.path,
            claudeConfigDir: result.account.configDir,
        })
        : null
    session.client.updateMetadata((metadata) => ({
        ...metadata,
        droverAccount: result.account.name,
        ...nameAfterFlip({
            metadata,
            workingDirectory: session.path,
            accountName: result.account.name,
            customTitle,
        }),
    }))
    flip.say(result.note)
    if (result.downgrade) applyDowngrade(session, result.downgrade)
    else if (result.restore) applyRestore(session, result.restore)

    // DROVE-47: the strip has to say the NEW account's headroom, and say it
    // now rather than after the settle delay, so the metadata update carrying
    // droverAccount and the one carrying its usage land in the same breath.
    session.usage?.tick()

    // DROVE-37: and say who else just went quiet. Claude Code binds Remote
    // Control to one account per machine, so landing on a new account tears
    // down the binding every OTHER live session was holding — Clay flipped
    // this session and watched an unrelated `employees` chat stop answering
    // his phone with no idea why. Drover cannot prevent that (nothing it
    // writes is shared; the binding is Claude Code's own), but it can stop it
    // being a mystery. Best effort: never blocks, never fails the flip.
    try {
        const warning = await remoteControlWarning({
            target: result.account.name,
            selfId: session.sessionId ?? '',
            ...(opts.listSessions ? { listSessions: opts.listSessions } : {}),
        })
        if (warning) {
            flip.say(warning.text)
            // DROVE-63: the same list in a shape the app can act on. The
            // warning's own remedy is "/remote-control there", which is the one
            // thing Clay cannot do from the phone — so the sessions it names
            // ride along as ids, and the app puts the toggle next to each of
            // them. Written on THIS session because this is the chat he is
            // reading the warning in; nothing here reaches across to another
            // session's metadata.
            session.client.updateMetadata((metadata) => ({
                ...metadata,
                remoteControlAtRisk: warning.atRisk,
                remoteControlAtRiskAt: Date.now(),
            }))
        }
    } catch (err) {
        logger.debug(`[${mode}]: could not check Remote Control fallout: ${String(err)}`)
    }
    logger.debug(`[${mode}]: flipped to ${result.account.name}, relaunching with --resume ${session.sessionId}`)

    resetAbort?.()
    return true
}
