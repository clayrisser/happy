import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createId, isCuid } from '@paralleldrive/cuid2';
import { RawJSONLinesSchema } from '../types';
import {
    ClaudeActivityPublisher,
    closeClaudeTurnWithStatus,
    mapClaudeLogMessageToSessionEnvelopes,
    mapQueuedPromptToSessionEnvelopes,
    readClaudeActivity,
    type ClaudeActivity,
    type ClaudeSessionProtocolState,
} from './sessionProtocolMapper';

describe('mapClaudeLogMessageToSessionEnvelopes', () => {
    it('maps user text to a user text envelope', () => {
        const result = mapClaudeLogMessageToSessionEnvelopes({
            type: 'user',
            uuid: 'u-1',
            message: {
                role: 'user',
                content: 'hello from user',
            },
            timestamp: '2025-01-01T00:00:00.000Z',
        } as any, { currentTurnId: null });

        expect(result.currentTurnId).toBeNull();
        expect(result.envelopes).toHaveLength(1);
        expect(result.envelopes[0].role).toBe('user');
        expect(result.envelopes[0].ev).toEqual({ t: 'text', text: 'hello from user' });
    });

    it('maps non-tool user array text to user text without opening an agent turn', () => {
        const result = mapClaudeLogMessageToSessionEnvelopes({
            type: 'user',
            uuid: 'u-array-1',
            isSidechain: false,
            message: {
                role: 'user',
                content: [
                    { type: 'text', text: 'look at this image' },
                    {
                        type: 'image',
                        source: {
                            type: 'base64',
                            media_type: 'image/png',
                            data: 'iVBORw0KGgo=',
                        },
                    },
                ],
            },
            timestamp: '2025-01-01T00:00:00.000Z',
        } as any, { currentTurnId: null });

        expect(result.currentTurnId).toBeNull();
        expect(result.envelopes).toHaveLength(1);
        expect(result.envelopes[0].role).toBe('user');
        expect(result.envelopes[0].turn).toBeUndefined();
        expect(result.envelopes[0].ev).toEqual({ t: 'text', text: 'look at this image' });
    });

    it('starts a turn and maps assistant text blocks', () => {
        const result = mapClaudeLogMessageToSessionEnvelopes({
            type: 'assistant',
            uuid: 'a-1',
            message: {
                role: 'assistant',
                content: [
                    { type: 'text', text: 'working...' },
                    { type: 'thinking', thinking: 'internal' },
                ],
            },
            timestamp: '2025-01-01T00:00:01.000Z',
        } as any, { currentTurnId: null });

        expect(result.currentTurnId).not.toBeNull();
        expect(result.envelopes).toHaveLength(3);
        expect(result.envelopes[0].ev.t).toBe('turn-start');
        expect(result.envelopes[1].ev).toEqual({ t: 'text', text: 'working...' });
        expect(result.envelopes[2].ev).toEqual({ t: 'text', text: 'internal', thinking: true });
    });

    it('carries Claude usage on the last assistant content envelope', () => {
        const usage = {
            input_tokens: 1200,
            cache_creation_input_tokens: 40,
            cache_read_input_tokens: 500,
            output_tokens: 80,
        };
        const result = mapClaudeLogMessageToSessionEnvelopes({
            type: 'assistant',
            uuid: 'a-usage-1',
            message: {
                role: 'assistant',
                usage,
                content: [
                    { type: 'text', text: 'working...' },
                    { type: 'thinking', thinking: 'internal' },
                ],
            },
            timestamp: '2025-01-01T00:00:01.000Z',
        } as any, { currentTurnId: null });

        expect(result.envelopes).toHaveLength(3);
        expect(result.envelopes[0].ev.t).toBe('turn-start');
        expect(result.envelopes[0]).not.toHaveProperty('usage');
        expect(result.envelopes[1]).not.toHaveProperty('usage');
        expect(result.envelopes[2]).toMatchObject({ usage });
    });

    it('normalizes a synthetic API error null service tier before emitting an envelope', () => {
        const message = RawJSONLinesSchema.parse({
            type: 'assistant',
            uuid: 'a-api-error-1',
            message: {
                model: '<synthetic>',
                content: [{ type: 'text', text: "You've hit your limit" }],
                usage: {
                    input_tokens: 0,
                    output_tokens: 0,
                    service_tier: null,
                },
            },
            isApiErrorMessage: true,
            apiErrorStatus: 429,
        });

        const result = mapClaudeLogMessageToSessionEnvelopes(message, { currentTurnId: null });
        const textEnvelope = result.envelopes.find((envelope) => envelope.ev.t === 'text');

        expect(textEnvelope).toMatchObject({
            ev: { t: 'text', text: "You've hit your limit" },
            usage: { input_tokens: 0, output_tokens: 0 },
        });
        expect(textEnvelope?.usage?.service_tier).toBeUndefined();
    });

    it('maps tool use and tool result blocks to tool-call lifecycle', () => {
        const usage = {
            input_tokens: 900,
            cache_creation_input_tokens: 10,
            cache_read_input_tokens: 250,
            output_tokens: 25,
        };
        const started = mapClaudeLogMessageToSessionEnvelopes({
            type: 'assistant',
            uuid: 'a-2',
            message: {
                role: 'assistant',
                usage,
                content: [
                    { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'ls' } },
                ],
            },
        } as any, { currentTurnId: null });

        expect(started.envelopes.some((e) => e.ev.t === 'tool-call-start')).toBe(true);
        expect(started.envelopes.find((e) => e.ev.t === 'tool-call-start')).toMatchObject({ usage });

        const ended = mapClaudeLogMessageToSessionEnvelopes({
            type: 'user',
            uuid: 'u-2',
            message: {
                role: 'user',
                content: [
                    { type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' },
                ],
            },
        } as any, { currentTurnId: started.currentTurnId });

        expect(ended.currentTurnId).toBe(started.currentTurnId);
        expect(ended.envelopes).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    ev: { t: 'tool-call-end', call: 'tool-1' },
                }),
            ]),
        );
    });

    it('exposes the generated session subagent id on Agent tool calls', () => {
        const started = mapClaudeLogMessageToSessionEnvelopes({
            type: 'assistant',
            uuid: 'a-agent-1',
            message: {
                role: 'assistant',
                content: [
                    {
                        type: 'tool_use',
                        id: 'tool-agent-1',
                        name: 'Agent',
                        input: {
                            description: 'Inspect translations',
                            prompt: 'Review all translation files',
                            mode: 'auto',
                        },
                    },
                ],
            },
        } as any, { currentTurnId: null });

        const toolCall = started.envelopes.find((envelope) => {
            return envelope.ev.t === 'tool-call-start'
                && envelope.ev.call === 'tool-agent-1';
        });

        expect(toolCall).toBeDefined();
        expect(toolCall?.ev).toEqual(expect.objectContaining({
            t: 'tool-call-start',
            name: 'Agent',
            title: 'Inspect translations',
            description: 'Inspect translations',
            args: expect.objectContaining({
                description: 'Inspect translations',
                prompt: 'Review all translation files',
                mode: 'auto',
                sessionSubagent: expect.any(String),
            }),
        }));

        if (toolCall?.ev.t === 'tool-call-start') {
            expect(isCuid(String(toolCall.ev.args.sessionSubagent))).toBe(true);
        }
    });

    it('generates stable session subagent ids for the same provider tool id', () => {
        const first = mapClaudeLogMessageToSessionEnvelopes({
            type: 'assistant',
            uuid: 'a-agent-stable-1',
            message: {
                role: 'assistant',
                content: [{
                    type: 'tool_use',
                    id: 'tool-agent-stable',
                    name: 'Agent',
                    input: {
                        description: 'Inspect translations',
                        prompt: 'Review all translation files',
                    },
                }],
            },
        } as any, { currentTurnId: null });
        const second = mapClaudeLogMessageToSessionEnvelopes({
            type: 'assistant',
            uuid: 'a-agent-stable-2',
            message: {
                role: 'assistant',
                content: [{
                    type: 'tool_use',
                    id: 'tool-agent-stable',
                    name: 'Agent',
                    input: {
                        description: 'Inspect translations',
                        prompt: 'Review all translation files',
                    },
                }],
            },
        } as any, { currentTurnId: null });

        const firstToolCall = first.envelopes.find((envelope) => envelope.ev.t === 'tool-call-start');
        const secondToolCall = second.envelopes.find((envelope) => envelope.ev.t === 'tool-call-start');

        expect(firstToolCall?.ev.t).toBe('tool-call-start');
        expect(secondToolCall?.ev.t).toBe('tool-call-start');
        if (firstToolCall?.ev.t === 'tool-call-start' && secondToolCall?.ev.t === 'tool-call-start') {
            expect(firstToolCall.ev.args.sessionSubagent).toBe(secondToolCall.ev.args.sessionSubagent);
            expect(isCuid(String(firstToolCall.ev.args.sessionSubagent))).toBe(true);
        }
    });

    it('stops visible Agent sidechains when the parent tool result arrives', () => {
        const state = { currentTurnId: null };
        const started = mapClaudeLogMessageToSessionEnvelopes({
            type: 'assistant',
            uuid: 'a-agent-stop-1',
            message: {
                role: 'assistant',
                content: [{
                    type: 'tool_use',
                    id: 'tool-agent-stop',
                    name: 'Agent',
                    input: {
                        description: 'Inspect translations',
                        prompt: 'Review all translation files',
                    },
                }],
            },
        } as any, state);
        const toolCall = started.envelopes.find((envelope) => envelope.ev.t === 'tool-call-start');
        expect(toolCall?.ev.t).toBe('tool-call-start');
        const sessionSubagent = toolCall?.ev.t === 'tool-call-start'
            ? String(toolCall.ev.args.sessionSubagent)
            : undefined;

        const child = mapClaudeLogMessageToSessionEnvelopes({
            type: 'assistant',
            uuid: 'a-agent-stop-child',
            parent_tool_use_id: 'tool-agent-stop',
            message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'child result' }],
            },
        } as any, state);
        expect(child.envelopes.some((envelope) => {
            return envelope.ev.t === 'start' && envelope.subagent === sessionSubagent;
        })).toBe(true);

        const stopped = mapClaudeLogMessageToSessionEnvelopes({
            type: 'user',
            uuid: 'u-agent-stop-1',
            isSidechain: false,
            message: {
                role: 'user',
                content: [{ type: 'tool_result', tool_use_id: 'tool-agent-stop', content: 'done' }],
            },
        } as any, state);

        expect(stopped.envelopes).toEqual(expect.arrayContaining([
            expect.objectContaining({
                subagent: sessionSubagent,
                ev: { t: 'stop' },
            }),
            expect.objectContaining({
                ev: { t: 'tool-call-end', call: 'tool-agent-stop' },
            }),
        ]));
    });

    it('uses parent_tool_use_id as subagent and emits subagent start', () => {
        const mappedSubagent = createId();
        const state = {
            currentTurnId: 'turn-1',
            providerSubagentToSessionSubagent: new Map<string, string>([['task-1', mappedSubagent]]),
        };

        const result = mapClaudeLogMessageToSessionEnvelopes({
            type: 'assistant',
            uuid: 'a-side-1',
            parent_tool_use_id: 'task-1',
            message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'sidechain text' }],
            },
        } as any, state);

        expect(result.envelopes).toHaveLength(2);
        expect(result.envelopes[0].subagent).toBe(mappedSubagent);
        expect(result.envelopes[0].ev).toEqual({ t: 'start' });
        expect(result.envelopes[1].subagent).toBe(mappedSubagent);
        expect(result.envelopes[1].ev).toEqual({ t: 'text', text: 'sidechain text' });
    });

    it('buffers subagent messages until parent Task registration is known', () => {
        const state = { currentTurnId: null };

        const buffered = mapClaudeLogMessageToSessionEnvelopes({
            type: 'assistant',
            uuid: 'a-side-buffered-1',
            parent_tool_use_id: 'task-buffer-1',
            message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'buffer me' }],
            },
        } as any, state);
        expect(buffered.envelopes).toHaveLength(0);

        const parent = mapClaudeLogMessageToSessionEnvelopes({
            type: 'assistant',
            uuid: 'a-parent-buffered-1',
            message: {
                role: 'assistant',
                content: [{
                    type: 'tool_use',
                    id: 'task-buffer-1',
                    name: 'Task',
                    input: { prompt: 'run side task' },
                }],
            },
        } as any, state);

        expect(parent.envelopes.some((envelope) => {
            return envelope.ev.t === 'tool-call-start'
                && envelope.ev.call === 'task-buffer-1';
        })).toBe(false);
        const bufferedText = parent.envelopes.find((envelope) => {
            return envelope.ev.t === 'text'
                && envelope.ev.text === 'buffer me';
        });
        expect(bufferedText?.subagent).toBeDefined();
        expect(isCuid(bufferedText!.subagent!)).toBe(true);
        expect(bufferedText?.subagent).not.toBe('task-buffer-1');
    });

    it('creates and tags subagent chain from Task prompt when parent_tool_use_id is absent', () => {
        const state = { currentTurnId: null };
        const prompt = 'Search for TypeScript 5.6 features';

        const taskToolUse = mapClaudeLogMessageToSessionEnvelopes({
            type: 'assistant',
            uuid: 'task-parent-assistant',
            message: {
                role: 'assistant',
                content: [{
                    type: 'tool_use',
                    id: 'task-call-1',
                    name: 'Task',
                    input: {
                        prompt,
                        description: 'Search TypeScript docs',
                    },
                }],
            },
        } as any, state);

        expect(taskToolUse.envelopes.some((envelope) => {
            return envelope.ev.t === 'tool-call-start'
                && envelope.ev.call === 'task-call-1';
        })).toBe(false);

        const sidechainRoot = mapClaudeLogMessageToSessionEnvelopes({
            type: 'user',
            uuid: 'sidechain-root',
            isSidechain: true,
            parentUuid: null,
            message: {
                role: 'user',
                content: prompt,
            },
        } as any, state);

        expect(sidechainRoot.envelopes).toHaveLength(2);
        const mappedSubagent = sidechainRoot.envelopes[0].subagent;
        expect(mappedSubagent).toBeDefined();
        expect(isCuid(mappedSubagent!)).toBe(true);
        expect(mappedSubagent).not.toBe('task-call-1');
        expect(sidechainRoot.envelopes[0].role).toBe('agent');
        expect(sidechainRoot.envelopes[0].subagent).toBe(mappedSubagent);
        expect(sidechainRoot.envelopes[0].ev).toEqual({ t: 'start', title: 'Search TypeScript docs' });
        expect(sidechainRoot.envelopes[1].subagent).toBe(mappedSubagent);
        expect(sidechainRoot.envelopes[1].ev).toEqual({ t: 'text', text: prompt });

        const sidechainChild = mapClaudeLogMessageToSessionEnvelopes({
            type: 'assistant',
            uuid: 'sidechain-child',
            isSidechain: true,
            parentUuid: 'sidechain-root',
            message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'Subagent result' }],
            },
        } as any, state);

        expect(sidechainChild.envelopes).toHaveLength(1);
        expect(sidechainChild.envelopes[0].subagent).toBe(mappedSubagent);
        expect(sidechainChild.envelopes[0].ev).toEqual({ t: 'text', text: 'Subagent result' });
    });

    it('infers subagent for non-SDK sidechain fixture logs', () => {
        const fixturePath = join(__dirname, '__fixtures__', 'task_non_sdk.jsonl');
        const rows = readFileSync(fixturePath, 'utf8')
            .trim()
            .split('\n')
            .slice(0, 6)
            .map((line) => JSON.parse(line));

        const state = { currentTurnId: null };
        const envelopes = rows.flatMap((row) => {
            return mapClaudeLogMessageToSessionEnvelopes(row as any, state).envelopes;
        });

        const subagentRoot = envelopes.find((envelope) => {
            return envelope.ev.t === 'text'
                && envelope.ev.text.startsWith('Search the web for information about TypeScript 5.6');
        });
        expect(subagentRoot?.subagent).toBeDefined();
        expect(isCuid(subagentRoot!.subagent!)).toBe(true);
        expect(subagentRoot?.subagent).not.toBe('toolu_01EmKA8FJ7B2Ah9seGxK1Wct');

        const subagentChild = envelopes.find((envelope) => {
            return envelope.ev.t === 'text'
                && envelope.ev.text.includes("I'll search for information about TypeScript 5.6");
        });
        expect(subagentChild?.subagent).toBe(subagentRoot?.subagent);
    });

    it('emits stop for completed subagent when parent Task tool returns', () => {
        const mappedSubagent = createId();
        const state = {
            currentTurnId: 'turn-1',
            providerSubagentToSessionSubagent: new Map<string, string>([['task-2', mappedSubagent]]),
            hiddenParentToolCalls: new Set<string>(['task-2']),
        };

        const started = mapClaudeLogMessageToSessionEnvelopes({
            type: 'assistant',
            uuid: 'a-side-2',
            parent_tool_use_id: 'task-2',
            message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'subagent running' }],
            },
        } as any, state);

        expect(started.envelopes.some((envelope) => {
            return envelope.ev.t === 'start' && envelope.subagent === mappedSubagent;
        })).toBe(true);

        const stopped = mapClaudeLogMessageToSessionEnvelopes({
            type: 'user',
            uuid: 'u-parent-2',
            isSidechain: false,
            message: {
                role: 'user',
                content: [{ type: 'tool_result', tool_use_id: 'task-2', content: 'done' }],
            },
        } as any, state);

        expect(stopped.envelopes).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    subagent: mappedSubagent,
                    ev: { t: 'stop' },
                }),
            ]),
        );
        expect(stopped.envelopes.some((envelope) => {
            return envelope.ev.t === 'tool-call-end'
                && envelope.ev.call === 'task-2';
        })).toBe(false);
    });

    it('does not emit envelopes for summary messages', () => {
        const result = mapClaudeLogMessageToSessionEnvelopes({
            type: 'summary',
            summary: 'Done',
            leafUuid: 'leaf-1',
        } as any, { currentTurnId: 'turn-1' });

        expect(result.currentTurnId).toBe('turn-1');
        expect(result.envelopes).toHaveLength(0);
    });

    it('does not emit envelopes for compact summary assistant messages', () => {
        const result = mapClaudeLogMessageToSessionEnvelopes({
            type: 'assistant',
            uuid: 'compact-summary-1',
            isCompactSummary: true,
            message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'Long compaction summary' }],
            },
        } as any, { currentTurnId: 'turn-1' });

        expect(result.currentTurnId).toBe('turn-1');
        expect(result.envelopes).toHaveLength(0);
    });
});

describe('closeClaudeTurnWithStatus', () => {
    it('emits turn-end with provided status when turn is active', () => {
        const result = closeClaudeTurnWithStatus({ currentTurnId: 'turn-1' }, 'cancelled');
        expect(result.currentTurnId).toBeNull();
        expect(result.envelopes).toHaveLength(1);
        expect(result.envelopes[0].ev).toEqual({ t: 'turn-end', status: 'cancelled' });
    });

    it('stops active subagents before ending an aborted turn', () => {
        const subagent = createId();
        const result = closeClaudeTurnWithStatus({
            currentTurnId: 'turn-1',
            startedSubagents: new Set([subagent]),
            activeSubagents: new Set([subagent]),
        }, 'cancelled');

        expect(result.currentTurnId).toBeNull();
        expect(result.envelopes).toHaveLength(2);
        expect(result.envelopes[0]).toMatchObject({
            subagent,
            ev: { t: 'stop' },
        });
        expect(result.envelopes[1].ev).toEqual({ t: 'turn-end', status: 'cancelled' });
    });
});


/**
 * Drive one Agent subagent through the real mapper: tool_use starts it, a
 * sidechain child publishes the start envelope, the parent tool_result stops
 * it. Returns the session subagent id so the caller can chain a second one.
 */
function runAgentSubagent(state: ClaudeSessionProtocolState, tag: string): { start: () => void; stop: () => void } {
    const toolId = `tool-${tag}`;
    return {
        start: () => {
            mapClaudeLogMessageToSessionEnvelopes({
                type: 'assistant',
                uuid: `a-${tag}`,
                message: {
                    role: 'assistant',
                    content: [{
                        type: 'tool_use',
                        id: toolId,
                        name: 'Agent',
                        input: { description: tag, prompt: `prompt ${tag}` },
                    }],
                },
            } as any, state);
            mapClaudeLogMessageToSessionEnvelopes({
                type: 'assistant',
                uuid: `a-${tag}-child`,
                parent_tool_use_id: toolId,
                message: { role: 'assistant', content: [{ type: 'text', text: 'working' }] },
            } as any, state);
        },
        stop: () => {
            mapClaudeLogMessageToSessionEnvelopes({
                type: 'user',
                uuid: `u-${tag}`,
                isSidechain: false,
                message: {
                    role: 'user',
                    content: [{ type: 'tool_result', tool_use_id: toolId, content: 'done' }],
                },
            } as any, state);
        },
    };
}

describe('readClaudeActivity', () => {
    it('tracks the active subagent set through add, add, remove and clear', () => {
        const state: ClaudeSessionProtocolState = { currentTurnId: null };
        expect(readClaudeActivity(state).subagents).toEqual({ running: 0, queued: 0, total: 0 });

        const first = runAgentSubagent(state, 'one');
        const second = runAgentSubagent(state, 'two');

        first.start();
        expect(readClaudeActivity(state).subagents).toEqual({ running: 1, queued: 0, total: 1 });

        second.start();
        expect(readClaudeActivity(state).subagents).toEqual({ running: 2, queued: 0, total: 2 });

        first.stop();
        expect(readClaudeActivity(state).subagents).toEqual({ running: 1, queued: 0, total: 2 });

        // Turn end clears whatever is still active, so a session that dies mid
        // fan-out cannot leave a stale count on the phone.
        closeClaudeTurnWithStatus(state, 'cancelled');
        expect(readClaudeActivity(state).subagents).toEqual({ running: 0, queued: 0, total: 2 });
    });

    it('leaves workflows, processes and tasks at zero so their rows stay hidden', () => {
        const activity = readClaudeActivity({ currentTurnId: null });
        expect(activity.workflows).toEqual({ running: 0, total: 0 });
        expect(activity.processes).toEqual({ running: 0 });
        expect(activity.tasks).toEqual({ pending: 0, inProgress: 0, completed: 0, total: 0 });
    });
});

describe('ClaudeActivityPublisher', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('coalesces a burst of subagent starts into far fewer writes than events', () => {
        vi.useFakeTimers();
        const writes: ClaudeActivity[] = [];
        const publisher = new ClaudeActivityPublisher((activity) => writes.push(activity), { coalesceMs: 300 });
        const state: ClaudeSessionProtocolState = { currentTurnId: null };

        const agents = ['a', 'b', 'c', 'd', 'e'].map((tag) => runAgentSubagent(state, tag));
        for (const agent of agents) {
            agent.start();
            publisher.sync(state);
        }

        // Five starts, ten mapper calls, nothing written yet.
        expect(writes).toHaveLength(0);
        vi.advanceTimersByTime(300);

        expect(writes).toHaveLength(1);
        expect(writes.length).toBeLessThan(agents.length);
        expect(writes[0].subagents).toEqual({ running: 5, queued: 0, total: 5 });
    });

    it('never writes twice for a value that did not move', () => {
        vi.useFakeTimers();
        const writes: ClaudeActivity[] = [];
        const publisher = new ClaudeActivityPublisher((activity) => writes.push(activity), { coalesceMs: 300 });
        const state: ClaudeSessionProtocolState = { currentTurnId: null };

        runAgentSubagent(state, 'solo').start();
        publisher.sync(state);
        vi.advanceTimersByTime(300);
        expect(writes).toHaveLength(1);

        // The message firehose keeps calling sync while nothing changes.
        for (let i = 0; i < 20; i += 1) {
            publisher.sync(state);
            vi.advanceTimersByTime(300);
        }
        expect(writes).toHaveLength(1);
    });

    it('publishes an idle session nothing at all', () => {
        vi.useFakeTimers();
        const writes: ClaudeActivity[] = [];
        const publisher = new ClaudeActivityPublisher((activity) => writes.push(activity), { coalesceMs: 300 });

        publisher.sync({ currentTurnId: null });
        vi.advanceTimersByTime(1000);
        expect(writes).toHaveLength(0);
    });

    it('writes the drop to zero immediately, without waiting on the timer', () => {
        vi.useFakeTimers();
        const writes: ClaudeActivity[] = [];
        const publisher = new ClaudeActivityPublisher((activity) => writes.push(activity), { coalesceMs: 300 });
        const state: ClaudeSessionProtocolState = { currentTurnId: null };

        const agent = runAgentSubagent(state, 'zero');
        agent.start();
        publisher.sync(state);
        vi.advanceTimersByTime(300);
        expect(writes).toHaveLength(1);

        agent.stop();
        publisher.sync(state);
        // No timer advance: a stale count must not survive a process that exits
        // the moment its last subagent finishes.
        expect(writes).toHaveLength(2);
        expect(writes[1].subagents).toEqual({ running: 0, queued: 0, total: 1 });
    });

    it('coalesces a start and its stop inside one window into a single write', () => {
        vi.useFakeTimers();
        const writes: ClaudeActivity[] = [];
        const publisher = new ClaudeActivityPublisher((activity) => writes.push(activity), { coalesceMs: 300 });
        const state: ClaudeSessionProtocolState = { currentTurnId: null };

        const first = runAgentSubagent(state, 'flap-1');
        first.start();
        publisher.sync(state);
        vi.advanceTimersByTime(300);
        expect(writes).toHaveLength(1);
        expect(writes[0].subagents.running).toBe(1);

        const second = runAgentSubagent(state, 'flap-2');
        second.start();
        publisher.sync(state);
        second.stop();
        publisher.sync(state);
        vi.advanceTimersByTime(300);

        // running went 1 -> 2 -> 1 inside one window. total moved though, so
        // the settled value is a real change and goes out once.
        expect(writes).toHaveLength(2);
        expect(writes[1].subagents).toEqual({ running: 1, queued: 0, total: 2 });
    });
});

describe('mapQueuedPromptToSessionEnvelopes (DROVE-41)', () => {
    it('shows a prompt the moment the terminal queues it', () => {
        const state: ClaudeSessionProtocolState = { currentTurnId: 'turn-1' };
        const result = mapQueuedPromptToSessionEnvelopes(
            { text: 'why is it taking so long', at: 1788113356575, carrier: 'enqueue' },
            state,
        );

        expect(result.envelopes).toHaveLength(1);
        expect(result.envelopes[0].role).toBe('user');
        expect(result.envelopes[0].ev).toEqual({ t: 'text', text: 'why is it taking so long' });
        // Stamped when it was typed, so it sits between the phone's messages
        // where the human put it rather than where Claude got round to it.
        expect(result.envelopes[0].time).toBe(1788113356575);
        // The turn Claude is in the middle of stays open. It is why the prompt
        // was queued at all, and ending it here would cut its reply in two.
        expect(result.currentTurnId).toBe('turn-1');
    });

    it('does not show the absorb record as a second message', () => {
        // The prompt reaches Claude twice on paper: the enqueue record when it
        // is typed, then an attachment/queued_command when the running turn
        // takes it. One message, so one bubble.
        const state: ClaudeSessionProtocolState = { currentTurnId: 'turn-1' };
        const typed = mapQueuedPromptToSessionEnvelopes(
            { text: 'why is it taking so long', at: 1788113356575, carrier: 'enqueue' },
            state,
        );
        const absorbed = mapQueuedPromptToSessionEnvelopes(
            { text: 'why is it taking so long', at: 1788113421656, carrier: 'absorbed' },
            state,
        );

        expect(typed.envelopes).toHaveLength(1);
        expect(absorbed.envelopes).toHaveLength(0);
    });

    it('shows an absorb record on its own when the enqueue was never seen', () => {
        // A scanner that starts mid-turn, or one whose first hook pre-marked
        // the transcript as history, has no enqueue to pair with. The absorb
        // record is then the first sighting and must not be swallowed.
        const state: ClaudeSessionProtocolState = { currentTurnId: 'turn-1' };
        const result = mapQueuedPromptToSessionEnvelopes(
            { text: 'resume the subagents', at: 1788113421656, carrier: 'absorbed' },
            state,
        );

        expect(result.envelopes).toHaveLength(1);
        expect(result.envelopes[0].ev).toEqual({ t: 'text', text: 'resume the subagents' });
    });

    it('reuses the queued envelope id when the prompt lands as a real turn', () => {
        // A prompt queued while Claude was busy and then dequeued normally
        // DOES become a `user` record. The app keys messages by envelope id,
        // so handing it the id we already sent leaves one bubble where the
        // human typed it instead of adding a second one lower down.
        const state: ClaudeSessionProtocolState = { currentTurnId: 'turn-1' };
        const queued = mapQueuedPromptToSessionEnvelopes(
            { text: 'why is it taking so long', at: 1788113356575, carrier: 'enqueue' },
            state,
        );
        const turn = mapClaudeLogMessageToSessionEnvelopes({
            type: 'user',
            uuid: 'ce582d10-2d6e-421d-96e8-7856e6ac21c4',
            isSidechain: false,
            message: { role: 'user', content: 'why is it taking so long' },
            timestamp: '2026-08-30T16:41:57.071Z',
        } as any, state);

        const userEnvelope = turn.envelopes.find((e) => e.role === 'user');
        expect(userEnvelope?.id).toBe(queued.envelopes[0].id);
        // And the id is spent: a second prompt with the same words is its own
        // message and gets its own bubble.
        const again = mapQueuedPromptToSessionEnvelopes(
            { text: 'why is it taking so long', at: 1788113500000, carrier: 'enqueue' },
            state,
        );
        expect(again.envelopes[0].id).not.toBe(queued.envelopes[0].id);
    });
});
