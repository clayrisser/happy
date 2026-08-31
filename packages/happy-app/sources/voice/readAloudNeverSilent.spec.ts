import { describe, expect, it } from 'vitest';
import type { Message } from '@/sync/typesMessage';
import { ReadAloudReader, type SpeakOptions, type SpeechEngine } from './readAloud';
import {
    captureOnlyReasons,
    readAloudInterruptions,
    readAloudStopsSpeech,
    speechStoppingReasons,
    stopsSpeech,
    type ReadAloudInterruption,
} from './readAloudGate';

/**
 * DROVE-179. Clay, three ways in one night: "Stop silencing the reading back
 * when I'm doing things. When reading button is on you should read while I
 * type and do things and scroll."
 *
 * The three fixes before this one each found ONE caller after he complained.
 * This spec is the class: it drives the REAL reader through a session of him
 * doing things and asserts, after every one of them, that the voice never
 * went quiet and never lost its place. It is deliberately one long session
 * rather than a case per gesture, because that is the shape of the bug — no
 * single gesture was ever wrong on its own.
 */

/** An engine that lets the test decide when each utterance ends. */
class FakeEngine implements SpeechEngine {
    spoken: string[] = [];
    stops = 0;
    private resolvers: (() => void)[] = [];

    speak(text: string, _options?: SpeakOptions): Promise<unknown> {
        this.spoken.push(text);
        return new Promise<void>((resolve) => { this.resolvers.push(resolve); });
    }

    stop(): void {
        this.stops += 1;
        const pending = this.resolvers;
        this.resolvers = [];
        for (const resolve of pending) resolve();
    }

    /** Is a sentence in the air right now? */
    get speaking(): boolean {
        return this.resolvers.length > 0;
    }

    finishOne(): void {
        this.resolvers.shift()?.();
    }
}

async function settle(): Promise<void> {
    for (let i = 0; i < 8; i++) await Promise.resolve();
}

function agentText(id: string, text: string, createdAt = 1): Message {
    return { kind: 'agent-text', id, localId: null, createdAt, text } as Message;
}

function userText(id: string, createdAt: number, text = 'next thing'): Message {
    return { kind: 'user-text', id, localId: null, createdAt, text } as Message;
}

/** A long reply, so there is always more to say after each thing he does. */
const reply = Array.from({ length: 12 }, (_, i) => `Sentence number ${i + 1}.`).join(' ');

describe('the gate table (DROVE-179)', () => {
    it('names every reason and no reason is undecided', () => {
        // The union cannot grow behind this test's back: the list is derived
        // from the table, and the table is `satisfies Record<Reason, boolean>`.
        expect(readAloudInterruptions.length).toBeGreaterThan(0);
        for (const reason of readAloudInterruptions) {
            expect(typeof readAloudStopsSpeech[reason]).toBe('boolean');
        }
        expect([...speechStoppingReasons, ...captureOnlyReasons].sort())
            .toEqual([...readAloudInterruptions].sort());
    });

    it('allows exactly the reasons the ticket allows', () => {
        // Written out rather than derived, so changing the table means
        // changing this line, which means saying so on the ticket.
        expect([...speechStoppingReasons].sort()).toEqual([
            'call-started',
            'headphones-unplugged',
            'mic',
            'preview',
            'switched-session',
            'toggled-off',
        ]);
    });

    it('calls everything he does with his hands a capture-only reason', () => {
        for (const reason of ['typed', 'sent', 'left-session', 'backgrounded', 'disconnected'] satisfies ReadAloudInterruption[]) {
            expect(stopsSpeech(reason)).toBe(false);
        }
    });
});

describe('a session of him doing things (DROVE-179)', () => {
    it('never goes quiet and never loses its place', async () => {
        const engine = new FakeEngine();
        const reader = new ReadAloudReader(engine);
        reader.setEnabled(true);
        reader.focus('s1');
        // Listening starts after the session is picked up, so the list below
        // is only what HE did.
        const captureStops: ReadAloudInterruption[] = [];
        reader.addInterruptListener((reason) => captureStops.push(reason));
        reader.onMessages('s1', [agentText('m1', reply, 10)]);
        await settle();

        expect(engine.speaking).toBe(true);
        const startedWith = engine.spoken.length;
        const placeBefore = reader.readPosition;

        /** After each gesture: still speaking, still in the same reply, nothing cut. */
        const stillReading = (what: string) => {
            expect(engine.speaking, `${what} silenced the voice`).toBe(true);
            expect(engine.stops, `${what} cut the utterance`).toBe(0);
            expect(reader.readPosition, `${what} moved the place`).toBe(placeBefore);
            expect(reader.isEnabled, `${what} turned reading off`).toBe(true);
            expect(reader.focusedSessionId, `${what} dropped the session`).toBe('s1');
        };

        // He types the next thing while listening. DROVE-162's case.
        reader.userTyped();
        stillReading('typing');

        // He scrolls. DROVE-146 removed the coupling; nothing to call, so the
        // check is that the reader has no scroll input left to be given one.
        expect('onVisibleRange' in reader).toBe(false);

        // A sheet, a tool row, an expanded block, a tab: every one of them
        // reaches the reader the same way, as the chat surface going away.
        reader.blur('s1', 'left-session');
        stillReading('a sheet opening');

        // The agent screen. The case the ticket named outright.
        reader.blur('s1', 'left-session');
        stillReading('the agent screen');

        // The app went to the background and came back.
        reader.interrupt('backgrounded');
        stillReading('backgrounding');

        // The transport blipped and reconnected.
        reader.interrupt('disconnected');
        stillReading('a reconnect');

        // A message arrives from the agent mid-sentence.
        reader.onMessages('s1', [agentText('m1', `${reply} And one more.`, 10)]);
        stillReading('a message arriving');

        // He sends. DROVE-122: the answer does not exist yet.
        reader.userSent();
        reader.onMessages('s1', [userText('u1', 20)]);
        stillReading('sending');

        // And after all of it the reply is still being read, sentence by
        // sentence, from where it was.
        engine.finishOne();
        await settle();
        expect(engine.spoken.length).toBe(startedWith + 1);
        expect(engine.speaking).toBe(true);

        // Every gesture told the captures, which is the half that was always
        // right and must not have been thrown away with the other half.
        expect(captureStops).toEqual([
            'typed',
            'left-session',
            'left-session',
            'backgrounded',
            'disconnected',
            'sent',
        ]);
    });

    it('still stops for the mic, and resumes from the same sentence', async () => {
        const engine = new FakeEngine();
        const reader = new ReadAloudReader(engine);
        reader.setEnabled(true);
        reader.focus('s1');
        reader.onMessages('s1', [agentText('m1', reply, 10)]);
        await settle();
        const before = engine.spoken.length;

        reader.setMicHeld(true);
        await settle();
        expect(engine.speaking).toBe(false);
        expect(engine.stops).toBeGreaterThan(0);

        reader.setMicHeld(false);
        await settle();
        // Picks up where it was: the next unsaid sentence, not the top.
        expect(engine.spoken.length).toBe(before + 1);
        expect(engine.spoken[before]).not.toBe(engine.spoken[before - 1]);
    });

    it('still stops when he turns the button off', async () => {
        const engine = new FakeEngine();
        const reader = new ReadAloudReader(engine);
        reader.setEnabled(true);
        reader.focus('s1');
        reader.onMessages('s1', [agentText('m1', reply, 10)]);
        await settle();

        reader.setEnabled(false);
        await settle();
        expect(engine.speaking).toBe(false);
        expect(reader.isEnabled).toBe(false);
    });

    it('still stops when the headphones come out, and when a call takes the route', async () => {
        for (const reason of ['headphones-unplugged', 'call-started', 'preview'] satisfies ReadAloudInterruption[]) {
            const engine = new FakeEngine();
            const reader = new ReadAloudReader(engine);
            reader.setEnabled(true);
            reader.focus('s1');
            reader.onMessages('s1', [agentText('m1', reply, 10)]);
            await settle();

            reader.interrupt(reason);
            await settle();
            expect(engine.speaking, reason).toBe(false);
        }
    });

    it('follows him to another session rather than going quiet', async () => {
        const engine = new FakeEngine();
        const reader = new ReadAloudReader(engine);
        reader.setEnabled(true);
        reader.focus('s1');
        reader.onMessages('s1', [agentText('m1', reply, 10)]);
        await settle();

        // The decision DROVE-179 asked to be written down: a DIFFERENT
        // session taking focus does stop the old reply, and the voice reads
        // the new session instead of falling silent.
        reader.focus('s2');
        await settle();
        expect(reader.focusedSessionId).toBe('s2');

        const before = engine.spoken.length;
        reader.onMessages('s2', [agentText('m2', 'The other session speaks.', 30)]);
        await settle();
        expect(engine.spoken.length).toBe(before + 1);
        expect(engine.speaking).toBe(true);
    });

    it('a blur from a session that does not hold focus changes nothing', async () => {
        const engine = new FakeEngine();
        const reader = new ReadAloudReader(engine);
        reader.setEnabled(true);
        reader.focus('s1');
        reader.onMessages('s1', [agentText('m1', reply, 10)]);
        await settle();

        reader.blur('s2', 'left-session');
        expect(reader.focusedSessionId).toBe('s1');
        expect(engine.speaking).toBe(true);
    });

    it('a tap is a seek, not a stop', async () => {
        const engine = new FakeEngine();
        const reader = new ReadAloudReader(engine);
        reader.setEnabled(true);
        reader.focus('s1');
        const captureStops: ReadAloudInterruption[] = [];
        reader.addInterruptListener((reason) => captureStops.push(reason));
        reader.onMessages('s1', [agentText('m1', reply, 10)]);
        await settle();

        expect(reader.seekToSentence('m1', 'Sentence number 5.')).toBe(true);
        await settle();
        // It carries on reading from there, and no capture was told to stop:
        // moving the playhead is not a reason to close the mic (DROVE-163).
        expect(engine.speaking).toBe(true);
        expect(engine.spoken[engine.spoken.length - 1]).toBe('Sentence number 5.');
        expect(captureStops).toEqual([]);
    });
});
