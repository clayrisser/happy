import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReadAloudReader, type SpeakOptions } from './readAloud';
import type { Message } from '@/sync/typesMessage';

/**
 * Read-aloud starts at what has ARRIVED, never in the history (DROVE-226).
 *
 * Clay, having asked for this before: "I TOLD YOU START READING ONLY NEW
 * FUCKING MESSAGING unless I double tap a specific place to start."
 *
 * THE INVARIANT. When reading begins for any reason other than his tap, the
 * position is at the newest unread content and older content is never spoken.
 * It is DROVE-126's spoken-once rule reaching one step further back rather
 * than a new rule: a sentence he has heard cannot repeat, and a sentence that
 * was already on his screen when reading started counts as heard.
 *
 * WHAT WAS ACTUALLY WRONG, because DROVE-189 was the first suspect and it is
 * not the cause. `onMessages` is fed from applyMessages, and applyMessages
 * carries the transcript as well as the live stream. Opening a session fetches
 * the most recent page and a background prefetch then pages BACKWARDS through
 * the rest, and every one of those pages reached the reader looking exactly
 * like a reply landing. The older pages are the worse half: the turn only
 * moves on a user message NEWER than the one that opened the turn, so a page
 * of ancient history is stamped with the CURRENT turn, appended after the
 * newest reply, and read out in full. The conversation, narrated backwards.
 *
 * The first two cases below are the measurement that rules DROVE-189 in or
 * out. Its rewind is one utterance wide and it stays that way.
 */

function prose(id: string, text: string, createdAt: number): Message {
    return { id, localId: null, createdAt, kind: 'agent-text', text } as unknown as Message;
}

function user(id: string, text: string, createdAt: number): Message {
    return { id, localId: null, createdAt, kind: 'user-text', text } as unknown as Message;
}

describe('reading starts at what arrived (DROVE-226)', () => {
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
        reader.setSessionEnabled('s1', true);
    });

    afterEach(() => {
        // A stalled reader holds a retry timer and the fake clock is shared
        // across the file. Turning read-aloud off drops it.
        reader.setEnabled(false);
        vi.useRealTimers();
    });

    async function tick(ms = 0): Promise<void> {
        await vi.advanceTimersByTimeAsync(ms);
    }

    /**
     * DROVE-189, ruled OUT, first half. A refusal part way through a reply
     * resumes at the sentence that was refused. Not at the top of the reply.
     */
    it('a refusal resumes at the refused sentence, not at the top of the reply', async () => {
        reader.setBackgrounded(true);
        reader.onMessages('s1', [prose('m1', 'One. Two. Three. Four.', 1)]);
        await tick();
        expect(said).toEqual(['One.', 'Two.', 'Three.', 'Four.']);

        // A notification takes the route as the next reply lands.
        refuse = true;
        reader.onMessages('s1', [prose('m2', 'Five. Six.', 2)]);
        await tick();
        expect(attempted).toEqual(['One.', 'Two.', 'Three.', 'Four.', 'Five.']);
        expect(said).toEqual(['One.', 'Two.', 'Three.', 'Four.']);

        refuse = false;
        await tick(retryDelayMs);
        // "Five." offered a second time and nothing else. The rewind is one
        // utterance wide.
        expect(attempted).toEqual(['One.', 'Two.', 'Three.', 'Four.', 'Five.', 'Five.', 'Six.']);
        expect(said).toEqual(['One.', 'Two.', 'Three.', 'Four.', 'Five.', 'Six.']);
    });

    /**
     * DROVE-189, ruled OUT, second half. The stall's retry does not restart
     * the reader anywhere: a refusal in the MIDDLE of a reply picks that reply
     * up mid-way, with nothing before the refused sentence said twice.
     */
    it('a refusal in the middle of a reply does not rewind past it', async () => {
        reader.setBackgrounded(true);
        reader.onMessages('s1', [prose('m1', 'Alpha. Beta.', 1)]);
        await tick();
        expect(said).toEqual(['Alpha.', 'Beta.']);

        refuse = true;
        reader.onMessages('s1', [prose('m2', 'Gamma. Delta. Epsilon.', 2)]);
        await tick();
        refuse = false;
        await tick(retryDelayMs);

        expect(said).toEqual(['Alpha.', 'Beta.', 'Gamma.', 'Delta.', 'Epsilon.']);
        // Only the refused utterance was ever offered twice.
        expect(attempted.filter((text) => text === 'Alpha.')).toHaveLength(1);
        expect(attempted.filter((text) => text === 'Gamma.')).toHaveLength(2);
    });

    /**
     * THE BUG. Opening a session hands the reader the most recent page of the
     * transcript. Every word of it was already on his screen.
     */
    it('opening a session says nothing that was already there', async () => {
        reader.onHistory('s1', [
            user('u1', 'first question', 1),
            prose('m1', 'An old answer. With two sentences.', 2),
            user('u2', 'second question', 3),
            prose('m2', 'The reply he already read.', 4),
        ]);
        await tick(retryDelayMs * 3);
        expect(said).toEqual([]);
        expect(reader.speechPending).toBe(false);
    });

    /**
     * THE WORSE HALF. The background prefetch pages backwards through the rest
     * of the conversation after the session is open, and those pages carry the
     * CURRENT turn, so nothing in the queue's own rules could catch them.
     */
    it('an older page fetched behind him is never spoken', async () => {
        reader.onHistory('s1', [user('u9', 'latest question', 90), prose('m9', 'The newest reply.', 91)]);
        await tick();
        expect(said).toEqual([]);

        // A reply arrives for real, and IS read.
        reader.onMessages('s1', [prose('m10', 'Something new.', 100)]);
        await tick();
        expect(said).toEqual(['Something new.']);

        // The prefetch fills in history from an hour ago.
        reader.onHistory('s1', [user('u1', 'ancient', 1), prose('m1', 'Ancient one. Ancient two.', 2)]);
        await tick(retryDelayMs * 3);
        expect(said).toEqual(['Something new.']);
    });

    it('what arrives after the transcript is read, and only that', async () => {
        reader.onHistory('s1', [prose('m1', 'Old one. Old two.', 1)]);
        await tick();
        reader.onMessages('s1', [prose('m2', 'Brand new.', 2)]);
        await tick();
        expect(said).toEqual(['Brand new.']);
    });

    /**
     * He opened the session while the model was part way through writing. The
     * sentences already on the screen are history; the rest of that same reply
     * is arriving, and arriving is what gets read.
     */
    it('a reply half written when he opened it is picked up, not restarted', async () => {
        reader.onHistory('s1', [prose('m1', 'The first half landed already.', 5)]);
        await tick();
        expect(said).toEqual([]);

        reader.onMessages('s1', [prose('m1', 'The first half landed already. And here is the rest.', 5)]);
        await tick();
        expect(said).toEqual(['And here is the rest.']);
    });

    /**
     * DROVE-163 and DROVE-195: the tap is the ONE way reading starts anywhere
     * but the newest thing, and it still reaches into the history. This is why
     * the transcript is remembered rather than dropped.
     */
    it('a tap on a remembered sentence still starts there', async () => {
        reader.onHistory('s1', [prose('m1', 'Old one. Old two. Old three.', 1)]);
        await tick();
        expect(said).toEqual([]);

        expect(reader.seekToSentence('m1', 'Old two.')).toBe(true);
        await tick();
        expect(said).toEqual(['Old two.', 'Old three.']);
    });

    it('a tap on a block still starts there', async () => {
        reader.onHistory('s1', [prose('m1', 'Old one.', 1), prose('m2', 'Old two.', 2)]);
        await tick();
        expect(said).toEqual([]);

        reader.seekTo(2);
        await tick();
        expect(said).toEqual(['Old two.']);
    });

    /**
     * The order matters and it is not decoration. The older pages arrive
     * newest-first, and `readFrom` clears the spoken marks FROM the tap TO THE
     * END. Appending a page of ancient history after the newest reply would
     * mean a tap in that reply un-marks the history behind it and reads it.
     */
    it('a tap in the newest reply does not drag backfilled history in behind it', async () => {
        reader.onHistory('s1', [prose('m5', 'Newest one. Newest two.', 50)]);
        await tick();
        // The prefetch lands AFTER, but belongs BEFORE.
        reader.onHistory('s1', [prose('m1', 'Ancient one. Ancient two.', 1)]);
        await tick();

        expect(reader.seekToSentence('m5', 'Newest one.')).toBe(true);
        await tick(retryDelayMs * 3);
        expect(said).toEqual(['Newest one.', 'Newest two.']);
    });

    /**
     * Reopening with the toggle already on. Nothing about coming back to a
     * session is a request to hear it again.
     */
    it('reopening a session re-reads nothing', async () => {
        reader.onHistory('s1', [prose('m1', 'Already heard.', 1)]);
        await tick();
        reader.onMessages('s1', [prose('m2', 'Heard live.', 2)]);
        await tick();
        expect(said).toEqual(['Heard live.']);

        // He leaves the screen and comes back. `blur` with 'left-session'
        // keeps the focus (DROVE-179), so this is the same reader and the
        // same timeline.
        reader.blur('s1', 'left-session');
        reader.focus('s1');
        await tick(retryDelayMs * 3);
        expect(said).toEqual(['Heard live.']);

        // And a session revisited from another one reloads its transcript.
        reader.focus('s2');
        reader.focus('s1');
        reader.onHistory('s1', [prose('m1', 'Already heard.', 1), prose('m2', 'Heard live.', 2)]);
        await tick(retryDelayMs * 3);
        expect(said).toEqual(['Heard live.']);
    });

    /**
     * Switching read-aloud on starts at the newest unread content, which when
     * nothing has arrived since means silence until something does.
     */
    it('switching read-aloud on speaks the newest message and nothing before it', async () => {
        reader.setEnabled(false);
        reader.onHistory('s1', [prose('m1', 'Old.', 1)]);
        reader.onMessages('s1', [prose('m2', 'Also old.', 2)]);
        await tick();
        expect(said).toEqual([]);

        reader.setEnabled(true);
        reader.setSessionEnabled('s1', true);
        reader.onHistory('s1', [prose('m1', 'Old.', 1), prose('m2', 'Also old.', 2)]);
        await tick(retryDelayMs * 3);
        expect(said).toEqual([]);

        reader.onMessages('s1', [prose('m3', 'The newest message.', 3)]);
        await tick();
        expect(said).toEqual(['The newest message.']);
    });

    /** The transcript belongs to the session being read, and to no other. */
    it('a transcript for another session is ignored', async () => {
        reader.onHistory('s2', [prose('m1', 'Not this session.', 1)]);
        await tick();
        expect(reader.speechPending).toBe(false);
        expect(said).toEqual([]);
    });

    /**
     * The last line of a reply that had no full stop when he opened the
     * session. It is remembered so he can tap it, and NOT counted as a
     * finished sentence, so the completed version is read once it lands.
     */
    it('a sentence still being written when he opened it is read once it finishes', async () => {
        reader.onHistory('s1', [prose('m1', 'Half a sen', 5)]);
        await tick();
        expect(said).toEqual([]);

        reader.onMessages('s1', [prose('m1', 'Half a sentence. And another.', 5)]);
        await tick();
        expect(said).toEqual(['Half a sentence.', 'And another.']);
    });

    /**
     * WHY THE SEAM IS THE FIX. The same transcript through the arrival door is
     * read out loud, which is what shipped: the reader cannot tell a page of
     * history from a reply landing, and it should not have to guess.
     */
    it('the same transcript through the arrival door is what the bug looked like', async () => {
        reader.onMessages('s1', [
            user('u1', 'first question', 1),
            prose('m1', 'An old answer.', 2),
            user('u2', 'second question', 3),
            prose('m2', 'The reply he already read.', 4),
        ]);
        await tick();
        expect(said).toContain('The reply he already read.');
    });

    /**
     * A gate still jumps the queue over a remembered transcript (DROVE-188).
     */
    it('a gate still outranks everything, transcript included', async () => {
        reader.onHistory('s1', [prose('m1', 'Old one.', 1)]);
        await tick();
        reader.sayUrgent('gate-1', 'Claude is asking to run a command.');
        await tick();
        expect(said).toEqual(['Claude is asking to run a command.']);
    });
});
