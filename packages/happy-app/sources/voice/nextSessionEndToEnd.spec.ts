import { beforeEach, describe, expect, it } from 'vitest';
import { ReadAloudReader, type SpeakOptions } from './readAloud';
import { startNextSessionPress } from './nextSession';
import type { RemoteCommand } from './headphonePress';
import type { Message } from '@/sync/typesMessage';

/**
 * The double press, driven through the REAL reader (DROVE-300).
 *
 * nextSession.spec.ts pins the decision and readingCycle.spec.ts pins the set.
 * Neither of them touches a reader, so neither can tell you whether the press
 * actually hands the voice over without losing a place — which is the whole
 * acceptance criterion, and the exact thing that was silently broken before
 * DROVE-289 (`focus` threw the reading away and coming back resumed at the
 * tail). So this file wires the press to a real `ReadAloudReader` with two and
 * three sessions and asserts positions on both sides of every press.
 *
 * NO MOUNTED SCREEN ANYWHERE IN HERE, which is the parity claim stated as a
 * test rather than as a comment. The press stream, the reader and the cycle
 * are all plain objects; there is no react, no navigation and no AppState. If
 * this passes, the same code path runs identically with the phone locked,
 * because there is nothing in it that could ask.
 */

function prose(id: string, text: string, createdAt: number): Message {
    return { id, localId: null, createdAt, kind: 'agent-text', text } as unknown as Message;
}

/** The engine from readAloudSessionSwitch.spec.ts: utterances finish on cue. */
class FakeEngine {
    spoken: string[] = [];
    stops = 0;
    private resolvers: Array<() => void> = [];

    speak(text: string, _options?: SpeakOptions): Promise<unknown> {
        this.spoken.push(text);
        return new Promise<void>((resolve) => { this.resolvers.push(resolve); });
    }

    stop(): void {
        this.stops += 1;
        for (const resolve of this.resolvers.splice(0)) resolve();
    }

    finish(): void {
        const resolve = this.resolvers.shift();
        if (resolve === undefined) throw new Error('nothing is speaking');
        resolve();
    }

    /** Two utterances in flight at once would be two voices at once. */
    get inFlight(): number {
        return this.resolvers.length;
    }
}

async function settle(): Promise<void> {
    for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe('a double press hands the voice to the next reading-enabled session', () => {
    let engine: FakeEngine;
    let reader: ReadAloudReader;
    let cycle: string[];
    let press: (command: RemoteCommand) => void;
    let stop: () => void;

    beforeEach(() => {
        engine = new FakeEngine();
        reader = new ReadAloudReader(engine);
        reader.setEnabled(true);
        reader.focus('s1');
        cycle = ['s1', 's2'];
        let listener: ((command: RemoteCommand) => void) | null = null;
        stop = startNextSessionPress({
            cycle: () => cycle,
            current: () => reader.focusedSessionId,
            reading: () => reader.isEnabled,
            take: (sessionId) => reader.focus(sessionId),
            subscribe: (fn) => {
                listener = fn;
                return { remove: () => { listener = null; } };
            },
        });
        press = (command) => listener?.(command);
    });

    it('pauses the current session at its sentence and never advances it', async () => {
        reader.onMessages('s1', [prose('m1', 'One. Two. Three. Four.', 10)]);
        await settle();
        engine.finish();
        await settle();
        // 'Two.' is at the synthesiser when he double-presses.
        expect(engine.spoken).toEqual(['One.', 'Two.']);

        const before = engine.spoken.length;
        press('next');
        await settle();

        // The utterance in flight is cut, nothing new is said out of s1, and
        // s1 is holding its place rather than having been stopped.
        expect(engine.spoken.length).toBe(before);
        expect(reader.hasHeldReading('s1')).toBe(true);
        expect(reader.focusedSessionId).toBe('s2');
        expect(reader.isEnabled).toBe(true);
    });

    it('never has two sessions speaking at once', async () => {
        reader.onMessages('s1', [prose('m1', 'One. Two. Three.', 10)]);
        await settle();
        expect(engine.inFlight).toBe(1);

        press('next');
        await settle();
        // The old session's utterance was settled by the switch, and the new
        // session has nothing to say yet, so the synthesiser is empty.
        expect(engine.inFlight).toBe(0);

        reader.onMessages('s2', [prose('m2', 'Alpha. Beta.', 20)]);
        await settle();
        expect(engine.inFlight).toBe(1);
        expect(engine.spoken).toEqual(['One.', 'Alpha.']);
    });

    it('resumes the session it comes back to at ITS own held position', async () => {
        reader.onMessages('s1', [prose('m1', 'One. Two. Three. Four.', 10)]);
        await settle();
        engine.finish();
        await settle();
        expect(engine.spoken).toEqual(['One.', 'Two.']);

        press('next');
        await settle();
        reader.onMessages('s2', [prose('m2', 'Alpha. Beta. Gamma.', 20)]);
        await settle();
        expect(engine.spoken).toEqual(['One.', 'Two.', 'Alpha.']);

        // Wraps back to s1, which resumes at the sentence after the one it was
        // cut in — DROVE-233's granularity, and never at the tail.
        press('next');
        await settle();
        expect(reader.focusedSessionId).toBe('s1');
        expect(engine.spoken).toEqual(['One.', 'Two.', 'Alpha.', 'Three.']);
    });

    it('walks the whole ring and wraps at the end', async () => {
        cycle = ['s1', 's2', 's3'];
        press('next');
        await settle();
        expect(reader.focusedSessionId).toBe('s2');
        press('next');
        await settle();
        expect(reader.focusedSessionId).toBe('s3');
        press('next');
        await settle();
        expect(reader.focusedSessionId).toBe('s1');
    });

    it('skips the sessions that do not have reading enabled', async () => {
        // s2 is not in the cycle at all, so no number of presses reaches it.
        cycle = ['s1', 's3'];
        press('next');
        await settle();
        expect(reader.focusedSessionId).toBe('s3');
        press('next');
        await settle();
        expect(reader.focusedSessionId).toBe('s1');
    });

    it('does nothing at all when only one session has reading enabled', async () => {
        cycle = ['s1'];
        reader.onMessages('s1', [prose('m1', 'One. Two. Three.', 10)]);
        await settle();
        expect(engine.spoken).toEqual(['One.']);
        const stopsBefore = engine.stops;

        press('next');
        press('next');
        await settle();

        // Not a stop, not a pause, not a lost place: the sentence in flight is
        // still in flight and the reader has not moved.
        expect(engine.stops).toBe(stopsBefore);
        expect(engine.spoken).toEqual(['One.']);
        expect(reader.focusedSessionId).toBe('s1');
        expect(reader.isPaused).toBe(false);
        expect(reader.isEnabled).toBe(true);

        engine.finish();
        await settle();
        expect(engine.spoken).toEqual(['One.', 'Two.']);
    });

    it('does not turn reading on from a pocket', async () => {
        reader.setEnabled(false);
        press('next');
        await settle();
        expect(reader.isEnabled).toBe(false);
        expect(engine.spoken).toEqual([]);
    });

    it('leaves the single press and the triple press alone', async () => {
        reader.onMessages('s1', [prose('m1', 'One. Two.', 10)]);
        await settle();
        press('toggle');
        press('play');
        press('pause');
        press('previous');
        await settle();
        // The transport is backgroundAudio.ts's and the mic is
        // useVoiceComposer's. This subscription must not answer either.
        expect(reader.focusedSessionId).toBe('s1');
        expect(reader.isPaused).toBe(false);
    });

    it('stops answering once it is torn down', async () => {
        stop();
        press('next');
        await settle();
        expect(reader.focusedSessionId).toBe('s1');
    });
});
