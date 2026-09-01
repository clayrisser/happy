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
 *   accounts / flip   the flip moves Claude logins. Cursor keys its credential
 *                     to the machine, not to a config dir, and publishes no
 *                     quota or reset time anywhere, so there is nothing to
 *                     switch between and nothing to decide with (DROVE-253).
 *                     No `droverAccount` is stamped and the flip stays hidden.
 *
 * What IS here now, and was not (DROVE-253):
 *
 *   permission modes  `--mode plan|ask`, `--force` and `--auto-review` are
 *                     real argv, so the picker maps onto something. The choice
 *                     is the session's own record, never read back off the
 *                     init frame, which reports "default" for all of them.
 *   effort            Cursor spells effort INSIDE the model id
 *                     (`cursor-grok-4.6-xhigh-fast`), and the bracket override
 *                     its help advertises was MEASURED to be rejected on this
 *                     login. So the id is split into a family and a tier, the
 *                     app picks each, and the tier is rejoined by lookup.
 *   token counts      the `result` frame's `usage`, per turn and summed.
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
import { readCursorSeed } from './cursorSeed';
import { prepareSessionCursorConfigDir } from './cursorConfig';
import {
    listCursorModels,
    buildCursorModelCatalog,
    resolveCursorModelId,
    splitCursorModelId,
    type CursorModelCatalog,
} from './cursorModels';
import {
    cursorPermissionCatalog,
    cursorPermissionModes,
    cursorModeSkipsPermissions,
} from './cursorPermission';
import { cursorApiKeySourceIsOwnLogin } from './cursorEnv';
import { addCursorUsage, emptyCursorUsageTally, type CursorUsageTally } from './cursorStream';

export interface RunCursorOptions {
    credentials: Credentials;
    startedBy?: 'daemon' | 'terminal';
    /** Cursor model id for the first turn; the phone can change it later. */
    model?: string | null;
    /** An existing Cursor chat id to attach to. */
    resumeChatId?: string | null;
    /** An app permission-mode code for the first turn. See cursorPermission.ts. */
    permissionMode?: string | null;
    /**
     * True when `drover cursor --gate` registered the permission gate, so the
     * `auto-review` mode has something to answer its prompts. Without a gate
     * that mode is a twenty-second pause and then yes, so it is not offered.
     */
    gated?: boolean;
    /**
     * A file whose contents become this session's FIRST TURN (DROVE-337).
     *
     * This is the lane a CLONE lands in. `drover clone --to cursor` exports
     * the source conversation and hands the FILE over, never the text: a seed
     * runs to tens of kilobytes and one stray quote on a command line would
     * turn a clone into a syntax error.
     *
     * Read ONCE, here, and submitted through the same queue a message from
     * the phone goes through, so the seed is an ordinary turn rather than a
     * second way to talk to the backend.
     */
    seedFile?: string | null;
}


export async function runCursor(opts: RunCursorOptions): Promise<void> {
    const sessionTag = randomUUID();
    connectionState.setBackend('cursor');

    // Before the API call, before the window has anything in it: a seed that
    // cannot be read must not cost a registered session that the phone then
    // shows as a working clone.
    const seed = opts.seedFile ? readCursorSeed(opts.seedFile) : null;

    const api = await ApiClient.create(opts.credentials);
    const settings = await readSettings();
    if (!settings?.machineId) {
        throw new Error('No machine ID found in settings');
    }
    await api.getOrCreateMachine({ machineId: settings.machineId, metadata: initialMachineMetadata });

    const permissionModes = cursorPermissionCatalog({ gated: opts.gated });
    const initialMode = opts.permissionMode ?? cursorPermissionModes.bypassPermissions;
    const { state, metadata } = createSessionMetadata({
        flavor: 'cursor',
        machineId: settings.machineId,
        startedBy: opts.startedBy,
        // Still honest, and now conditional: `--force` really does skip every
        // approval, but it is no longer the only mode this harness can run in.
        dangerouslySkipPermissions: cursorModeSkipsPermissions(initialMode),
    });
    const meta = metadata as unknown as Record<string, unknown>;
    // The permission picker is published, not hardcoded in the app: `cursor`
    // is not one of the flavors with a built-in mode table, and the app reads
    // `operatingModes` for anything that is not. So a mode this build supports
    // appears without an app release, and one it drops disappears the same way.
    meta.operatingModes = permissionModes;
    meta.currentOperatingModeCode = initialMode;
    meta.permissionMode = initialMode;
    const initialSplit = opts.model ? splitCursorModelId(opts.model) : null;
    if (initialSplit) {
        meta.modelMode = initialSplit.base;
        meta.currentModelCode = initialSplit.base;
        if (initialSplit.effort) {
            meta.effortLevel = initialSplit.effort;
            meta.currentThoughtLevelCode = initialSplit.effort;
        }
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

    // The pickers come from the CLI, not from a table in the app, so they
    // cannot drift from what `--model` accepts. Published after the session
    // exists because the call costs a round trip and a session that appears a
    // second later is worse than a picker that fills a second later.
    //
    // The flat list is folded into families plus an effort axis first: sixty
    // near-duplicate ids is not a picker, and the tier in the id is the only
    // effort control cursor-agent actually honours (cursorModels.ts).
    let catalog: CursorModelCatalog | null = null;
    void listCursorModels(configDir, process.cwd()).then((flat) => {
        if (flat.length === 0) return;
        catalog = buildCursorModelCatalog(flat);
        const built = catalog;
        session.updateMetadata((current) => ({
            ...current,
            models: built.models,
            ...(built.efforts.length > 0 ? { thoughtLevels: built.efforts } : {}),
        }));
    });

    let usageTally: CursorUsageTally = emptyCursorUsageTally;

    const backend = new CursorBackend({
        cwd: process.cwd(),
        configDir,
        model: opts.model ?? null,
        permissionMode: initialMode,
        resumeChatId: opts.resumeChatId ?? null,
        echo: (text) => process.stdout.write(text),
        log: (msg) => logger.debug(`[cursor] ${msg}`),
        // A turn that is NOT running as the machine's own login has to say so.
        // An inherited key is scrubbed before the turn (cursorEnv.ts), so this
        // firing at all means either the session owns a key or cursor-agent
        // found one somewhere drover does not control — either way, visible.
        onApiKeySource: (source) => {
            if (cursorApiKeySourceIsOwnLogin(source)) return;
            logger.debug(`[cursor] running under apiKeySource=${source}, not the machine login`);
            session.updateMetadata((current) => ({
                ...current,
                cursorApiKeySource: source,
            }));
        },
        // Cursor reports usage once, at turn end, and nothing finer. Enough for
        // a turn and a session tally; not enough for a live clock, which is why
        // liveStatus stays a Claude-only thing for this harness.
        onUsage: (usage) => {
            usageTally = addCursorUsage(usageTally, usage);
            const tally = usageTally;
            session.updateMetadata((current) => ({
                ...current,
                cursorUsage: {
                    turn: {
                        inputTokens: usage.inputTokens,
                        outputTokens: usage.outputTokens,
                        cacheReadTokens: usage.cacheReadTokens,
                        cacheWriteTokens: usage.cacheWriteTokens,
                    },
                    session: {
                        turns: tally.turns,
                        inputTokens: tally.inputTokens,
                        outputTokens: tally.outputTokens,
                        cacheReadTokens: tally.cacheReadTokens,
                        cacheWriteTokens: tally.cacheWriteTokens,
                    },
                },
            }));
        },
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

    // A model, effort or mode picked in the app arrives as a metadata update
    // and takes effect on the NEXT turn. None of them can change the turn
    // already running: a Cursor turn is one cursor-agent process and its argv
    // is fixed at exec.
    let appliedMode: string | null = initialMode;
    session.on('metadata', (updated: unknown) => {
        const next = updated as {
            modelMode?: string | null;
            effortLevel?: string | null;
            permissionMode?: string | null;
        } | null;
        // Model and effort are one string to cursor-agent, so a change to
        // either has to be resolved against the whole catalog. Before the
        // catalog arrives the pick is passed through untouched, which is the
        // old behaviour and still correct for a full id.
        const family = next?.modelMode ?? null;
        const effort = next?.effortLevel ?? null;
        backend.setModel(catalog ? resolveCursorModelId(catalog, family, effort) : family);

        const mode = next?.permissionMode ?? null;
        backend.setPermissionMode(mode);
        // The info screen's "skips permissions" line has to follow the mode,
        // or a session sitting in Plan still reads as one that runs anything.
        // Guarded on a real change because this writes metadata from inside a
        // metadata handler, and an unguarded write is a loop.
        if (mode !== appliedMode) {
            appliedMode = mode;
            const skips = cursorModeSkipsPermissions(mode);
            session.updateMetadata((current) => (
                current?.dangerouslySkipPermissions === skips
                    ? current
                    : { ...current, dangerouslySkipPermissions: skips }
            ));
        }
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

        // The clone's first turn (DROVE-337). Echoed as a user envelope for
        // the same reason a line typed into the pane is: a half of the
        // conversation the app cannot see is two conversations, not one
        // session, and the seed is the only thing this session knows.
        //
        // Queued rather than sent straight to the backend, so it is an
        // ordinary turn: it takes the turn markers, the keepAlive and the
        // failure handling every other turn takes. And queued AFTER the
        // banner, so the pane says what session this is before it fills with
        // a retold conversation.
        if (seed) {
            sendEnvelopes([createEnvelope('user', { t: 'text', text: seed })]);
            messageQueue.push(seed, {});
        }

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
