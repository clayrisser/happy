import { render } from "ink";
import { Session } from "./session";
import { MessageBuffer } from "@/ui/ink/messageBuffer";
import { RemoteModeDisplay } from "@/ui/ink/RemoteModeDisplay";
import React from "react";
import { claudeRemote } from "./claudeRemote";
import { PermissionHandler } from "./utils/permissionHandler";
import { mergeUsageLimits } from "./utils/usageLimits";
import { Future } from "@/utils/future";
import { SDKAssistantMessage, SDKMessage, SDKUserMessage } from "./sdk";
import { formatClaudeMessageForInk } from "@/ui/messageFormatterInk";
import { logger } from "@/ui/logger";
import { SDKToLogConverter } from "./utils/sdkToLogConverter";
import { EnhancedMode } from "./loop";
import { RawJSONLines } from "@/claude/types";
import { OutgoingMessageQueue } from "./utils/OutgoingMessageQueue";
import { getToolName } from "./utils/getToolName";
import { getAskUserQuestionToolCallIds } from "./utils/questionNotification";
import { launchFailureMessage } from "./utils/launchFailureMessage";
import { cleanupStdinAfterInk } from "@/utils/terminalStdinCleanup";
import type { MessageParam, ContentBlockParam } from '@anthropic-ai/sdk/resources';
import { applyPendingFlip, transcriptPathFor } from "@/drover/flip/apply";
import { detectClaudeImageMime } from "./utils/imageMime";
import { InFlightTracker } from "@/drover/flip/inflight";

interface PermissionsField {
    date: number;
    result: 'approved' | 'denied';
    mode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
    allowedTools?: string[];
}

export async function claudeRemoteLauncher(session: Session): Promise<'switch' | 'exit'> {
    logger.debug('[claudeRemoteLauncher] Starting remote launcher');

    // Check if we have a TTY for UI rendering
    const hasTTY = process.stdout.isTTY && process.stdin.isTTY;
    logger.debug(`[claudeRemoteLauncher] TTY available: ${hasTTY}`);

    // Configure terminal
    let messageBuffer = new MessageBuffer();
    let inkInstance: any = null;

    if (hasTTY) {
        console.clear();
        inkInstance = render(React.createElement(RemoteModeDisplay, {
            messageBuffer,
            logPath: process.env.DEBUG ? session.logPath : undefined,
            onExit: async () => {
                // Exit the entire client
                logger.debug('[remote]: Exiting client via Ctrl-C');
                if (!exitReason) {
                    exitReason = 'exit';
                }
                await abort();
            },
            onSwitchToLocal: () => {
                // Switch to local mode
                logger.debug('[remote]: Switching to local mode via double space');
                doSwitch();
            }
        }), {
            exitOnCtrlC: false,
            patchConsole: false
        });
    }

    if (hasTTY) {
        process.stdin.resume();
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
        }
        process.stdin.setEncoding("utf8");
    }

    // Handle abort
    let exitReason: 'switch' | 'exit' | null = null;
    let abortController: AbortController | null = null;
    let abortFuture: Future<void> | null = null;

    async function abort() {
        if (abortController && !abortController.signal.aborted) {
            abortController.abort();
        }
        await abortFuture?.promise;
    }

    async function doAbort() {
        logger.debug('[remote]: doAbort');
        session.onAbort();
        await abort();
    }

    async function doSwitch() {
        logger.debug('[remote]: doSwitch');
        if (!exitReason) {
            exitReason = 'switch';
        }
        await abort();
    }

    // When to abort
    session.client.rpcHandlerManager.registerHandler('abort', doAbort); // When abort clicked
    session.client.rpcHandlerManager.registerHandler('switch', doSwitch); // When switch clicked
    // Removed catch-all stdin handler - now handled by RemoteModeDisplay keyboard handlers

    // Who is still running inside the SDK's claude process (BASED-135).
    // `query()` is not a spawned TUI, but it IS a child process, aborting it
    // is still a SIGTERM, and async subagents still live inside it — so the
    // same count has to be available to the same gate. Fed from onMessage
    // below, which sees the launch banner's tool_result as an SDK user
    // message, and topped up by the tracker's own tail of the transcript.
    const inflight = new InFlightTracker({
        transcript: () => transcriptPathFor(session),
    });

    // Cattle Drover (BASED-127): a flip stops the engine the same way a switch
    // does, and this is the half remote mode never had. `request()` calls this
    // handler; with nothing registered it logged "no abort handler registered"
    // and the flip queued until the session came back to local mode and its
    // next child exited — which reads exactly like a button that does nothing.
    //
    // Registered once, out here, and reads the MUTABLE `abortController`: the
    // loop mints a fresh one every turn and nulls it between turns, so a
    // closure over any single controller would go stale within one message.
    session.flip?.setAbortHandler(() => {
        if (abortController && !abortController.signal.aborted) {
            abortController.abort();
        }
    });
    // ...and the controller decides whether to stop it at all, which it cannot
    // do without knowing who is still running in there. Same probe, same gate,
    // same answers as local mode: a flip with subagents in flight announces
    // and waits for a repeat rather than killing them.
    session.flip?.setInFlightProbe(() => inflight.snapshot());

    // Create permission handler
    const permissionHandler = new PermissionHandler(session);

    // Drop any permission requests left over in agent state from a
    // previous CLI process that died while a tool prompt was open. The
    // in-memory pendingRequests map is fresh and empty, but the server
    // still has `requests: { [id]: {...} }` and the app shows a spinner
    // + "Permission required" banner that no click can clear — the
    // previous process is gone and the new one has no record of the id.
    // reset() moves any stale entries to completedRequests with status
    // 'canceled' so the UI reflects what actually happened.
    permissionHandler.reset('Previous CLI process exited before responding');

    // Create outgoing message queue
    const messageQueue = new OutgoingMessageQueue(
        (logMessage) => session.client.sendClaudeSessionMessage(logMessage)
    );

    // Set up callback to release delayed messages when permission is requested
    permissionHandler.setOnPermissionRequest((toolCallId: string) => {
        messageQueue.releaseToolCall(toolCallId);
    });

    // Create SDK to Log converter (pass responses from permissions)
    const sdkToLogConverter = new SDKToLogConverter({
        sessionId: session.sessionId || 'unknown',
        cwd: session.path,
        version: process.env.npm_package_version
    }, permissionHandler.getResponseLookup());


    // Handle messages
    let ongoingToolCalls = new Map<string, { parentToolCallId: string | null }>();
    let notifiedQuestionToolCalls = new Set<string>();

    function onMessage(message: SDKMessage) {

        // BASED-135: this stream carries "Async agent launched successfully"
        // and, sometimes, the notification that ends it. Offered first, and
        // before anything that can throw, because the gate that reads it
        // decides whether Clay loses eight agents.
        inflight.note(message);

        // DROVE-12: and it carries the harness's own synthetic limit notice.
        // The flip itself works in remote mode, but until now nothing FED the
        // detector here — noteTranscriptMessage was called from the local
        // launcher and nowhere else — so a remote session that ran out of headroom
        // neither flipped nor parked and simply kept talking to an exhausted
        // account. Same detector as local on purpose: the SDK's typed
        // rate_limit_event is a usage-reporting channel, and a second route
        // into the same decision is a second thing to keep in agreement.
        // After inflight.note, which documents above why it goes first.
        session.flip?.noteTranscriptMessage(message);

        // Write to message log
        formatClaudeMessageForInk(message, messageBuffer);

        // Track active tool calls
        if (message.type === 'assistant') {
            let umessage = message as SDKAssistantMessage;
            if (umessage.message.content && Array.isArray(umessage.message.content)) {
                for (let c of umessage.message.content) {
                    if (c.type === 'tool_use') {
                        logger.debug('[remote]: detected tool use ' + c.id! + ' parent: ' + umessage.parent_tool_use_id);
                        ongoingToolCalls.set(c.id!, { parentToolCallId: umessage.parent_tool_use_id ?? null });
                    }
                }
            }
        }

        // Notify once when Claude asks the user a native clarifying question
        for (const toolCallId of getAskUserQuestionToolCallIds(message)) {
            if (notifiedQuestionToolCalls.has(toolCallId)) {
                continue;
            }
            notifiedQuestionToolCalls.add(toolCallId);
            session.api.push().sendSessionNotification({
                kind: 'question',
                metadata: session.client.getMetadata(),
                data: {
                    sessionId: session.client.sessionId,
                    tool: 'AskUserQuestion',
                    toolCallId,
                    type: 'question_request',
                    provider: 'claude',
                }
            });
        }

        if (message.type === 'user') {
            let umessage = message as SDKUserMessage;
            if (umessage.message.content && Array.isArray(umessage.message.content)) {
                for (let c of umessage.message.content) {
                    if (c.type === 'tool_result' && c.tool_use_id) {
                        ongoingToolCalls.delete(c.tool_use_id);

                        // When tool result received, release any delayed messages for this tool call
                        messageQueue.releaseToolCall(c.tool_use_id);
                    }
                }
            }
        }

        // Convert SDK message to log format and send to client
        const logMessage = sdkToLogConverter.convert(message);
        if (logMessage) {
            // Add permissions field to tool result content
            if (logMessage.type === 'user' && logMessage.message?.content) {
                const content = Array.isArray(logMessage.message.content)
                    ? logMessage.message.content
                    : [];

                // Modify the content array to add permissions to each tool_result
                for (let i = 0; i < content.length; i++) {
                    const c = content[i];
                    if (c.type === 'tool_result' && c.tool_use_id) {
                        const response = permissionHandler.getResponseForToolUseId(c.tool_use_id);

                        if (response) {
                            const permissions: PermissionsField = {
                                date: response.receivedAt || Date.now(),
                                result: response.approved ? 'approved' : 'denied'
                            };

                            // Add optional fields if they exist
                            if (response.mode) {
                                permissions.mode = response.mode;
                            }

                            if (response.allowTools && response.allowTools.length > 0) {
                                permissions.allowedTools = response.allowTools;
                            }

                            // Add permissions directly to the tool_result content object
                            content[i] = {
                                ...c,
                                permissions
                            };
                        }
                    }
                }
            }

            // Queue message with optional delay for tool calls
            if (logMessage.type === 'assistant' && message.type === 'assistant') {
                const assistantMsg = message as SDKAssistantMessage;
                const toolCallIds: string[] = [];

                if (assistantMsg.message.content && Array.isArray(assistantMsg.message.content)) {
                    for (const block of assistantMsg.message.content) {
                        if (block.type === 'tool_use' && block.id) {
                            toolCallIds.push(block.id);
                        }
                    }
                }

                if (toolCallIds.length > 0) {
                    // Check if this is a sidechain tool call (has parent_tool_use_id)
                    const isSidechain = assistantMsg.parent_tool_use_id !== undefined;

                    if (!isSidechain) {
                        // Top-level tool call - queue with delay
                        messageQueue.enqueue(logMessage, {
                            delay: 250,
                            toolCallIds
                        });
                        return; // Don't queue again below
                    }
                }
            }

            // Queue all other messages immediately (no delay)
            messageQueue.enqueue(logMessage);
        }

        // Insert a fake message to start the sidechain
        if (message.type === 'assistant') {
            let umessage = message as SDKAssistantMessage;
            if (umessage.message.content && Array.isArray(umessage.message.content)) {
                for (let c of umessage.message.content) {
                    if (c.type === 'tool_use' && c.name === 'Task' && c.input && typeof (c.input as any).prompt === 'string') {
                        const logMessage2 = sdkToLogConverter.convertSidechainUserMessage(c.id!, (c.input as any).prompt);
                        if (logMessage2) {
                            messageQueue.enqueue(logMessage2);
                        }
                    }
                }
            }
        }
    }

    try {
        let pending: {
            message: MessageParam['content'];
            mode: EnhancedMode;
        } | null = null;

        /**
         * The mode the last message ran under, kept across turns.
         *
         * A flip's arrival prompt has to be sent as a message, because a
         * `query()` loop has no equivalent of the local launcher's
         * `pendingInitialPrompt`. That message needs a mode, and the only
         * honest one is whatever the session was already running: sending it
         * under a fresh default would silently drop the model, effort and
         * permission mode the user picked. Null only before the first message
         * of the session, where there is nothing to preserve.
         */
        let lastMode: EnhancedMode | null = null;

        /**
         * Say the arrival prompt to the Claude that comes back after a flip.
         *
         * `unshift`, not `push`: anything the phone queued while the flip was
         * happening is served AFTER "carry on where we left off", which is the
         * same order the local launcher gets for free by handing the prompt to
         * the spawn itself.
         */
        const queueArrivalPrompt = (prompt: string): void => {
            session.queue.unshift(prompt, lastMode ?? {});
        };

        // Track session ID to detect when it actually changes
        // This prevents context loss when mode changes (permission mode, model, etc.)
        // without starting a new session. Only reset parent chain when session ID
        // actually changes (e.g., new session started or /clear command used).
        // See: https://github.com/anthropics/happy-cli/issues/143
        let previousSessionId: string | null = null;
        while (!exitReason) {
            logger.debug('[remote]: launch');
            messageBuffer.addMessage('═'.repeat(40), 'status');

            // Only reset parent chain and show "new session" message when session ID actually changes
            const isNewSession = session.sessionId !== previousSessionId;
            if (isNewSession) {
                messageBuffer.addMessage('Starting new Claude session...', 'status');
                permissionHandler.reset(); // Reset permissions before starting new session
                sdkToLogConverter.resetParentChain(); // Reset parent chain for new conversation
                logger.debug(`[remote]: New session detected (previous: ${previousSessionId}, current: ${session.sessionId})`);
            } else {
                messageBuffer.addMessage('Continuing Claude session...', 'status');
                logger.debug(`[remote]: Continuing existing session: ${session.sessionId}`);
            }

            previousSessionId = session.sessionId;
            // Fresh engine, fresh count. Cleared HERE rather than when the last
            // one stopped, so the flip below can still name the agents it
            // stranded, and so an entry we never managed to resolve cannot jam
            // the gate for the rest of the session.
            inflight.reset();
            const controller = new AbortController();
            abortController = controller;
            abortFuture = new Future<void>();
            let modeHash: string | null = null;
            let mode: EnhancedMode | null = null;
            try {
                const remoteResult = await claudeRemote({
                    sessionId: session.sessionId,
                    path: session.path,
                    allowedTools: session.allowedTools ?? [],
                    mcpServers: session.mcpServers,
                    hookSettingsPath: session.hookSettingsPath,
                    jsRuntime: session.jsRuntime,
                    canCallTool: permissionHandler.handleToolCall,
                    isAborted: (toolCallId: string) => {
                        return permissionHandler.isAborted(toolCallId);
                    },
                    nextMessage: async () => {
                        if (pending) {
                            let p = pending;
                            pending = null;
                            lastMode = p.mode;
                            permissionHandler.handleModeChange(p.mode.permissionMode);
                            return p;
                        }

                        let msg = await session.queue.waitForMessagesAndGetAsString(controller.signal);

                        // Check if mode has changed
                        if (msg) {
                            if ((modeHash && msg.hash !== modeHash) || msg.isolate) {
                                logger.debug('[remote]: mode has changed, pending message');
                                pending = msg;
                                return null;
                            }
                            modeHash = msg.hash;
                            mode = msg.mode;
                            lastMode = msg.mode;
                            permissionHandler.handleModeChange(mode.permissionMode);

                            // Per-message attachments are already claimed by the message
                            // when it was pushed onto the queue, so there is no race window
                            // to wait out here — just consume what travelled with the batch.
                            const attachments = msg.attachments ?? [];
                            if (attachments.length > 0) {
                                const contentBlocks: ContentBlockParam[] = [];
                                for (const att of attachments) {
                                    // Detect media type from the decrypted bytes' magic header
                                    // rather than trusting the wire-supplied mimeType. iOS image
                                    // pickers happily report things like "image/heic" or no
                                    // mimeType at all, which the Anthropic API rejects with a
                                    // strict enum validation error. If the bytes look like one
                                    // of the four formats Claude accepts, send that label —
                                    // otherwise skip the attachment with a debug log.
                                    const detected = detectClaudeImageMime(att.data);
                                    if (!detected) {
                                        logger.debug(`[remote] Skipping unsupported attachment (no magic-byte match): ${att.name}, claimed mimeType=${att.mimeType}`);
                                        continue;
                                    }
                                    contentBlocks.push({
                                        type: 'image' as const,
                                        source: {
                                            type: 'base64' as const,
                                            media_type: detected,
                                            data: Buffer.from(att.data).toString('base64'),
                                        },
                                    });
                                }
                                contentBlocks.push({ type: 'text' as const, text: msg.message });
                                logger.debug(`[remote] Combined ${contentBlocks.length - 1} image(s) with text message`);
                                return {
                                    message: contentBlocks,
                                    mode: msg.mode,
                                };
                            }

                            return {
                                message: msg.message,
                                mode: msg.mode
                            }
                        }

                        // Exit
                        return null;
                    },
                    onSessionFound: (sessionId) => {
                        // Update converter's session ID when new session is found
                        sdkToLogConverter.updateSessionId(sessionId);
                        session.onSessionFound(sessionId);
                    },
                    onSDKMetadata: (metadata) => {
                        logger.debug('[remote] SDK metadata received, updating session:', metadata);
                        session.client.updateMetadata((currentMetadata) => ({
                            ...currentMetadata,
                            tools: metadata.tools,
                            slashCommands: metadata.slashCommands,
                            mcpServers: metadata.mcpServers,
                            skills: metadata.skills,
                        }));
                    },
                    onUsageLimits: (patch) => {
                        // Merging against currentAgentState re-hydrates window
                        // state across claudeRemote re-entries (mode switches).
                        session.client.updateAgentState((currentAgentState) => ({
                            ...currentAgentState,
                            usageLimits: mergeUsageLimits(currentAgentState.usageLimits, patch),
                        }));
                    },
                    onQueryReady: (q) => {
                        permissionHandler.setPermissionModeUpdater(async (mode) => {
                            await q.setPermissionMode(mode);
                        });
                    },
                    onThinkingChange: session.onThinkingChange,
                    claudeEnvVars: session.claudeEnvVars,
                    claudeArgs: session.claudeArgs,
                    onMessage,
                    onCompletionEvent: (message: string) => {
                        logger.debug(`[remote]: Completion event: ${message}`);
                        session.client.sendSessionEvent({ type: 'message', message });
                    },
                    onSessionReset: () => {
                        logger.debug('[remote]: Session reset');
                        session.clearSessionId();
                    },
                    onReady: () => {
                        session.client.closeClaudeSessionTurn('completed');
                        if (!pending && session.queue.size() === 0) {
                            session.api.push().sendSessionNotification({
                                kind: 'done',
                                metadata: session.client.getMetadata(),
                                data: {
                                    sessionId: session.client.sessionId,
                                    type: 'ready',
                                    provider: 'claude',
                                }
                            });
                        }
                    },
                    signal: abortController.signal,
                });
                
                // Consume one-time Claude flags after spawn
                session.consumeOneTimeFlags();
                
                // A pending flip means this abort was the flip's own doing,
                // not the user pressing stop (BASED-127). Saying "Aborted by
                // user" there is a lie, and closing the turn as cancelled
                // contradicts the flip note that is about to say the session
                // is carrying on somewhere else. The local launcher makes the
                // same choice by checking for a flip before either exit path.
                if (!exitReason && controller.signal.aborted && !session.flip?.hasPending()) {
                    session.client.closeClaudeSessionTurn('cancelled');
                    session.client.sendSessionEvent({ type: 'message', message: 'Aborted by user' });
                }
            } catch (e) {
                logger.debug('[remote]: launch error', e);
                if (!exitReason) {
                    session.client.closeClaudeSessionTurn('failed');
                    session.client.sendSessionEvent({ type: 'message', message: launchFailureMessage(e) });
                    continue;
                }
            } finally {

                logger.debug('[remote]: launch finally');

                // Terminate all ongoing tool calls
                for (let [toolCallId, { parentToolCallId }] of ongoingToolCalls) {
                    const converted = sdkToLogConverter.generateInterruptedToolResult(toolCallId, parentToolCallId);
                    if (converted) {
                        logger.debug('[remote]: terminating tool call ' + toolCallId + ' parent: ' + parentToolCallId);
                        session.client.sendClaudeSessionMessage(converted);
                    }
                }
                ongoingToolCalls.clear();

                // Flush any remaining messages in the queue
                logger.debug('[remote]: flushing message queue');
                await messageQueue.flush();
                messageQueue.destroy();
                logger.debug('[remote]: message queue flushed');

                // Reset abort controller and future
                abortController = null;
                abortFuture?.resolve(undefined);
                abortFuture = null;
                logger.debug('[remote]: launch done');
                permissionHandler.reset();
                modeHash = null;
                mode = null;

                // Cattle Drover (BASED-127): the engine has stopped, and a
                // flip is one of the things that stops it — so this is remote
                // mode's equivalent of the two applyPendingFlip calls the
                // local launcher makes after its child exits.
                //
                // In the FINALLY rather than after it, because the catch
                // branch above `continue`s on a launch error and would jump
                // straight past a flip that is sitting right there. That is
                // the same shape of hole as the one this ticket is fixing: a
                // request accepted, logged, and then silently never carried
                // out. The finally runs on every path out of the turn.
                //
                // No resetAbort: this loop mints a fresh AbortController at
                // the top of every iteration, so there is no aborted signal to
                // re-arm — that is a local-launcher problem, where one
                // controller has to survive a relaunch.
                await applyPendingFlip({
                    session,
                    mode: 'remote',
                    deliverPrompt: queueArrivalPrompt,
                });
            }
        }
    } finally {

        // Clean up permission handler
        permissionHandler.reset();

        // Hand the flip controller back its null state (BASED-127). The
        // controller outlives every launcher, and both of these close over
        // things that die with THIS call: an AbortController that is already
        // aborted, and a tracker whose transcript tail belongs to an engine
        // that has stopped. Left registered, the stale abort handler is what
        // the next mode's flip would call — it would return quietly, having
        // stopped nothing, and the flip would queue forever.
        session.flip?.setAbortHandler(null);
        session.flip?.setInFlightProbe(null);

        // Reset Terminal
        const t0 = Date.now();
        logger.debug(`[remote]: cleanup begin exitReason=${exitReason} hasInk=${!!inkInstance} rawMode=${(process.stdin as any).isRaw}`);
        if (inkInstance) {
            inkInstance.unmount();
        }
        logger.debug(`[remote]: ink.unmount() done +${Date.now() - t0}ms rawMode=${(process.stdin as any).isRaw}`);

        // Drain any keystrokes that landed in stdin while Ink owned it (e.g.
        // extra spaces from the double-space switch confirmation, or anything
        // typed before the user perceives that the switch has completed) so
        // they don't leak into the next interactive child process when local
        // mode takes stdin back via stdio: 'inherit'. Raw mode stays on for
        // the whole window so the kernel does not echo any in-flight bytes
        // at whatever screen position Ink last left the cursor.
        await cleanupStdinAfterInk({
            stdin: process.stdin,
            drainMs: 150,
            onDebug: (event) => {
                logger.debug(`[remote]: stdin drain ${event.bytes}B / ${event.chunks} chunk(s) +${Date.now() - t0}ms`);
            },
        });
        logger.debug(`[remote]: cleanup done +${Date.now() - t0}ms rawMode=${(process.stdin as any).isRaw}`);
        messageBuffer.clear();

        // Resolve abort future
        if (abortFuture) { // Just in case of error
            abortFuture.resolve(undefined);
        }
    }

    return exitReason || 'exit';
}
