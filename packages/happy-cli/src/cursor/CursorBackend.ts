/**
 * Cursor agent backend (DROVE-57).
 *
 * WHY IT IS SHAPED LIKE THIS, measured on cursor-agent 2026.08.25:
 *
 * cursor-agent has no inbox. There is no socket, no `--input-format`, and
 * nothing that feeds a RUNNING interactive TUI, so a phone message cannot be
 * delivered to one. What it does have is a durable chat: `create-chat` mints a
 * chat id, and `--print --resume <id>` runs ONE turn against that chat with
 * the full history intact. Proven: a second `--resume` run answered a question
 * about what the first run had said.
 *
 * So a turn is a process. The chat is the session, `--resume` is the thread,
 * and `--output-format stream-json` is the transcript — the same frames the
 * pane would draw, on stdout, where they can be mapped into Happy messages.
 * Nothing is tailed off disk and nothing is typed into a pane.
 *
 * `--force` is not a shortcut. In `--print` there is no interactive approval
 * to raise, so a turn without it stalls or refuses on the first shell command.
 *
 * MEASURED, and it is why the gate never answers `ask` (DROVE-253): a
 * `beforeShellExecution` hook returning `{"permission":"ask"}` under
 * `--print --force` does NOT reject and does not prompt. The tool call sat for
 * ~20s and then RAN — `executionTime 20603ms` against `localExecutionTimeMs
 * 495`, exit 0, stdout delivered. So `ask` is fail-OPEN with a twenty-second
 * tax. A gate with nobody to ask must answer `deny`.
 *
 * `--force` is no longer the only mode, though. `--mode plan|ask`,
 * `--auto-review` and `--sandbox` are real argv, so the app's permission
 * picker maps onto something (see `cursorPermission.ts`). What cannot be done
 * is reading the choice back: the init frame hardcodes
 * `permissionMode:"default"` — literally, out of the bundle — under `--force`
 * and under `--mode ask` alike.
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { AgentBackend, AgentMessage, AgentMessageHandler, StartSessionResult } from '@/agent/core';
import { logger } from '@/ui/logger';
import { resolveCursorBin } from './cursorBin';
import {
    splitFrames,
    CursorFrameMapper,
    readCursorUsage,
    readCursorApiKeySource,
    type CursorUsage,
} from './cursorStream';
import { cursorTurnEnv, scrubbedCursorVars, type CursorOwnedCredential } from './cursorEnv';
import { listCursorModels, type CursorModelListing } from './cursorModels';
import { cursorPermissionArgs } from './cursorPermission';

const execFileAsync = promisify(execFile);

export interface CursorBackendOptions {
    cwd: string;
    /** CURSOR_CONFIG_DIR for this session. See cursorConfig.ts for why it is its own. */
    configDir: string;
    /** Cursor model id, e.g. `cursor-grok-4.6-xhigh-fast`. Null means the config default. */
    model?: string | null;
    /** An app permission-mode code. See cursorPermission.ts for the mapping. */
    permissionMode?: string | null;
    /** An existing chat id to attach to instead of minting a new one. */
    resumeChatId?: string | null;
    /**
     * A credential this SESSION owns, if any. Absent means the machine login,
     * and an inherited `CURSOR_API_KEY` is scrubbed rather than honoured.
     */
    credential?: CursorOwnedCredential;
    /** Echo the agent's text to this sink so the tmux pane shows the conversation. */
    echo?: (text: string) => void;
    log?: (msg: string) => void;
    /** `apiKeySource` off the init frame, once per turn. `login` is the quiet one. */
    onApiKeySource?: (source: string) => void;
    /** The `usage` block off the result frame, once per turn that produced one. */
    onUsage?: (usage: CursorUsage) => void;
}

export class CursorBackend implements AgentBackend {
    private readonly opts: CursorBackendOptions;
    private readonly handlers = new Set<AgentMessageHandler>();
    private child: ChildProcessByStdio<null, Readable, Readable> | null = null;
    private chatId: string | null = null;
    private cancelled = false;
    /** The model in force for the NEXT turn, so a pick lands without a restart. */
    private model: string | null;
    /** Likewise the permission mode. A running turn's mode is fixed at exec. */
    private permissionMode: string | null;

    constructor(opts: CursorBackendOptions) {
        this.opts = opts;
        this.model = opts.model ?? null;
        this.permissionMode = opts.permissionMode ?? null;
    }

    private log(msg: string) {
        (this.opts.log ?? ((m: string) => logger.debug(`[cursor] ${m}`)))(msg);
    }

    private emit(msg: AgentMessage) {
        for (const handler of this.handlers) handler(msg);
    }

    onMessage(handler: AgentMessageHandler): void {
        this.handlers.add(handler);
    }

    offMessage(handler: AgentMessageHandler): void {
        this.handlers.delete(handler);
    }

    /** The chat this session is driving, once it exists. */
    get currentChatId(): string | null {
        return this.chatId;
    }

    setModel(model: string | null): void {
        this.model = model;
        this.log(`model for the next turn: ${model ?? 'the config default'}`);
    }

    setPermissionMode(mode: string | null): void {
        this.permissionMode = mode;
        this.log(`permission mode for the next turn: ${mode ?? 'the default'}`);
    }

    /**
     * The turn's environment, with the identity variables scrubbed unless this
     * session owns one. See cursorEnv.ts for why that is not paranoia: an
     * inherited key is EXCHANGED for tokens and persisted into the machine
     * keychain, so it can overwrite the login the IDE uses.
     */
    private env(): NodeJS.ProcessEnv {
        const scrubbed = scrubbedCursorVars(this.opts.credential ?? {});
        if (scrubbed.length > 0) {
            this.log(`scrubbed from the turn environment: ${scrubbed.join(', ')}`);
        }
        return cursorTurnEnv(this.opts.configDir, this.opts.credential ?? {});
    }

    /**
     * `--list-models`, under exactly the environment a turn gets (DROVE-395).
     *
     * The list used to build an env of its own beside the turn's. Same
     * function today, so the same answer today; but the question the picker
     * asks is "what can the NEXT TURN run", and the only way that stays true
     * through whatever the turn env grows next is to ask it from here. What
     * came back, or why nothing did, is the caller's to publish.
     */
    async listModels(): Promise<CursorModelListing> {
        return listCursorModels({ cwd: this.opts.cwd, env: this.env() });
    }

    /**
     * Mint the chat up front, so the session has an id before anyone has typed.
     * A chat that cannot be created is fatal: a session that reports itself
     * alive and then fails every turn is worse than one that never started.
     */
    async startSession(): Promise<StartSessionResult> {
        if (this.opts.resumeChatId) {
            this.chatId = this.opts.resumeChatId;
            this.log(`resuming chat ${this.chatId}`);
            return { sessionId: this.chatId };
        }
        const { stdout } = await execFileAsync(resolveCursorBin(), ['create-chat'], {
            cwd: this.opts.cwd,
            env: this.env(),
            timeout: 60_000,
        });
        const id = stdout.trim().split('\n').pop()?.trim() ?? '';
        if (!id) throw new Error('cursor-agent create-chat returned no chat id');
        this.chatId = id;
        this.log(`chat ${id}`);
        return { sessionId: id };
    }

    /** One turn: one cursor-agent process, its stdout mapped as it arrives. */
    async sendPrompt(_sessionId: string, prompt: string): Promise<void> {
        if (!this.chatId) throw new Error('cursor backend has no chat; startSession first');
        this.cancelled = false;

        const args = [
            '--print',
            '--output-format', 'stream-json',
            // Real text deltas instead of one lump per assistant run. The
            // trailing repeat this turns on is dropped by CursorFrameMapper;
            // see cursorStream.ts for the two signals that identify it.
            '--stream-partial-output',
            // NOT optional. Without it a directory Cursor has not seen stops
            // the run dead with an interactive "Workspace Trust Required"
            // prompt on stderr and exit 1 — which from the phone reads as a
            // session that simply does nothing.
            '--trust',
            ...cursorPermissionArgs(this.permissionMode),
            '--resume', this.chatId,
        ];
        if (this.model) args.push('--model', this.model);
        args.push(prompt);

        const child = spawn(resolveCursorBin(), args, {
            cwd: this.opts.cwd,
            env: this.env(),
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        this.child = child;

        let buffer = '';
        let stderr = '';
        let sawResult = false;
        // One mapper per turn: the assistant-run accumulator it holds is only
        // meaningful within a turn, and carrying it across would let the last
        // frame of one turn suppress the first frame of the next.
        const mapper = new CursorFrameMapper();

        child.stdout.setEncoding('utf-8');
        child.stdout.on('data', (chunk: string) => {
            buffer += chunk;
            const { frames, rest } = splitFrames(buffer);
            buffer = rest;
            for (const frame of frames) {
                if (frame.type === 'result') sawResult = true;
                const source = readCursorApiKeySource(frame);
                if (source) this.opts.onApiKeySource?.(source);
                const usage = readCursorUsage(frame);
                if (usage) this.opts.onUsage?.(usage);
                for (const msg of mapper.map(frame)) {
                    if (msg.type === 'model-output' && msg.textDelta && this.opts.echo) {
                        this.opts.echo(msg.textDelta);
                    }
                    this.emit(msg);
                }
            }
        });
        child.stderr.setEncoding('utf-8');
        child.stderr.on('data', (chunk: string) => {
            stderr += chunk;
            if (stderr.length > 8000) stderr = stderr.slice(-8000);
        });

        const code = await new Promise<number>((resolve) => {
            child.on('error', (err) => {
                this.emit({ type: 'status', status: 'error', detail: err.message });
                resolve(-1);
            });
            child.on('close', (c) => resolve(c ?? -1));
        });
        this.child = null;

        if (this.cancelled) {
            this.emit({ type: 'status', status: 'idle' });
            return;
        }
        // A turn that never produced a `result` frame did not end; say so
        // rather than letting the app show a turn that just stops.
        if (code !== 0 && !sawResult) {
            const detail = stderr.trim() || `cursor-agent exited ${code}`;
            this.emit({ type: 'status', status: 'error', detail });
            throw new Error(detail);
        }
        if (!sawResult) {
            this.emit({ type: 'status', status: 'idle' });
        }
    }

    async cancel(_sessionId: string): Promise<void> {
        this.cancelled = true;
        const child = this.child;
        if (!child) return;
        child.kill('SIGTERM');
        // SIGKILL after a grace period, because a turn that ignores the stop
        // keeps writing frames into a session the phone thinks is idle.
        setTimeout(() => {
            if (this.child === child) child.kill('SIGKILL');
        }, 2000).unref?.();
    }

    async dispose(): Promise<void> {
        await this.cancel('');
        this.handlers.clear();
    }
}
