import { logger } from "@/ui/logger";
import { claudeLocal, ExitCodeError } from "./claudeLocal";
import { defaultSessionName, isDefaultSessionName, resumesExistingTranscript, Session } from "./session";
import { Future } from "@/utils/future";
import { createSessionScanner, type SessionScanner } from "./utils/sessionScanner";
import { launchFailureMessage } from "./utils/launchFailureMessage";
import { ambientDataDir } from "@/drover/flip/accounts";
import { parseFlipCommand } from "@/drover/flip/controller";

export type LauncherResult = { type: 'switch' } | { type: 'exit', code: number };

/**
 * Carry out a pending Cattle Drover flip (BASED-98), if there is one.
 *
 * Returns true when the caller should relaunch the child rather than exit.
 * Everything it changes is process-local — CLAUDE_CONFIG_DIR for the next
 * spawn, the transcript on disk, the session's own metadata — so the Happy
 * server sees nothing but the same session continuing to send messages.
 */
async function applyPendingFlip(
    session: Session,
    scanner: Awaited<SessionScanner>,
    resetAbort: () => void,
): Promise<boolean> {
    const flip = session.flip;
    let request = flip?.take();
    if (!flip || !request) return false;

    // A park is resolved HERE, in a loop, rather than by queueing another
    // request for the next child to trip over. Queueing it meant the flip sat
    // pending for the whole of the next conversation, so when Clay eventually
    // quit claude the launcher found a stale request and relaunched instead of
    // exiting — a session that would not close.
    let result = flip.apply(request, session.sessionId);
    while (result.kind === 'parked') {
        session.client.sendSessionEvent({ type: 'message', message: result.note });
        // say(), not announce(): a park runs with NO claude child, so this
        // terminal is the one surface that can show anything for the next few
        // hours, and it was the one surface a park never wrote to. Every trip
        // round this loop says it again, and apply() words the repeat as an
        // answer to whoever asked — pressing prefix+F into a park used to
        // reprint the identical sentence, which reads as the key doing
        // nothing. That silence, not the parking, is what wedged Clay.
        flip.say(result.note);
        await flip.park(result.until, result.account.name);
        // The ledger has moved on, so ask again. `take()` first, in case a
        // human flipped by hand while we were parked — their choice wins.
        request = flip.take() ?? { account: null, reason: 'cooldown expired', by: 'auto' };
        result = flip.apply(request, session.sessionId);
    }

    if (result.kind === 'refused') {
        // Say why, in the session, and carry on where we are. A refused flip
        // must never take the session down with it.
        session.client.sendSessionEvent({ type: 'message', message: result.note });
        flip.say(result.note);
        resetAbort();
        return true;
    }

    // Point the next spawn at the new account. claudeLocal merges these over
    // process.env, so this is all it takes — and DROVER_ACCOUNT travels with
    // it so anything downstream reading the stamp agrees.
    //
    // The AMBIENT account is reached by unsetting CLAUDE_CONFIG_DIR, not by
    // setting it to ~/.claude: Claude Code reads its global config from
    // `join(CLAUDE_CONFIG_DIR || homedir(), '.claude.json')`, so pointing the
    // variable at ~/.claude silently swaps the file holding the OAuth account
    // for an empty one and the flip lands in the first-run wizard. An empty
    // string is what claudeLocal's env merge understands as "not set" — see
    // the delete there — because `undefined` in a spread survives as a key.
    const next: Record<string, string> = {
        ...session.claudeEnvVars,
        DROVER_ACCOUNT: result.account.name,
    };
    next.CLAUDE_CONFIG_DIR = result.account.ambient ? '' : result.account.configDir;
    session.claudeEnvVars = next;

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
    scanner.setClaudeConfigDir(result.account.configDir);

    session.pendingInitialPrompt = result.prompt;
    if (!result.resume) {
        // Nothing was ever said, so there is no transcript in the new account
        // to resume from. Clearing the id makes the next spawn a clean start
        // rather than a --resume against a file that does not exist there.
        session.clearSessionId();
    }

    // Keep the app honest about which account is doing the work now.
    //
    // `summary`, not just `name`: the phone's session title reads
    // metadata.summary.text and falls back to the literal "New chat" —
    // getSessionName in happy-app/sources/utils/sessionUtils.ts — so stamping
    // only `name` renamed the session everywhere EXCEPT the screen Clay was
    // looking at. Both are restamped, and both only while they are still
    // default-shaped, so a title Claude Code or the app wrote outlives a flip
    // instead of collapsing back into a path.
    const flippedName = defaultSessionName(session.path, result.account.name);
    session.client.updateMetadata((metadata) => ({
        ...metadata,
        droverAccount: result.account.name,
        name: isDefaultSessionName(metadata.name, session.path) ? flippedName : metadata.name,
        summary: isDefaultSessionName(metadata.summary?.text, session.path)
            ? { text: flippedName, updatedAt: Date.now() }
            : metadata.summary,
    }));
    session.client.sendSessionEvent({ type: 'message', message: result.note });
    flip.say(result.note);
    logger.debug(`[local]: flipped to ${result.account.name}, relaunching with --resume ${session.sessionId}`);

    resetAbort();
    return true;
}

export async function claudeLocalLauncher(session: Session): Promise<LauncherResult> {

    let scannerMessageChain = Promise.resolve();

    // Create scanner. It reads the account the session is on NOW, which after
    // an earlier flip is not the one this process was started on: the launcher
    // is re-entered on every local/remote switch, and only session.claudeEnvVars
    // remembers the move. Empty means the ambient account, whose transcripts
    // still live in ~/.claude, so it maps to that rather than falling back to
    // the wrapper's stale CLAUDE_CONFIG_DIR.
    const startingConfigDir = session.claudeEnvVars?.CLAUDE_CONFIG_DIR;
    const scanner = await createSessionScanner({
        sessionId: session.sessionId,
        workingDirectory: session.path,
        claudeConfigDir: startingConfigDir === undefined
            ? undefined
            : (startingConfigDir || ambientDataDir()),
        onMessage: (message) => {
            // Cattle Drover (BASED-98): local mode has no typed rate-limit
            // channel — the SDK's rate_limit_event only exists on the remote
            // path — so the transcript is where a usage limit becomes visible.
            session.flip?.noteTranscriptMessage(message);
            // Block SDK summary messages - we generate our own
            if (message.type !== 'summary') {
                scannerMessageChain = scannerMessageChain.then(async () => {
                    try {
                        await session.client.sendClaudeSessionMessageFromLocalTranscript(message);
                    } catch (error) {
                        logger.debug('[local]: failed to send Claude transcript message', error);
                    }
                });
            }
        }
    });
    
    // Register callback to notify scanner when session ID is found via hook
    // This is important for --continue/--resume where session ID is not known upfront
    //
    // BASED-98: whatever is on disk when the FIRST SessionStart hook of this
    // run fires is HISTORY, not activity — this process's child has written
    // nothing yet. Pre-mark it, or the scanner streams the whole transcript to
    // the phone as fresh user prompts. Only what is on disk at that instant is
    // marked, so everything Claude appends afterwards still flows, and later
    // hooks (/compact, a fork) are new content and are left alone. Judged by
    // "first hook", never by id, so a Claude that forks on resume is covered.
    //
    // The entry paths, and where the history is at that first hook:
    //
    //   fresh start                   nothing on disk — this is a no-op
    //   --resume <id>, reattach hit   on disk AND on the server already
    //   --resume <id>, reattach miss  on disk; fresh Happy session, so replaying
    //                                 it just refills a chat nobody asked for
    //   --resume  (bare picker)       on disk; the id does not exist until this
    //                                 very hook, so reattach cannot run at all
    //   --continue                    on disk, same as an explicit --resume
    //   local -> remote -> local      n/a: session.sessionId is set by then, so
    //                                 createSessionScanner's own constructor
    //                                 marks the file and the hook is a no-op
    //   fork / side chat              n/a: runClaude seeds the scanner with the
    //                                 forked id and owns the backfill itself
    //   flip                          MUST NOT pre-mark — see setClaudeConfigDir
    //                                 in sessionScanner.ts. The carried file is
    //                                 re-read from the top on purpose, because
    //                                 what Claude appended between the last poll
    //                                 and the kill is still unsent, and marking
    //                                 it eats exactly those messages. A flip
    //                                 relaunches INSIDE the loop below, always
    //                                 past the first hook, so it cannot get here.
    //
    // This was gated on the reattach path alone, which covered row 2 and
    // nothing else. Clay ran bare `drover --resume` (row 4) repeatedly against
    // a 190 MB transcript and got days of old messages restreamed every time.
    let firstHookIsHistory = session.sessionId === null
        && (session.reattachedClaudeSessionId !== undefined
            || resumesExistingTranscript(session.claudeArgs));
    const scannerSessionCallback = (sessionId: string) => {
        const treatExistingAsProcessed = firstHookIsHistory;
        firstHookIsHistory = false;
        scanner.onNewSession(sessionId, treatExistingAsProcessed ? { treatExistingAsProcessed } : undefined);
    };
    session.addSessionFoundCallback(scannerSessionCallback);


    // Handle abort
    let exitReason: LauncherResult | null = null;
    let switchRequested = false;
    // `let`, not `const`: a Cattle Drover flip aborts the child on purpose and
    // then needs a FRESH controller for the replacement, because an aborted
    // signal stays aborted and would kill the new child on spawn.
    let processAbortController = new AbortController();
    let exutFuture = new Future<void>();
    try {
        async function abort() {

            // Send abort signal
            if (!processAbortController.signal.aborted) {
                processAbortController.abort();
            }

            // Await full exit
            await exutFuture.promise;
        }

        async function doAbort() {
            logger.debug('[local]: doAbort');
            session.onAbort();

            // Switching to remote mode
            if (!exitReason) {
                exitReason = { type: 'switch' };
            }

            session.client.closeClaudeSessionTurn('cancelled');

            // Reset sent messages
            session.queue.reset();

            // Abort
            await abort();
        }

        async function doSwitch() {
            logger.debug('[local]: doSwitch');
            switchRequested = true;
            if (!processAbortController.signal.aborted) {
                processAbortController.abort();
            }
        }

        // When to abort
        session.client.rpcHandlerManager.registerHandler('abort', doAbort); // Abort current process, clean queue and switch to remote mode
        session.client.rpcHandlerManager.registerHandler('switch', doSwitch); // When user wants to switch to remote mode

        // A flip stops the child the same way a switch does — the difference
        // is what happens next, and that is decided below rather than here.
        session.flip?.setAbortHandler(() => {
            if (!processAbortController.signal.aborted) processAbortController.abort();
        });

        session.queue.setOnMessage((message: string, _mode) => {
            // `/flip` from the app is a command to this launcher, not a turn
            // for Claude — so it is handled here and never forwarded. It is
            // also the only trigger that needs no app changes at all, which
            // matters because the shipped TestFlight build predates all this.
            const flipCommand = session.flip ? parseFlipCommand(message) : null;
            if (flipCommand && session.flip) {
                session.flip.request(flipCommand);
                return;
            }
            // Remote messages request control from the app. Stop local Claude
            // so queued app messages can be picked up by remote mode now.
            void doSwitch();
        });

        // Exit if there are messages in the queue
        if (session.queue.size() > 0) {
            return { type: 'switch' };
        }

        // Handle session start
        const handleSessionStart = (sessionId: string) => {
            session.onSessionFound(sessionId);
            scanner.onNewSession(sessionId);
        }

        // Run local mode
        while (true) {
            // If we already have an exit reason, return it
            if (exitReason) {
                return exitReason;
            }

            // Launch
            logger.debug('[local]: launch');
            try {
                const initialPrompt = session.pendingInitialPrompt;
                session.pendingInitialPrompt = undefined;
                await claudeLocal({
                    path: session.path,
                    sessionId: session.sessionId,
                    onSessionFound: handleSessionStart,
                    onThinkingChange: session.onThinkingChange,
                    abort: processAbortController.signal,
                    claudeEnvVars: session.claudeEnvVars,
                    claudeArgs: session.claudeArgs,
                    mcpServers: session.mcpServers,
                    allowedTools: session.allowedTools,
                    hookSettingsPath: session.hookSettingsPath,
                    sandboxConfig: session.sandboxConfig,
                    initialPrompt,
                });

                // Consume one-time Claude flags after spawn
                // For example we don't want to pass --resume flag after first spawn
                session.consumeOneTimeFlags();

                // A flip is checked BEFORE the exit paths, because the child
                // exiting is how a flip announces itself: the controller
                // aborted it deliberately, so this looks exactly like a normal
                // exit until you ask whether a flip is pending.
                if (await applyPendingFlip(session, scanner, () => {
                    processAbortController = new AbortController();
                })) {
                    continue;
                }

                // Normal exit
                if (!exitReason) {
                    session.client.closeClaudeSessionTurn('completed');
                    exitReason = (switchRequested || session.queue.size() > 0)
                        ? { type: 'switch' }
                        : { type: 'exit', code: 0 };
                    break;
                }
            } catch (e) {
                logger.debug('[local]: launch error', e);

                // The child ran and exited, so its one-time flags are spent.
                // The success path above says the same thing; this path never
                // did, and a flip ALWAYS lands here, so the flags Clay typed
                // once were passed to every relaunch.
                //
                // That is what sent a flipped session to Claude's session
                // PICKER instead of the conversation. A session started with
                // `drover --resume` kept that bare `--resume` in claudeArgs,
                // and claudeLocal only strips it when it has no session id of
                // its own — after a flip it does — so the relaunch spawned
                // `--resume <id> … --resume`, and the second, valueless one
                // wins. Measured: 22:57 in 2026-08-28-22-56-09-pid-11422.log
                // relaunched with exactly those args and no SessionStart hook
                // ever arrived, because Claude was sitting on the list.
                //
                // ExitCodeError only: it means the process started and
                // exited. A failure to spawn at all must keep the flags for
                // the retry.
                if (e instanceof ExitCodeError) {
                    session.consumeOneTimeFlags();
                }

                // A flip is checked here TOO, and this is the path that
                // actually matters. Killing an interactive TUI does not
                // produce the tidy signal-exit the success path assumes —
                // Claude comes back through ExitCodeError instead — so a flip
                // checked only above is silently swallowed and the session
                // ends rather than moving accounts. Measured, not theorised:
                // the first live flip died exactly here, logging "request
                // accepted" and then nothing at all.
                if (await applyPendingFlip(session, scanner, () => {
                    processAbortController = new AbortController();
                })) {
                    continue;
                }

                // If Claude exited with non-zero exit code, propagate it
                if (e instanceof ExitCodeError) {
                    if (exitReason) {
                        break; // preserve existing exit reason (e.g. switch intent) — SIGTERM is expected
                    }
                    if (switchRequested || session.queue.size() > 0) {
                        session.client.closeClaudeSessionTurn('failed');
                        exitReason = { type: 'switch' };
                        break;
                    }
                    session.client.closeClaudeSessionTurn('failed');
                    exitReason = { type: 'exit', code: e.exitCode };
                    break;
                }
                if (!exitReason) {
                    session.client.sendSessionEvent({ type: 'message', message: launchFailureMessage(e) });
                    continue;
                } else {
                    break;
                }
            }
            logger.debug('[local]: launch done');
        }
    } finally {

        // Resolve future
        exutFuture.resolve(undefined);

        // Set handlers to no-op
        session.client.rpcHandlerManager.registerHandler('abort', async () => { });
        session.client.rpcHandlerManager.registerHandler('switch', async () => { });
        session.queue.setOnMessage(null);
        
        // Remove session found callback
        session.removeSessionFoundCallback(scannerSessionCallback);

        // Cleanup
        await scanner.cleanup();
        await scannerMessageChain;
    }

    // Return
    return exitReason || { type: 'exit', code: 0 };
}
