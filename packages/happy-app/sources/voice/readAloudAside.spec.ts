import { beforeEach, describe, expect, it } from 'vitest';
import type { Message, ToolCall } from '@/sync/typesMessage';
import { ReadAloudReader, type SpeakOptions, type SpeechEngine } from './readAloud';
import { createCuedSpeechEngine } from './cuedSpeechEngine';

/**
 * The titles of tool calls, terminal calls and agents, through the REAL queue
 * (DROVE-112).
 *
 * Driven end to end rather than by calling internals, because the two things
 * that matter about a title are properties of the queue and not of the policy
 * that produced it: that it lands in its place in the transcript, and that it
 * is never said twice.
 */

class FakeEngine implements SpeechEngine {
    spoken: string[] = [];
    asides: boolean[] = [];
    private resolvers: (() => void)[] = [];

    speak(text: string, options?: SpeakOptions): Promise<unknown> {
        this.spoken.push(text);
        this.asides.push(options?.aside === true);
        return new Promise<void>((resolve) => { this.resolvers.push(resolve); });
    }

    stop(): void {
        const pending = this.resolvers;
        this.resolvers = [];
        for (const resolve of pending) resolve();
    }

    finishOne(): void {
        this.resolvers.shift()?.();
    }
}

async function settle(): Promise<void> {
    for (let i = 0; i < 8; i++) await Promise.resolve();
}

function agentText(id: string, text: string, createdAt: number): Message {
    return { kind: 'agent-text', id, localId: null, createdAt, text } as Message;
}

function toolCall(id: string, description: string, createdAt: number, patch: Partial<ToolCall> = {}): Message {
    return {
        kind: 'tool-call',
        id,
        localId: null,
        createdAt,
        children: [],
        tool: {
            name: 'Bash',
            state: 'running',
            input: {},
            createdAt,
            startedAt: null,
            completedAt: null,
            description,
            ...patch,
        },
    } as Message;
}

/** The title policy, stubbed: whatever a tool call's description says. */
function titleFor(message: Message): string | null {
    return message.kind === 'tool-call' ? message.tool.description : null;
}

/** Speak everything the engine has been handed, one utterance at a time. */
async function drain(engine: FakeEngine, limit = 20): Promise<void> {
    for (let i = 0; i < limit; i++) {
        engine.finishOne();
        await settle();
    }
}

describe('spoken titles in the reading lane', () => {
    let engine: FakeEngine;
    let reader: ReadAloudReader;

    beforeEach(() => {
        engine = new FakeEngine();
        reader = new ReadAloudReader(engine, { asideFor: titleFor, skipMarker: '' });
        reader.setEnabled(true);
        reader.focus('s1');
        reader.setSessionEnabled('s1', true);
    });

    it('says a title in its place, between the sentences around it', async () => {
        reader.onMessages('s1', [
            agentText('m1', 'First I will look.', 10),
            toolCall('t1', 'Check OTA and build progress', 20),
            agentText('m2', 'That worked.', 30),
        ]);
        await settle();
        await drain(engine);
        expect(engine.spoken).toEqual([
            'First I will look.',
            'Check OTA and build progress',
            'That worked.',
        ]);
    });

    it('marks the title as an aside and the prose as not', async () => {
        reader.onMessages('s1', [
            agentText('m1', 'Looking now.', 10),
            toolCall('t1', 'Read the lane', 20),
        ]);
        await settle();
        await drain(engine);
        expect(engine.asides).toEqual([false, true]);
    });

    it('never says a title twice, however often the message is redelivered', async () => {
        const call = toolCall('t1', 'Check OTA and build progress', 20);
        reader.onMessages('s1', [call]);
        await settle();
        await drain(engine);
        reader.onMessages('s1', [call]);
        reader.onMessages('s1', [call]);
        await settle();
        await drain(engine);
        expect(engine.spoken.filter((line) => line === 'Check OTA and build progress')).toHaveLength(1);
    });

    it('says a held tail before the title that came after it, not the other way round', async () => {
        // A reply whose last sentence has no full stop is held, waiting to
        // grow. A tool call landing after it means it is not going to.
        reader.onMessages('s1', [agentText('m1', 'Working on it', 10)]);
        reader.onMessages('s1', [toolCall('t1', 'Run the tests', 20)]);
        await settle();
        await drain(engine);
        expect(engine.spoken).toEqual(['Working on it', 'Run the tests']);
    });

    it('says nothing extra when no title policy is wired up', async () => {
        const plain = new ReadAloudReader(engine);
        plain.setEnabled(true);
        plain.focus('s2');
        plain.setSessionEnabled('s2', true);
        plain.onMessages('s2', [
            agentText('m1', 'Just prose.', 10),
            toolCall('t1', 'Should stay quiet', 20),
        ]);
        await settle();
        await drain(engine);
        expect(engine.spoken).toEqual(['Just prose.']);
    });
});

describe('the skip marker becomes a sound', () => {
    it('fires onSkip and says no words when the marker is empty', async () => {
        const engine = new FakeEngine();
        const skips: number[] = [];
        let now = 0;
        const reader = new ReadAloudReader(engine, {
            now: () => now,
            skipMarker: '',
            onSkip: () => { skips.push(now); },
            maxBacklogSeconds: () => 1,
        });
        reader.setEnabled(true);
        reader.focus('s1');
        reader.setSessionEnabled('s1', true);

        // A stream still arriving, with more unspoken audio than the threshold:
        // the conditions the cut needs (DROVE-108).
        reader.onMessages('s1', [agentText('m1', 'One two three four five six seven eight.', 10)]);
        await settle();
        now += 100;
        reader.onMessages('s1', [agentText('m2', 'Nine ten. Eleven twelve. Thirteen fourteen. Fifteen sixteen.', 20)]);
        now += 100;
        reader.onMessages('s1', [agentText('m3', 'Seventeen eighteen. Nineteen twenty.', 30)]);
        await settle();
        engine.finishOne();
        await settle();

        expect(skips.length).toBeGreaterThan(0);
        expect(reader.skipCount).toBe(skips.length);
        expect(engine.spoken).not.toContain('Skipping ahead.');
        // And the jump is not silent: reading carries straight on rather than
        // resting where the marker used to be.
        expect(engine.spoken.length).toBeGreaterThan(1);
    });

    it('still says the words when a caller leaves the default marker in place', async () => {
        const engine = new FakeEngine();
        let now = 0;
        const reader = new ReadAloudReader(engine, { now: () => now, maxBacklogSeconds: () => 1 });
        reader.setEnabled(true);
        reader.focus('s1');
        reader.setSessionEnabled('s1', true);
        reader.onMessages('s1', [agentText('m1', 'One two three four five six seven eight.', 10)]);
        await settle();
        now += 100;
        reader.onMessages('s1', [agentText('m2', 'Nine ten. Eleven twelve. Thirteen fourteen. Fifteen sixteen.', 20)]);
        now += 100;
        reader.onMessages('s1', [agentText('m3', 'Seventeen eighteen. Nineteen twenty.', 30)]);
        await settle();
        engine.finishOne();
        await settle();
        expect(engine.spoken).toContain('Skipping ahead.');
    });
});

describe('the cued engine wrapper', () => {
    it('holds the route for the whole utterance and gives it back after', async () => {
        const engine = new FakeEngine();
        const seen: boolean[] = [];
        const wrapped = createCuedSpeechEngine(engine, { setSpeaking: (value) => seen.push(value) });
        const spoken = wrapped.speak('Hello.');
        await settle();
        expect(seen).toEqual([true]);
        engine.finishOne();
        await spoken;
        expect(seen).toEqual([true, false]);
    });

    it('does not release the route while a straggler and a new utterance overlap', async () => {
        const engine = new FakeEngine();
        const seen: boolean[] = [];
        const wrapped = createCuedSpeechEngine(engine, { setSpeaking: (value) => seen.push(value) });
        const first = wrapped.speak('One.');
        const second = wrapped.speak('Two.');
        await settle();
        engine.finishOne();
        await first;
        // Still speaking: one utterance ending while another is in flight is
        // not a gap a cue may sound in.
        expect(seen).toEqual([true]);
        engine.finishOne();
        await second;
        expect(seen).toEqual([true, false]);
    });

    it('passes the aside flag through untouched', async () => {
        const engine = new FakeEngine();
        const wrapped = createCuedSpeechEngine(engine, { setSpeaking: () => {} });
        const spoken = wrapped.speak('A title', { aside: true });
        await settle();
        engine.finishOne();
        await spoken;
        expect(engine.asides).toEqual([true]);
    });
});
