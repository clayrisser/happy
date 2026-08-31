import { describe, expect, it, beforeEach } from 'vitest';
import type { Message } from '@/sync/typesMessage';
import { ReadAloudReader, type SpeechEngine } from './readAloud';

/** An engine that lets a test decide when each utterance ends. */
class FakeEngine implements SpeechEngine {
    spoken: string[] = [];
    stops = 0;
    private resolvers: (() => void)[] = [];

    speak(text: string): Promise<unknown> {
        this.spoken.push(text);
        return new Promise<void>((resolve) => { this.resolvers.push(resolve); });
    }

    stop(): void {
        this.stops += 1;
        const pending = this.resolvers;
        this.resolvers = [];
        for (const resolve of pending) resolve();
    }

    /** Let the current utterance finish. */
    finishOne(): void {
        const resolve = this.resolvers.shift();
        resolve?.();
    }
}

/** Let every queued microtask run, the way the reader chains them. */
async function settle(): Promise<void> {
    for (let i = 0; i < 8; i++) await Promise.resolve();
}

function agentText(id: string, text: string, createdAt = 1): Message {
    return { kind: 'agent-text', id, localId: null, createdAt, text } as Message;
}

describe('ReadAloudReader', () => {
    let engine: FakeEngine;
    let reader: ReadAloudReader;

    beforeEach(() => {
        engine = new FakeEngine();
        reader = new ReadAloudReader(engine);
        reader.setEnabled(true);
        reader.focus('s1');
    });

    it('speaks assistant prose one sentence at a time', async () => {
        reader.onMessages('s1', [agentText('m1', 'All set. Tests pass. Nothing else changed.')]);
        await settle();
        expect(engine.spoken).toEqual(['All set.']);

        engine.finishOne();
        await settle();
        expect(engine.spoken).toEqual(['All set.', 'Tests pass.']);

        engine.finishOne();
        await settle();
        expect(engine.spoken).toEqual(['All set.', 'Tests pass.', 'Nothing else changed.']);
    });

    it('starts speaking before the rest of the reply is queued', async () => {
        reader.onMessages('s1', [agentText('m1', 'First part lands.')]);
        await settle();
        expect(engine.spoken).toEqual(['First part lands.']);

        // Second block of the same turn, still mid-turn.
        reader.onMessages('s1', [agentText('m2', 'Second part lands.', 2)]);
        await settle();
        expect(engine.spoken).toEqual(['First part lands.']);

        engine.finishOne();
        await settle();
        expect(engine.spoken).toEqual(['First part lands.', 'Second part lands.']);
    });

    it('never speaks tool calls, thinking or the user', async () => {
        const tool = {
            kind: 'tool-call', id: 't1', localId: null, createdAt: 1, children: [],
            tool: {
                name: 'Bash', state: 'completed', input: { command: 'ls' },
                createdAt: 1, startedAt: 1, completedAt: 2, description: 'ls',
            },
        } as unknown as Message;
        const thinking = {
            kind: 'agent-text', id: 'k1', localId: null, createdAt: 2,
            text: '*deciding*', isThinking: true,
        } as unknown as Message;
        const user = {
            kind: 'user-text', id: 'u1', localId: null, createdAt: 3, text: 'go on',
        } as unknown as Message;

        reader.onMessages('s1', [tool, thinking, user]);
        await settle();
        expect(engine.spoken).toEqual([]);
    });

    it('reads only the session in focus', async () => {
        reader.onMessages('s2', [agentText('m1', 'Other session talking.')]);
        await settle();
        expect(engine.spoken).toEqual([]);
    });

    it('says nothing at all while disabled', async () => {
        reader.setEnabled(false);
        reader.onMessages('s1', [agentText('m1', 'Quiet please.')]);
        await settle();
        expect(engine.spoken).toEqual([]);
    });

    it('cuts speech and drops the rest of the queue when interrupted', async () => {
        reader.onMessages('s1', [agentText('m1', 'One. Two. Three.')]);
        await settle();
        expect(engine.spoken).toEqual(['One.']);

        reader.interrupt('typed');
        await settle();
        expect(engine.stops).toBe(1);
        expect(reader.pending).toBe(0);
        // The straggler settling under the old generation must not restart it.
        expect(engine.spoken).toEqual(['One.']);
    });

    it('goes quiet when read-aloud is toggled off mid-reply', async () => {
        reader.onMessages('s1', [agentText('m1', 'One. Two.')]);
        await settle();
        reader.setEnabled(false);
        await settle();
        expect(engine.stops).toBe(1);
        expect(engine.spoken).toEqual(['One.']);
    });

    it('stops when the session being read changes', async () => {
        reader.onMessages('s1', [agentText('m1', 'One. Two.')]);
        await settle();
        reader.focus('s2');
        await settle();
        expect(engine.stops).toBe(1);
        expect(engine.spoken).toEqual(['One.']);
    });

    it('stops when the session is left entirely', async () => {
        reader.onMessages('s1', [agentText('m1', 'One. Two.')]);
        await settle();
        reader.focus(null, 'left-session');
        await settle();
        expect(engine.stops).toBe(1);
    });

    it('lets a second chat unmount without taking the voice away', async () => {
        reader.onMessages('s1', [agentText('m1', 'One. Two.')]);
        await settle();
        // The embedded side chat, on some other session, going away.
        reader.blur('s2');
        await settle();
        expect(reader.focusedSessionId).toBe('s1');
        expect(engine.stops).toBe(0);

        reader.blur('s1');
        await settle();
        expect(reader.focusedSessionId).toBeNull();
        expect(engine.stops).toBe(1);
    });

    it('does not re-read a message that is redelivered unchanged', async () => {
        const message = agentText('m1', 'Only once.');
        reader.onMessages('s1', [message]);
        await settle();
        engine.finishOne();
        await settle();
        reader.onMessages('s1', [message]);
        await settle();
        expect(engine.spoken).toEqual(['Only once.']);
    });

    it('reads only the new tail when a message grows', async () => {
        reader.onMessages('s1', [agentText('m1', 'First.')]);
        await settle();
        engine.finishOne();
        await settle();
        reader.onMessages('s1', [agentText('m1', 'First. Second.')]);
        await settle();
        expect(engine.spoken).toEqual(['First.', 'Second.']);
    });

    it('releases the audio session once the queue drains', async () => {
        reader.onMessages('s1', [agentText('m1', 'Just one sentence.')]);
        await settle();
        expect(engine.stops).toBe(0);
        engine.finishOne();
        await settle();
        expect(engine.stops).toBe(1);
    });

    it('keeps going when one utterance fails', async () => {
        const flaky: SpeechEngine = {
            spoken: [] as string[],
            speak(text: string) {
                (this as any).spoken.push(text);
                return (this as any).spoken.length === 1
                    ? Promise.reject(new Error('voice unavailable'))
                    : Promise.resolve();
            },
            stop() {},
        } as unknown as SpeechEngine;
        const other = new ReadAloudReader(flaky);
        other.setEnabled(true);
        other.focus('s1');
        other.onMessages('s1', [agentText('m1', 'One. Two.')]);
        await settle();
        expect((flaky as any).spoken).toEqual(['One.', 'Two.']);
    });
});

/**
 * Every way speech can be cut has to reach a capture listener, with the
 * reason (DROVE-30). The mic hangs off this, so a path that cut speech
 * without notifying would be a latched mic left hot.
 */
describe('ReadAloudReader interrupt listeners', () => {
    let engine: FakeEngine;
    let reader: ReadAloudReader;
    let heard: string[];

    beforeEach(() => {
        engine = new FakeEngine();
        reader = new ReadAloudReader(engine);
        heard = [];
        reader.addInterruptListener((reason) => heard.push(reason));
    });

    it('hears a direct interrupt even while nothing is speaking', () => {
        reader.interrupt('typed');
        reader.interrupt('sent');
        expect(heard).toEqual(['typed', 'sent']);
        // And the engine was never asked to stop, because it never started.
        expect(engine.stops).toBe(0);
    });

    it('hears focus moving, losing focus, and the toggle going off', () => {
        reader.setEnabled(true);
        reader.focus('s1');
        reader.focus('s2');
        reader.blur('s2');
        reader.setEnabled(false);
        expect(heard).toEqual(['switched-session', 'switched-session', 'left-session', 'toggled-off']);
        // Turning it off when it is already off cuts nothing and says nothing.
        reader.setEnabled(false);
        expect(heard).toHaveLength(4);
    });

    it('carries the reason a call started and the mic was pressed', () => {
        reader.interrupt('call-started');
        reader.interrupt('mic');
        expect(heard).toEqual(['call-started', 'mic']);
    });

    it('keeps notifying the rest when one listener throws', () => {
        const after: string[] = [];
        reader.addInterruptListener(() => { throw new Error('boom'); });
        reader.addInterruptListener((reason) => after.push(reason));
        reader.interrupt('typed');
        expect(after).toEqual(['typed']);
    });

    it('stops notifying after the unsubscribe', () => {
        const late: string[] = [];
        const off = reader.addInterruptListener((reason) => late.push(reason));
        reader.interrupt('typed');
        off();
        reader.interrupt('sent');
        expect(late).toEqual(['typed']);
    });
});
