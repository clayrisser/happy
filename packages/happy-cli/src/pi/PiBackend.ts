/**
 * The pi RPC client (DROVE-316).
 *
 * `pi --mode rpc` is a real bidirectional JSONL protocol on stdin and stdout —
 * measured by DROVE-295 against pi 0.80.3 by driving it, not read off a doc
 * page. Commands go in correlated by `id`, responses come back with the same
 * `id`, and events stream out in between. So this file OWNS the agent loop
 * rather than watching a stream somebody else owns, which is the codex
 * situation and is what makes the gates real.
 *
 * It is deliberately NOT the codexAppServerClient shape. That file is 1600
 * lines because codex speaks two notification dialects that must be
 * de-duplicated against each other, raises approvals as JSON-RPC REQUESTS that
 * must be responded to, wedges mid-tool and has to be killed and resumed by
 * thread id, and carries a collab-subagent graph. pi has none of that: one
 * dialect, events not requests, and a stop that works. What survives from
 * codex is the request/response correlation and the approval race; the rest is
 * the runCursor/AgentBackend shape.
 *
 * THREE MEASURED FACTS THIS FILE IS BUILT AROUND, each of which silently ruins
 * the runner if it is forgotten:
 *
 *  1. NEVER `--no-extensions`. The local model PROVIDERS are extensions, so
 *     that flag makes pi answer `Unknown provider "lmstudio"` and refuse to
 *     start. The argv is built by piArgs.ts, which refuses the flag outright,
 *     and the gate is loaded with `--extension` on TOP of discovery.
 *
 *  2. SIGTERM LOSES THE ENTIRE TRANSCRIPT. pi flushes its session JSONL on a
 *     graceful exit and writes NOTHING AT ALL when killed — the conversation is
 *     not truncated, it is absent. Closing stdin is the graceful path (measured:
 *     exit 0, file on disk), so `shutdown()` ends stdin FIRST and only escalates
 *     to a signal after a grace period that the child is given a real chance to
 *     use. PiBackend.test.ts proves a terminated session keeps its history.
 *
 *  3. Gates have no protocol message of their own. The `tool_call` extension
 *     event fires before the tool runs and CAN BLOCK, and in rpc mode
 *     `ctx.ui.select()` reaches us as an `extension_ui_request` and SUSPENDS
 *     the tool until we write an `extension_ui_response` back. A dialog that
 *     times out resolves to `undefined`, and undefined is not allow — so
 *     fail-closed is NATIVE here rather than a rule this file remembers to
 *     follow. The title carries the tool call id (`pi wants to run bash [id]`)
 *     because pi's dialog options have no field for a payload, and the id is
 *     the join back to the arguments `tool_execution_start` already delivered.
 */

import { spawn, type ChildProcess } from 'node:child_process';

import type { AgentMessage, AgentMessageHandler } from '@/agent/core';
import { logger } from '@/ui/logger';
import { buildPiRpcArgs, type PiSpawnArgsOptions } from './piArgs';

/** The `data` block `get_state` answers with, as far as this file reads it. */
export interface PiState {
    sessionId: string | null;
    /** The ABSOLUTE path pi is writing its transcript to. Never derived. */
    sessionFile: string | null;
    thinkingLevel: string | null;
    model: { provider: string; id: string; baseUrl?: string | null; name?: string } | null;
}

export type PiGateDecision = 'allow' | 'deny';

/**
 * Answer a gate. Returning 'deny' — or throwing, or never being set — denies.
 * There is no third outcome and no default of allow.
 */
export type PiApprovalHandler = (req: {
    /** The tool pi is about to run, off the dialog title. */
    toolName: string;
    /** The tool call id, off the dialog title. Joins to the args below. */
    toolCallId: string;
    /** The arguments `tool_execution_start` carried, if we saw it. */
    args: Record<string, unknown> | null;
}) => Promise<PiGateDecision>;

export interface PiBackendOptions {
    piBin: string;
    cwd: string;
    env?: NodeJS.ProcessEnv;
    spawnArgs?: PiSpawnArgsOptions;
    /** Echo the agent's text to the pane. */
    echo?: (text: string) => void;
    log?: (msg: string) => void;
    /** How long to wait for a clean exit before signalling. */
    shutdownGraceMs?: number;
}

/** `pi wants to run <tool> [<callId>]` — the contract adapters/pi-gate.mjs writes. */
const GATE_TITLE = /^pi wants to run (\S+) \[([^\]]+)\]$/;

const HANDSHAKE_ATTEMPTS = 40;
const HANDSHAKE_INTERVAL_MS = 250;
const COMMAND_TIMEOUT_MS = 15_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 5_000;

const sleep = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms).unref?.(); });

export class PiBackend {
    private readonly opts: PiBackendOptions;
    private readonly handlers = new Set<AgentMessageHandler>();
    private child: ChildProcess | null = null;
    private approvalHandler: PiApprovalHandler | null = null;

    /** command id -> resolve, for the commands whose answer we need. */
    private readonly waiting = new Map<string, (msg: PiFrame | null) => void>();
    /** toolCallId -> the args `tool_execution_start` carried, for the gate card. */
    private readonly pendingTools = new Map<string, { name: string; args: Record<string, unknown> }>();
    private seq = 0;

    /** Resolved by `agent_end`. Null between turns. */
    private turn: { resolve: () => void; reject: (e: Error) => void } | null = null;
    /** How much of the current assistant message has already been emitted. */
    private emittedText = '';
    private exited: Promise<number> | null = null;
    private stopping = false;

    private state: PiState | null = null;

    constructor(opts: PiBackendOptions) {
        this.opts = opts;
    }

    private log(msg: string) {
        (this.opts.log ?? ((m: string) => logger.debug(`[pi] ${m}`)))(msg);
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

    setApprovalHandler(handler: PiApprovalHandler): void {
        this.approvalHandler = handler;
    }

    /** The handshake's answer: session id, transcript path, model in force. */
    get currentState(): PiState | null {
        return this.state;
    }

    /**
     * Spawn pi and complete the `get_state` handshake.
     *
     * The handshake is not decoration. It is the only way to learn the ABSOLUTE
     * path pi is writing its transcript to — the filename carries a timestamp
     * prefix, so nothing can join a session id to a file by arithmetic — and it
     * is the earliest point at which the model actually in force, with its
     * baseUrl, is knowable. The startup health check needs both.
     */
    async start(): Promise<PiState> {
        if (this.child) throw new Error('pi backend already started');
        const args = buildPiRpcArgs(this.opts.spawnArgs);
        this.log(`spawn ${this.opts.piBin} ${args.join(' ')}`);

        const child = spawn(this.opts.piBin, args, {
            cwd: this.opts.cwd,
            env: this.opts.env ?? process.env,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        this.child = child;

        this.exited = new Promise<number>((resolve) => {
            child.on('exit', (code) => {
                this.log(`pi exited ${code}`);
                // Nothing is going to answer any of these now. Failing them is
                // the honest outcome; leaving them pending hangs the turn.
                for (const [id, r] of this.waiting) { this.waiting.delete(id); r(null); }
                const turn = this.turn;
                this.turn = null;
                turn?.reject(new Error(`pi exited ${code ?? 'unexpectedly'}`));
                resolve(code ?? -1);
            });
        });

        let spawnError: Error | null = null;
        child.on('error', (err) => {
            spawnError = err;
            this.log(`could not start '${this.opts.piBin}': ${err.message}`);
        });

        child.stderr?.setEncoding('utf-8');
        child.stderr?.on('data', (chunk: string) => this.log(`stderr: ${chunk.trimEnd()}`));

        this.readFrames(child);

        // get_state is the handshake, and it is retried because pi loads its
        // extensions — including the local model PROVIDERS — before it answers.
        let state: PiState | null = null;
        for (let i = 0; i < HANDSHAKE_ATTEMPTS && !state; i++) {
            if (spawnError) break;
            if (child.exitCode !== null) break;
            const r = await this.ask('get_state');
            if (r?.success && r.data) state = readPiState(r.data);
            else await sleep(HANDSHAKE_INTERVAL_MS);
        }
        if (spawnError) {
            throw new Error(
                `drover pi: could not start '${this.opts.piBin}': ${(spawnError as Error).message}`,
            );
        }
        if (!state) {
            await this.shutdown();
            throw new Error(
                `drover pi: '${this.opts.piBin}' never answered get_state.\n`
                + '  Is it really pi, and does this build support --mode rpc?\n'
                + '  check with:  pi --version   (0.80.3 or newer)',
            );
        }
        this.state = state;
        return state;
    }

    /**
     * STRICT JSONL, LF ONLY.
     *
     * pi's own docs single this out and it is not pedantry: node's `readline`
     * also splits on U+2028 and U+2029, which are LEGAL INSIDE A JSON STRING.
     * A transcript containing one would be torn in half by a generic line
     * reader and the frame lost. Splitting on \n and stripping a trailing \r is
     * the whole contract.
     */
    private readFrames(child: ChildProcess): void {
        let buf = '';
        child.stdout?.setEncoding('utf-8');
        child.stdout?.on('data', (chunk: string) => {
            buf += chunk;
            for (;;) {
                const i = buf.indexOf('\n');
                if (i < 0) break;
                const line = buf.slice(0, i).replace(/\r$/, '');
                buf = buf.slice(i + 1);
                if (!line.trim()) continue;
                let frame: PiFrame;
                try {
                    frame = JSON.parse(line) as PiFrame;
                } catch {
                    this.log(`unparseable frame: ${line.slice(0, 200)}`);
                    continue;
                }
                void this.handle(frame).catch((err) => {
                    this.log(`handle ${String(frame.type)}: ${err instanceof Error ? err.message : String(err)}`);
                });
            }
        });
    }

    private send(obj: Record<string, unknown>): void {
        const stdin = this.child?.stdin;
        if (!stdin || stdin.destroyed || !stdin.writable) return;
        stdin.write(JSON.stringify(obj) + '\n');
    }

    /** A command whose response we wait for, correlated by `id`. */
    private ask(type: string, extra?: Record<string, unknown>): Promise<PiFrame | null> {
        const id = `drover-${++this.seq}`;
        return new Promise((resolve) => {
            this.waiting.set(id, resolve);
            this.send({ id, type, ...(extra ?? {}) });
            setTimeout(() => {
                if (this.waiting.delete(id)) resolve(null);
            }, COMMAND_TIMEOUT_MS).unref?.();
        });
    }

    private async handle(msg: PiFrame): Promise<void> {
        if (msg.type === 'response') {
            const r = msg.id ? this.waiting.get(msg.id) : undefined;
            if (r && msg.id) {
                this.waiting.delete(msg.id);
                r(msg);
            }
            return;
        }
        if (msg.type === 'extension_ui_request') return this.onUiRequest(msg);

        if (msg.type === 'agent_start' || msg.type === 'turn_start') {
            this.emit({ type: 'status', status: 'running' });
            return;
        }
        if (msg.type === 'message_start') {
            this.emittedText = '';
            return;
        }
        if (msg.type === 'tool_execution_start') {
            const callId = String(msg.toolCallId ?? '');
            const name = String(msg.toolName ?? 'tool');
            const args = (msg.args ?? {}) as Record<string, unknown>;
            this.pendingTools.set(callId, { name, args });
            // A tool call, rendered as a tool call. AcpSessionManager turns this
            // into a `tool-call-start` envelope, which is what gives the app a
            // tool card instead of a paragraph of JSON in the chat.
            this.emit({ type: 'tool-call', toolName: name, args, callId });
            return;
        }
        if (msg.type === 'tool_execution_end') {
            const callId = String(msg.toolCallId ?? '');
            const pending = this.pendingTools.get(callId);
            this.pendingTools.delete(callId);
            this.emit({
                type: 'tool-result',
                toolName: String(msg.toolName ?? pending?.name ?? 'tool'),
                result: msg.result ?? null,
                callId,
            });
            return;
        }
        if (msg.type === 'message_update' || msg.type === 'message_end') {
            // Both are handled, and the delta is computed rather than trusted,
            // because pi streams an assistant message as a growing snapshot
            // rather than as deltas. Emitting the frame's whole text on every
            // update would repeat the message once per token.
            const message = msg.message as { role?: string; content?: unknown[] } | undefined;
            if (message?.role !== 'assistant') {
                if (msg.type === 'message_end') this.emittedText = '';
                return;
            }
            const full = assistantText(message.content);
            if (full.startsWith(this.emittedText)) {
                const delta = full.slice(this.emittedText.length);
                if (delta) {
                    this.emittedText = full;
                    this.opts.echo?.(delta);
                    this.emit({ type: 'model-output', textDelta: delta });
                }
            } else if (full) {
                // A rewrite rather than an append. Rare, but emitting the whole
                // thing is better than emitting a nonsense slice of it.
                this.emittedText = full;
                this.opts.echo?.(full);
                this.emit({ type: 'model-output', textDelta: full });
            }
            if (msg.type === 'message_end') this.emittedText = '';
            return;
        }
        if (msg.type === 'agent_end') {
            const turn = this.turn;
            this.turn = null;
            this.emittedText = '';
            this.emit({ type: 'status', status: 'idle' });
            turn?.resolve();
            return;
        }
    }

    /**
     * A gate, off pi's `ctx.ui.select()`.
     *
     * Fire-and-forget methods (`notify`) expect no answer at all; writing one
     * back would be a frame pi is not reading for. `confirm` answers with
     * `confirmed`, `select` with `value` — sending the wrong key leaves the
     * tool suspended until pi's own timeout, which then denies, correctly but
     * slowly and for the wrong reason.
     *
     * ANYTHING THAT IS NOT AN EXPLICIT ALLOW IS A DENY. No handler set, a
     * handler that threw, a title we could not parse: all deny.
     */
    private async onUiRequest(msg: PiFrame): Promise<void> {
        const method = String(msg.method ?? '');
        if (method !== 'select' && method !== 'confirm') {
            if (method === 'notify' && typeof msg.message === 'string') {
                this.opts.echo?.(`\n  … ${msg.message}\n`);
            }
            return;
        }

        const title = String(msg.title ?? '');
        const m = GATE_TITLE.exec(title);
        const toolName = m ? m[1] : 'a tool';
        const toolCallId = m ? m[2] : String(msg.id ?? '');
        const pending = this.pendingTools.get(toolCallId) ?? null;

        let decision: PiGateDecision = 'deny';
        try {
            if (this.approvalHandler) {
                decision = await this.approvalHandler({
                    toolName,
                    toolCallId,
                    args: pending?.args ?? null,
                });
            } else {
                this.log(`no approval handler; denying ${toolName}`);
            }
        } catch (err) {
            this.log(`approval handler threw; denying ${toolName}: ${err instanceof Error ? err.message : String(err)}`);
            decision = 'deny';
        }

        const allowed = decision === 'allow';
        if (method === 'confirm') {
            this.send({ type: 'extension_ui_response', id: msg.id, confirmed: allowed });
        } else {
            this.send({ type: 'extension_ui_response', id: msg.id, value: allowed ? 'allow' : 'deny' });
        }
    }

    /**
     * One turn.
     *
     * `followUp` rather than a bare prompt: a bare one is REJECTED while the
     * agent is streaming, and a message from the phone arriving mid-turn is the
     * normal case rather than the exception. `steer` would cut into the running
     * turn, which is a different intention than "here is the next thing".
     */
    async sendPrompt(text: string): Promise<void> {
        if (!this.child) throw new Error('pi backend has no child; start() first');
        const done = new Promise<void>((resolve, reject) => {
            this.turn = { resolve, reject };
        });
        const r = await this.ask('prompt', { message: text, streamingBehavior: 'followUp' });
        if (r && r.success === false) {
            this.turn = null;
            throw new Error(`pi refused the prompt: ${String(r.error ?? 'no reason given')}`);
        }
        await done;
    }

    /** Stop the running turn. pi answers `abort`; the turn ends with agent_end. */
    async cancel(): Promise<void> {
        if (!this.child) return;
        await this.ask('abort');
    }

    /** `provider/id`, already resolved. Returns pi's own refusal if it refuses. */
    async setModel(provider: string, modelId: string): Promise<{ ok: boolean; error?: string }> {
        const r = await this.ask('set_model', { provider, modelId });
        if (r?.success) {
            if (this.state) this.state.model = { provider, id: modelId };
            return { ok: true };
        }
        return { ok: false, error: String(r?.error ?? 'pi refused the model') };
    }

    async setThinking(level: string): Promise<boolean> {
        const r = await this.ask('set_thinking_level', { level });
        if (r?.success && this.state) this.state.thinkingLevel = level;
        return r?.success === true;
    }

    /**
     * The clean shutdown, and the whole reason this method exists rather than a
     * `child.kill()` at the call site.
     *
     * MEASURED on pi 0.80.3 (DROVE-295): SIGTERM mid-run leaves NO jsonl at all.
     * The conversation is not truncated, it is absent — pi writes its session
     * file when it exits gracefully and never otherwise. Closing stdin is the
     * graceful path: pi sees EOF, finishes, flushes, exits 0.
     *
     * So the order is stdin.end() FIRST, then a real wait, and a signal only
     * after the grace period has genuinely elapsed. Escalating early is the same
     * as not trying: a transcript half-written is a transcript not written.
     */
    async shutdown(graceMs: number = this.opts.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS): Promise<number> {
        const child = this.child;
        if (!child) return 0;
        if (this.stopping) return this.exited ? await this.exited : 0;
        this.stopping = true;

        if (child.exitCode !== null) return child.exitCode;

        try {
            child.stdin?.end();
        } catch {
            /* already gone */
        }

        const exited = this.exited ?? Promise.resolve(0);
        const timedOut = Symbol('timeout');
        const raced = await Promise.race([
            exited,
            new Promise<typeof timedOut>((r) => { setTimeout(() => r(timedOut), graceMs).unref?.(); }),
        ]);
        if (raced !== timedOut) return raced as number;

        // The grace period is spent and pi is still up. A signal now loses the
        // transcript, which is bad — but a process that never exits is worse,
        // and this is the only path that reaches a kill.
        this.log(`pi did not exit within ${graceMs}ms of stdin close; the transcript may be lost`);
        try {
            child.kill('SIGTERM');
        } catch {
            /* already gone */
        }
        const afterTerm = await Promise.race([
            exited,
            new Promise<typeof timedOut>((r) => { setTimeout(() => r(timedOut), 2000).unref?.(); }),
        ]);
        if (afterTerm !== timedOut) return afterTerm as number;
        try {
            child.kill('SIGKILL');
        } catch {
            /* already gone */
        }
        return await exited;
    }

    async dispose(): Promise<void> {
        await this.shutdown();
        this.handlers.clear();
        this.approvalHandler = null;
    }
}

/** A frame off pi's stdout. Loosely typed on purpose: unknown types are ignored. */
interface PiFrame {
    type?: string;
    id?: string;
    command?: string;
    success?: boolean;
    error?: unknown;
    data?: unknown;
    method?: string;
    title?: string;
    message?: unknown;
    toolCallId?: string;
    toolName?: string;
    args?: unknown;
    result?: unknown;
    isError?: boolean;
}

/** The text blocks of an assistant message, joined. */
export function assistantText(content: unknown): string {
    if (!Array.isArray(content)) return '';
    let out = '';
    for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        const b = block as { type?: unknown; text?: unknown };
        if (b.type === 'text' && typeof b.text === 'string') out += b.text;
    }
    return out;
}

/** Read only the fields the runner needs, so an unknown shape cannot throw. */
export function readPiState(data: unknown): PiState | null {
    if (!data || typeof data !== 'object') return null;
    const d = data as Record<string, unknown>;
    const model = d.model && typeof d.model === 'object'
        ? d.model as Record<string, unknown>
        : null;
    return {
        sessionId: typeof d.sessionId === 'string' ? d.sessionId : null,
        sessionFile: typeof d.sessionFile === 'string' ? d.sessionFile : null,
        thinkingLevel: typeof d.thinkingLevel === 'string' ? d.thinkingLevel : null,
        model: model && typeof model.provider === 'string' && typeof model.id === 'string'
            ? {
                provider: model.provider,
                id: model.id,
                baseUrl: typeof model.baseUrl === 'string' ? model.baseUrl : null,
                name: typeof model.name === 'string' ? model.name : undefined,
            }
            : null,
    };
}
