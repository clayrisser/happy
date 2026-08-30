import { logger } from "@/ui/logger";
import { claudeLocal, ExitCodeError } from "./claudeLocal";
import { applyCustomTitle, resumesExistingTranscript, Session } from "./session";
import { Future } from "@/utils/future";
import { createSessionScanner } from "./utils/sessionScanner";
import { launchFailureMessage } from "./utils/launchFailureMessage";
import { ambientDataDir } from "@/drover/flip/accounts";
import { parseFlipCommand } from "@/drover/flip/controller";
import { injectIntoPane } from "./utils/paneInject";
import { InFlightTracker, describeInFlight } from "@/drover/flip/inflight";
// The flip itself lives in @/drover/flip/apply because BOTH launchers carry
// one out now (BASED-127). It used to be defined here, which is precisely why
// a flip requested in remote mode queued and never happened.
import { applyPendingFlip, transcriptPathFor } from "@/drover/flip/apply";

export type LauncherResult = { type: 'switch' } | { type: 'exit', code: number };

export async function claudeLocalLauncher(session: Session): Promise<LauncherResult> {

    let scannerMessageChain = Promise.resolve();

    // A switch that doSwitch held back because subagents were running. Taken
    // the moment the last one reports in, so the deferral costs the rest of
    // the agents' run rather than the rest of the session.
    let deferredSwitch = false;
    let takeDeferredSwitch: (() => void) | null = null;

    // Who is still running inside the child (BASED-135). Stopping the child is
    // a SIGTERM, and async subagents live INSIDE it, so every abort below has
    // to ask this first. See inflight.ts for why it also tails the transcript
    // itself rather than trusting the scanner alone.
    const inflight = new InFlightTracker({
        transcript: () => transcriptPathFor(session),
        onIdle: () => takeDeferredSwitch?.(),
    });

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
        onCustomTitle: (title) => applyCustomTitle(session, title),
        onMessage: (message) => {
            // Cattle Drover (BASED-98): local mode has no typed rate-limit
            // channel — the SDK's rate_limit_event only exists on the remote
            // path — so the transcript is where a usage limit becomes visible.
            session.flip?.noteTranscriptMessage(message);
            // BASED-135: the same stream carries "Async agent launched
            // successfully" and, sometimes, the notification that ends it.
            inflight.note(message);
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

    // Is a Claude child in the foreground of our pane RIGHT NOW? Gates
    // pane-injection (BASED-113): between spawns, or during a park, the pane is
    // a shell prompt and a phone message must not be typed into it. Set around
    // the one `await claudeLocal` below, the only window a child is live.
    let childAlive = false;

    // The tmux pane this session is running in, if any. `$TMUX_PANE` is set for
    // every process started inside a pane, so a drover session launched from a
    // key binding or a normal shell has it; a daemon-spawned one does not, and
    // that absence is exactly the signal to keep using remote mode for it.
    const tmuxPane = process.env.TMUX_PANE;
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

        /**
         * A second explicit switch inside this window forces the abort even
         * with subagents running. Long enough to be a deliberate second press,
         * short enough that it cannot be a press from ten minutes ago.
         */
        const switchConfirmMs = 30_000;
        let switchAskedAt = 0;

        /**
         * Stop local claude so remote mode can take the session over.
         *
         * BASED-135: this used to be an unconditional abort, which is a
         * SIGTERM to the child, and async subagents live inside that child.
         * Clay routinely runs 4-12 at once and lost them to a mode switch
         * repeatedly. Their partial work survives on disk, but the COMPLETION
         * NOTIFICATION does not: it arrives later as its own transcript
         * record, so a resumed session reads as though every agent launched
         * fine and then never reported. Silently.
         *
         * So with anything in flight we take the DEFERRED path the launcher
         * already had and never used: `switchRequested` alone is enough, and
         * the loop below turns it into `{type:'switch'}` when the child exits
         * of its own accord (:380-382 and :429-433). The phone's message is
         * already in the queue by the time we get here — MessageQueue2.push
         * enqueues before it calls this handler — so nothing is dropped, it is
         * served the moment the child is gone.
         *
         * The cost is honest and worth naming: the switch does not happen
         * until claude exits. Two ways out, and the announcement says both —
         * press the same switch again within 30s, or hit stop, which is
         * `doAbort` and is deliberately NOT gated. Stop means stop.
         *
         * @param explicit the user pressing "switch to remote", rather than a
         *   phone message arriving. Only an explicit press can confirm: two
         *   messages typed in quick succession are not a demand to kill eight
         *   agents, and treating them as one is exactly this bug again.
         */
        async function doSwitch(explicit = false) {
            logger.debug('[local]: doSwitch');
            switchRequested = true;

            const busy = inflight.snapshot();
            if (busy.count > 0) {
                const now = Date.now();
                const confirming = explicit && now - switchAskedAt < switchConfirmMs;
                if (!confirming) {
                    if (explicit) switchAskedAt = now;
                    deferredSwitch = true;
                    logger.debug(
                        `[local]: switch deferred, ${busy.count} subagent(s) in flight: ${busy.ids.join(', ')}`,
                    );
                    session.client.sendSessionEvent({
                        type: 'message',
                        message:
                            `Cattle Drover: holding the switch to remote — ${describeInFlight(busy)}. ` +
                            'Stopping local Claude now would kill them and lose their completion ' +
                            'notifications silently, so the switch happens when this turn\'s Claude ' +
                            'exits. Anything you send is queued and served then. To take over NOW ' +
                            'and accept the loss: press switch again within 30s, or press stop.',
                    });
                    return;
                }
                logger.debug(`[local]: switch confirmed, abandoning ${busy.count} subagent(s)`);
                session.client.sendSessionEvent({
                    type: 'message',
                    message:
                        `Cattle Drover: switching to remote anyway — ${describeInFlight(busy)} ` +
                        'will not report back. Their partial work is under ' +
                        'tasks/<agentId>.output in this session\'s scratch directory.',
                });
                switchAskedAt = 0;
            }

            deferredSwitch = false;
            if (!processAbortController.signal.aborted) {
                processAbortController.abort();
            }
        }

        // The last subagent reported in and a switch was waiting on exactly
        // that. Take it now rather than making Clay quit claude to get his
        // phone answered.
        takeDeferredSwitch = () => {
            if (!deferredSwitch) return;
            deferredSwitch = false;
            logger.debug('[local]: subagents finished, taking the deferred switch');
            session.client.sendSessionEvent({
                type: 'message',
                message: 'Cattle Drover: subagents finished — switching to remote now.',
            });
            if (!processAbortController.signal.aborted) {
                processAbortController.abort();
            }
        };

        // When to abort
        session.client.rpcHandlerManager.registerHandler('abort', doAbort); // Abort current process, clean queue and switch to remote mode
        // The user pressing "switch to remote": explicit, so a second press
        // inside 30s overrides the subagent hold above.
        session.client.rpcHandlerManager.registerHandler('switch', () => doSwitch(true));

        // A flip stops the child the same way a switch does — the difference
        // is what happens next, and that is decided below rather than here.
        session.flip?.setAbortHandler(() => {
            if (!processAbortController.signal.aborted) processAbortController.abort();
        });

        // ...and the controller decides whether to stop it at all, which it
        // cannot do without knowing who is still running in there (BASED-135).
        // Handed as a probe rather than the tracker itself so the controller
        // stays a pure decision-maker with no idea a transcript exists.
        session.flip?.setInFlightProbe(() => inflight.snapshot());

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
            // Cattle Drover (BASED-113): if this session is a live Claude in a
            // tmux pane, type the phone's message straight into that pane
            // instead of switching to remote mode. The pane you are watching IS
            // the session — same `$TMUX_PANE` the flip keys use — so the
            // message lands as if typed at the desk, no takeover, no new
            // session, and whatever is running (subagents included) stays on
            // screen. injectIntoPane declines when the pane is gone or parked at
            // a shell, and the switch below is the fallback for exactly that and
            // for sessions with no pane at all.
            if (tmuxPane && childAlive) {
                void injectIntoPane(tmuxPane, message).then((delivered) => {
                    if (!delivered) {
                        logger.debug('[local]: pane injection declined — switching to remote');
                        void doSwitch();
                    }
                });
                return;
            }
            // Remote messages request control from the app. Stop local Claude
            // so queued app messages can be picked up by remote mode now —
            // unless subagents are running, in which case doSwitch holds off
            // and the queued message waits for the child to exit. Not
            // `explicit`: typing a message is not a decision to kill them.
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
                // Fresh child, fresh count. Cleared HERE rather than on exit
                // so the flip below can still name the agents it stranded, and
                // so an entry we never managed to resolve cannot jam the gate
                // for the rest of the session.
                inflight.reset();
                // ...and a hold that belonged to the child that just died must
                // not fire against its replacement.
                deferredSwitch = false;
                // A child is about to be in the foreground of our pane; phone
                // messages may be typed into it now rather than switching to
                // remote (BASED-113). Cleared in `finally` so a parked or
                // between-spawns pane, which is a shell, never gets typed into.
                childAlive = true;
                try {
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
                } finally {
                    // The child is no longer in the foreground — whether it
                    // exited cleanly or threw, the pane is back to a shell (or
                    // about to relaunch), so injection must stop here.
                    childAlive = false;
                }

                // Consume one-time Claude flags after spawn
                // For example we don't want to pass --resume flag after first spawn
                session.consumeOneTimeFlags();

                // A flip is checked BEFORE the exit paths, because the child
                // exiting is how a flip announces itself: the controller
                // aborted it deliberately, so this looks exactly like a normal
                // exit until you ask whether a flip is pending.
                if (await applyPendingFlip({
                    session,
                    mode: 'local',
                    scanner,
                    // The next spawn carries it as its opening prompt.
                    deliverPrompt: (prompt) => { session.pendingInitialPrompt = prompt; },
                    resetAbort: () => {
                        processAbortController = new AbortController();
                    },
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
                if (await applyPendingFlip({
                    session,
                    mode: 'local',
                    scanner,
                    // The next spawn carries it as its opening prompt.
                    deliverPrompt: (prompt) => { session.pendingInitialPrompt = prompt; },
                    resetAbort: () => {
                        processAbortController = new AbortController();
                    },
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
        // The tracker dies with this launcher call; the controller outlives it.
        session.flip?.setInFlightProbe(null);
        // ...and so does the abort handler, which closes over an
        // AbortController that is already aborted by the time we get here
        // (BASED-127). Left registered, that dead closure IS the controller's
        // idea of how to stop the child for the whole of the next remote turn:
        // FlipController.request() called it, nothing happened, and the flip
        // queued until the session came back to local mode. Each launcher owns
        // the handler for exactly as long as it owns a child.
        session.flip?.setAbortHandler(null);
        takeDeferredSwitch = null;

        // Remove session found callback
        session.removeSessionFoundCallback(scannerSessionCallback);

        // Cleanup
        await scanner.cleanup();
        await scannerMessageChain;
    }

    // Return
    return exitReason || { type: 'exit', code: 0 };
}
