#!/usr/bin/env node
// A stand-in for `pi --mode rpc` (DROVE-316).
//
// The sibling of cattle-drover's tests/fixtures/pi-stub.mjs, and for the same
// reason: the test suite must not need a model, a GPU or a running LM Studio.
// Every frame here was copied from the live pi 0.80.3 session DROVE-295 drove
// by hand — the command/response correlation by `id`, the event names, the
// extension_ui_request the gate raises, the tool_execution_end that follows an
// answer.
//
// IT ALSO REPRODUCES THE FLUSH BEHAVIOUR, which is the whole point of the copy
// living here rather than being imported from the other repo. The real pi
// writes its session JSONL when it exits GRACEFULLY and writes NOTHING AT ALL
// when it is killed — measured, and it is the single most expensive trap in
// this harness. So this stub writes its transcript on the `stdin end` path and
// installs SIGTERM/SIGINT handlers that exit WITHOUT writing. A runner that
// signals instead of closing stdin therefore produces an empty transcript here
// exactly as it would in production, and PiBackend.test.ts can assert on it
// instead of on a comment.
//
// It never invents a reply and never decides anything. What the runner sends is
// recorded verbatim, so an assertion is about what the runner actually said.
//
// Usage:
//   node piStub.mjs --mode rpc [--record FILE] [--session-file FILE]
//                   [--no-gate-frame] [--hang-on-stdin-close] [any pi flag]

import fs from 'node:fs';

const argv = process.argv.slice(2);
function flag(name, fallback) {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : fallback;
}

const recordFile = flag('--record', process.env.PI_STUB_RECORD || null);
const sessionId = flag('--session-id-out', '01a05e34-97a7-79bc-8eeb-9364f0f08673');
const sessionFile = flag(
    '--session-file',
    process.env.PI_STUB_SESSION_FILE || '/tmp/pi-stub-session.jsonl',
);
const raiseGate = !argv.includes('--no-gate-frame');
// Refuses to exit when stdin closes, so a test can drive the escalation path.
const hangOnStdinClose = argv.includes('--hang-on-stdin-close');
// What the runner asked pi to load. Recorded, never obeyed — the stub plays the
// gate itself, and the test asserts the runner passed the real one's path.
const gateExt = flag('--extension', null);
const baseUrl = flag('--stub-base-url', process.env.PI_STUB_BASE_URL || 'http://localhost:1234/v1');
const provider = flag('--stub-provider', process.env.PI_STUB_PROVIDER || 'lmstudio');

function record(what) {
    if (!recordFile) return;
    fs.appendFileSync(recordFile, JSON.stringify(what) + '\n');
}
record({ kind: 'argv', argv, extension: gateExt });

function out(o) {
    process.stdout.write(JSON.stringify(o) + '\n');
}

const state = {
    model: {
        id: 'openai/gpt-oss-120b',
        name: 'gpt-oss-120b (LM Studio)',
        api: 'openai-completions',
        provider,
        baseUrl,
        contextWindow: 131072,
        maxTokens: 8192,
    },
    thinkingLevel: 'off',
    isStreaming: false,
    steeringMode: 'one-at-a-time',
    followUpMode: 'one-at-a-time',
    sessionFile,
    sessionId,
    messageCount: 0,
};

/** The conversation, written to sessionFile ONLY on a graceful exit. */
const transcript = [];

/** The gate frame currently outstanding, so a response can complete the turn. */
let openGate = null;
let calls = 0;

function runTurn(message) {
    transcript.push({ role: 'user', content: [{ type: 'text', text: message }] });
    out({ type: 'agent_start' });
    out({ type: 'turn_start' });
    out({ type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: message }] } });
    out({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: message }] } });

    if (!raiseGate) {
        const text = `echo: ${message}`;
        transcript.push({ role: 'assistant', content: [{ type: 'text', text }] });
        // Streamed as a growing snapshot, which is what the real pi does and
        // what the runner's delta arithmetic has to survive.
        out({ type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: text.slice(0, 5) }] } });
        out({ type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text }] } });
        out({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }] } });
        out({ type: 'agent_end', messages: [] });
        return;
    }

    const callId = `call-${++calls}`;
    out({ type: 'tool_execution_start', toolCallId: callId, toolName: 'bash', args: { command: 'echo GATED' } });
    openGate = { callId, id: `ui-${calls}` };
    // The exact frame ctx.ui.select produces in rpc mode, title format included.
    out({
        type: 'extension_ui_request',
        id: openGate.id,
        method: 'select',
        title: `pi wants to run bash [${callId}]`,
        options: ['allow', 'deny'],
        timeout: 300000,
    });
}

function finishGate(allowed) {
    const g = openGate;
    openGate = null;
    transcript.push({ role: 'toolResult', toolCallId: g.callId, isError: !allowed });
    out({
        type: 'tool_execution_end',
        toolCallId: g.callId,
        toolName: 'bash',
        result: {
            content: [{ type: 'text', text: allowed ? 'GATED\n' : 'denied on the drover bus' }],
            details: {},
        },
        isError: !allowed,
    });
    out({ type: 'agent_end', messages: [] });
}

// STRICT JSONL, LF ONLY — the same rule the runner follows, and for the same
// reason: a generic line reader also splits on U+2028/U+2029, which are legal
// inside a JSON string.
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
    buf += d;
    for (;;) {
        const i = buf.indexOf('\n');
        if (i < 0) break;
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let cmd;
        try {
            cmd = JSON.parse(line);
        } catch {
            record({ kind: 'unparseable', line });
            continue;
        }
        record(cmd);

        if (cmd.type === 'extension_ui_response') {
            if (openGate && openGate.id === cmd.id) {
                finishGate(cmd.value === 'allow' || cmd.confirmed === true);
            }
            continue;
        }
        if (cmd.type === 'get_state') {
            out({ id: cmd.id, type: 'response', command: 'get_state', success: true, data: state });
            continue;
        }
        if (cmd.type === 'prompt' || cmd.type === 'steer' || cmd.type === 'follow_up') {
            out({ id: cmd.id, type: 'response', command: cmd.type, success: true });
            state.messageCount += 1;
            runTurn(cmd.message);
            continue;
        }
        if (cmd.type === 'set_model') {
            const ok = cmd.provider === provider;
            if (ok) state.model = { ...state.model, provider: cmd.provider, id: cmd.modelId };
            out({
                id: cmd.id,
                type: 'response',
                command: 'set_model',
                success: ok,
                ...(ok ? { data: state.model } : { error: `unknown provider ${cmd.provider}` }),
            });
            continue;
        }
        if (cmd.type === 'set_thinking_level') {
            state.thinkingLevel = cmd.level;
            out({ id: cmd.id, type: 'response', command: 'set_thinking_level', success: true });
            continue;
        }
        if (cmd.type === 'abort') {
            if (openGate) finishGate(false);
            out({ id: cmd.id, type: 'response', command: 'abort', success: true });
            continue;
        }
        out({ id: cmd.id, type: 'response', command: cmd.type, success: false, error: 'unsupported by the stub' });
    }
});

/**
 * The graceful path: stdin closed, so the transcript is flushed and we exit 0.
 * This is what the real pi does and the only path on which it writes anything.
 */
process.stdin.on('end', () => {
    record({ kind: 'stdin-closed' });
    if (hangOnStdinClose) {
        // A pi that ignores EOF. NOT unref'd: the point is to hold the event
        // loop open so the runner's grace period is really spent, which is the
        // only path in PiBackend.shutdown that reaches a signal.
        setInterval(() => { /* stay alive */ }, 60_000);
        return;
    }
    fs.writeFileSync(sessionFile, transcript.map((e) => JSON.stringify(e)).join('\n') + '\n');
    process.exit(0);
});

/**
 * The lossy path, reproduced deliberately. A signalled pi writes NOTHING — the
 * conversation is not truncated, it is absent — so a runner that reaches for a
 * signal loses the session it just had. Nothing is written here on purpose.
 */
for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
        record({ kind: `signal:${signal}` });
        process.exit(143);
    });
}
