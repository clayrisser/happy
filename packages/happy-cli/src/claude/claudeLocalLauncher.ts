import { basename } from "node:path";

import { logger } from "@/ui/logger";
import { claudeLocal, ExitCodeError } from "./claudeLocal";
import { Session } from "./session";
import { Future } from "@/utils/future";
import { createSessionScanner } from "./utils/sessionScanner";
import { launchFailureMessage } from "./utils/launchFailureMessage";
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
async function applyPendingFlip(session: Session, resetAbort: () => void): Promise<boolean> {
    const flip = session.flip;
    const request = flip?.take();
    if (!flip || !request) return false;

    const result = flip.apply(request, session.sessionId);

    if (result.kind === 'refused') {
        // Say why, in the session, and carry on where we are. A refused flip
        // must never take the session down with it.
        session.client.sendSessionEvent({ type: 'message', message: result.note });
        flip.say(result.note);
        resetAbort();
        return true;
    }

    if (result.kind === 'parked') {
        session.client.sendSessionEvent({ type: 'message', message: result.note });
        flip.say(result.note);
        await flip.park(result.until);
        // Waking up is just another flip attempt: the ledger has moved on, so
        // pickTarget now has something to choose. Re-queue and go round again.
        flip.request({ account: null, reason: 'cooldown expired', by: 'auto' });
        resetAbort();
        return true;
    }

    // Point the next spawn at the new account. claudeLocal merges these over
    // process.env, so this is all it takes — and DROVER_ACCOUNT travels with
    // it so anything downstream reading the stamp agrees.
    session.claudeEnvVars = {
        ...session.claudeEnvVars,
        CLAUDE_CONFIG_DIR: result.account.configDir,
        DROVER_ACCOUNT: result.account.name,
    };
    session.pendingInitialPrompt = result.prompt;
    if (!result.resume) {
        // Nothing was ever said, so there is no transcript in the new account
        // to resume from. Clearing the id makes the next spawn a clean start
        // rather than a --resume against a file that does not exist there.
        session.clearSessionId();
    }

    // Keep the app honest about which account is doing the work now.
    session.client.updateMetadata((metadata) => ({
        ...metadata,
        droverAccount: result.account.name,
        name: `[${result.account.name}] ${basename(session.path)}`,
    }));
    session.client.sendSessionEvent({ type: 'message', message: result.note });
    flip.say(result.note);
    logger.debug(`[local]: flipped to ${result.account.name}, relaunching with --resume ${session.sessionId}`);

    resetAbort();
    return true;
}

export async function claudeLocalLauncher(session: Session): Promise<LauncherResult> {

    let scannerMessageChain = Promise.resolve();

    // Create scanner
    const scanner = await createSessionScanner({
        sessionId: session.sessionId,
        workingDirectory: session.path,
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
    const scannerSessionCallback = (sessionId: string) => {
        scanner.onNewSession(sessionId);
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
                if (await applyPendingFlip(session, () => {
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

                // A flip is checked here TOO, and this is the path that
                // actually matters. Killing an interactive TUI does not
                // produce the tidy signal-exit the success path assumes —
                // Claude comes back through ExitCodeError instead — so a flip
                // checked only above is silently swallowed and the session
                // ends rather than moving accounts. Measured, not theorised:
                // the first live flip died exactly here, logging "request
                // accepted" and then nothing at all.
                if (await applyPendingFlip(session, () => {
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
