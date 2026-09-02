import { describe, expect, it } from 'vitest';
import type { Message } from '@/sync/typesMessage';
import type { ToolCall } from '@/sync/typesMessage';
import { resolveSpokenRate, resolveStreamTalk } from '@/sync/settings';
import { ReadAloudReader, type SpeakOptions, type SpeechEngine } from './readAloud';

/**
 * The normal rate is the slider, full stop (DROVE-177).
 *
 * Clay, an hour after DROVE-116 shipped: "why are you talking so fast when
 * not behind". These drive the real reader with the shipped numbers, wired
 * the way readAloudService wires it, through a realistic session: prose,
 * a run of tool calls with spoken titles (DROVE-112), more prose, and the
 * agent finishing. The engine here resolves the ABSOLUTE rate exactly as
 * speechEngine does, so what is asserted is the number AVSpeechUtterance
 * would be handed, not a multiplier.
 */

/** What speechEngine would say each utterance at, given the slider. */
class RateEngine implements SpeechEngine {
    spoken: { text: string; rate: number; aside: boolean }[] = [];
    private resolvers: (() => void)[] = [];

    constructor(private readonly sliderRate: number) {}

    speak(text: string, options?: SpeakOptions): Promise<unknown> {
        const aside = options?.aside === true;
        this.spoken.push({ text, aside, rate: resolveSpokenRate(this.sliderRate, options?.rateScale ?? 1, aside) });
        return new Promise<void>((resolve) => { this.resolvers.push(resolve); });
    }

    stop(): void {
        const pending = this.resolvers;
        this.resolvers = [];
        for (const resolve of pending) resolve();
    }

    get busy(): boolean {
        return this.resolvers.length > 0;
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

function userText(id: string, createdAt: number, text: string): Message {
    return { kind: 'user-text', id, localId: null, createdAt, text } as Message;
}

function toolCall(id: string, description: string, createdAt: number): Message {
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
        } as ToolCall,
    } as Message;
}

/** The title policy, stubbed: every tool call is worth its description. */
function titleFor(message: Message): string | null {
    return message.kind === 'tool-call' ? message.tool.description ?? null : null;
}

/** `count` sentences of `width` words each. */
function prose(prefix: string, count: number, width = 8): string {
    return Array.from({ length: count }, (_, i) =>
        `${prefix} ${Array.from({ length: width - 2 }, (__, w) => `word${w + 1}`).join(' ')} ${i + 1}.`).join(' ');
}

/**
 * The slider somewhere other than the default, so a pass proves the reader
 * follows HIS number rather than happening to land on 0.52.
 */
const sliderRate = 0.45;

function realReader(engine: SpeechEngine, clock: () => number, running: () => boolean): ReadAloudReader {
    // Exactly the expressions readAloudService uses, against a settings
    // object that carries only the slider, the way a synced partial would.
    const talk = resolveStreamTalk({ streamTalk: { rate: sliderRate } });
    expect(talk.rate).toBe(sliderRate);
    expect(talk.maxBacklogSeconds).toBe(15);
    expect(talk.jumpBacklogSeconds).toBe(45);
    const reader = new ReadAloudReader(engine, {
        now: clock,
        maxBacklogSeconds: () => talk.maxBacklogSeconds,
        jumpBacklogSeconds: () => talk.jumpBacklogSeconds,
        maxRateScale: () => (talk.rate > 0 ? talk.catchUpRate / talk.rate : 1),
        turnStillRunning: () => running(),
        skipMarker: '',
        asideFor: titleFor,
    });
    reader.setEnabled(true);
    reader.focus('s1');
    reader.setSessionEnabled('s1', true);
    return reader;
}

const asideRate = resolveSpokenRate(sliderRate, 1, true);

describe('the normal rate is the slider (DROVE-177)', () => {
    it('never rises above the slider through a session of prose and tool calls with the backlog under the threshold', async () => {
        const engine = new RateEngine(sliderRate);
        let clock = 1_000_000;
        let running = true;
        const reader = realReader(engine, () => clock, () => running);

        // Speak whatever is queued, a sentence every two seconds, until the
        // queue drains, the way a phone would between two events.
        async function drain(): Promise<void> {
            await settle();
            while (engine.busy) {
                clock += 2000;
                engine.finishOne();
                await settle();
            }
        }

        const t0 = clock;
        reader.onMessages('s1', [userText('u1', t0, 'Fix the failing spec.')]);
        clock = t0 + 1500;
        reader.onMessages('s1', [agentText('a1', 'Let me look at the spec first. The failure is in the reader.', clock)]);
        await settle();
        clock += 500;
        reader.onMessages('s1', [toolCall('c1', 'Reading readAloud.spec.ts', clock)]);
        clock += 1500;
        reader.onMessages('s1', [toolCall('c2', 'Searching for catchUpRate', clock)]);
        clock += 1500;
        reader.onMessages('s1', [toolCall('c3', 'Running the reader spec', clock)]);
        await drain();

        // The next reply streams in two batches, so for that moment the
        // stream IS arriving; the backlog is still far under 15 s.
        clock += 4000;
        const a2 = clock;
        reader.onMessages('s1', [agentText('a2', 'The ramp fires on a finished reply.', a2)]);
        await settle();
        clock += 400;
        reader.onMessages('s1', [agentText('a2', 'The ramp fires on a finished reply. That is the bug. I will gate it on arrival.', a2)]);
        await settle();
        clock += 1000;
        reader.onMessages('s1', [toolCall('c4', 'Editing readAloud.ts', clock)]);
        clock += 4000;
        reader.onMessages('s1', [toolCall('c5', 'Running the voice specs', clock)]);
        await drain();

        clock += 6000;
        reader.onMessages('s1', [agentText('a3', 'All green now. The rate stays at the slider when nothing new is arriving.', clock)]);
        running = false;
        await drain();

        expect(reader.skipCount).toBe(0);
        expect(engine.spoken.map((s) => s.text)).toEqual([
            'Let me look at the spec first.',
            'The failure is in the reader.',
            'Reading readAloud.spec.ts',
            'Searching for catchUpRate',
            'Running the reader spec',
            'The ramp fires on a finished reply.',
            'That is the bug.',
            'I will gate it on arrival.',
            'Editing readAloud.ts',
            'Running the voice specs',
            'All green now.',
            'The rate stays at the slider when nothing new is arriving.',
        ]);
        const asides = engine.spoken.filter((s) => s.aside);
        const sentences = engine.spoken.filter((s) => !s.aside);
        expect(asides).toHaveLength(5);
        expect(sentences).toHaveLength(7);
        // Prose at the slider, exactly. A title at the slider times the one
        // aside scale (DROVE-112), and nothing on top of that either.
        for (const s of sentences) expect(s.rate).toBe(sliderRate);
        for (const s of asides) expect(s.rate).toBe(asideRate);
        expect(asideRate).toBeCloseTo(sliderRate * 1.22, 10);
    });

    it('reads a long reply that has finished at the slider from first sentence to last', async () => {
        const engine = new RateEngine(sliderRate);
        let clock = 1_000_000;
        const reader = realReader(engine, () => clock, () => false);

        // 120 words: 48 s of audio, past both thresholds, in one piece and
        // with the agent done. Every sentence at the slider, nothing dropped.
        reader.onMessages('s1', [agentText('a1', prose('Done', 15), clock)]);
        await settle();
        while (engine.busy) {
            clock += 3000;
            engine.finishOne();
            await settle();
        }
        expect(engine.spoken).toHaveLength(15);
        expect(reader.skipCount).toBe(0);
        for (const s of engine.spoken) expect(s.rate).toBe(sliderRate);
    });

    it('still speeds up when it really is behind, and comes straight back when the agent stops', async () => {
        const engine = new RateEngine(sliderRate);
        let clock = 1_000_000;
        let running = true;
        const reader = realReader(engine, () => clock, () => running);
        const talk = resolveStreamTalk({ streamTalk: { rate: sliderRate } });

        // A reply streaming in half-second batches while one sentence is
        // being spoken: the backlog climbs into the band and the voice
        // reads faster, but never past the catch-up rate.
        const at = clock;
        let text = '';
        for (let batch = 1; batch <= 6; batch++) {
            text = prose('Stream', batch * 2);
            reader.onMessages('s1', [agentText('a1', text, at)]);
            await settle();
            clock += 500;
        }
        expect(engine.spoken).toHaveLength(1);
        expect(engine.spoken[0].rate).toBe(sliderRate);
        engine.finishOne();
        await settle();
        expect(engine.spoken[1].rate).toBeGreaterThan(sliderRate);
        expect(engine.spoken[1].rate).toBeLessThanOrEqual(talk.catchUpRate);
        expect(reader.skipCount).toBe(0);

        // The agent finishes. Whatever is queued is the answer, so the next
        // sentence and every one after it is back at the slider.
        running = false;
        while (engine.busy) {
            clock += 3000;
            engine.finishOne();
            await settle();
        }
        for (const s of engine.spoken.slice(2)) expect(s.rate).toBe(sliderRate);
        expect(reader.skipCount).toBe(0);
    });

    it('does not keep the ramp up through a run of tool titles with no new prose', async () => {
        const engine = new RateEngine(sliderRate);
        let clock = 1_000_000;
        const reader = realReader(engine, () => clock, () => true);

        // 20 s of prose lands as a stream, then only tool calls for the
        // next ten seconds. A title is not prose to catch up to, so once
        // the arrival window has passed the voice is back at the slider,
        // with the backlog still over the threshold and the agent still
        // running.
        const at = clock;
        reader.onMessages('s1', [agentText('a1', prose('Burst', 3), at)]);
        await settle();
        clock += 500;
        reader.onMessages('s1', [agentText('a1', prose('Burst', 7), at)]);
        await settle();
        engine.finishOne();
        await settle();
        expect(engine.spoken[1].rate).toBeGreaterThan(sliderRate);

        for (let i = 1; i <= 5; i++) {
            clock += 2000;
            reader.onMessages('s1', [toolCall(`c${i}`, `Tool call number ${i}`, clock)]);
            engine.finishOne();
            await settle();
        }
        const afterWindow = engine.spoken.slice(3);
        expect(afterWindow.length).toBeGreaterThan(0);
        for (const s of afterWindow) expect(s.rate).toBe(s.aside ? asideRate : sliderRate);
        expect(reader.skipCount).toBe(0);
    });
});
