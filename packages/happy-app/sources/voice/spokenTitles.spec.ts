import { beforeEach, describe, expect, it } from 'vitest';
import type { Message, ToolCall } from '@/sync/typesMessage';
import { SpokenTitleTracker, spokenToolTitle } from './spokenTitles';
import { audioCuesDefaults, type AudioCues } from '@/sync/settings';

function tool(patch: Partial<ToolCall> = {}): ToolCall {
    return {
        name: 'Bash',
        state: 'running',
        input: {},
        createdAt: 1,
        startedAt: null,
        completedAt: null,
        description: null,
        ...patch,
    };
}

function toolCall(id: string, patch: Partial<ToolCall> = {}, createdAt = 1): Message {
    return { kind: 'tool-call', id, localId: null, createdAt, tool: tool(patch), children: [] } as Message;
}

function agentText(id: string, text = 'And here is the answer.', createdAt = 1): Message {
    return { kind: 'agent-text', id, localId: null, createdAt, text } as Message;
}

function userText(id: string, createdAt = 1): Message {
    return { kind: 'user-text', id, localId: null, createdAt, text: 'do it' } as Message;
}

describe('spokenToolTitle', () => {
    it('reads a terminal call by its description, which is the row Clay pointed at', () => {
        expect(spokenToolTitle(tool({ description: 'Check OTA and build progress' })))
            .toBe('Check OTA and build progress');
    });

    it('falls back to the command when a terminal call has no description', () => {
        expect(spokenToolTitle(tool({ input: { command: 'git status' } }))).toBe('git status');
    });

    it('names an agent by its own description', () => {
        expect(spokenToolTitle(tool({ name: 'Task', input: { description: 'Audit the reader' } })))
            .toBe('Agent: Audit the reader');
    });

    it('falls back to the subagent type, which still says more than nothing', () => {
        expect(spokenToolTitle(tool({ name: 'Agent', input: { subagent_type: 'Explore' } })))
            .toBe('Agent: Explore');
    });

    it('says an MCP tool name in words rather than in underscores', () => {
        expect(spokenToolTitle(tool({ name: 'mcp__huly__create_issue' }))).toBe('huly create issue');
    });

    it('trims a title down to a footnote rather than a paragraph', () => {
        const long = 'x'.repeat(30) + ' ' + 'y'.repeat(200);
        const said = spokenToolTitle(tool({ description: long }));
        expect(said.length).toBeLessThanOrEqual(81);
        expect(said.endsWith('…')).toBe(true);
    });
});

describe('SpokenTitleTracker', () => {
    let tracker: SpokenTitleTracker;
    let config: Required<AudioCues>;

    beforeEach(() => {
        tracker = new SpokenTitleTracker();
        config = { ...audioCuesDefaults };
    });

    it('plays one cue when a RUN of tool calls starts, never one per call', () => {
        const first = tracker.observe(toolCall('t1'), config);
        const second = tracker.observe(toolCall('t2'), config);
        const third = tracker.observe(toolCall('t3'), config);
        expect(first.events).toEqual(['toolRun']);
        expect(second.events).toEqual([]);
        expect(third.events).toEqual([]);
    });

    it('starts a new run after prose, the way the transcript folds them', () => {
        expect(tracker.observe(toolCall('t1'), config).events).toEqual(['toolRun']);
        tracker.observe(agentText('m1'), config);
        expect(tracker.observe(toolCall('t2'), config).events).toEqual(['toolRun']);
    });

    it('says at most the run cap of tool titles and drops the rest silently', () => {
        config = { ...config, titlesPerRun: 2 };
        const said = ['t1', 't2', 't3', 't4', 't5']
            .map((id, index) => tracker.observe(toolCall(id, { description: `step ${index}` }), config).title)
            .filter((title): title is string => title !== null);
        expect(said).toEqual(['step 0', 'step 1']);
    });

    it('resets the run cap when prose comes between two runs', () => {
        config = { ...config, titlesPerRun: 1 };
        expect(tracker.observe(toolCall('t1', { description: 'one' }), config).title).toBe('one');
        expect(tracker.observe(toolCall('t2', { description: 'two' }), config).title).toBeNull();
        tracker.observe(agentText('m1'), config);
        expect(tracker.observe(toolCall('t3', { description: 'three' }), config).title).toBe('three');
    });

    it('never folds an agent away, because that is the one worth hearing', () => {
        config = { ...config, titlesPerRun: 0 };
        const agent = tracker.observe(toolCall('a1', { name: 'Task', input: { description: 'Ship it' } }), config);
        expect(agent.events).toEqual(['agentStart']);
        expect(agent.title).toBe('Agent: Ship it');
    });

    it('sounds once when an agent finishes, and differently when it fails', () => {
        const spawn = toolCall('a1', { name: 'Task', input: { description: 'Ship it' } });
        tracker.observe(spawn, config);
        const done = toolCall('a1', { name: 'Task', input: { description: 'Ship it' }, state: 'completed' });
        expect(tracker.observe(done, config).events).toEqual(['agentDone']);

        const other = new SpokenTitleTracker();
        other.observe(toolCall('a2', { name: 'Agent' }), config);
        expect(other.observe(toolCall('a2', { name: 'Agent', state: 'error' }), config).events).toEqual(['agentFailed']);
    });

    it('says nothing at all when an ordinary tool finishes', () => {
        tracker.observe(toolCall('t1'), config);
        expect(tracker.observe(toolCall('t1', { state: 'completed' }), config).events).toEqual([]);
    });

    it('is silent on a redelivery of the same call', () => {
        // applyMessages reports a message as changed whenever anything about
        // it changes, so without the seen map a redelivery would speak twice.
        expect(tracker.observe(toolCall('t1', { description: 'once' }), config).title).toBe('once');
        const again = tracker.observe(toolCall('t1', { description: 'once' }), config);
        expect(again.title).toBeNull();
        expect(again.events).toEqual([]);
    });

    it('says nothing for a message that is neither a tool call nor a boundary', () => {
        expect(tracker.observe(agentText('m1'), config)).toEqual({ events: [], title: null });
        expect(tracker.observe(userText('u1'), config)).toEqual({ events: [], title: null });
    });

    it('still fires the earcons when the titles are switched off', () => {
        config = { ...config, speakTitles: false };
        const spawn = tracker.observe(toolCall('a1', { name: 'Task' }), config);
        expect(spawn.events).toEqual(['agentStart']);
        expect(spawn.title).toBeNull();
    });

    it('speaks agent titles alone when tool titles are switched off', () => {
        config = { ...config, speakToolTitles: false };
        expect(tracker.observe(toolCall('t1', { description: 'grep' }), config).title).toBeNull();
        expect(tracker.observe(toolCall('a1', { name: 'Task', input: { description: 'Dig' } }), config).title)
            .toBe('Agent: Dig');
    });

    it('forgets the fold when focus moves to another session', () => {
        config = { ...config, titlesPerRun: 1 };
        expect(tracker.observe(toolCall('t1', { description: 'one' }), config).title).toBe('one');
        expect(tracker.observe(toolCall('t2', { description: 'two' }), config).title).toBeNull();
        tracker.reset();
        expect(tracker.observe(toolCall('t3', { description: 'three' }), config).title).toBe('three');
    });

    it('closes a run at the start of a new turn', () => {
        expect(tracker.observe(toolCall('t1'), config).events).toEqual(['toolRun']);
        tracker.observe(userText('u1'), config);
        expect(tracker.observe(toolCall('t2'), config).events).toEqual(['toolRun']);
    });
});
