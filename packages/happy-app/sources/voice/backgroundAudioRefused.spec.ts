import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReadAloudReader, type SpeakOptions } from './readAloud';
import { stopsSpeech } from './readAloudGate';
import type { Message } from '@/sync/typesMessage';

/**
 * A refused audio session no longer eats the reply (DROVE-189, second pass).
 *
 * Clay has now reported the same thing three times, in the same words: "when
 * the app is not in foreground it's stopping the read back audio." Each
 * earlier fix was true and none of them was the whole thing.
 *
 *   - DROVE-30 put `UIBackgroundModes: ["audio"]` in the plist. Necessary,
 *     and it has been on his phone since build 1.
 *   - DROVE-179 ruled that backgrounding is not a stop, so the gate carries
 *     `backgrounded: false`. Necessary.
 *   - The first DROVE-189 pass stopped `rest()` releasing the audio session on
 *     a drained queue, which is what let iOS suspend a backgrounded app.
 *     Necessary.
 *
 * What none of them covered is what happens when the session says NO. On iOS
 * `speak` rejects when `activatePlayback` throws, and it throws for as long as
 * an audio-session interruption has not ended: a call, Siri, a notification
 * sound, and his phone gets a lot of those with eight agents running. The
 * reader swallowed that rejection and pumped the next sentence, which was
 * refused too, and the next, marking each one `spoken` on the way in. One
 * refusing second consumed the whole reply. The app was alive, connected and
 * silent, with nothing left to say, which is exactly what he describes.
 *
 * The rule now: REJECTED is not SPOKEN. A refused utterance is put back whole
 * and the queue waits, because the sentence is still owed. RESOLVED stays
 * spoken however short it was, which is DROVE-126's invariant and the reason
 * coming back to the app cannot repeat a sentence he already heard.
 */

function prose(id: string, text: string, createdAt: number): Message {
    return { id, localId: null, createdAt, kind: 'agent-text', text } as unknown as Message;
}

describe('an audio session that refuses (DROVE-189)', () => {
    /** Sentences the engine was OFFERED, refused ones included. */
    let attempted: string[];
    /** Sentences that actually made a sound. */
    let said: string[];
    let refuse: boolean;
    let reader: ReadAloudReader;

    const retryDelayMs = 10;

    beforeEach(() => {
        vi.useFakeTimers();
        attempted = [];
        said = [];
        refuse = false;
        reader = new ReadAloudReader(
            {
                speak(text: string, _options?: SpeakOptions) {
                    attempted.push(text);
                    // What DroverSpeechModule does: reject before a word is
                    // uttered when `activatePlayback` throws.
                    if (refuse) return Promise.reject(new Error('cannot activate session'));
                    said.push(text);
                    return Promise.resolve();
                },
                stop() { },
            },
            { retryDelayMs },
        );
        reader.setEnabled(true);
        reader.focus('s1');
    });

    afterEach(() => {
        // A stalled reader holds a retry timer, and the fake clock is shared
        // across the file: leaving one armed lets the previous test's reader
        // speak into this one's arrays. Turning read-aloud off drops it, and
        // the real clock drops anything else.
        reader.setEnabled(false);
        vi.useRealTimers();
    });

    /** Let the microtask queue and any due timers run. */
    async function tick(ms = 0): Promise<void> {
        await vi.advanceTimersByTimeAsync(ms);
    }

    it('THE BUG: a refusing session used to swallow the whole reply', async () => {
        refuse = true;
        reader.setBackgrounded(true);
        reader.onMessages('s1', [prose('m1', 'One. Two. Three.', 1)]);
        await tick();

        // One sentence offered, one refused, and the queue stops there. Before
        // this ticket all three were offered, all three refused, and all three
        // marked spoken inside a single turn of the loop.
        expect(attempted).toEqual(['One.']);
        expect(said).toEqual([]);
        expect(reader.isStalled).toBe(true);
    });

    it('reads the whole reply once the session takes it back', async () => {
        refuse = true;
        reader.setBackgrounded(true);
        reader.onMessages('s1', [prose('m1', 'One. Two. Three.', 1)]);
        await tick();

        refuse = false;
        await tick(retryDelayMs);
        expect(said).toEqual(['One.', 'Two.', 'Three.']);
        expect(reader.isStalled).toBe(false);
    });

    it('keeps asking while the refusal lasts rather than giving up once', async () => {
        refuse = true;
        reader.setBackgrounded(true);
        reader.onMessages('s1', [prose('m1', 'One.', 1)]);
        await tick();
        expect(reader.refusalCount).toBe(1);

        await tick(retryDelayMs * 4);
        expect(reader.refusalCount).toBeGreaterThan(1);
        expect(said).toEqual([]);

        refuse = false;
        await tick(retryDelayMs);
        expect(said).toEqual(['One.']);
    });

    it('coming back to the foreground asks at once instead of waiting out the timer', async () => {
        refuse = true;
        reader.setBackgrounded(true);
        reader.onMessages('s1', [prose('m1', 'One.', 1)]);
        await tick();
        expect(said).toEqual([]);

        // He opens the app. The session is his again the moment he does.
        refuse = false;
        reader.setBackgrounded(false);
        await tick();
        expect(said).toEqual(['One.']);
    });

    /**
     * DROVE-126's invariant, from the other side. A sentence that DID make a
     * sound stays spoken, so returning to the app cannot re-read it; only the
     * one that was refused is still owed.
     */
    it('does not repeat a sentence he already heard when he comes back', async () => {
        reader.setBackgrounded(true);
        reader.onMessages('s1', [prose('m1', 'One. Two. Three.', 1)]);
        await tick();
        expect(said).toEqual(['One.', 'Two.', 'Three.']);

        // A notification takes the route. The next reply is refused.
        refuse = true;
        reader.onMessages('s1', [prose('m2', 'Four. Five.', 2)]);
        await tick();
        expect(said).toEqual(['One.', 'Two.', 'Three.']);

        refuse = false;
        reader.setBackgrounded(false);
        await tick();
        // Four and Five, once each, and not a word of the first reply again.
        expect(said).toEqual(['One.', 'Two.', 'Three.', 'Four.', 'Five.']);
    });

    it('a sentence that was cut mid-word is still spoken and never repeats', async () => {
        // The engine RESOLVES: a real utterance that ended early still made a
        // sound, so it is finished with. Only a rejection is still owed.
        reader.setBackgrounded(true);
        reader.onMessages('s1', [prose('m1', 'One. Two.', 1)]);
        await tick();
        expect(said).toEqual(['One.', 'Two.']);
        reader.setBackgrounded(false);
        await tick(retryDelayMs * 3);
        expect(said).toEqual(['One.', 'Two.']);
    });

    it('a gate line the session refused goes back to the FRONT of the queue', async () => {
        refuse = true;
        reader.setBackgrounded(true);
        reader.sayUrgent('gate-1', 'Claude is asking to run a command.');
        await tick();
        expect(said).toEqual([]);
        expect(reader.urgentPending).toBe(1);

        refuse = false;
        reader.onMessages('s1', [prose('m1', 'A reply.', 1)]);
        await tick(retryDelayMs);
        // The gate still outranks the transcript on the way out (DROVE-188).
        expect(said).toEqual(['Claude is asking to run a command.', 'A reply.']);
    });

    it('material arriving while stalled is queued, not lost and not spoken early', async () => {
        refuse = true;
        reader.setBackgrounded(true);
        reader.onMessages('s1', [prose('m1', 'One.', 1)]);
        await tick();
        reader.onMessages('s1', [prose('m2', 'Two.', 2)]);
        await tick();
        expect(said).toEqual([]);

        refuse = false;
        await tick(retryDelayMs);
        expect(said).toEqual(['One.', 'Two.']);
    });

    it('turning read-aloud off ends the retries', async () => {
        refuse = true;
        reader.setBackgrounded(true);
        reader.onMessages('s1', [prose('m1', 'One.', 1)]);
        await tick();
        expect(reader.isStalled).toBe(true);

        reader.setEnabled(false);
        expect(reader.isStalled).toBe(false);
        const before = reader.refusalCount;
        await tick(retryDelayMs * 5);
        expect(reader.refusalCount).toBe(before);
        expect(said).toEqual([]);
    });

    it('audioSessionRecovered is safe to call when nothing is owed', async () => {
        reader.setBackgrounded(true);
        reader.onMessages('s1', [prose('m1', 'One.', 1)]);
        await tick();
        expect(said).toEqual(['One.']);
        reader.audioSessionRecovered();
        reader.audioSessionRecovered();
        await tick(retryDelayMs * 2);
        expect(said).toEqual(['One.']);
    });

    it('the mic giving the route back is one of the moments it asks again', async () => {
        refuse = true;
        reader.setBackgrounded(true);
        reader.onMessages('s1', [prose('m1', 'One.', 1)]);
        await tick();
        expect(said).toEqual([]);

        reader.setMicHeld(true);
        refuse = false;
        reader.setMicHeld(false);
        await tick();
        expect(said).toEqual(['One.']);
    });

    /**
     * The gate still answers the lifecycle questions the ticket asks, and
     * these are the answers the rest of this file assumes.
     */
    it('backgrounding, locking and a dropped socket are not stops', () => {
        expect(stopsSpeech('backgrounded')).toBe(false);
        expect(stopsSpeech('disconnected')).toBe(false);
        expect(stopsSpeech('left-session')).toBe(false);
    });
});
