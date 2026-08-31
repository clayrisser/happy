/**
 * Cursor session runner (DROVE-57).
 *
 * The daemon spawns this in a tmux window as:
 *   drover cursor --happy-starting-mode local --started-by daemon
 *
 * It is the runOpenClaw shape, because the job is the same one: create a Happy
 * session so the phone can see it, pump the agent's output through the shared
 * message mapper, and turn a message from the phone into a turn.
 *
 * What is deliberately NOT here, because Cursor does not have it:
 *
 *   accounts / flip   the flip moves Claude logins. Cursor has its own auth
 *                     and nothing to switch between, so no `droverAccount` is
 *                     stamped and the app's flip action stays hidden.
 *   permission modes  `--print` has no interactive approval. The turn runs
 *                     with `--force` and the session says so.
 *   effort            Cursor spells effort INSIDE the model id
 *                     (`cursor-grok-4.6-xhigh-fast`), so there is no second
 *                     axis to pick. The app shows no effort control.
 *
 * The pane is a real half of the session, not a spinner: the agent's text is
 * echoed to stdout, and a line typed into the pane is a turn exactly like a
 * message from the phone.
 */

import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { ApiClient } from '@/api/api';
import type { ApiSessionClient } from '@/api/apiSession';
import { AcpSessionManager } from '@/agent/acp/AcpSessionManager';
import type { AgentMessage } from '@/agent/core';
import { createEnvelope, type SessionEnvelope } from '@slopus/happy-wire';
import { encodeBase64 } from '@/api/encryption';
import { configuration } from '@/configuration';
import { notifyDaemonSessionStarted } from '@/daemon/controlClient';
import { initialMachineMetadata } from '@/daemon/run';
import { Credentials, readSettings } from '@/persistence';
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler';
import { logger } from '@/ui/logger';
import { connectionState } from '@/utils/serverConnectionErrors';
import { createSessionMetadata } from '@/utils/createSessionMetadata';
import { setupOfflineReconnection } from '@/utils/setupOfflineReconnection';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { CursorBackend } from './CursorBackend';
import { prepareSessionCursorConfigDir } from './cursorConfig';
import { listCursorModels } from './cursorModels';

export interface RunCursorOptions {
    credentials: Credentials;
    startedBy?: 'daemon' | 'terminal';
    /** Cursor model id for the first turn; the phone can change it later. */
    model?: string | null;
    /** An existing Cursor chat id to attach to. */
    resumeChatId?: string | null;
}

export async function runCursor(opts: RunCursorOptions): Promise<void> {
    const sessionTag = randomUUID();
    connectionState.setBackend('cursor');

    const api = await ApiClient.create(opts.credentials);
    const settings = await readSettings();
    if (!settings?.machineId) {
        throw new Error('No machine ID found in settings');
    }
    await api.getOrCreateMachine({ machineId: settings.machineId, metadata: initialMachineMetadata });

    const { state, metadata } = createSessionMetadata({
        flavor: 'cursor',
        machineId: settings.machineId,
        startedBy: opts.startedBy,
        // Honest, not incidental: a `--print` turn has no approval prompt to
        // raise, so every Cursor turn runs with --force and the phone must
        // show that rather than an inert permission picker.
        dangerouslySkipPermissions: true,
    });
    if (opts.model) {
        (metadata as unknown as Record<string, unknown>).modelMode = opts.model;
    }
    // The pane is real, so the app renders the session as one that has a
    // terminal in front of it rather than a headless run.
    if (process.env.TMUX_PANE) {
        (metadata as unknown as Record<string, unknown>).hasPane = true;
    }

    const response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });

    let session: ApiSessionClient;
    const { session: initialSession, reconnectionHandle } = setupOfflineReconnection({
        api,
        sessionTag,
        metadata,
        state,
        response,
        onSessionSwap: (newSession) => {
            session = newSession;
        },
    });
    session = initialSession;

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
            logger.debug('[cursor] Failed to report session to daemon:', error);
        }
    }

    const configDir = prepareSessionCursorConfigDir(
        join(configuration.happyHomeDir, 'cursor-sessions', sessionTag),
    );

    // The picker's list comes from the CLI, not from a table in the app, so it
    // cannot drift from what `--model` accepts. Published after the session
    // exists because the call costs a round trip and a session that appears a
    // second later is worse than a picker that fills a second later.
    void listCursorModels(configDir, process.cwd()).then((models) => {
        if (models.length === 0) return;
        session.updateMetadata((current) => ({ ...current, models }));
    });

    const backend = new CursorBackend({
        cwd: process.cwd(),
        configDir,
        model: opts.model ?? null,
        resumeChatId: opts.resumeChatId ?? null,
        echo: (text) => process.stdout.write(text),
        log: (msg) => logger.debug(`[cursor] ${msg}`),
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

    session.onUserMessage((message) => {
        if (!message.content.text) return;
        messageQueue.push(message.content.text, {});
    });

    // A model picked in the app arrives as a metadata update and takes effect
    // on the NEXT turn. It cannot change the turn already running: a Cursor
    // turn is one cursor-agent process and its model is fixed at exec.
    session.on('metadata', (updated: unknown) => {
        const next = (updated as { modelMode?: string | null } | null)?.modelMode ?? null;
        backend.setModel(next);
    });

    session.keepAlive(thinking, 'remote');
    const keepAliveInterval = setInterval(() => session.keepAlive(thinking, 'remote'), 2000);

    const handleAbort = async () => {
        await backend.cancel('');
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

    // The pane's own keyboard. Without this the terminal half of a Cursor
    // session is read-only, which is not the same kind of session as every
    // other one drover runs.
    let stdinReader: ReturnType<typeof createInterface> | null = null;
    if (process.stdin.isTTY) {
        stdinReader = createInterface({ input: process.stdin });
        stdinReader.on('line', (line) => {
            const text = line.trim();
            if (!text) return;
            // Echoed into the session so the phone sees what was typed at
            // the keyboard. A pane whose half of the conversation is invisible
            // in the app is two conversations, not one session.
            sendEnvelopes([createEnvelope('user', { t: 'text', text })]);
            messageQueue.push(text, {});
        });
    }

    try {
        const started = await backend.startSession();
        process.stdout.write(
            `\ncursor session ${response?.id ?? sessionTag} — chat ${started.sessionId}\n`
            + `type here or send from the phone; ctrl-c ends it\n\n`,
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
                await backend.sendPrompt(started.sessionId, batch.message);
                sendEnvelopes(sessionManager.endTurn('completed'));
            } catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                logger.debug(`[cursor] turn failed: ${detail}`);
                process.stderr.write(`\ncursor turn failed: ${detail}\n`);
                sendEnvelopes(sessionManager.endTurn('failed'));
            }
            thinking = false;
            session.keepAlive(false, 'remote');
            session.sendSessionEvent({ type: 'ready' });
            process.stdout.write('\n');
        }
    } finally {
        clearInterval(keepAliveInterval);
        stdinReader?.close();
        reconnectionHandle?.cancel();
        backend.offMessage(onBackendMessage);
        await backend.dispose();
        try {
            session.updateMetadata((currentMetadata) => ({
                ...currentMetadata,
                lifecycleState: 'archived',
                lifecycleStateSince: Date.now(),
                archivedBy: 'cli',
                archiveReason: 'Session ended',
            }));
            session.sendSessionDeath();
            await session.flush();
            await session.close();
        } catch (error) {
            logger.debug('[cursor] Session close failed:', error);
        }
    }
}

/** Where a session's isolated Cursor config lives, for tests and for humans. */
export function cursorSessionConfigDir(tag: string, home: string = os.homedir()): string {
    return join(home, '.happy', 'cursor-sessions', tag);
}
