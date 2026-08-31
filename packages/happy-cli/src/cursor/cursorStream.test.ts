import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { AcpSessionManager } from '@/agent/acp/AcpSessionManager';
import { cursorToolName, mapCursorFrame, splitFrames, type CursorFrame } from './cursorStream';
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
