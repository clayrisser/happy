import { logger } from "@/ui/logger";
import { claudeLocal, ExitCodeError } from "./claudeLocal";
import { applyCustomTitle, resumesExistingTranscript, Session } from "./session";
import { Future } from "@/utils/future";
import { createSessionScanner } from "./utils/sessionScanner";
import { launchFailureMessage } from "./utils/launchFailureMessage";
import { ambientDataDir } from "@/drover/flip/accounts";
import { parseFlipCommand } from "@/drover/flip/controller";
import { injectIntoPaneGated } from "./utils/paneInject";
import { findInbox, sendToInbox } from "./utils/inboxSocket";
import { stageAttachments, withAttachmentNote } from "./utils/stageAttachments";
import type { QueueItem } from "@/utils/MessageQueue2";
import type { EnhancedMode } from "./loop";
import { InFlightTracker, describeInFlight } from "@/drover/flip/inflight";
// The flip itself lives in @/drover/flip/apply because BOTH launchers carry
// one out now (BASED-127). It used to be defined here, which is precisely why
// a flip requested in remote mode queued and never happened.
import { applyPendingFlip, transcriptPathFor } from "@/drover/flip/apply";

export type LauncherResult = { type: 'switch' } | { type: 'exit', code: number };

export async function claudeLocalLauncher(session: Session): Promise<LauncherResult> {

    let scannerMessageChain = Promise.resolve();

    // Text this launcher put into the pane itself (DROVE-41). A phone message
    // goes in through the inbox socket or the keyboard, so Claude Code queues
    // it exactly like a typed one and it comes back to us as a queued-prompt
    // record — but the app is already showing it, because the app is what
    // sent it.
    //
    // Kept for a window rather than taken on the first match, because ONE
    // delivery produces two of those records (the enqueue, then the absorb)
    // and both have to be swallowed. The window is what keeps the list from
    // growing forever and, more importantly, from suppressing a real message:
    // a delivery made while Claude was idle never queues at all, so nothing
    // ever comes back to clear it, and a stale entry would silence the next
    // thing Clay typed that happened to repeat those words.
    const deliveredFromApp: Array<{ text: string, at: number }> = [];
    const deliveredEchoWindowMs = 60_000;

    function pruneDeliveredEchoes() {
        const cutoff = Date.now() - deliveredEchoWindowMs;
        while (deliveredFromApp.length > 0 && deliveredFromApp[0].at < cutoff) {
            deliveredFromApp.shift();
        }
    }

    function noteDeliveredFromApp(text: string) {
        pruneDeliveredEchoes();
        deliveredFromApp.push({ text, at: Date.now() });
    }

    function takeDeliveredEcho(text: string): boolean {
        pruneDeliveredEchoes();
        return deliveredFromApp.some((d) => d.text === text);
    }

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
        onQueuedPrompt: (prompt) => {
            if (takeDeliveredEcho(prompt.text)) {
                logger.debug('[local]: queued prompt is our own delivery coming back — not re-sending it');
                return;
            }
            session.client.sendQueuedPromptFromLocalTranscript(prompt);
        },
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
         * already had and never used: the phone's message stays on the queue —
         * MessageQueue2.push enqueues before it calls the handler — and
         * exitReasonAfterChild turns that into `{type:'switch'}` when the child
         * exits of its own accord. Nothing is dropped; it is served the moment
         * the child is gone. Only reachable for a session with no pane, since a
         * pane session delivers into the pane instead of switching.
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
            // Only an explicit press marks this session as wanting remote
            // (BASED-141). This flag is never cleared anywhere, and doSwitch
            // used to set it before it had even decided whether to abort — so
            // one undeliverable phone message, or one switch deferred behind
            // running subagents, turned every later exit of that session into
            // a takeover. An implicit switch still works: for a session with
            // no pane the queued message it is switching FOR is what the exit
            // path reads.
            if (explicit) switchRequested = true;

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

        // Messages this launcher accepted but could not hand over yet. They
        // stay ON the queue until the spawn that serves them actually starts,
        // so nothing is dropped in between; the queue no longer means "switch"
        // for a pane session, so leaving them there is free.
        let heldForNextSpawn: QueueItem<EnhancedMode>[] = [];

        /**
         * Hold a message for the next child and tell the phone it waited.
         *
         * The pane IS the session, so there is nowhere to switch to when the
         * message cannot go in right now — between spawns, during a flip
         * relaunch, or with the pane parked at a shell. The flip path already
         * carries a prompt across a relaunch this way.
         */
        function holdForNextSpawn(message: string, item?: QueueItem<EnhancedMode>) {
            session.pendingInitialPrompt = session.pendingInitialPrompt
                ? `${session.pendingInitialPrompt}\n${message}`
                : message;
            if (item) heldForNextSpawn.push(item);
            logger.debug('[local]: no live child to take the message — held for the next spawn');
            session.client.sendSessionEvent({
                type: 'message',
                message:
                    'Cattle Drover: nothing is listening in the terminal right now, so your '
                    + 'message is held and goes in the moment Claude is back.',
            });
        }

        /**
         * Hand `message` to the Claude running in our pane.
         *
         * Channel 0 is Claude's own inbox socket: it queues the message inside
         * Claude and serves it between tool calls, so it is safe mid-turn and
         * cannot merge with a half-typed line or answer an open dialog. The
         * pane paste is the fallback for a Claude too old to have a socket, or
         * one whose registry record has gone stale.
         */
        async function deliverToChild(message: string): Promise<boolean> {
            if (!tmuxPane) return false;
            // Recorded before either carrier runs, because Claude Code writes
            // the enqueue record the instant the text lands (DROVE-41).
            noteDeliveredFromApp(message);
            try {
                const configDir = session.claudeEnvVars?.CLAUDE_CONFIG_DIR;
                const inbox = await findInbox(configDir || undefined, session.sessionId, tmuxPane);
                if (inbox) {
                    const outcome = await sendToInbox(inbox, message, inbox.sessionId);
                    if (outcome === 'ok') {
                        logger.debug('[local]: delivered to the inbox socket');
                        return true;
                    }
                    logger.debug(`[local]: inbox socket ${outcome} — falling back to the pane`);
                }
            } catch (err) {
                // Reading the registry must never cost us the message.
                logger.debug('[local]: inbox lookup failed', err);
            }
            // The keystroke path. Enter is pressed only when the gate says
            // Claude is idle at its prompt with nothing pending on the bus;
            // otherwise the text lands as a draft for the human to submit,
            // because a stray Enter merges with a half-typed line or answers
            // an open dialog with whatever is highlighted.
            const result = await injectIntoPaneGated(
                {
                    pane: tmuxPane,
                    configDir: session.claudeEnvVars?.CLAUDE_CONFIG_DIR,
                    claudeSessionId: session.sessionId,
                },
                message,
            );
            if (result.delivered && !result.submitted) {
                logger.debug('[local]: pasted as a draft — Claude was busy or a prompt is pending');
                session.client.sendSessionEvent({
                    type: 'message',
                    message: 'Drafted in the terminal; press Enter there to send it.',
                });
            }
            return result.delivered;
        }

        async function deliverToPaneSession(message: string, item?: QueueItem<EnhancedMode>) {
            if (childAlive && await deliverToChild(message)) {
                // Served. Take it back off the queue, or the launcher will
                // read it later as an unanswered message (BASED-141) and the
                // remote launcher would replay it as a fresh turn.
                if (item) session.queue.remove(item);
                return;
            }
            holdForNextSpawn(message, item);
        }

        /**
         * What a dead child means for the session.
         *
         * A pane session has nowhere to switch TO: the terminal is the session,
         * and remote mode would spawn a second, headless Claude beside the one
         * Clay is looking at. So the child exiting means the session is over,
         * whatever is left on the queue. Only a session with no pane — a
         * daemon-spawned one — can be handed to remote mode, and there the
         * queue is exactly the reason to do it.
         */
        function exitReasonAfterChild(code: number): LauncherResult {
            const pending = session.queue.size();
            if (tmuxPane) {
                if (pending > 0) {
                    logger.debug(`[local]: pane session exiting with ${pending} undelivered message(s) queued`);
                }
                return { type: 'exit', code };
            }
            return (switchRequested || pending > 0)
                ? { type: 'switch' }
                : { type: 'exit', code };
        }

        session.queue.setOnMessage((message: string, _mode, item) => {
            // `/flip` from the app is a command to this launcher, not a turn
            // for Claude — so it is handled here and never forwarded. It is
            // also the only trigger that needs no app changes at all, which
            // matters because the shipped TestFlight build predates all this.
            const flipCommand = session.flip ? parseFlipCommand(message) : null;
            if (flipCommand && session.flip) {
                session.flip.request(flipCommand);
                return;
            }
            // Cattle Drover (BASED-113, BASED-141): if this session lives in a
            // tmux pane, the message goes to the Claude in that pane and the
            // session never changes mode. The pane you are watching IS the
            // session, so a takeover would kill the terminal you are looking at
            // and hide whatever it was doing behind a fresh headless run.
            // Undeliverable right now means "wait for the next child", not
            // "switch": see holdForNextSpawn.
            if (tmuxPane) {
                // DROVE-38: the bytes of a phone image ride the queue item, and
                // both carriers a pane has are text. So they go to disk at the
                // path Claude Code uses for its own pasted images, and the path
                // goes into the text for Claude to Read this turn. Before the
                // hold-for-next-spawn branch too, so a photo sent between
                // children is not lost with the child that was not there.
                const staged = stageAttachments({
                    attachments: item?.attachments,
                    configDir: session.claudeEnvVars?.CLAUDE_CONFIG_DIR || ambientDataDir(),
                    sessionId: session.sessionId ?? 'unknown',
                });
                void deliverToPaneSession(withAttachmentNote(message, staged), item);
                return;
            }
            // No pane: remote mode is the only carrier the app has. Stop local
            // Claude so the queued message can be picked up now — unless
            // subagents are running, in which case doSwitch holds off and the
            // message waits for the child to exit. Not `explicit`: typing a
            // message is not a decision to kill them.
            void doSwitch();
        });

        // Messages that arrived before this launcher took over. For a session
        // with no pane that is a demand for remote mode; for a pane session it
        // is a note in the log, because the exit path no longer reads it.
        if (session.queue.size() > 0) {
            const reason = exitReasonAfterChild(0);
            if (reason.type === 'switch') {
                return reason;
            }
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
                // Anything held for this spawn is in that prompt now, so it
                // comes off the queue here rather than when it arrived — a
                // message that never reached a child is one we still owe.
                if (heldForNextSpawn.length > 0) {
                    for (const held of heldForNextSpawn) session.queue.remove(held);
                    heldForNextSpawn = [];
                }
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
                    // The next spawn carries it as its opening prompt —
                    // appended, because a phone message that arrived while the
                    // child was down is waiting in exactly the same place.
                    deliverPrompt: (prompt) => {
                        session.pendingInitialPrompt = session.pendingInitialPrompt
                            ? `${session.pendingInitialPrompt}\n${prompt}`
                            : prompt;
                    },
                    resetAbort: () => {
                        processAbortController = new AbortController();
                    },
                })) {
                    continue;
                }

                // Normal exit
                if (!exitReason) {
                    session.client.closeClaudeSessionTurn('completed');
                    exitReason = exitReasonAfterChild(0);
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
                    // The next spawn carries it as its opening prompt —
                    // appended, because a phone message that arrived while the
                    // child was down is waiting in exactly the same place.
                    deliverPrompt: (prompt) => {
                        session.pendingInitialPrompt = session.pendingInitialPrompt
                            ? `${session.pendingInitialPrompt}\n${prompt}`
                            : prompt;
                    },
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
                    session.client.closeClaudeSessionTurn('failed');
                    exitReason = exitReasonAfterChild(e.exitCode);
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
