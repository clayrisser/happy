import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { AcpSessionManager } from '@/agent/acp/AcpSessionManager';
import {
    cursorToolName,
    mapCursorFrame,
    splitFrames,
    CursorFrameMapper,
    readCursorUsage,
    readCursorApiKeySource,
    cursorUsageToSessionUsage,
    addCursorUsage,
    emptyCursorUsageTally,
    type CursorFrame,
} from './cursorStream';
import type { AgentMessage } from '@/agent/core';
import { parseCursorModels } from './cursorModels';

/**
 * The fixture is a REAL `cursor-agent --print --output-format stream-json` run,
 * captured byte for byte. A hand-written one would have passed against a wrong
 * reader, which is exactly how the first attempt at this harness shipped a
 * tailer that silently dropped every Cursor line.
 */
const fixture = readFileSync(join(__dirname, '__fixtures__', 'cursor-stream.jsonl'), 'utf-8');

function framesOf(text: string): CursorFrame[] {
    return splitFrames(text.endsWith('\n') ? text : text + '\n').frames;
}

describe('cursor stream frames', () => {
    it('reads every line of a real run', () => {
        const frames = framesOf(fixture);
        expect(frames.length).toBe(14);
        expect(frames[0].type).toBe('system');
        expect(frames.at(-1)?.type).toBe('result');
    });

    it('keeps a half line for the next chunk', () => {
        const first = splitFrames('{"type":"result","subtype":"suc');
        expect(first.frames).toEqual([]);
        const second = splitFrames(first.rest + 'cess","is_error":false}\n');
        expect(second.frames).toHaveLength(1);
        expect(second.frames[0].type).toBe('result');
        expect(second.rest).toBe('');
    });

    it('ignores non-JSON noise on stdout', () => {
        const { frames } = splitFrames('Update available: 2026.08.26\n{"type":"result"}\n');
        expect(frames).toHaveLength(1);
    });

    it('names a tool from the key Cursor wraps it in', () => {
        expect(cursorToolName({ readToolCall: {} }).name).toBe('Read');
        expect(cursorToolName({ shellToolCall: {} }).name).toBe('Shell');
        expect(cursorToolName({}).name).toBe('Tool');
        expect(cursorToolName(undefined).name).toBe('Tool');
    });

    it('does not replay the user frame, which the app already has', () => {
        const user = framesOf(fixture).find((f) => f.type === 'user')!;
        expect(mapCursorFrame(user)).toEqual([]);
    });

    it('maps thinking deltas as streaming thinking, and drops the completed marker', () => {
        const frames = framesOf(fixture).filter((f) => f.type === 'thinking');
        const delta = frames.find((f) => f.subtype === 'delta')!;
        expect(mapCursorFrame(delta)).toEqual([
            { type: 'event', name: 'thinking', payload: { text: delta.text, streaming: true } },
        ]);
        const done = frames.find((f) => f.subtype === 'completed')!;
        expect(mapCursorFrame(done)).toEqual([]);
    });

    it('maps a tool call to a start and an end under one call id', () => {
        const calls = framesOf(fixture).filter((f) => f.type === 'tool_call');
        const started = mapCursorFrame(calls.find((f) => f.subtype === 'started')!);
        const completed = mapCursorFrame(calls.find((f) => f.subtype === 'completed')!);
        expect(started[0]).toMatchObject({ type: 'tool-call', toolName: 'Read' });
        expect(completed[0]).toMatchObject({ type: 'tool-result', toolName: 'Read' });
        expect((started[0] as { callId: string }).callId)
            .toBe((completed[0] as { callId: string }).callId);
        expect((started[0] as { args: Record<string, unknown> }).args)
            .toEqual({ path: '/private/tmp/cursorprobe/note.txt' });
    });

    it('ends the turn on result, and calls an errored result an error', () => {
        expect(mapCursorFrame({ type: 'result', subtype: 'success', is_error: false }))
            .toEqual([{ type: 'status', status: 'idle' }]);
        expect(mapCursorFrame({ type: 'result', subtype: 'success', is_error: true, error: 'boom' }))
            .toEqual([{ type: 'status', status: 'error', detail: 'boom' }]);
    });

    /**
     * The point of the whole mapping: a real Cursor run has to come out the
     * other side as the SAME envelopes every other harness produces, through
     * the shared manager, not a parallel one.
     */
    it('a real run becomes text, thinking and tool envelopes on the shared mapper', () => {
        const manager = new AcpSessionManager();
        const envelopes = [
            ...manager.startTurn(),
            ...framesOf(fixture).flatMap((frame) => mapCursorFrame(frame).flatMap((m) => manager.mapMessage(m))),
            ...manager.endTurn('completed'),
        ];
        const kinds = envelopes.map((e) => e.ev.t);
        expect(kinds[0]).toBe('turn-start');
        expect(kinds.at(-1)).toBe('turn-end');
        expect(kinds).toContain('tool-call-start');
        expect(kinds).toContain('tool-call-end');

        const texts = envelopes.filter((e) => e.ev.t === 'text') as Array<{ ev: { text: string; thinking?: boolean } }>;
        expect(texts.some((t) => t.ev.thinking === true)).toBe(true);
        expect(texts.map((t) => t.ev.text).join('')).toContain('hello');
    });
});

describe('cursor model list', () => {
    it('reads id and label out of --list-models', () => {
        const models = parseCursorModels([
            'Available models',
            '',
            'auto - Auto (default)',
            'cursor-grok-4.6-xhigh-fast - Cursor Grok 4.6 Extra High Fast',
            'auto - Auto (default)',
            'not a model line at all,',
        ].join('\n'));
        expect(models).toEqual([
            { code: 'auto', value: 'Auto (default)' },
            { code: 'cursor-grok-4.6-xhigh-fast', value: 'Cursor Grok 4.6 Extra High Fast' },
        ]);
    });

    it('is empty rather than wrong when the CLI says nothing', () => {
        expect(parseCursorModels('')).toEqual([]);
    });
});

// --- DROVE-253 -------------------------------------------------------------

describe('--stream-partial-output', () => {
    /**
     * Byte-for-byte off a live run of
     *   cursor-agent --print --output-format stream-json
     *                --stream-partial-output --trust --force
     *                --model composer-2.5 --resume <chat>
     *                'Reply with exactly the three words: alpha beta gamma.'
     */
    const partial = readFileSync(
        join(__dirname, '__fixtures__', 'cursor-stream-partial.jsonl'),
        'utf-8',
    );

    function drive(text: string): AgentMessage[] {
        const { frames } = splitFrames(text.endsWith('\n') ? text : `${text}\n`);
        const mapper = new CursorFrameMapper();
        return frames.flatMap((f) => mapper.map(f));
    }

    it('emits the deltas once and drops the repeated full text', () => {
        const deltas = drive(partial)
            .filter((m): m is Extract<AgentMessage, { type: 'model-output' }> => m.type === 'model-output')
            .map((m) => m.textDelta);
        expect(deltas).toEqual(['alpha', ' beta', ' gamma']);
        expect(deltas.join('')).toBe('alpha beta gamma');
    });

    it('the stateless mapper drops NOTHING, which is right for a caller not '
        + 'passing the flag', () => {
        const { frames } = splitFrames(partial);
        const deltas = frames.flatMap(mapCursorFrame)
            .filter((m): m is Extract<AgentMessage, { type: 'model-output' }> => m.type === 'model-output')
            .map((m) => m.textDelta);
        expect(deltas).toEqual(['alpha', ' beta', ' gamma', 'alpha beta gamma']);
    });

    it('a tool call ends the run, so the segment after it is never mistaken '
        + 'for a repeat of the segment before', () => {
        const stream = [
            '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"same"}]},"timestamp_ms":1}',
            '{"type":"tool_call","subtype":"started","call_id":"c1","tool_call":{"readToolCall":{"args":{}}}}',
            '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"same"}]}}',
        ].join('\n');
        const deltas = drive(stream)
            .filter((m): m is Extract<AgentMessage, { type: 'model-output' }> => m.type === 'model-output')
            .map((m) => m.textDelta);
        expect(deltas).toEqual(['same', 'same']);
    });

    it('a repeated delta is kept, because a real delta carries timestamp_ms '
        + 'and the trailing repeat does not', () => {
        const stream = [
            '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"ha"}]},"timestamp_ms":1}',
            '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"ha"}]},"timestamp_ms":2}',
            '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"haha"}]}}',
        ].join('\n');
        const deltas = drive(stream)
            .filter((m): m is Extract<AgentMessage, { type: 'model-output' }> => m.type === 'model-output')
            .map((m) => m.textDelta);
        expect(deltas).toEqual(['ha', 'ha']);
    });

    it('the fixture WITHOUT the flag still yields all its text, because the '
        + 'final segment there also carries no timestamp_ms and is the only '
        + 'carrier of that text', () => {
        const plain = readFileSync(join(__dirname, '__fixtures__', 'cursor-stream.jsonl'), 'utf-8');
        const deltas = drive(plain)
            .filter((m): m is Extract<AgentMessage, { type: 'model-output' }> => m.type === 'model-output')
            .map((m) => m.textDelta);
        expect(deltas.join('')).toContain('hello');
        expect(deltas.length).toBe(2);
    });
});

describe('usage off the result frame', () => {
    it('reads the four counts', () => {
        const frame = {
            type: 'result',
            usage: { inputTokens: 25516, outputTokens: 37, cacheReadTokens: 7616, cacheWriteTokens: 0 },
        };
        expect(readCursorUsage(frame)).toEqual({
            inputTokens: 25516, outputTokens: 37, cacheReadTokens: 7616, cacheWriteTokens: 0,
        });
    });

    it('is null on any frame that is not a result, and on a result with none', () => {
        expect(readCursorUsage({ type: 'assistant' })).toBeNull();
        expect(readCursorUsage({ type: 'result' })).toBeNull();
        expect(readCursorUsage({ type: 'result', usage: undefined })).toBeNull();
    });

    it('does NOT subtract cacheRead from input: measured across two turns of '
        + 'one chat, turn 2 read back 33152 cached tokens against turn 1 '
        + 'input 25516 + cacheRead 7616 = 33132, so the two do not overlap', () => {
        const u = readCursorUsage({
            type: 'result',
            usage: { inputTokens: 25516, outputTokens: 37, cacheReadTokens: 7616, cacheWriteTokens: 0 },
        })!;
        expect(cursorUsageToSessionUsage(u)).toEqual({
            input_tokens: 25516,
            output_tokens: 37,
            cache_read_input_tokens: 7616,
            cache_creation_input_tokens: 0,
        });
    });

    it('sums across turns', () => {
        let tally = emptyCursorUsageTally;
        tally = addCursorUsage(tally, {
            inputTokens: 25516, outputTokens: 37, cacheReadTokens: 7616, cacheWriteTokens: 0,
        });
        tally = addCursorUsage(tally, {
            inputTokens: 60, outputTokens: 19, cacheReadTokens: 33152, cacheWriteTokens: 0,
        });
        expect(tally).toEqual({
            turns: 2, inputTokens: 25576, outputTokens: 56, cacheReadTokens: 40768, cacheWriteTokens: 0,
        });
    });

    it('the result frame emits token-count BESIDE the status, on a failed turn '
        + 'too, because the tokens were spent either way', () => {
        const ok = mapCursorFrame({
            type: 'result', is_error: false,
            usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 },
        });
        expect(ok.map((m) => m.type)).toEqual(['token-count', 'status']);
        const bad = mapCursorFrame({
            type: 'result', is_error: true, error: 'boom',
            usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 },
        });
        expect(bad.map((m) => m.type)).toEqual(['token-count', 'status']);
    });
});

describe('apiKeySource off the init frame', () => {
    it('reads it, and only from a system/init frame', () => {
        expect(readCursorApiKeySource({ type: 'system', subtype: 'init', apiKeySource: 'env' })).toBe('env');
        expect(readCursorApiKeySource({ type: 'system', subtype: 'init' })).toBeNull();
        expect(readCursorApiKeySource({ type: 'result', apiKeySource: 'env' })).toBeNull();
    });

    it('the real fixture is a machine login', () => {
        const plain = readFileSync(join(__dirname, '__fixtures__', 'cursor-stream.jsonl'), 'utf-8');
        const { frames } = splitFrames(plain);
        const sources = frames.map(readCursorApiKeySource).filter(Boolean);
        expect(sources).toEqual(['login']);
    });
});
