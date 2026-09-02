/**
 * pi session runner (DROVE-316).
 *
 * The daemon spawns this in a tmux window as:
 *   drover pi --happy-starting-mode local --started-by daemon
 *
 * WHY THIS EXISTS AT ALL. DROVE-295 made pi a drover harness: a pane, a gate
 * that really blocks, a model picked by lookup, a transcript the phone can
 * read. What it deliberately did NOT do is put pi in the phone's new-session
 * picker, and the reason is written into harnessCatalog.ts: appearing there is
 * a PROMISE that the daemon can spawn it. A tap opens a tmux window and expects
 * a happy-cli runner on the other end to register a Happy session. Without one,
 * the tap opens a window and then calls a session that never appears a success.
 * This file is that runner. The picker entry comes after it, never before.
 *
 * It is the runCursor shape rather than the runCodex one, on purpose. runCodex
 * is 1100 lines because the codex app-server speaks two notification dialects,
 * raises approvals as JSON-RPC requests, wedges mid-tool and has to be killed
 * and resumed by thread id, and carries a subagent graph. pi has none of that.
 * What it shares with codex — and the reason DROVE-295 called it "the codex
 * situation" — is that drover OWNS the loop, which is what makes the gate real.
 *
 * THE THREE THINGS THAT MAKE OR BREAK IT, all measured on pi 0.80.3:
 *
 *   --no-extensions   never passed. The local model PROVIDERS are extensions.
 *                     piArgs.ts refuses the flag and piArgs.test.ts pins it.
 *   shutdown          stdin first, signal last. pi flushes its transcript on a
 *                     clean exit and writes NOTHING when killed, so a runner
 *                     that SIGTERMs on Ctrl-C destroys the conversation it just
 *                     had. PiBackend.shutdown() and its test are the guard.
 *   the runtime       probed before the session is offered as ready, so a dead
 *                     LM Studio is a startup failure naming the port rather
 *                     than an opaque provider error on the first turn.
 *
 * The pane is a real half of the session, as it is for Cursor: pi's rpc mode
 * draws no TUI, so what this file prints IS what the human sees, and a line
 * typed here is a turn exactly like a message from the phone.
 */

import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ApiClient } from '@/api/api';
import type { ApiSessionClient } from '@/api/apiSession';
import { AcpSessionManager } from '@/agent/acp/AcpSessionManager';
import type { AgentMessage } from '@/agent/core';
import { createEnvelope, type SessionEnvelope } from '@slopus/happy-wire';
import { encodeBase64 } from '@/api/encryption';
import { notifyDaemonSessionStarted } from '@/daemon/controlClient';
import { initialMachineMetadata } from '@/daemon/run';
import { droverDir } from '@/drover/hooks';
import { Credentials, readSettings } from '@/persistence';
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler';
import { logger } from '@/ui/logger';
import { connectionState } from '@/utils/serverConnectionErrors';
import { createSessionMetadata } from '@/utils/createSessionMetadata';
import { setupOfflineReconnection } from '@/utils/setupOfflineReconnection';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { openDroverToolGate, piGateEnabled } from '@/codex/droverGate';
import { configuration } from '@/configuration';
import { piRegistrationLine } from './piRegistration';
import { PiBackend, type PiGateDecision, type PiState } from './PiBackend';
import { PiPermissionHandler } from './piPermissionHandler';
import { findPiBin, PI_BIN } from './piBin';
import { listPiModels, resolvePiModel, type PiModel } from './piModels';
import { probePiRuntime } from './piLocalRuntime';
import { subscribeHarnessAttachments, textWithHarnessAttachments } from '@/utils/harnessAttachments';
import { createSerialAsyncHandler } from '@/codex/utils/serialAsyncHandler';

/**
 * pi's own gate has three settings and they come from the ENVIRONMENT of the
 * pane, not from a per-session picker. The app knows this — DROVE-295's
 * modelModeOptions offers pi exactly one permission mode — so the session
 * publishes the one mode rather than a picker that cannot change anything.
 */
const PI_PERMISSION_MODE = 'default';

export interface RunPiOptions {
    credentials: Credentials;
    startedBy?: 'daemon' | 'terminal';
    /** A model string to resolve by lookup. Ambiguous is refused, never guessed. */
    model?: string | null;
    /** off | minimal | low | medium | high */
    thinking?: string | null;
    /** A pi session file path or partial uuid to resume. */
    resumeSessionId?: string | null;
    /** false disables the gate extension. The pane is then unsupervised. */
    gate?: boolean;
    /**
     * A file whose contents become this session's first prompt.
     *
     * A FILE rather than an argument, because `drover clone --to pi` writes
     * tens of kilobytes of retold conversation and one stray quote on a command
     * line turns the launch into a syntax error (DROVE-295).
     */
    seedFile?: string | null;
}

/** Where adapters/pi-gate.mjs lives, or null when the checkout cannot be found. */
export function piGateExtensionPath(root: string = droverDir()): string | null {
    const path = join(root, 'adapters', 'pi-gate.mjs');
    return existsSync(path) ? path : null;
}

/** `[{ code, value }]` — the shape the app's model picker reads (DROVE-295). */
export function piModelOptions(models: readonly PiModel[]): { code: string; value: string }[] {
    // Local first. pi knows about a great many models this machine has no key
    // for — auth.json is empty here on purpose — and an unreachable model is a
    // session that fails on its first turn.
    const local = models.filter((m) => m.local);
    const remote = models.filter((m) => !m.local);
    return [...local, ...remote].map((m) => ({
        code: m.ref,
        value: m.local ? `${m.id} (${m.provider})` : m.ref,
    }));
}

export async function runPi(opts: RunPiOptions): Promise<void> {
    const sessionTag = randomUUID();
    connectionState.setBackend('pi');
    const cwd = process.cwd();

    // ---- the binary. Resolved absolutely, because a session started from the
    // phone is spawned by a launchd daemon whose PATH does not have
    // /opt/homebrew/bin, which is exactly where pi installs. See piBin.ts.
    const piBin = findPiBin();
    if (!piBin) {
        throw new Error(
            `drover pi: '${PI_BIN}' is not installed, or not anywhere this process can see.\n`
            + '  install it:  npm install -g @earendil-works/pi-coding-agent\n'
            + '\n'
            + '  installed somewhere unusual?  HAPPY_PI_PATH=/path/to/pi',
        );
    }

    // ---- the model, BEFORE anything else exists.
    //
    // DROVE-253's rule: a model string is only real if the CLI itself lists it.
    // On this machine `openai/gpt-oss-120b` is listed under BOTH huggingface
    // and lmstudio, so a short name is genuinely ambiguous — one of those has a
    // local server behind it and the other has no key. Refusing here, with both
    // candidates named, beats a session that starts and then fails its first
    // turn with an auth error about a provider nobody chose.
    const models = await listPiModels(piBin, cwd);
    let resolvedModel: PiModel | null = null;
    if (opts.model) {
        const resolution = resolvePiModel(models, opts.model);
        if (!resolution.ok) throw new Error(resolution.message);
        resolvedModel = resolution.model;
    }

    // ---- the Happy session, so the phone can see it.
    const api = await ApiClient.create(opts.credentials);
    const settings = await readSettings();
    if (!settings?.machineId) throw new Error('No machine ID found in settings');
    await api.getOrCreateMachine({ machineId: settings.machineId, metadata: initialMachineMetadata });

    const gateOn = opts.gate !== false;
    const { state, metadata } = createSessionMetadata({
        flavor: 'pi',
        machineId: settings.machineId,
        startedBy: opts.startedBy,
        // Honest, and it is the gate that makes it so: every non-read tool call
        // raises a dialog that suspends the tool, and an unanswered one denies.
        // An ungated pane really does skip every approval, and says so.
        dangerouslySkipPermissions: !gateOn,
    });
    const meta = metadata as unknown as Record<string, unknown>;
    meta.permissionMode = PI_PERMISSION_MODE;
    meta.currentOperatingModeCode = PI_PERMISSION_MODE;
    if (models.length > 0) meta.models = piModelOptions(models);
    if (resolvedModel) {
        meta.modelMode = resolvedModel.ref;
        meta.currentModelCode = resolvedModel.ref;
    }
    if (opts.thinking) {
        meta.effortLevel = opts.thinking;
        meta.currentThoughtLevelCode = opts.thinking;
    }
    if (process.env.TMUX_PANE) meta.hasPane = true;

    const response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });

    let session: ApiSessionClient;
    let permissionHandler: PiPermissionHandler | null = null;
    const { session: initialSession, reconnectionHandle } = setupOfflineReconnection({
        api,
        sessionTag,
        metadata,
        state,
        response,
        onSessionSwap: (newSession) => {
            session = newSession;
            // Without this the handler holds a dead session and every gate
            // raised after a reconnect renders nowhere.
            permissionHandler?.updateSession(newSession);
        },
    });
    session = initialSession;
    permissionHandler = new PiPermissionHandler(session);
    // A previous process may have died holding cards. They can never be
    // answered now, so clear them rather than leaving the phone showing
    // questions that resolve nothing.
    permissionHandler.reset('Previous CLI process exited before responding');

    if (response) {
        try {
            await notifyDaemonSessionStarted(response.id, metadata, {
                encryptionKey: encodeBase64(response.encryptionKey),
                encryptionVariant: response.encryptionVariant,
                seq: response.seq,
                metadataVersion: response.metadataVersion,
                agentStateVersion: response.agentStateVersion,
            });
        } catch (error) {
            logger.debug('[pi] Failed to report session to daemon:', error);
        }
    }

    // ---- the agent.
    const gateExtension = gateOn ? piGateExtensionPath() : null;
    if (gateOn && !gateExtension) {
        // Loud, because the alternative is an unsupervised pane that looks
        // exactly like a supervised one.
        process.stderr.write(
            'drover pi: adapters/pi-gate.mjs was not found in the drover checkout.\n'
            + '  This session runs UNGATED. Point DROVER_DIR at your cattle-drover\n'
            + '  checkout, or pass --no-gate to say you meant it.\n\n',
        );
    }

    const backend = new PiBackend({
        piBin,
        cwd,
        spawnArgs: {
            gateExtension,
            model: resolvedModel?.ref ?? null,
            thinking: opts.thinking ?? null,
            resumeSessionId: opts.resumeSessionId ?? null,
        },
        echo: (text) => process.stdout.write(text),
        log: (msg) => logger.debug(`[pi] ${msg}`),
    });

    const sessionManager = new AcpSessionManager();
    const messageQueue = new MessageQueue2<Record<string, never>>(() => '');
    let shouldExit = false;
    let thinking = false;
    let abortController = new AbortController();

    const sendEnvelopes = (envelopes: SessionEnvelope[]) => {
        for (const envelope of envelopes) session.sendSessionProtocolMessage(envelope);
    };
    const onBackendMessage = (msg: AgentMessage) => {
        sendEnvelopes(sessionManager.mapMessage(msg));
    };
    backend.onMessage(onBackendMessage);

    // ---- the gate.
    //
    // Two surfaces race: the app's own permission card, and the drover bus
    // (gum in tmux, the watch, the phone's bus card). Whichever answers first
    // withdraws the other. This is DROVE-273's Codex shape, and the fail-open
    // line is drawn in the same place: a bus that could not be ASKED resolves
    // null and never wins the race, while a bus card nobody answered is a DENY.
    //
    // Everything that is not an explicit allow is a deny, on every path —
    // including the one where this handler throws. pi agrees: its dialog
    // resolves to `undefined` on timeout and undefined is not allow, so the
    // tool is refused by pi's own protocol even if drover says nothing at all.
    backend.setApprovalHandler(async ({ toolName, toolCallId, args }): Promise<PiGateDecision> => {
        const preview = previewArgs(args);
        const gate = piGateEnabled()
            ? openDroverToolGate({
                type: 'mcp',
                toolName,
                harness: 'pi',
                title: `pi wants to run ${toolName}`,
                preview,
                sessionId: session.sessionId ?? null,
                cwd,
            })
            : null;

        process.stdout.write(`\n  ? gate: ${toolName} ${preview.slice(0, 120)}\n`);
        try {
            const fromApp = permissionHandler!.handleToolCall(toolCallId, toolName, args ?? {});
            if (!gate) {
                const result = await fromApp;
                return result.decision === 'approved' || result.decision === 'approved_for_session'
                    ? 'allow'
                    : 'deny';
            }
            const fromBus = gate.decision.then((d) => (
                d === null
                    // Not a decision. Never settling is what keeps a bus that
                    // could not be asked from beating the phone to an answer.
                    ? new Promise<never>(() => { /* deliberately never settles */ })
                    : { source: 'bus' as const, decision: d }
            ));
            const winner = await Promise.race([
                fromApp.then((r) => ({ source: 'app' as const, decision: r.decision })),
                fromBus,
            ]);
            if (winner.source === 'bus') {
                permissionHandler!.resolveExternally(
                    toolCallId,
                    winner.decision === 'approved' ? 'approved' : 'denied',
                    'drover',
                );
                return winner.decision === 'approved' ? 'allow' : 'deny';
            }
            gate.cancel();
            return winner.decision === 'approved' || winner.decision === 'approved_for_session'
                ? 'allow'
                : 'deny';
        } catch (error) {
            gate?.cancel();
            logger.debug('[pi] gate failed; denying:', error);
            return 'deny';
        }
    });

    let piState: PiState;
    try {
        piState = await backend.start();
    } catch (error) {
        // The session exists by now, so it has to be told it is over rather
        // than left as a row on the phone that never says anything.
        await closeSession(session, reconnectionHandle, 'pi failed to start');
        throw error;
    }

    // ---- the runtime, BEFORE the prompt is offered.
    const provider = piState.model?.provider ?? '';
    const check = await probePiRuntime({
        provider,
        baseUrl: piState.model?.baseUrl ?? null,
        modelId: piState.model?.id ?? null,
    });
    if (!check.ok) {
        await backend.shutdown();
        await closeSession(session, reconnectionHandle, 'the local model runtime is down');
        throw new Error(check.error ?? `drover pi: ${provider} is not answering`);
    }
    if (check.warning) process.stderr.write(`${check.warning}\n\n`);

    const modelRef = piState.model ? `${piState.model.provider}/${piState.model.id}` : null;
    if (modelRef) {
        session.updateMetadata((current) => ({
            ...current,
            modelMode: modelRef,
            currentModelCode: modelRef,
        }));
    }

    subscribeHarnessAttachments(session, 'pi');
    session.onUserMessage(createSerialAsyncHandler(async (message) => {
        const attachments = await session.drainAttachmentsForUserMessage();
        // An image with no words is a real message (DROVE-378).
        if (!message.content.text && attachments.length === 0) return;
        messageQueue.push(message.content.text ?? '', {}, attachments.length > 0 ? attachments : undefined);
    }, (error) => {
        logger.warn('[pi] Failed to handle user message', {
            errorName: error instanceof Error ? error.name : typeof error,
        });
    }));

    // The clone seed, queued as the first turn once the session is ours. Read
    // here rather than at parse time so a session that failed to start never
    // pulls a large file into memory for nothing.
    if (opts.seedFile) {
        try {
            const seed = readFileSync(opts.seedFile, 'utf-8');
            if (seed.trim()) {
                sendEnvelopes([createEnvelope('user', { t: 'text', text: seed })]);
                messageQueue.push(seed, {});
            }
        } catch (error) {
            process.stderr.write(
                `drover pi: could not read the seed file ${opts.seedFile}: `
                + `${error instanceof Error ? error.message : String(error)}\n`,
            );
        }
    }

    // A model or thinking level picked in the app arrives as a metadata update.
    // Unlike Cursor, pi can take both on a RUNNING session — `set_model` and
    // `set_thinking_level` are real rpc commands — so they land immediately
    // rather than on the next turn. A pick pi refuses is reported and the
    // session keeps the model it had; it is never silently dropped.
    let appliedModel = modelRef;
    let appliedThinking = piState.thinkingLevel ?? opts.thinking ?? null;
    session.on('metadata', (updated: unknown) => {
        const next = updated as { modelMode?: string | null; effortLevel?: string | null } | null;
        const wantModel = next?.modelMode ?? null;
        if (wantModel && wantModel !== appliedModel) {
            appliedModel = wantModel;
            const resolution = resolvePiModel(models, wantModel);
            if (!resolution.ok) {
                process.stderr.write(`${resolution.message}\n`);
            } else {
                const picked = resolution.model;
                void backend.setModel(picked.provider, picked.id).then((r) => {
                    if (!r.ok) process.stderr.write(`drover pi: ${r.error}\n`);
                });
            }
        }
        const wantThinking = next?.effortLevel ?? null;
        if (wantThinking && wantThinking !== appliedThinking) {
            appliedThinking = wantThinking;
            void backend.setThinking(wantThinking);
        }
    });

    session.keepAlive(thinking, 'remote');
    const keepAliveInterval = setInterval(() => session.keepAlive(thinking, 'remote'), 2000);

    const handleAbort = async () => {
        // Pending permissions are released FIRST. A wedged approval is exactly
        // what an abort has to get past, and cancelling the turn underneath one
        // leaves the tool suspended with nobody left to answer it.
        permissionHandler?.abortAll();
        await backend.cancel();
        thinking = false;
        session.keepAlive(false, 'remote');
        abortController.abort();
        abortController = new AbortController();
    };
    session.rpcHandlerManager.registerHandler('abort', handleAbort);
    registerKillSessionHandler(session.rpcHandlerManager, async () => {
        shouldExit = true;
        messageQueue.close();
        await handleAbort();
    });

    // The pane's own keyboard. Without this the terminal half of a pi session
    // is read-only, which is not the same kind of session as every other one
    // drover runs — and for pi it is the only TUI there is.
    let stdinReader: ReturnType<typeof createInterface> | null = null;
    if (process.stdin.isTTY) {
        stdinReader = createInterface({ input: process.stdin });
        stdinReader.on('line', (line) => {
            const text = line.trim();
            if (!text) return;
            // Echoed into the session so the phone sees what was typed at the
            // keyboard. A pane whose half of the conversation is invisible in
            // the app is two conversations, not one session.
            sendEnvelopes([createEnvelope('user', { t: 'text', text })]);
            messageQueue.push(text, {});
        });
    }

    try {
        // WHERE it registered, not just THAT it did (DROVE-379). A session
        // that does not turn up in the app is otherwise indistinguishable
        // from one that went to another machine, account, home or server, and
        // telling those apart cost a morning of reading logs.
        const registration = piRegistrationLine({
            machineId: settings.machineId,
            happyHomeDir: configuration.happyHomeDir,
            serverUrl: configuration.serverUrl,
            account: process.env.DROVER_ACCOUNT,
            homeDir: homedir(),
        });
        process.stdout.write(
            `\npi session ${response?.id ?? sessionTag} — ${modelRef ?? 'no model'}\n`
            + `${piState.sessionId ? `pi session ${piState.sessionId}\n` : ''}`
            + `${registration ? `${registration}\n` : ''}`
            + 'type here or send from the phone; ctrl-c ends it\n\n',
        );

        while (!shouldExit) {
            const waitSignal = abortController.signal;
            const batch = await messageQueue.waitForMessagesAndGetAsString(waitSignal);
            if (!batch) {
                if (shouldExit) break;
                if (waitSignal.aborted) continue;
                break;
            }
            thinking = true;
            session.keepAlive(true, 'remote');
            sendEnvelopes(sessionManager.startTurn());
            try {
                await backend.sendPrompt(textWithHarnessAttachments({
                    text: batch.message,
                    attachments: batch.attachments,
                    sessionId: session.sessionId,
                    harness: 'pi',
                }));
                sendEnvelopes(sessionManager.endTurn('completed'));
            } catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                logger.debug(`[pi] turn failed: ${detail}`);
                process.stderr.write(`\npi turn failed: ${detail}\n`);
                sendEnvelopes(sessionManager.endTurn('failed'));
                // pi is gone, not merely unhappy. Carrying on would spin the
                // loop against a dead child forever.
                if (detail.includes('pi exited')) shouldExit = true;
            }
            thinking = false;
            session.keepAlive(false, 'remote');
            session.sendSessionEvent({ type: 'ready' });
            process.stdout.write('\n');
        }
    } finally {
        clearInterval(keepAliveInterval);
        stdinReader?.close();
        backend.offMessage(onBackendMessage);
        // THE TRANSCRIPT IS FLUSHED HERE, and this ordering is the point: pi is
        // shut down cleanly and given time to write its session file BEFORE the
        // Happy session is torn down. Killing the child on the way out — or
        // letting process exit take it — loses the whole conversation.
        await backend.shutdown();
        await closeSession(session, reconnectionHandle, 'Session ended');
    }
}

/** Archive and close, in the order every other runner uses. */
async function closeSession(
    session: ApiSessionClient,
    reconnectionHandle: { cancel: () => void } | null | undefined,
    reason: string,
): Promise<void> {
    reconnectionHandle?.cancel();
    try {
        session.updateMetadata((currentMetadata) => ({
            ...currentMetadata,
            lifecycleState: 'archived',
            lifecycleStateSince: Date.now(),
            archivedBy: 'cli',
            archiveReason: reason,
        }));
        session.sendSessionDeath();
        await session.flush();
        await session.close();
    } catch (error) {
        logger.debug('[pi] Session close failed:', error);
    }
}

/** The one line of a tool call worth putting on a card. */
export function previewArgs(args: Record<string, unknown> | null): string {
    if (!args) return '';
    if (typeof args.command === 'string') return args.command;
    if (typeof args.path === 'string') return args.path;
    if (typeof args.pattern === 'string') return args.pattern;
    try {
        return JSON.stringify(args).slice(0, 2000);
    } catch {
        return '';
    }
}
