import { logger } from "@/ui/logger";
import { createDotPublisher } from "@/drover/dotPublish";
import { claudeLocal, ExitCodeError } from "./claudeLocal";
import { applyCustomTitle, resumesExistingTranscript, Session } from "./session";
import { Future } from "@/utils/future";
import { createSessionScanner } from "./utils/sessionScanner";
import { compactionLatch } from "./utils/compaction";
import { launchFailureMessage } from "./utils/launchFailureMessage";
import { ambientDataDir } from "@/drover/flip/accounts";
import { parseFlipCommand } from "@/drover/flip/controller";
import { capturePane, injectIntoPane, interruptPane, paneAcceptsCommand, paneIsIdle, pressPaneKey, registryStatus } from "./utils/paneInject";
import { paneCommandKind, paneCommandOutcome, paneUltracodeActive } from "./utils/paneCommandOutcome";
import { creditsSafeRow, paneCreditsDialog, type PaneCreditsDialog } from "./utils/paneCreditsDialog";
import { answerPaneCreditsRow } from "./utils/paneCreditsAnswer";
import { creditsGateName, creditsLedgerVerdict, openPaneCreditsGate } from "./utils/paneCreditsGate";
import { noteGate } from "@/drover/gateLedger";
import { createPaneCommandQueue, paneCommandArgument, paneCommandsForSelection, paneModelAsRequest, paneSlashCommand, parseRemoteControlRequest, remoteControlCommand, type PaneModelSelection } from "./utils/paneModelSync";
import { cyclePaneMode, panePermissionAsRequest, pressCycleKey, readPaneMode, readPaneModeChip, type PaneMode } from "./utils/panePermissionSync";
import { isPermissionMode, mapToClaudeMode } from "./utils/permissionMode";
// DROVE-232: a relaunch is a fresh Claude Code, and a fresh Claude Code reads
// its model and effort out of the config dir rather than out of the session it
// is continuing. Both halves of the answer -- the argv that makes it boot right
// and the reconcile that catches what the argv did not land -- live here.
import { modeCarryArgs, modeReconcileCommands, type ModeObservation, type ModeRequest } from "./utils/modeCarry";
import { findInbox, sendToInbox, wrapForPane } from "./utils/inboxSocket";
import {
    noteMessageDelivered,
    noteMessageUndelivered,
    undeliveredExplanation,
    type UndeliveredReason,
} from "@/drover/messageLedger";
import { stageAttachments, withAttachmentNote } from "./utils/stageAttachments";
import type { QueueItem } from "@/utils/MessageQueue2";
import type { EnhancedMode } from "./loop";
import { InFlightTracker, describeInFlight } from "@/drover/flip/inflight";
import { AgentLaunchIndex, agentStopResult } from "./utils/agentNotification";
// The flip itself lives in @/drover/flip/apply because BOTH launchers carry
// one out now (BASED-127). It used to be defined here, which is precisely why
// a flip requested in remote mode queued and never happened.
import { applyPendingFlip, transcriptPathFor } from "@/drover/flip/apply";
// DROVE-172: a session keeps running the bundle node read at spawn, so a
// shipped CLI fix reached the daemon and none of Clay's open sessions. The
// launcher watches its own dist and hands the session to the new one between
// turns.
import { announceRelaunch } from "@/drover/relaunch/announce";
import { startRelaunchGate, type RelaunchGate } from "@/drover/relaunch/gate";
import { relaunchExitCode, relaunchIsHandover } from "@/drover/relaunch/handover";
import { loadedDistStamp, distEntrypoint, distEntryIsComplete, readDistStamp } from "@/drover/relaunch/stamp";
import { createStaleWatcher } from "@/drover/relaunch/staleWatcher";

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

    // DROVE-115: which Agent tool call each background agent belongs to, so
    // the terminal tool-call-end below can be addressed to the card that has
    // been drawing "Running" since the launch receipt. Fed off the same
    // message stream inflight reads.
    const agentLaunches = new AgentLaunchIndex();

    // Create scanner. It reads the account the session is on NOW, which after
    // an earlier flip is not the one this process was started on: the launcher
    // is re-entered on every local/remote switch, and only session.claudeEnvVars
    // remembers the move. Empty means the ambient account, whose transcripts
    // still live in ~/.claude, so it maps to that rather than falling back to
    // the wrapper's stale CLAUDE_CONFIG_DIR.
    const startingConfigDir = session.claudeEnvVars?.CLAUDE_CONFIG_DIR;

    /**
     * Whether Remote Control is on in the pane, per the transcript (DROVE-63).
     * null until the scanner has read a `bridge-session` record — and the
     * toggle is never typed on a null, because it is a toggle.
     */
    let observedRemoteControl: boolean | null = null;
    /**
     * Re-decide whether `/remote-control` still needs typing. Assigned for real
     * once the pane command queue exists further down; a no-op until then
     * because the scanner reports the transcript's current state DURING its own
     * construction, which is before that queue is built. The first observation
     * only has to be recorded, never acted on.
     */
    let reconcileRemoteControl: () => void = () => { };

    // Is an API call in flight right now? claudeLocal reports it off fd 3
    // (fetch-start / fetch-end), and it is the one fact the transcript cannot
    // supply: while the model composes a reply nothing is written to disk at
    // all, which is exactly the "Sketching… 17m 13s" the app used to render as
    // the word "online" (DROVE-54). Wrapped rather than replaced, because the
    // session's own keep-alive is the other consumer.
    let thinking = false;
    const onThinkingChange = (next: boolean) => {
        thinking = next;
        session.onThinkingChange(next);
    };

    // DROVE-247: the terminal's dot. Created here rather than inside the
    // scanner because it reads `thinking` above, which is this scope's.
    const dotPublisher = createDotPublisher(() => session.sessionId);

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
        // DROVE-45: what the pane is ACTUALLY running, so the phone's picker
        // stops showing a stored preference instead. This is also the whole
        // pane -> app direction: `/model` typed in the terminal changes the
        // model on the next turn's transcript entry, and that is what the app
        // reads. Only for a pane session — a paneless local run has no
        // terminal for anyone to type `/model` into.
        onRunObserved: process.env.TMUX_PANE
            ? (run) => {
                // DROVE-164: the transcript cannot say `ultracode`. Claude Code
                // runs it as xhigh with dynamic workflows beside it and records
                // `"effort":"xhigh"` with no field to tell the two apart, so the
                // one and only place ultracode is written down is the composer's
                // top rule. Read it whenever the transcript claims xhigh, and a
                // `/effort ultracode` Clay typed at his own keyboard reaches the
                // phone as Ultracode instead of snapping it to xHigh.
                void (async () => {
                    let effort = run.effort;
                    if (effort === 'xhigh') {
                        const capture = await capturePane(process.env.TMUX_PANE!);
                        if (capture !== null && paneUltracodeActive(capture)) effort = 'ultracode';
                    }
                    observedRun = { model: run.model, effort };
                    session.client.updateMetadata((metadata) => ({
                        ...metadata,
                        paneModel: run.model,
                        paneEffort: effort,
                    }));
                    reconcilePaneModes();
                    // After the reconcile, never before it: the reconcile is
                    // the one place the app's standing request is allowed to
                    // beat the pane (DROVE-164), and mirroring first would
                    // erase the very difference it exists to apply.
                    mirrorPaneIntoRequest();
                })();
            }
            : undefined,
        // DROVE-36: the same half, for the permission mode. Clay had Yolo
        // selected in the composer while the pane asked for permission on
        // every call, and the app had no way at all to know what the pane was
        // actually in — the composer was showing its own stored pick. This is
        // also how a shift+tab typed at the keyboard reaches the phone.
        //
        // DROVE-199: and the observation now feeds the REQUEST as well as the
        // pill. Reporting only `panePermissionMode` left `permissionMode`
        // standing on whatever the app last picked, which is the field the
        // app's own change test and this launcher's delta both run against —
        // so a mode moved at the keyboard made the phone's next tap on that
        // row a no-op twice over. See reportPanePermissionMode.
        onPermissionModeObserved: process.env.TMUX_PANE
            ? (mode) => { void reportPanePermissionMode(mode); }
            : undefined,
        // DROVE-63: and whether Remote Control is on, from the same file, for
        // the same reason — the app's toggle has to show what is TRUE, so that
        // `/remote-control` typed in the terminal (or a DROVE-37 teardown that
        // nobody typed at all) reaches the phone. Pane sessions only: a
        // paneless run has no terminal to type the toggle into.
        onRemoteControlObserved: process.env.TMUX_PANE
            ? (active) => {
                observedRemoteControl = active
                session.client.updateMetadata((metadata) => ({
                    ...metadata,
                    paneRemoteControl: active,
                }))
                // An observation can make a queued toggle wrong: the terminal
                // may have done the very thing the app asked for while the
                // command was still waiting for an idle prompt.
                reconcileRemoteControl()
            }
            : undefined,
        // DROVE-54: the running tool, the background agents and the workflows,
        // so the app shows the same task tree the terminal does instead of a
        // green dot. Not gated on TMUX_PANE — a paneless local run is still a
        // real Claude writing the same files, and the app is still the only
        // place Clay can watch it from.
        isThinking: () => thinking,
        // DROVE-257: and whether a COMPACTION is running, which no amount of
        // reading the disk can tell you while it happens. The latch is opened
        // by the `PreCompact` hook (runClaude wires the hook server to it) and
        // closed by the `compact_boundary` record this same reader tails.
        compaction: compactionLatch,
        onLiveStatus: (liveStatus) => {
            session.client.updateMetadata((metadata) => ({
                ...metadata,
                liveStatus,
            }))
            // DROVE-247: and the same facts to the drover bus, so the TERMINAL
            // can draw the dot the phone has drawn since DROVE-231. The three
            // terms are the strip's own (`AgentInputStatusRow`): the snapshot's
            // `main`, the fd 3 thinking counter for the seconds before a
            // snapshot exists, and a compaction — which is the main thread
            // working and the one state nothing else reports. Publishes only
            // when the state moves; see dotPublish.ts.
            const mainWorking = !!liveStatus?.main || thinking || !!liveStatus?.compacting
            dotPublisher.sync({
                mainWorking,
                toolRunning: !!liveStatus?.main && !!liveStatus.tool,
                compacting: !!liveStatus?.compacting,
            })
            // DROVE-340: the same boolean is the only turn boundary local mode
            // has. Its working-to-idle edge is a turn ending, which is when
            // the account's usage has certainly moved and when Clay looks at
            // the card, so the reporter goes and asks rather than waiting out
            // its thirty-second floor. The edge is detected in the reporter,
            // beside the rest of the cadence.
            session.usage?.noteLiveStatus(mainWorking)
        },
        // DROVE-115: an async agent's tool call ended the instant it launched,
        // so its card had no way to learn the agent had finished and sat on
        // "Running, quiet for 40m" for as long as the session lived. This is
        // the completion, sent as the terminal result for that same call.
        onAgentNotification: (notification) => {
            if (!notification.terminal) return;
            const launch = agentLaunches.get(notification.agentId);
            const call = notification.toolUseId ?? launch?.toolUseId;
            if (!call) {
                // Nothing to address it to. The agent screen still reads the
                // truth off the transcript, so the card is the only thing left
                // stale — the same place DROVE-110 left it, not worse.
                logger.debug(`[local]: agent ${notification.agentId} reported ${notification.status} but no tool call is known for it`);
                return;
            }
            session.client.sendClaudeAgentStop({
                call,
                ...agentStopResult(notification, launch),
                ...(notification.at ? { at: notification.at } : {}),
            });
            agentLaunches.forget(notification.agentId);
        },
        onMessage: (message) => {
            // Cattle Drover (BASED-98): local mode has no typed rate-limit
            // channel — the SDK's rate_limit_event only exists on the remote
            // path — so the transcript is where a usage limit becomes visible.
            session.flip?.noteTranscriptMessage(message);
            // DROVE-47: a turn ending or a limit notice landing is when the
            // usage cache is likeliest to have moved. Coalesced inside, so a
            // turn's worth of lines costs one look.
            session.usage?.refresh();
            // BASED-135: the same stream carries "Async agent launched
            // successfully" and, sometimes, the notification that ends it.
            inflight.note(message);
            // DROVE-115: the launch record is where the agent id and its Agent
            // tool call are named in the same place.
            agentLaunches.note(message);
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
        },
        // DROVE-78: `/goal` writes a goal_status record into the transcript,
        // and that record is the only thing that ever says what the goal IS.
        // runClaude keeps the goal state for both modes so the app sees one
        // card whichever launcher is running; this scanner is the one that
        // follows a flip, so without it the card froze on the account the
        // wrapper happened to start on.
        onTranscriptEvent: (event) => session.onGoalStatusEvent?.(event),
    });

    // DROVE-93: the agent screen on the phone asks for a subagent's transcript
    // over the session RPC channel and polls with the cursor it got back. This
    // scanner is the one that follows a flip, so it answers rather than the
    // remote-mode scanner runClaude registered at startup.
    session.client.rpcHandlerManager.registerHandler('subagentTranscript', async (params: unknown) =>
        scanner.readSubagentTranscript((params ?? {}) as Parameters<typeof scanner.readSubagentTranscript>[0]));

    // DROVE-290: the wave view of one workflow run, same channel, same
    // flip-following scanner.
    session.client.rpcHandlerManager.registerHandler('workflowDetail', async (params: unknown) =>
        scanner.readWorkflowDetail((params ?? {}) as Parameters<typeof scanner.readWorkflowDetail>[0]));

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
    //                                 very hook, so reattach cannot run at all.
    //                                 Under drover this row is unreachable
    //                                 since DROVE-50: bin/drover's own picker
    //                                 resolves the id first and hands us row 2.
    //                                 Still here for a plain, unwrapped run.
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
    /**
     * The app -> pane half of DROVE-45.
     *
     * The phone's model and effort pickers write `modelMode` /
     * `effortLevel` into session metadata, and until now the only thing
     * that ever read them was the SDK path, which hands them to query().
     * A pane has no query(), so the pick was silently ignored: Clay's
     * composer said "Fable 5 - Ultracode" while /status in the pane read
     * claude-opus-5[1m].
     *
     * The pane's own way in is `/model <name>` and `/effort <level>`, both
     * real commands in 2.1.251, and the app's keys are already exactly what
     * they take. So this types them.
     *
     * NOT through the idle gate any more (DROVE-164). That gate never opened:
     * a session Clay is actually working is never idle, and his log for
     * 2026-08-31 has `/effort max` queued at 05:40:59 and still waiting at
     * 08:06. The picker's commands take the weaker `paneAcceptsCommand` — pane
     * alive, no dialog on screen, input box empty — which is the property that
     * was ever at stake, and Claude Code runs the command mid-turn without
     * complaint. A slash command Clay TYPED on the phone (DROVE-49) keeps the
     * strict gate.
     */
    const paneCommands = createPaneCommandQueue({
        isIdle: () => paneIsIdle({
            pane: tmuxPane!,
            configDir: session.claudeEnvVars?.CLAUDE_CONFIG_DIR,
            claudeSessionId: session.sessionId,
        }),
        accepts: () => paneAcceptsCommand({
            pane: tmuxPane!,
            configDir: session.claudeEnvVars?.CLAUDE_CONFIG_DIR,
            claudeSessionId: session.sessionId,
        }),
        // Only the phone's own slash commands ask for this (DROVE-49). The
        // model/effort picker does not, because Clay runs 4–12 agents at a
        // time and a picker held for the length of that run reads as broken.
        agentsQuiet: () => inflight.count() === 0,
        send: async (command) => {
            if (!childAlive) return false;
            // DROVE-36 rides this queue but not this carrier. 2.1.251 has no
            // slash command for the permission mode (measured — see
            // panePermissionSync.ts), so its pick is applied by cycling
            // shift+tab and reading the footer back. Routed by the `#` sigil
            // rather than by a name, so a pseudo command this launcher has not
            // learned yet is REFUSED instead of typed at the prompt.
            if (!command.startsWith('/')) {
                if (command.startsWith('#permission-mode ')) {
                    return applyPanePermissionMode(command.slice('#permission-mode '.length));
                }
                logger.debug(`[local]: no carrier for pane command ${command} — dropping it`);
                return true;
            }
            const kind = paneCommandKind(command);
            if (kind === null) {
                // A slash command Clay typed on the phone. Nothing to read
                // back — the TUI's answer to `/clear` is the whole screen.
                const ok = await injectIntoPane(tmuxPane!, command, { submit: true });
                if (ok) notePaneCommandApplied(command);
                return ok;
            }
            return applyPaneSelectionCommand(command, kind);
        },
    });

    /**
     * How long the TUI gets to repaint its footer after a shift+tab.
     *
     * The cycle re-reads the pane after every press, so this is the whole cost
     * of a wrong guess: too short and we read the old chip and press again,
     * landing a mode past the one we wanted.
     */
    const paneCycleSettleMs = 150;

    /**
     * Put the pane into `mode`, and say so on the phone once it is there.
     *
     * Returns false only for a keystroke that did not go in or a prompt we
     * could not see — the two cases worth retrying. A mode this session will
     * not give (bypass disabled by policy, auto behind its flag) returns TRUE:
     * the request was carried out as far as it can be, and re-queuing it every
     * two seconds would press shift+tab at Clay's prompt forever.
     */
    async function applyPanePermissionMode(mode: string): Promise<boolean> {
        // Narrowed upstream, not here: the only producer of this string is
        // paneModeFor, which runs the app's key through isPermissionMode and
        // mapToClaudeMode. And cyclePaneMode never acts on the value anyway —
        // it only compares it to what it reads back off the pane.
        //
        // The watcher is held off for the length of the cycle (DROVE-199). It
        // reads the same footer this loop is pressing against, and a read
        // landing between a press and its settle would report a mode that is
        // on its way somewhere else — then mirror it into the request and
        // cancel the very pick being applied.
        cyclingPermissionMode = true;
        let outcome: Awaited<ReturnType<typeof cyclePaneMode>>;
        try {
            outcome = await cyclePaneMode(mode as PaneMode, {
                read: () => readPaneMode(tmuxPane!),
                press: () => pressCycleKey(tmuxPane!),
                settle: () => new Promise((r) => setTimeout(r, paneCycleSettleMs)),
            });
        } finally {
            cyclingPermissionMode = false;
        }
        if (outcome === 'applied') {
            logger.debug(`[local]: pane is now in permission mode ${mode}`);
            await reportPanePermissionMode(mode, true);
            return true;
        }
        if (outcome === 'unreachable') {
            // Said out loud rather than logged. A pick that cannot happen and
            // reports nothing is the complaint DROVE-36 is about, one level up.
            logger.debug(`[local]: ${mode} is not available in this session's cycle`);
            session.client.sendSessionEvent({
                type: 'message',
                message: `Cattle Drover: this session cannot switch to ${mode} — `
                    + 'it is not in the terminal\'s permission-mode cycle (disabled by '
                    + 'settings or policy). The pane is back on the mode it was in.',
            });
            // And stop ASKING for it (DROVE-199, the same rule DROVE-191 wrote
            // for a refused `/effort`). The cycle walked the pane back to where
            // it started, so the request has to follow it there; leaving
            // `permissionMode: "bypassPermissions"` standing after the session
            // said no is a false value the app renders nowhere and this
            // launcher would read as a pick still outstanding.
            const settled = await readPaneMode(tmuxPane!);
            if (settled !== null) await reportPanePermissionMode(settled, true);
            return true;
        }
        logger.debug(`[local]: could not reach the prompt to set ${mode} (${outcome}) — retrying later`);
        return false;
    }

    /**
     * Write down the mode the pane is in, and make the app's request agree
     * with it (DROVE-199).
     *
     * One place, three callers: the transcript's own per-turn record, the
     * footer watcher below, and the cycle when it settles. Only ever called
     * with a mode that was READ or CONFIRMED, never with one that was merely
     * asked for.
     */
    async function reportPanePermissionMode(mode: string, applying = false): Promise<void> {
        observedPermissionMode = mode;
        session.client.updateMetadata((metadata) => ({
            ...metadata,
            panePermissionMode: mode,
        }));
        // DROVE-232: reconcile BEFORE mirroring, for the reason the reconcile's
        // own header gives. The footer watcher runs on its own 2s poll rather
        // than off the transcript, so for the permission mode this is the path
        // that gets there first, and the mirror it used to call straight into
        // is what wrote a relaunch's default over the request.
        if (!applying) reconcilePaneModes();
        mirrorPanePermissionIntoRequest(applying);
    }

    /**
     * How often the pane's footer is re-read for the permission mode
     * (DROVE-199).
     *
     * The transcript is the wrong source for this one fact and the scanner
     * says so in its own docs: Claude Code appends a `permission-mode` record
     * as part of the state block around every PROMPT, so a shift+tab pressed
     * at an idle prompt writes nothing at all and the phone's padlock stayed
     * on the previous turn's mode until Clay sent another message. The footer
     * says it the moment the key is pressed, which is why the carrier already
     * reads it. Same interval as the command retry, which is well inside the
     * "within a turn" the ticket asks for and is one `tmux capture-pane` — the
     * gate already runs one of those on the same cadence whenever anything is
     * queued.
     */
    const panePermissionPollMs = 2000;
    let panePermissionTimer: NodeJS.Timeout | null = null;
    /** True while cyclePaneMode is pressing. See applyPanePermissionMode. */
    let cyclingPermissionMode = false;

    /**
     * Read the footer and report a mode that moved without us.
     *
     * The CHIP only, and only while a Claude child is in the foreground of the
     * pane. Both guards are the same lesson, measured on a live run: the `❯`
     * fallback that reads an absent chip as manual mode is right at a gated
     * prompt and wrong on a timer, because the folder-trust dialog and a shell
     * prompt both draw a `❯` and no chip. The first version of this watcher
     * reported `default` for a session that came up in `auto`, and the mirror
     * dutifully wrote that into the request.
     */
    async function watchPanePermissionMode(): Promise<void> {
        if (!tmuxPane || !childAlive || cyclingPermissionMode) return;
        const mode = await readPaneModeChip(tmuxPane);
        if (mode === null || mode === observedPermissionMode) return;
        logger.debug(`[local]: the pane's permission mode is ${mode} — reporting it`);
        await reportPanePermissionMode(mode);
    }

    /** True from the moment a credits gate is raised until its row is typed. */
    let creditsGateBusy = false;

    /**
     * The Fable credits dialog, on the same footer timer (DROVE-279).
     *
     * It has to be a WATCHER and not just an outcome of `/model`, because the
     * dialog Clay actually hits is the mid-session one: he is halfway through a
     * turn, the week's included Fable usage runs out, and Claude Code draws
     * "You've reached your Fable 5 limit" with nobody having typed anything.
     * Nothing polls the pane on that path, so the dialog sits there, and
     * `paneAcceptsCommand` — which now refuses while it is up — holds every
     * queued command behind it. That is the strand Clay described.
     *
     * Reads and hands off. It never answers, and there is nothing in this
     * function or below it that presses a key at a dialog it has not read off
     * the screen on the same tick.
     */
    async function watchPaneCreditsDialog(): Promise<void> {
        if (!tmuxPane || !childAlive || creditsGateBusy) return;
        // Its own capture rather than one shared with the footer watcher: that
        // watcher's seam is `readPaneModeChip`, and pulling the capture up out
        // of it to save a `tmux capture-pane` every two seconds would move a
        // seam DROVE-199's tests hold, to buy a subprocess. The two reads look
        // at disjoint parts of the screen anyway — a footer chip and a dialog,
        // which are never both there.
        const capture = await capturePane(tmuxPane);
        if (capture === null) return;
        const dialog = paneCreditsDialog(capture);
        // Null is "nothing answerable on screen" and covers the spinner steps
        // this dialog opens on ("Checking usage credits…"). Two seconds later
        // the timer looks again, and the queue stays held meanwhile because
        // paneAcceptsCommand matches on the TITLE rather than on the rows.
        if (dialog === null) return;
        creditsGateBusy = true;
        try {
            await runPaneCreditsGate(dialog);
        } catch (e) {
            // A throw here would leave the latch set and the dialog forever
            // unasked. Nothing below is allowed to be the reason a pane stays
            // stranded.
            logger.debug('[local]: the credits gate threw:', e);
        } finally {
            creditsGateBusy = false;
        }
    }

    /**
     * Ask Clay which row, then type THAT row. Never a default, never a guess.
     *
     * The three outcomes and what each one costs:
     *
     *   - he picks a row: it is typed. If the row he picked spends money, he
     *     spent it, which is the only way this dialog is ever allowed to spend
     *     anything.
     *   - nobody answers inside the budget: the SAFE row is typed — the
     *     component's own decline, identified by its text rather than by its
     *     position — and both halves of DROVE-239's trail are written: the
     *     ledger says `unanswered-safe-row` and the withdrawal on the bus says
     *     `gate-timeout:fable-credits`, so `endedBy.by` names us instead of
     *     the anonymous "producer".
     *   - the safe row cannot be recognised: Escape, which is the dialog's own
     *     onCancel. Dismissed, nothing consented to, nothing bought.
     *
     * Every one of the three ends with the dialog off the screen, which is
     * what unblocks the pane queue.
     */
    async function runPaneCreditsGate(dialog: PaneCreditsDialog): Promise<void> {
        logger.debug(`[local]: ${dialog.title} is on screen — asking rather than answering`);
        session.client.sendSessionEvent({
            type: 'message',
            message: `Cattle Drover: the terminal is asking "${dialog.title}". Pick a row on your phone — nothing is bought until you do.`,
        });
        const outcome = await openPaneCreditsGate({
            dialog,
            sessionId: session.sessionId ?? null,
            cwd: process.cwd(),
            account: session.client.getMetadata()?.droverAccount ?? null,
            surface: tmuxPane ?? null,
        });
        const safe = creditsSafeRow(dialog);
        // The ONLY two labels that can be typed: one a human named, or the one
        // this side identified as the decline. Null means Escape.
        const label = outcome.pick === 'row' ? outcome.label : (safe?.label ?? null);
        if (outcome.pick === 'safe') {
            logger.debug(`[local]: nobody answered the credits gate (${outcome.reason}) — taking ${label ?? 'Escape'}`);
        }
        const result = await answerPaneCreditsRow(
            {
                capture: () => capturePane(tmuxPane!),
                press: (key) => pressPaneKey(tmuxPane!, key),
                settle: (ms) => new Promise<void>((r) => setTimeout(r, ms)),
            },
            label,
        );
        // Said out loud on the phone, not just logged. A dialog that answered
        // itself while Clay was not looking is exactly what has to be visible.
        const said =
            result.state === 'typed'
                ? outcome.pick === 'row'
                    ? `Cattle Drover: typed "${result.label}" in the terminal.`
                    : `Cattle Drover: nobody answered "${dialog.title}", so the terminal took the safe row "${result.label}". Nothing was bought.`
                : result.state === 'dismissed'
                    ? `Cattle Drover: dismissed "${dialog.title}" without buying anything — ${result.reason}.`
                    : result.state === 'gone'
                        ? `Cattle Drover: "${dialog.title}" closed in the terminal before an answer landed.`
                        : `Cattle Drover: could not answer "${dialog.title}" — ${result.reason}. Nothing was typed.`;
        session.client.sendSessionEvent({ type: 'message', message: said });
        // DROVE-239's split, in this gate's words: `-remotely` is a human
        // having decided, anything else is this process having decided FOR
        // him. That distinction is the whole reason the ledger exists, and it
        // has to survive without the bus's memory.
        noteGate('question', creditsGateName, creditsLedgerVerdict(outcome, result));
        if (result.state === 'stuck') {
            logger.debug(`[local]: the credits dialog is still up: ${result.reason}`);
        }
    }

    /**
     * The toggle half of what used to be one optimistic write.
     *
     * `/remote-control` carries no value and prints no result line worth
     * parsing. It is a toggle and we only ever type it when we know the current
     * state differs from the request, so the state after it lands is the
     * opposite of what we observed (DROVE-63).
     */
    function notePaneCommandApplied(command: string): void {
        if (command !== '/remote-control') return;
        const next = !(observedRemoteControl ?? false);
        observedRemoteControl = next;
        session.client.updateMetadata((metadata) => ({
            ...metadata,
            paneRemoteControl: next,
        }));
    }

    /** How long the TUI gets to answer a `/model` or `/effort`, and how often we look. */
    const paneOutcomeTimeoutMs = 8000;
    const paneOutcomePollMs = 300;

    /**
     * Type `/model` or `/effort` and then READ THE PANE BACK (DROVE-164).
     *
     * "tmux accepted the keystrokes" was the old proof, and it was worth
     * nothing. Measured against 2.1.251, three things happen to a command that
     * was typed perfectly, and the app was told all three had worked:
     *
     *   - a "Change effort level? / Switch model?" confirmation goes up and
     *     waits for an Enter nobody was pressing. This is EVERY effort change
     *     made at an idle prompt on a conversation with history, which is to
     *     say every one Clay ever made from his phone;
     *   - Claude Code refuses in words: an org cap, a model that cannot reach
     *     xhigh, a launch-effort pin, a model name it does not know;
     *   - `/effort ultracode` succeeds but is recorded as `xhigh`, because
     *     ultracode is xhigh plus workflows rather than a sixth level.
     *
     * So this presses the Enter, reports the refusal to the phone in Claude
     * Code's own words, and writes back what the pane actually settled on.
     */
    async function applyPaneSelectionCommand(command: string, kind: 'effort' | 'model'): Promise<boolean> {
        const before = (await capturePane(tmuxPane!)) ?? '';
        if (!(await injectIntoPane(tmuxPane!, command, { submit: true }))) return false;

        let confirmed = false;
        const deadline = Date.now() + paneOutcomeTimeoutMs;
        while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, paneOutcomePollMs));
            const after = await capturePane(tmuxPane!);
            if (after === null) {
                // No screen to read is not a slow answer, it is no answer.
                // Polling another twenty-six times will not conjure a tmux.
                logger.debug(`[local]: cannot read ${tmuxPane} back after ${command}`);
                return true;
            }
            const outcome = paneCommandOutcome(before, after, kind);
            if (outcome.state === 'credits') {
                // NOT the confirm arm below, and the difference is money
                // (DROVE-279). `watchPaneCreditsDialog` is already on the same
                // 2s timer and owns this dialog, so this returns rather than
                // racing it — two writers on one pane interleave their
                // keystrokes, and one of this dialog's rows is a purchase.
                logger.debug(`[local]: ${command} raised the Fable credits dialog — the gate owns it, not this loop`);
                return true;
            }
            if (outcome.state === 'confirm') {
                // Answered only because we READ our own dialog first and know
                // "Yes" is the highlighted row. A blind Enter at a pane is the
                // DROVE-80 mistake; this is the panePermissionSync pattern.
                if (confirmed) continue;
                confirmed = true;
                logger.debug(`[local]: ${command} raised the confirmation — answering it`);
                await pressPaneKey(tmuxPane!, 'Enter');
                continue;
            }
            if (outcome.state === 'refused') {
                logger.debug(`[local]: the pane refused ${command}: ${outcome.message}`);
                rollBackPaneSelection(kind);
                // Said out loud rather than logged. A pick that silently does
                // nothing is the whole of DROVE-164.
                session.client.sendSessionEvent({
                    type: 'message',
                    message: `Cattle Drover: the terminal would not take ${command} — ${outcome.message}`,
                });
                await reportPaneRun();
                // DROVE-191: and stop ASKING for it. Rolling back `paneSelection`
                // alone left `effortLevel: "turbo"` standing on the server after
                // the pane had said no, so the request field was a lie the app
                // showed nowhere and the next metadata event would have retyped.
                mirrorPaneIntoRequest(kind);
                return true;
            }
            if (outcome.state === 'applied') {
                if (outcome.kept) {
                    // "Kept model as X" is the pane saying the switch did NOT
                    // happen, so the word in it names the model we were trying
                    // to leave. Treated as a refusal without the shouting.
                    logger.debug(`[local]: the pane kept its model instead of taking ${command}`);
                    rollBackPaneSelection(kind);
                    mirrorPaneIntoRequest(kind);
                    return true;
                }
                logger.debug(`[local]: the pane took ${command} (${outcome.value})`);
                // The ARGUMENT, not the pane's answer, for a model (DROVE-191).
                // Claude Code answers in display names and everything else in
                // this system speaks model ids; see paneCommandArgument.
                await reportPaneRun(kind, kind === 'model' ? paneCommandArgument(command) : outcome.value);
                mirrorPaneIntoRequest(kind);
                return true;
            }
        }
        // Nothing recognisable came back. Do NOT claim it landed: the scanner
        // reports the real run within a turn, and a stale chip for one turn is
        // cheaper than a chip that is confidently wrong.
        logger.debug(`[local]: no answer from the pane for ${command} — leaving the chip to the transcript`);
        return true;
    }

    /** A pick the pane refused was never applied, so stop believing it was. */
    function rollBackPaneSelection(kind: 'effort' | 'model'): void {
        if (kind === 'effort') paneSelection = { ...paneSelection, effortLevel: observedRun.effort ?? undefined };
        else paneSelection = { ...paneSelection, modelMode: observedRun.model ?? undefined };
    }

    /**
     * Write what the pane is on NOW into metadata, reading the screen for the
     * one fact the transcript cannot carry.
     *
     * `/effort ultracode` leaves `"effort":"xhigh"` in the JSONL and no field
     * that says ultracode, so a session set to Ultracode reported xHigh and the
     * chip snapped back — read as the app refusing the pick (DROVE-101). The
     * composer's top rule says `── ultracode ─` while it is on, and that is the
     * only place the truth is written down.
     */
    async function reportPaneRun(kind?: 'effort' | 'model', value?: string | null): Promise<void> {
        if (kind === 'model') {
            const model = value === 'default' || value === undefined ? null : value;
            observedRun = { ...observedRun, model };
            session.client.updateMetadata((metadata) => ({ ...metadata, paneModel: model }));
            return;
        }
        // The command's own word is authoritative when there is one: Claude
        // Code printed `Set effort level to ultracode` and there is nothing the
        // screen can add to that. The rule is only consulted when we are
        // reporting the run WITHOUT having just set it — after a refusal —
        // where `xhigh` on screen may really be ultracode.
        let effort = kind === 'effort'
            ? (value === 'auto' || value === undefined ? null : value)
            : (observedRun.effort ?? null);
        if (kind === undefined && effort === 'xhigh') {
            const capture = await capturePane(tmuxPane!);
            if (capture !== null && paneUltracodeActive(capture)) effort = 'ultracode';
        }
        observedRun = { ...observedRun, effort };
        session.client.updateMetadata((metadata) => ({ ...metadata, paneEffort: effort }));
    }

    /** How often a held command re-checks whether the prompt opened up. */
    const paneCommandRetryMs = 2000;
    let paneCommandTimer: NodeJS.Timeout | null = null;

    /**
     * Drain now, and keep a slow retry running for as long as anything is
     * still held. A timer only while there is work: an idle pane session
     * costs nothing, which matters because the scanner's own poll already
     * had to be taught not to burn a core on this file.
     */
    function pumpPaneCommands(): void {
        void paneCommands.flush().then(() => {
            if (paneCommands.pending().length === 0) {
                if (paneCommandTimer) {
                    clearInterval(paneCommandTimer);
                    paneCommandTimer = null;
                }
                return;
            }
            if (!paneCommandTimer) {
                paneCommandTimer = setInterval(pumpPaneCommands, paneCommandRetryMs);
                paneCommandTimer.unref?.();
            }
        });
    }

    /**
     * The picks we believe the pane is already on. Seeded from the metadata
     * this launcher booted with, so a reconnect — or the CLI's own
     * metadata writes coming back round — does not retype `/model` at the
     * prompt for a model that never changed.
     */
    let paneSelection: PaneModelSelection = tmuxPane
        ? {
            modelMode: session.client.getMetadata()?.modelMode,
            effortLevel: session.client.getMetadata()?.effortLevel,
            permissionMode: paneModeFor(session.client.getMetadata()?.permissionMode),
        }
        : {};

    /**
     * The app's permission key as a mode the pane understands (DROVE-36).
     *
     * mapToClaudeMode is the ONE place Codex's vocabulary is folded into
     * Claude's — `yolo` is bypass, `safe-yolo` and `read-only` are default —
     * so the composer's Yolo row lands on bypassPermissions here rather than on
     * a second copy of that table. An unknown string from a newer app is
     * dropped rather than guessed at: undefined means "no pick", which the
     * queue reads as nothing to do.
     */
    function paneModeFor(picked: string | null | undefined): string | null | undefined {
        if (picked === undefined) return undefined;
        if (picked === null) return null;
        if (!isPermissionMode(picked)) {
            logger.debug(`[local]: app asked for permission mode ${picked}, which this CLI does not know`);
            return undefined;
        }
        return mapToClaudeMode(picked);
    }

    /**
     * What the app last asked Remote Control to be (DROVE-63).
     *
     * Held separately from the model/effort picks because it is compared
     * against the OBSERVED state rather than against the previous request. A
     * toggle has no memory: what matters is where the pane is now, not what was
     * asked for last time.
     */
    /** What the pane is observed to be running, from the transcript or a slash command it took (DROVE-77). */
    let observedRun: { model?: string | null; effort?: string | null } = {};

    /**
     * The permission mode the pane is observed to be in (DROVE-36/DROVE-199).
     * A Claude mode, never an app key. `undefined` means nothing has been read
     * yet, which is the one state that must not be compared against: it is not
     * the same as "the pane is on default".
     */
    let observedPermissionMode: string | undefined = undefined;

    let requestedRemoteControl: boolean | null = tmuxPane
        ? parseRemoteControlRequest(session.client.getMetadata()?.remoteControl)
        : null;

    reconcileRemoteControl = () => {
        if (!tmuxPane) return;
        const command = remoteControlCommand(observedRemoteControl, requestedRemoteControl);
        if (!command) {
            // The terminal may have got there first, or the app may have asked
            // and then changed its mind while the pane was busy. Either way a
            // waiting toggle would now break what it was meant to fix.
            paneCommands.cancel('/remote-control');
            return;
        }
        logger.debug(`[local]: app wants Remote Control ${requestedRemoteControl ? 'on' : 'off'} — queueing ${command}`);
        paneCommands.request([command]);
        pumpPaneCommands();
    };

    /**
     * The session is about to spawn a REPLACEMENT child (DROVE-232).
     *
     * Called on every spawn after the first, which in practice means a flip or
     * a crash-restart; DROVE-220's CLI relaunch arrives as a whole new process
     * and gets the same treatment for free, because a new process starts here
     * anyway. Three things have to be true before the new Claude comes up:
     *
     *   the reconcile is armed again      it is latched per child, and the old
     *                                     child spent it.
     *   the observations are dropped      `paneModel` / `paneEffort` /
     *                                     `panePermissionMode` describe a pane
     *                                     that no longer exists. Leaving them
     *                                     standing means the composer draws a
     *                                     dead process's effort, and the app's
     *                                     own change test runs against it. Null
     *                                     is the honest answer until the new
     *                                     child says otherwise, and the app
     *                                     falls back to the REQUEST for the
     *                                     gap, which is the value Clay picked.
     *   the wait is declared              `modeReapplyAt` tells the phone this
     *                                     session is re-applying, so DROVE-217
     *                                     can draw the controls amber while it
     *                                     happens instead of letting a value
     *                                     appear and then change under him.
     */
    function noteModeReapply(): void {
        if (!tmuxPane) return;
        armModeReconcile();
        observedRun = {};
        observedPermissionMode = undefined;
        session.client.updateMetadata((metadata) => ({
            ...metadata,
            paneModel: null,
            paneEffort: null,
            panePermissionMode: null,
            modeReapplyAt: Date.now(),
        }));
        logger.debug('[local]: relaunching — carrying the session modes onto the new child and re-applying what it does not take');
    }

    /**
     * Take the wait down once the new child has spoken and agrees.
     *
     * Only ever narrows: a marker left standing costs an amber control for the
     * 45 seconds the app bounds it by, and the app settles on the pane agreeing
     * whatever this field says. Clearing it is tidiness, not correctness.
     */
    function settleModeReapply(observed: ModeObservation): void {
        if (session.client.getMetadata()?.modeReapplyAt == null) return;
        const spoken = observed.model !== undefined
            || observed.effort !== undefined
            || observed.permissionMode !== undefined;
        if (!spoken) return;
        session.client.updateMetadata((metadata) => ({ ...metadata, modeReapplyAt: null }));
    }

    /**
     * WHICH FIELDS ARE ARMED AT LAUNCHER START, AND WHY IT IS NOT ALL THREE.
     *
     * A launcher starting up is attaching to a pane whose Claude Code has been
     * running: its model is the TRUTH and the stored request may be months
     * stale, which is why DROVE-191 mirrors the pane into the request there
     * rather than retyping. A launcher relaunching a CHILD is the opposite case
     * -- the process is seconds old and its model came out of a config file, so
     * the request is the truth and the pane is the thing that is wrong.
     *
     * Effort is armed at start anyway, and that is not an inconsistency: it is
     * DROVE-164, where a pick made while the CLI was down never reached the
     * pane at all because only a metadata DELTA applied one. Model and
     * permission mode are NOT, because arming them would make a `/model` typed
     * at Clay's own keyboard get typed straight back at him -- the exact loop
     * DROVE-191 exists to prevent.
     */
    let modeReconciled = { model: true, effort: false, permissionMode: true };
    function armModeReconcile(): void {
        modeReconciled = { model: false, effort: false, permissionMode: false };
    }
    /** The three picks as metadata holds them right now. */
    function requestedModes(): ModeRequest {
        const metadata = session.client.getMetadata();
        return {
            modelMode: metadata?.modelMode,
            effortLevel: metadata?.effortLevel,
            permissionMode: metadata?.permissionMode,
        };
    }
    /**
     * Once per CHILD, when the pane's real modes are first known: are they what
     * the app asked for (DROVE-164, widened by DROVE-232)?
     *
     * `paneSelection` is seeded from the app's OWN request, on the reasoning
     * that a reconnect should not retype a pick that never changed. The cost is
     * that a pick made while the CLI was down, or one that a crash or a
     * relaunch interrupted, is assumed to have landed and is never typed at all
     * -- the only thing that ever applies a mode is a metadata DELTA. Remote
     * Control has had a start-up reconcile since DROVE-63; this is the same one.
     *
     * DROVE-232 changed two things about it, and both were the same bug seen
     * from different ends.
     *
     * PER CHILD, NOT PER LAUNCHER. A flip does not restart the launcher, it
     * respawns the child inside it (drover/flip/apply.ts), so the old
     * once-a-launcher latch was already spent by the time the new account's
     * Claude came up and the reconcile never ran for the one case it was most
     * needed in. `armModeReconcile()` clears it on every spawn after the first.
     *
     * ALL THREE FIELDS, NOT JUST EFFORT. Effort was the only one reconciled
     * because the model could not be compared against a transcript that cannot
     * tell `claude-opus-5` from `claude-opus-5[1m]`. `paneHoldsRequest` folds
     * that variant the way the app's own `paneAgrees` does, so the comparison
     * terminates and the model and the permission mode can join.
     *
     * IT RUNS BEFORE THE MIRROR, and that ordering is the whole fix. The mirror
     * exists to follow the pane when Clay moves it at his keyboard, and it
     * cannot tell that apart from a relaunch landing on another account's
     * default -- so left to itself it wrote `high` over `effortLevel: max` and
     * the request was gone rather than merely unapplied. Reconciling first
     * queues the command, and a queued command of that kind suppresses the
     * mirror for that field, so the request survives long enough to be applied
     * or to be REFUSED out loud.
     */
    function reconcilePaneModes(): void {
        if (!tmuxPane) return;
        // Only fields the pane has actually spoken about are in play, and each
        // is latched the first time it speaks. A field the pane has never
        // reported keeps waiting; a field that was reconciled and refused must
        // not be retyped on the next observation forever.
        const observed: ModeObservation = {
            ...(modeReconciled.model ? {} : { model: observedRun.model }),
            ...(modeReconciled.effort ? {} : { effort: observedRun.effort }),
            ...(modeReconciled.permissionMode ? {} : { permissionMode: observedPermissionMode }),
        };
        if (observedRun.model !== undefined) modeReconciled.model = true;
        if (observedRun.effort !== undefined) modeReconciled.effort = true;
        if (observedPermissionMode !== undefined) modeReconciled.permissionMode = true;

        const request = requestedModes();
        const commands = modeReconcileCommands(request, observed);
        if (commands.length === 0) {
            // Everything the pane has spoken about agrees, so nothing is
            // outstanding on those fields any more.
            settleModeReapply(observed);
            return;
        }
        logger.debug(`[local]: the pane came up on modes the app did not ask for — queueing ${commands.join(', ')}`);
        // Record the intent in the same breath, or the next metadata event
        // would read the pane's value as a fresh pick and fight this.
        if (commands.some((c) => c.startsWith('/model '))) {
            paneSelection = { ...paneSelection, modelMode: request.modelMode };
        }
        if (commands.some((c) => c.startsWith('/effort '))) {
            paneSelection = { ...paneSelection, effortLevel: request.effortLevel };
        }
        if (commands.some((c) => c.startsWith('#permission-mode '))) {
            paneSelection = { ...paneSelection, permissionMode: paneModeFor(request.permissionMode) };
        }
        for (const command of commands) {
            paneCommands.request([command], { allowWhileBusy: true });
        }
        pumpPaneCommands();
    }

    /**
     * Make the app's stored REQUEST agree with what the pane is running
     * (DROVE-191).
     *
     * `paneModel` and `paneEffort` have tracked the terminal since DROVE-45,
     * and the app renders those, so the pill was right. `modelMode` was not:
     * it stayed on whatever the app last picked, and both the app's "did this
     * change?" test and this launcher's own delta ran against it. Clay typed
     * `/model claude-sonnet-5` at his keyboard, metadata read
     * `{"modelMode":"claude-opus-5[1m]","paneModel":"claude-sonnet-5"}`, the
     * row correctly showed Sonnet 5, and tapping Opus 5 [1M] wrote nothing and
     * emitted no frame, because the app already believed it was on Opus.
     *
     * Mirroring the pane INTO the request is the direction that does not loop.
     * Reconciling the other way — retyping `/model` because the transcript
     * disagrees — is what `claudeLocalLauncher` has always refused to do, since
     * the transcript cannot tell `claude-opus-5` from `claude-opus-5[1m]` and
     * every launch would retype forever. Here the same ambiguity costs nothing:
     * `paneModelAsRequest` keeps a bracket variant the pane cannot contradict,
     * and everything else follows the pane.
     *
     * `applying` names the command being carried out right now, whose queue
     * entry has not been shifted off yet. Any OTHER queued command is a pick
     * still on its way to the prompt, and mirroring over it would cancel the
     * very thing that is waiting.
     */
    function mirrorPaneIntoRequest(applying?: 'effort' | 'model'): void {
        if (!tmuxPane) return;
        const queued = paneCommands.pending();
        const waitingFor = (kind: 'effort' | 'model') =>
            kind !== applying && queued.some((c) => c.startsWith(`/${kind} `));
        const metadata = session.client.getMetadata();
        const patch: { modelMode?: string | null; effortLevel?: string | null } = {};
        if (observedRun.model !== undefined && !waitingFor('model')) {
            const wanted = paneModelAsRequest(observedRun.model ?? null, metadata?.modelMode);
            if (wanted !== (metadata?.modelMode ?? null)) patch.modelMode = wanted;
        }
        if (observedRun.effort !== undefined && !waitingFor('effort')) {
            const wanted = observedRun.effort ?? null;
            if (wanted !== (metadata?.effortLevel ?? null)) patch.effortLevel = wanted;
        }
        if (Object.keys(patch).length === 0) return;
        // Kept in step with the write, or the next metadata event would read
        // its own mirror as a fresh pick and type it back at the prompt.
        paneSelection = { ...paneSelection, ...patch };
        logger.debug(`[local]: the pane moved under the app's request — mirroring ${JSON.stringify(patch)}`);
        session.client.updateMetadata((m) => ({ ...m, ...patch }));
    }

    /**
     * The same mirror, for the permission mode (DROVE-199).
     *
     * Separate from the one above rather than a third branch inside it because
     * the two do not share a vocabulary. `modelMode` and `effortLevel` are the
     * same strings the pane speaks; `permissionMode` is an APP key that
     * `paneModeFor` folds into a Claude mode, so `paneSelection` and the
     * metadata field hold different values for the same choice and mixing them
     * is how `yolo` would end up rewritten to `bypassPermissions` for nothing.
     *
     * A `#permission-mode` still waiting in the queue suppresses it, for the
     * DROVE-191 reason: that command IS the request, on its way to the prompt,
     * and mirroring the mode it is about to leave would cancel it.
     */
    function mirrorPanePermissionIntoRequest(applying = false): void {
        if (!tmuxPane || observedPermissionMode === undefined) return;
        // `applying` names the `#permission-mode` being carried out right now,
        // whose queue entry has not been shifted off yet. Any OTHER one still
        // waiting is a pick on its way to the prompt, and mirroring over it
        // would cancel the very thing that is queued.
        if (!applying && paneCommands.pending().some((c) => c.startsWith('#permission-mode '))) return;
        const metadata = session.client.getMetadata();
        const wanted = panePermissionAsRequest(observedPermissionMode, metadata?.permissionMode);
        if (wanted === undefined || wanted === (metadata?.permissionMode ?? null)) return;
        // Kept in step with the write, in the pane's own vocabulary, or the
        // next metadata event would read this mirror as a fresh pick and press
        // shift+tab at Clay's prompt for a mode it is already in.
        paneSelection = { ...paneSelection, permissionMode: paneModeFor(wanted) };
        logger.debug(`[local]: the pane's permission mode moved under the app's request — mirroring ${wanted}`);
        session.client.updateMetadata((m) => ({ ...m, permissionMode: wanted }));
    }

    const onMetadataChanged = (metadata: { modelMode?: string | null, effortLevel?: string | null, permissionMode?: string | null, remoteControl?: unknown } | null) => {
        if (!tmuxPane || !metadata) return;
        const next: PaneModelSelection = {
            modelMode: metadata.modelMode,
            effortLevel: metadata.effortLevel,
            permissionMode: paneModeFor(metadata.permissionMode),
        };
        // DROVE-63 rides this same signal: one metadata event, one idle gate,
        // one queue. Deliberately not a second carrier. It runs BEFORE the
        // early return below, because a metadata write that only moves the
        // toggle leaves `commands` empty and must still be acted on.
        requestedRemoteControl = parseRemoteControlRequest(metadata.remoteControl);
        reconcileRemoteControl();
        // DROVE-77: a pick that names what the pane is ALREADY running is not
        // a change, it is Clay's own terminal command coming back. He typed
        // /model and /effort at the keyboard, the scanner reported the run,
        // the app wrote the same values into modelMode/effortLevel, and the
        // metadata event queued `/model claude-fable-5` and `/effort ultracode`
        // to be typed back into his prompt. Only the config-dir bug this
        // commit also fixes kept the idle gate from ever letting them through.
        // Compared against the OBSERVED run, not the previous request, and a
        // command already waiting for that value is withdrawn too.
        //
        // DROVE-191 turns the same comparison the other way up. `paneSelection`
        // remembers the last value the app asked for, and `commandFor` types
        // nothing when the new pick equals it — so a pick that matches a stale
        // request but NOT the pane sent no command at all. That is the "model
        // switching does nothing" path: `/model` typed at the keyboard, a flip,
        // or DROVE-187's limit downgrade moves the pane, the app still holds
        // the old request, and tapping the model it holds is a no-op twice
        // over. So the OBSERVED run decides both ways: matching it withdraws
        // the command, and differing from it forces one out even when the
        // request has not moved.
        if (next.modelMode !== undefined && observedRun.model !== undefined) {
            if (paneModelAsRequest(observedRun.model ?? null, next.modelMode) === next.modelMode) {
                paneCommands.cancel('/model');
                next.modelMode = paneSelection.modelMode;
            } else {
                paneSelection = { ...paneSelection, modelMode: undefined };
            }
        }
        if (next.effortLevel !== undefined && observedRun.effort !== undefined) {
            if (next.effortLevel === (observedRun.effort ?? null)) {
                paneCommands.cancel('/effort');
                next.effortLevel = paneSelection.effortLevel;
            } else {
                paneSelection = { ...paneSelection, effortLevel: undefined };
            }
        }
        // DROVE-199: and the third field, on the same rule. Both values here
        // are already Claude modes — `next.permissionMode` came through
        // paneModeFor and `observedPermissionMode` is read off the footer — so
        // this is a plain comparison rather than the model's fold. A pick that
        // names the mode the pane is already in is Clay's own shift+tab coming
        // back round; one that differs from it forces a command out even when
        // the stale request happens to match, which is the half that was
        // broken. Null-safe on purpose: `default` and a cleared pick are the
        // same mode, and `commandFor` spells both as `#permission-mode default`.
        if (next.permissionMode !== undefined && observedPermissionMode !== undefined) {
            if ((next.permissionMode ?? 'default') === observedPermissionMode) {
                paneCommands.cancel('#permission-mode');
                next.permissionMode = paneSelection.permissionMode;
            } else {
                paneSelection = { ...paneSelection, permissionMode: undefined };
            }
        }
        const commands = paneCommandsForSelection(paneSelection, next);
        if (commands.length === 0) return;
        // Record the intent even if the pane is busy. The queue owns the
        // retry; re-deriving the same commands on the next metadata write
        // would just queue duplicates of what is already waiting.
        paneSelection = { ...paneSelection, ...next };
        logger.debug(`[local]: app changed the model/effort — queueing ${commands.join(', ')}`);
        // Every picker command takes the weaker gate, permission mode included
        // (DROVE-199). It used to keep waiting for idle on the reasoning that a
        // shift+tab loop reading the pane back wants the screen holding still —
        // but "idle" is not that property, it is the TURN being over, and
        // DROVE-164 already measured what that costs: a session Clay is
        // actually working is never idle, so the pick sat in the queue and the
        // padlock never moved. What the loop actually needs is what
        // `paneAcceptsCommand` checks and `paneIsIdle` does not: no dialog on
        // screen and an empty input box. A running turn changes neither, the
        // mode chip stays first in the footer while it streams, and the loop
        // stops of its own accord the moment it loses sight of the prompt.
        for (const command of commands) {
            paneCommands.request([command], { allowWhileBusy: true });
        }
        pumpPaneCommands();
    };
    if (tmuxPane) {
        session.client.on('metadata', onMetadataChanged);
        // The footer watcher (DROVE-199). Unconditional for a pane session
        // rather than started on demand like the command retry: what it is
        // watching for is a key Clay presses, which arrives on no signal this
        // process can subscribe to. `watchPanePermissionMode` no-ops while
        // there is no child in the pane, so the cost between spawns is a
        // timer tick.
        // Same timer and the same reason it is unconditional, for the credits
        // dialog too (DROVE-279): that one arrives on no signal this process
        // can subscribe to either — Claude Code draws it mid-turn when the
        // week's included Fable usage runs out — and it blocks the pane queue
        // until somebody answers it.
        panePermissionTimer = setInterval(() => {
            void watchPanePermissionMode();
            void watchPaneCreditsDialog();
        }, panePermissionPollMs);
        panePermissionTimer.unref?.();
        // The scanner already reported the transcript's state, but it did so
        // before the queue existed. Decide once now, so a session relaunched
        // with the app's request still standing (a flip, a crash, a resume)
        // honours it instead of waiting for the next metadata write (DROVE-63).
        reconcileRemoteControl();
        // A model downgrade decided by the flip controller (DROVE-187).
        //
        // It cannot ride onMetadataChanged: applyDowngrade writes the pick
        // through updateMetadata, and apiSession only emits `metadata` for
        // changes that arrive from SOMEBODY ELSE, on purpose, so a listener
        // cannot echo itself into a loop. It cannot ride paneSelection either
        // — that is seeded from the same metadata a line above and would
        // therefore believe the pane is already on the new model, which it is
        // not: the flip has just started a fresh claude child on the account's
        // own default.
        //
        // So it is taken once, here, and typed. `allowWhileBusy`, like every
        // other picker command since DROVE-164: Claude Code runs `/model` and
        // `/effort` mid-turn, and the idle gate this used to wait for never
        // opened on a session Clay was actually working.
        const downgraded = session.flip?.takeDowngradePick();
        if (downgraded) {
            const commands = [`/model ${downgraded.model}`];
            if (downgraded.effort) commands.push(`/effort ${downgraded.effort}`);
            paneSelection = {
                ...paneSelection,
                modelMode: downgraded.model,
                ...(downgraded.effort ? { effortLevel: downgraded.effort } : {}),
            };
            logger.debug(`[local]: flip downgraded the model — queueing ${commands.join(', ')}`);
            for (const command of commands) paneCommands.request([command], { allowWhileBusy: true });
            pumpPaneCommands();
        }
    }

    // `let`, not `const`: a Cattle Drover flip aborts the child on purpose and
    // then needs a FRESH controller for the replacement, because an aborted
    // signal stays aborted and would kill the new child on spawn.
    let processAbortController = new AbortController();
    let exutFuture = new Future<void>();
    // DROVE-172: declared out here so the finally can stop its timer. Assigned
    // beside the flip probes below, which is where the facts it gates on live.
    let relaunchGate: RelaunchGate | null = null;

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

            // Cattle Drover (DROVE-13): for a session living in a tmux pane,
            // Stop on the phone means cancel THIS TURN and nothing else. The
            // app's own handler says so in as many words — "Stop cancels only
            // the active turn" — and upstream answered it with a SIGTERM plus
            // `{type:'switch'}`, which takes down the terminal Clay is watching:
            // scrollback, whatever he had half-typed, and any open plan or
            // permission prompt go with it, and he gets a headless run back in
            // exchange for a turn he only wanted stopped.
            //
            // So the pane gets the keystroke a person at the keyboard would
            // use and the child is never touched. Same rule the message path
            // already follows (deliverToPaneSession): the pane IS the session,
            // so there is nothing to switch to.
            //
            // This does NOT soften the abort a flip needs — a flip has to kill
            // the child to relaunch it on another account, and it goes through
            // setAbortHandler below rather than through here.
            if (tmuxPane) {
                const outcome = childAlive
                    ? await interruptPane({
                        pane: tmuxPane,
                        configDir: session.claudeEnvVars?.CLAUDE_CONFIG_DIR,
                        claudeSessionId: session.sessionId,
                    })
                    : 'unavailable';
                if (outcome === 'unavailable') {
                    // Between spawns, parked at a shell, or the pane is gone.
                    // There is no turn in there to cancel, and killing the
                    // child would be a strictly worse answer to a button that
                    // simply had nothing to do.
                    logger.debug('[local]: nothing in the pane took the interrupt');
                    session.client.sendSessionEvent({
                        type: 'message',
                        message:
                            'Cattle Drover: nothing is running in the terminal right now, '
                            + 'so there was no turn to stop.',
                    });
                } else if (outcome === 'gate-cancelled') {
                    // A prompt was open, so Stop withdrew it rather than typing
                    // over it (DROVE-80). Said out loud because the outcome is
                    // not the one the button implies: the tool call is refused
                    // by its own producer, and the turn goes on from there.
                    logger.debug('[local]: Stop withdrew an open prompt on the bus instead of pressing Escape');
                    session.client.sendSessionEvent({
                        type: 'message',
                        message:
                            'Cattle Drover: a prompt was waiting for you, so Stop withdrew it '
                            + 'on the bus. Escape into an open dialog is a no, not a stop.',
                    });
                } else if (outcome === 'unknown') {
                    // The bus could not say whether a dialog is open. Escape
                    // sent blind is exactly the defect DROVE-80 closed, so
                    // nothing was sent and nothing is guessed behind it.
                    logger.debug('[local]: the bus could not say whether a prompt is open — Stop sent nothing');
                    session.client.sendSessionEvent({
                        type: 'message',
                        message:
                            'Cattle Drover: the drover bus did not answer, so Stop sent nothing '
                            + 'rather than risk answering a prompt you have open. Try again once '
                            + 'the bus is back.',
                    });
                }
                // Closed either way, or the app keeps showing a turn that the
                // person watching has already stopped. NOT on 'unknown': there
                // nothing was typed and nothing was withdrawn, so the turn is
                // still running and the Stop button has to stay on screen for
                // the retry that message asks for.
                if (outcome !== 'unknown') session.client.closeClaudeSessionTurn('cancelled');
                // The queue is deliberately NOT reset here. A pane session
                // takes each message OFF the queue as it delivers it, so
                // anything still on it is waiting for the next child and never
                // ran — Stop is about the turn in flight, not about un-sending
                // a message.
                return;
            }

            // No pane: the child is the only thing there is to stop, and remote
            // mode is the only place the phone can still reach the session.
            // Upstream behaviour, unchanged.
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
        // Stop on the phone. For a pane session that is an Escape into the pane
        // and nothing else; for a paneless one it still stops the child and
        // switches to remote mode. See doAbort (DROVE-13).
        session.client.rpcHandlerManager.registerHandler('abort', doAbort);
        /**
         * DROVE-79: a pane session exposes NO `switch` RPC at all.
         *
         * Cattle Drover has one mode for a pane. The terminal IS the session,
         * so there is nothing to switch TO, and exitReasonAfterChild says so by
         * returning `exit` for every pane child whatever is on the queue. That
         * left this handler unable to do the one thing its name promises: it
         * aborted the child, the child died, and the launcher exited. A button
         * the app calls "switch to remote" would have ended the terminal Clay
         * is watching.
         *
         * Absent rather than a refusal, so the app can read the capability as
         * gone: with no handler the method is never announced to the server and
         * `sessionSwitch` comes back "Method not found", which a client can
         * render as "this session has one mode" instead of offering a control
         * that destroys the session. Nothing else registers `switch` on this
         * path either. Only claudeRemoteLauncher does, and a pane session
         * never reaches remote mode, so skipping the register is enough to
         * leave the method unregistered for the life of the process.
         */
        if (!tmuxPane) {
            // The user pressing "switch to remote": explicit, so a second press
            // inside 30s overrides the subagent hold above.
            session.client.rpcHandlerManager.registerHandler('switch', () => doSwitch(true));
        }

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

        // DROVE-172, and it rides the same two facts the flip gate does. A
        // relaunch is a SIGTERM to the child, so it waits for the turn to end
        // and for every subagent to report, exactly as BASED-135 requires --
        // the difference is only what comes back afterwards.
        relaunchGate = startRelaunchGate({
            watcher: createStaleWatcher({
                loaded: loadedDistStamp,
                read: () => readDistStamp(distEntrypoint()),
                complete: () => distEntryIsComplete(distEntrypoint()),
            }),
            claudeSessionId: () => session.sessionId,
            isBusy: () => thinking || inflight.count() > 0,
            /**
             * Claude Code's own word for it, not ours.
             *
             * `thinking` above is the fd3 fetch counter and it reads FALSE for
             * the whole of a long tool call — measured on 2026-08-31, a
             * `sleep 150` in the pane looked quiet for every second of it and
             * the first version of this gate killed it. The record Claude keeps
             * in `<config dir>/sessions/` does not: it reads `busy` inside a
             * turn and `shell` inside a bash tool. `paneIsIdle` is the same
             * check plus "no permission card on screen and the pane is still
             * Claude's", which is a stop this must also not walk into, so a
             * pane session takes that whole gate.
             *
             * Paneless (remote-only) sessions have no pane to read, so they
             * take the registry alone. Either way anything unreadable is
             * `false`: the session stays stale and `drover stale-sessions`
             * names it, which is the safe half of the trade.
             */
            turnIsOver: async () => {
                const configDir = session.claudeEnvVars?.CLAUDE_CONFIG_DIR;
                if (tmuxPane) {
                    return paneIsIdle({
                        pane: tmuxPane,
                        configDir,
                        claudeSessionId: session.sessionId,
                    });
                }
                return (await registryStatus(configDir, session.sessionId, '')) === 'idle';
            },
            childAlive: () => childAlive,
            abortChild: () => {
                if (!processAbortController.signal.aborted) processAbortController.abort();
            },
            /**
             * Both surfaces, and the phone is the one that counts (DROVE-220).
             *
             * The tmux status line is on a Mac Clay is not looking at. On
             * 2026-08-31 his session ran an eight-hour-old bundle through
             * three shipped CLI fixes and every word about it went to that
             * status line and a debug log, so he reported all three as still
             * broken and three more lanes were sent after bugs that were
             * already fixed. The conversation is where he is, so that is where
             * the notice goes -- the same channel a held prompt uses to say it
             * is waiting.
             */
            announce: (line) => announceRelaunch(
                line,
                (message) => session.client.sendSessionEvent({ type: 'message', message })
            ),
        });

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
         *
         * `note` is a parameter because the two callers are telling the phone
         * two different things (DROVE-48). Nothing listening yet is a wait.
         * A live child whose inbox refused the write is a FAILURE that happens
         * to be recoverable, and saying "held, goes in the moment Claude is
         * back" about a Claude that is right there and running is the kind of
         * reassuring lie this stack keeps getting caught by.
         */
        function holdForNextSpawn(message: string, item?: QueueItem<EnhancedMode>, note?: string) {
            session.pendingInitialPrompt = session.pendingInitialPrompt
                ? `${session.pendingInitialPrompt}\n${message}`
                : message;
            if (item) heldForNextSpawn.push(item);
            logger.debug('[local]: no live child to take the message — held for the next spawn');
            session.client.sendSessionEvent({
                type: 'message',
                message: note
                    ?? 'Cattle Drover: nothing is listening in the terminal right now, so your '
                    + 'message is held and goes in the moment Claude is back.',
            });
        }

        /**
         * A slash command typed on the phone goes to the KEYBOARD, never to
         * the socket (DROVE-49).
         *
         * Claude Code's uds handler hardcodes `skipSlashCommands:true` on every
         * message it takes off the inbox socket (2.1.251, `Ye`), so `/model
         * opus` sent from the app used to arrive as five words of prose. The
         * pane executes it, and the pane command queue is the only thing here
         * that types on a gate rather than on hope: it waits for Claude's own
         * registry to say idle, for the drover bus to hold no pending
         * question, for the pane to still be running Claude, and — for a
         * phone command specifically — for every async agent to have reported
         * in, because one of those can be what the terminal is looking at.
         *
         * Held, never drafted. A half-typed `/clear` sitting in Clay's input
         * box waiting to merge with his next line is worse than a late one.
         */
        async function deliverSlashCommand(command: string): Promise<boolean> {
            noteDeliveredFromApp(command);
            const agents = inflight.count();
            const idle = agents === 0 && await paneIsIdle({
                pane: tmuxPane!,
                configDir: session.claudeEnvVars?.CLAUDE_CONFIG_DIR,
                claudeSessionId: session.sessionId,
            });
            if (idle && await injectIntoPane(tmuxPane!, command, { submit: true })) {
                notePaneCommandApplied(command);
                logger.debug(`[local]: typed ${command} into the pane`);
                return true;
            }
            paneCommands.request([command], { collapse: false, requireQuietAgents: true });
            pumpPaneCommands();
            // infoDeveloper, not info: `info` writes to the console, and this
            // process shares a pane with a Claude Code TUI that owns the screen.
            logger.infoDeveloper(
                `[local]: holding ${command} for the pane's prompt`
                + ` (${agents > 0 ? `${agents} agent(s) running` : 'terminal busy'})`,
            );
            session.client.sendSessionEvent({
                type: 'message',
                message: agents > 0
                    ? `Cattle Drover: ${command} is waiting — ${agents} agent(s) are still running in the terminal.`
                    : `Cattle Drover: ${command} is waiting for the terminal's prompt.`,
            });
            return true;
        }

        /**
         * The same carrier, offered to whoever holds an RPC rather than a
         * message (DROVE-78).
         *
         * The app's goal card acts through the `goal-action` RPC, which
         * runClaude answers, and runClaude's only way to run a command used to
         * be the SDK message queue, which a pane session does not have. So it
         * threw, for every session, since one mode made every session a pane
         * session. This is the way in: exactly what a `/goal` TYPED on the
         * phone already takes, so there is one gate and one set of rules.
         *
         * Registered only for a pane session, and only while this launcher
         * owns it. Absent is the honest answer for a paneless local run: the
         * app is told there is no terminal instead of being handed a button
         * that fails.
         */
        if (tmuxPane) {
            session.paneSlashCommandCarrier = async (command: string) => {
                // Between spawns, mid-flip, or parked at a shell there is no
                // Claude in there to take it. Not held for the next child the
                // way a message is: a `/goal` folded into the next child's
                // opening prompt would run against a conversation that has not
                // started, and the phone asked about THIS one.
                if (!childAlive) return false;
                return deliverSlashCommand(command);
            };
        }

        /**
         * Hand `message` to the Claude running in our pane, or say it did not
         * arrive. There is no third answer any more (DROVE-48).
         *
         * The carrier is Claude's own inbox socket: it queues the message
         * INSIDE Claude and serves it to the main conversation between tool
         * calls, so it is safe mid-turn, cannot merge with a half-typed line
         * and cannot answer an open dialog.
         *
         * There used to be a pane paste behind it for a Claude too old to have
         * a socket or one whose registry record had gone stale. It is gone.
         * A bracketed paste lands on WHATEVER HAS FOCUS, and the terminal
         * drives subagents now: with Clay inside a background task's view the
         * message went to that subagent, was answered by the wrong Claude, and
         * nothing anywhere said so. Clay's ruling on the shape of that fix is
         * the reason it is a deletion rather than a guard — "if you have to
         * fall back then things aren't set up correctly in the first place".
         *
         * So a socket miss is a failed delivery, reported to the phone with
         * the reason and counted in `drover status`, rather than a silent
         * downgrade onto a carrier that can hit the wrong conversation.
         *
         * A slash command takes neither: see deliverSlashCommand.
         */
        async function deliverToChild(message: string): Promise<UndeliveredReason | null> {
            if (!tmuxPane) return 'no-inbox-socket';
            // DROVE-36: a mode picked in the composer and a message sent from
            // the composer arrive as two separate writes, and the mode's
            // carrier waits for an idle prompt. Sending the message first would
            // mean the turn Clay just started runs under the OLD mode and the
            // switch lands after it — which is exactly "Yolo is selected and it
            // still asks". So the queue is drained first, on the way in.
            //
            // Awaited, but not required to succeed. The inbox socket queues
            // INSIDE Claude, so a message is never lost by going second; a mode
            // change that cannot land right now stays queued for the retry and
            // the message still goes.
            await paneCommands.flush();
            // DROVE-49: a slash command from the phone cannot go down the
            // socket at all — Claude Code sets skipSlashCommands:true on
            // everything it takes off it — so it takes the keyboard, on its
            // own gate, and never the socket below.
            const command = paneSlashCommand(message);
            if (command) {
                await deliverSlashCommand(command);
                return null;
            }
            // Recorded before the write, because Claude Code writes the
            // enqueue record the instant the text lands (DROVE-41). Both
            // spellings: sendToInbox wraps the body in a
            // <cross-session-message> element, so that is what comes back as a
            // queued-prompt record, and the plain one is kept for a transcript
            // that recorded it unwrapped.
            noteDeliveredFromApp(message);
            noteDeliveredFromApp(wrapForPane(message));
            try {
                const configDir = session.claudeEnvVars?.CLAUDE_CONFIG_DIR;
                const inbox = await findInbox(configDir || undefined, session.sessionId, tmuxPane);
                if (!inbox) return 'no-inbox-socket';
                const outcome = await sendToInbox(inbox, message, inbox.sessionId);
                if (outcome === 'ok') {
                    logger.debug('[local]: delivered to the inbox socket');
                    noteMessageDelivered();
                    return null;
                }
                return outcome === 'gone' ? 'inbox-socket-gone' : 'inbox-socket-refused';
            } catch (err) {
                // Reading the registry must never throw out of here — but it
                // is now a failed delivery rather than a reason to paste.
                logger.debug('[local]: inbox lookup failed', err);
                return 'inbox-lookup-failed';
            }
        }

        async function deliverToPaneSession(message: string, item?: QueueItem<EnhancedMode>) {
            if (!childAlive) {
                holdForNextSpawn(message, item);
                return;
            }
            const undelivered = await deliverToChild(message);
            if (!undelivered) {
                // Served. Take it back off the queue, or the launcher will
                // read it later as an unanswered message (BASED-141) and the
                // remote launcher would replay it as a fresh turn.
                if (item) session.queue.remove(item);
                return;
            }
            // FOLD, NEVER DROP: the message is kept for the next child rather
            // than thrown away, and the phone is told plainly that it has NOT
            // gone in yet and why — so resending it is Clay's call, not a
            // guess made for him by a carrier that might hit a subagent.
            noteMessageUndelivered(undelivered);
            logger.debug(`[local]: message undelivered — ${undelivered}`);
            holdForNextSpawn(
                message,
                item,
                `Cattle Drover: your message did NOT reach the terminal — ${undeliveredExplanation(undelivered)}. `
                + 'It is held for the next time Claude starts here. Nothing was typed into the pane, '
                + 'because a paste can land on whichever subagent the terminal is showing.',
            );
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
            // DROVE-172 first, before anything else looks at the queue. The
            // child was stopped so a newer bundle could take this session, and
            // runClaude turns this code into the handover. A pane session and a
            // paneless one both want it: the alternative is remote mode on the
            // OLD code, which is the bug.
            if (relaunchGate?.requested()) return { type: 'exit', code: relaunchExitCode };
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
        //
        // DROVE-232: the first spawn is the session starting; every spawn after
        // it is a REPLACEMENT -- a flip onto another account, or a child that
        // died and is coming back. Only a replacement needs the pane readings
        // dropped and the re-apply declared, because only a replacement is a
        // fresh Claude Code standing in for one that already had the picks.
        //
        // DROVE-220's relaunch is a replacement too, and it is the one this
        // counter cannot see: the whole node process exited and came back, so
        // its first spawn IS the second child of that pane. The wrapper says so
        // by setting DROVER_RELAUNCH_HANDOVER, which is why the counter starts
        // from that rather than from false, and why both relaunches are fixed
        // here rather than in two places.
        let spawned = relaunchIsHandover(session.client.sessionId);
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
                if (spawned) noteModeReapply();
                spawned = true;
                try {
                await claudeLocal({
                    path: session.path,
                    sessionId: session.sessionId,
                    onSessionFound: handleSessionStart,
                    onThinkingChange,
                    abort: processAbortController.signal,
                    claudeEnvVars: session.claudeEnvVars,
                    // DROVE-232: the picks go on the CHILD's argv, not just into
                    // the queue that types at its prompt. A flip's arrival
                    // prompt is a positional argument to this very spawn, so
                    // anything applied after the child is up has already lost a
                    // turn to the wrong effort -- which is the expensive half of
                    // "it reset my effort". Derived per spawn and never written
                    // back to session.claudeArgs: a permission mode this spawn
                    // had to evict --dangerously-skip-permissions for must not
                    // stay evicted for the next one.
                    claudeArgs: modeCarryArgs(session.claudeArgs, requestedModes()),
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
        // DROVE-79: still absent for a pane session, not a no-op. A registered
        // method is a capability the app can see and call, and this session
        // has nowhere to switch to whether a launcher owns it or not.
        if (!tmuxPane) {
            session.client.rpcHandlerManager.registerHandler('switch', async () => { });
        }
        session.queue.setOnMessage(null);
        // DROVE-78: the pane goes with the launcher. Left set, the carrier
        // would keep telling runClaude a terminal is listening through the
        // whole of the next remote turn, and the app's goal card would take
        // the pane branch to a pane this call no longer owns.
        session.paneSlashCommandCarrier = null;
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
        relaunchGate?.stop();
        takeDeferredSwitch = null;
        // DROVE-45: the launcher is re-entered on every local/remote switch, so
        // a listener left behind would be added again on the next pass and
        // type the same /model once per stale registration.
        if (tmuxPane) session.client.off('metadata', onMetadataChanged);
        if (paneCommandTimer) {
            clearInterval(paneCommandTimer);
            paneCommandTimer = null;
        }
        if (panePermissionTimer) {
            clearInterval(panePermissionTimer);
            panePermissionTimer = null;
        }

        // Remove session found callback
        session.removeSessionFoundCallback(scannerSessionCallback);

        // Cleanup
        // DROVE-247: stop before the scanner, so a `working` cannot be in
        // flight to the bus after the row has gone quiet. The bus ages the last
        // publish out on `staleMs`; nothing has to send a final `connected`.
        dotPublisher.dispose();
        await scanner.cleanup();
        await scannerMessageChain;
    }

    // Return
    return exitReason || { type: 'exit', code: 0 };
}
