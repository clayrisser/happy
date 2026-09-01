/**
 * The pi RPC client, against a stub that reproduces pi's measured behaviour
 * (DROVE-316).
 *
 * THE TEST THAT MATTERS MOST is "a terminated session keeps its history". pi
 * flushes its session JSONL on a graceful exit and writes NOTHING AT ALL when
 * killed — the conversation is not truncated, it is absent — so a runner that
 * reaches for a signal on Ctrl-C silently destroys the conversation it just
 * had. src/pi/testing/piStub.mjs reproduces exactly that: it writes on the
 * stdin-close path and its SIGTERM handler writes nothing. So the assertion
 * here is on a file, not on a comment.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AgentMessage } from '@/agent/core';
import { PiBackend, assistantText, readPiState } from './PiBackend';

const STUB = fileURLToPath(new URL('./testing/piStub.mjs', import.meta.url));

let dir: string;
let sessionFile: string;
let recordFile: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pi-backend-'));
    sessionFile = join(dir, 'session.jsonl');
    recordFile = join(dir, 'record.jsonl');
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

function makeBackend(extra: string[] = [], opts: { shutdownGraceMs?: number } = {}) {
    const messages: AgentMessage[] = [];
    // The stub IS the binary — it carries a `#!/usr/bin/env node` shebang and
    // the exec bit — rather than being an argument to node. Running it as
    // `node <stub>` would put buildPiRpcArgs's `--mode rpc` in front of the
    // script path, where node takes it as one of its own flags and refuses.
    const backend = new PiBackend({
        piBin: STUB,
        cwd: dir,
        shutdownGraceMs: opts.shutdownGraceMs ?? 5000,
        log: () => { /* quiet */ },
        spawnArgs: {
            gateExtension: '/repo/adapters/pi-gate.mjs',
            passthrough: [
                '--record', recordFile,
                '--session-file', sessionFile,
                ...extra,
            ],
        },
    });
    backend.onMessage((m) => messages.push(m));
    return { backend, messages };
}

/** The argv the stub was spawned with, as it recorded it. */
function stubArgv(): string[] {
    const lines = readFileSync(recordFile, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    return lines.find((l) => l.kind === 'argv')?.argv ?? [];
}

describe('PiBackend handshake', () => {
    it('learns the session file and the model from get_state', async () => {
        const { backend } = makeBackend(['--no-gate-frame']);
        const state = await backend.start();
        expect(state.sessionFile).toBe(sessionFile);
        expect(state.model?.provider).toBe('lmstudio');
        expect(state.model?.baseUrl).toBe('http://localhost:1234/v1');
        await backend.shutdown();
    });

    it('passes the gate extension through, and never --no-extensions', async () => {
        const { backend } = makeBackend(['--no-gate-frame']);
        await backend.start();
        await backend.shutdown();
        const argv = stubArgv();
        expect(argv).toContain('--extension');
        expect(argv).toContain('/repo/adapters/pi-gate.mjs');
        expect(argv).not.toContain('--no-extensions');
        expect(argv).not.toContain('-ne');
    });
});

describe('PiBackend transcript', () => {
    it('emits assistant text as DELTAS, not once per snapshot', async () => {
        // pi streams a growing snapshot of the message. Emitting the whole
        // thing on every update would repeat the answer once per chunk.
        const { backend, messages } = makeBackend(['--no-gate-frame']);
        await backend.start();
        await backend.sendPrompt('hello');
        await backend.shutdown();

        const text = messages
            .filter((m): m is Extract<AgentMessage, { type: 'model-output' }> => m.type === 'model-output')
            .map((m) => m.textDelta ?? '')
            .join('');
        expect(text).toBe('echo: hello');
    });

    it('renders a tool call as a tool call, not as text', async () => {
        const { backend, messages } = makeBackend();
        backend.setApprovalHandler(async () => 'allow');
        await backend.start();
        await backend.sendPrompt('run it');
        await backend.shutdown();

        const call = messages.find((m) => m.type === 'tool-call');
        expect(call).toMatchObject({ type: 'tool-call', toolName: 'bash', args: { command: 'echo GATED' } });
        const result = messages.find((m) => m.type === 'tool-result');
        expect(result).toMatchObject({ type: 'tool-result', toolName: 'bash' });
        // The join the app needs to attach the result card to the call card.
        expect((result as { callId: string }).callId)
            .toBe((call as { callId: string }).callId);
    });
});

describe('PiBackend gates', () => {
    it('allows when the handler allows', async () => {
        const { backend, messages } = makeBackend();
        backend.setApprovalHandler(async () => 'allow');
        await backend.start();
        await backend.sendPrompt('run it');
        await backend.shutdown();
        const answers = readFileSync(recordFile, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
        expect(answers.find((a) => a.type === 'extension_ui_response')?.value).toBe('allow');
        expect(messages.some((m) => m.type === 'tool-result')).toBe(true);
    });

    it('denies when the handler denies', async () => {
        const { backend } = makeBackend();
        backend.setApprovalHandler(async () => 'deny');
        await backend.start();
        await backend.sendPrompt('run it');
        await backend.shutdown();
        const answers = readFileSync(recordFile, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
        expect(answers.find((a) => a.type === 'extension_ui_response')?.value).toBe('deny');
    });

    it('FAILS CLOSED when no handler is set at all', async () => {
        // A gate nobody can answer is not a gate that approves.
        const { backend } = makeBackend();
        await backend.start();
        await backend.sendPrompt('run it');
        await backend.shutdown();
        const answers = readFileSync(recordFile, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
        expect(answers.find((a) => a.type === 'extension_ui_response')?.value).toBe('deny');
    });

    it('FAILS CLOSED when the handler throws', async () => {
        const { backend } = makeBackend();
        backend.setApprovalHandler(async () => { throw new Error('the bus went away'); });
        await backend.start();
        await backend.sendPrompt('run it');
        await backend.shutdown();
        const answers = readFileSync(recordFile, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
        expect(answers.find((a) => a.type === 'extension_ui_response')?.value).toBe('deny');
    });

    it('hands the handler the arguments tool_execution_start carried', async () => {
        // pi dialog options have no field for a payload, so the title carries
        // the call id and the args are joined back from the earlier frame.
        let seen: { toolName: string; toolCallId: string; args: Record<string, unknown> | null } | null = null;
        const { backend } = makeBackend();
        backend.setApprovalHandler(async (req) => { seen = req; return 'deny'; });
        await backend.start();
        await backend.sendPrompt('run it');
        await backend.shutdown();
        expect(seen).toMatchObject({ toolName: 'bash', args: { command: 'echo GATED' } });
        expect(seen!.toolCallId).toBe('call-1');
    });
});

describe('PiBackend shutdown', () => {
    it('a terminated session KEEPS ITS HISTORY', async () => {
        // The one that pays for this whole file. pi writes its transcript only
        // on a graceful exit, so ending the session must close stdin rather
        // than signal. The stub writes on stdin-close and writes nothing on
        // SIGTERM, exactly as the real pi does.
        const { backend } = makeBackend(['--no-gate-frame']);
        await backend.start();
        await backend.sendPrompt('remember this');
        expect(existsSync(sessionFile)).toBe(false); // nothing flushed mid-session

        const code = await backend.shutdown();

        expect(code).toBe(0);
        expect(existsSync(sessionFile)).toBe(true);
        const transcript = readFileSync(sessionFile, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
        expect(transcript.some((e) => e.role === 'user' && e.content?.[0]?.text === 'remember this')).toBe(true);
        expect(transcript.some((e) => e.role === 'assistant')).toBe(true);
    });

    it('closes stdin FIRST and never signals a child that exits cleanly', async () => {
        const { backend } = makeBackend(['--no-gate-frame']);
        await backend.start();
        await backend.shutdown();
        const events = readFileSync(recordFile, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
        expect(events.some((e) => e.kind === 'stdin-closed')).toBe(true);
        expect(events.some((e) => typeof e.kind === 'string' && e.kind.startsWith('signal:'))).toBe(false);
    });

    it('escalates ONLY after the grace period a hung child was given', async () => {
        // A process that never exits is worse than a lost transcript, but it is
        // the only case that reaches a signal — and the grace period has to
        // have genuinely elapsed first.
        const { backend } = makeBackend(['--no-gate-frame', '--hang-on-stdin-close'], { shutdownGraceMs: 300 });
        await backend.start();
        const started = Date.now();
        await backend.shutdown();
        expect(Date.now() - started).toBeGreaterThanOrEqual(280);
        const events = readFileSync(recordFile, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
        expect(events.some((e) => e.kind === 'stdin-closed')).toBe(true);
        expect(events.some((e) => e.kind === 'signal:SIGTERM')).toBe(true);
    });

    it('is idempotent, so a Ctrl-C during teardown cannot double-kill', async () => {
        const { backend } = makeBackend(['--no-gate-frame']);
        await backend.start();
        const [a, b] = await Promise.all([backend.shutdown(), backend.shutdown()]);
        expect(a).toBe(0);
        expect(b).toBe(0);
        expect(existsSync(sessionFile)).toBe(true);
    });
});

describe('PiBackend model changes', () => {
    it('applies a model pi accepts', async () => {
        const { backend } = makeBackend(['--no-gate-frame']);
        await backend.start();
        expect(await backend.setModel('lmstudio', 'qwen/qwen3-coder-next')).toEqual({ ok: true });
        expect(backend.currentState?.model?.id).toBe('qwen/qwen3-coder-next');
        await backend.shutdown();
    });

    it('reports pi own refusal rather than pretending it landed', async () => {
        const { backend } = makeBackend(['--no-gate-frame']);
        await backend.start();
        const r = await backend.setModel('nosuchprovider', 'whatever');
        expect(r.ok).toBe(false);
        expect(r.error).toContain('nosuchprovider');
        await backend.shutdown();
    });
});

describe('frame readers', () => {
    it('joins the text blocks of an assistant message', () => {
        expect(assistantText([
            { type: 'text', text: 'a' },
            { type: 'thinking', text: 'ignored' },
            { type: 'text', text: 'b' },
        ])).toBe('ab');
        expect(assistantText(null)).toBe('');
    });

    it('reads only the fields the runner needs, so a strange shape cannot throw', () => {
        expect(readPiState({ sessionId: 1, sessionFile: '/x', model: 'nope' })).toEqual({
            sessionId: null,
            sessionFile: '/x',
            thinkingLevel: null,
            model: null,
        });
        expect(readPiState(null)).toBeNull();
    });
});
