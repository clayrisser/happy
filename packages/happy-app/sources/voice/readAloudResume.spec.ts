import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReadAloudReader, type ReadAloudMark, type SpeakOptions } from './readAloud';
import { applyReadAloudResume, pruneReadAloudResume, readAloudResumeLimit, type ReadAloudResumeMark } from '@/sync/localSettings';
import type { Message } from '@/sync/typesMessage';

/**
 * A restart is not a reset (DROVE-193).
 *
 * Clay: "why does it start over reading when I restart the app." He
 * force-quits and reopens constantly, because that is how every OTA reaches
 * him, and every launch read the reply from the top again.
 *
 * WHAT WAS ACTUALLY WRONG, measured before anything was built. DROVE-226
 * already covers a transcript that reaches a FOCUSED reader: those pages come
 * in as history, marked spoken, and say nothing, and the first case below
 * pins that down so this ticket cannot be blamed for it. The half DROVE-226
 * cannot cover is a reply still being WRITTEN. The socket redelivers that
 * message with more text on it, the count of how many of its sentences have
 * already been queued is `queuedChunks`, and that died with the process — so
 * every complete sentence is enqueued fresh and the reply is read from its
 * first word. The second case is that, and it read "One. Two. Three. Four."
 * where only "Four." was new.
 *
 * THE FIX is DROVE-126's spoken-once invariant written down: one mark per
 * session, per device, keyed by message id and the sentence's ordinal inside
 * that message rather than by a position in the timeline, because the
 * timeline is rebuilt out of whichever pages the next launch happens to fetch.
 */

function prose(id: string, text: string, createdAt: number): Message {
    return { id, localId: null, createdAt, kind: 'agent-text', text } as unknown as Message;
}

/** One handset's device-local store, surviving as many launches as a test wants. */
function device() {
    const marks = new Map<string, ReadAloudMark>();
    /** Every write, in order, so a mark that moved BACKWARDS is visible. */
    const writes: { sessionId: string, mark: ReadAloudMark }[] = [];
    return {
        marks,
        writes,
        resumeFrom: (sessionId: string) => marks.get(sessionId) ?? null,
        onSpoke: (sessionId: string, mark: ReadAloudMark) => {
            marks.set(sessionId, mark);
            writes.push({ sessionId, mark });
        },
    };
}

describe('read-aloud resumes across a restart (DROVE-193)', () => {
    let said: string[];
    let skips: number;
    let generating: boolean;
    let readers: ReadAloudReader[];

    beforeEach(() => {
        vi.useFakeTimers();
        said = [];
        skips = 0;
        generating = false;
        readers = [];
    });

    afterEach(() => {
        for (const reader of readers) reader.setEnabled(false);
        vi.useRealTimers();
    });

    /**
     * Start the app. A new reader over the SAME device store is exactly what a
     * relaunch is: nothing in the process survives, everything on the disk does.
     */
    function launch(store: ReturnType<typeof device>, sessionId: string | null = 's1'): ReadAloudReader {
        const reader = new ReadAloudReader(
            {
                speak(text: string, _options?: SpeakOptions) { said.push(text); return Promise.resolve(); },
                stop() { },
            },
            {
                retryDelayMs: 10,
                resumeFrom: store.resumeFrom,
                onSpoke: store.onSpoke,
                onSkip: () => { skips += 1; },
                turnStillRunning: () => generating,
            },
        );
        readers.push(reader);
        reader.setEnabled(true);
        if (sessionId !== null) {
            reader.focus(sessionId);
            // ARMED BY HAND, EVERY LAUNCH (DROVE-386). This is the relaunch
            // test, so it is the one place the new rule is most visible: the
            // persisted setting comes back on, and the session does NOT come
            // back armed. What survives a relaunch is the read POSITION on the
            // disk (DROVE-193), which is what these tests are about; the
            // arming is his to redo, and `launch` doing it explicitly is the
            // honest spelling of "and then he turned this session on again".
            reader.setSessionEnabled(sessionId, true);
        }
        return reader;
    }

    async function tick(ms = 5000): Promise<void> {
        await vi.advanceTimersByTimeAsync(ms);
    }

    it('the transcript reaching a focused reader still says nothing (DROVE-226 holds)', async () => {
        const store = device();
        const reader = launch(store);
        reader.onHistory('s1', [prose('m1', 'One. Two. Three.', 100)]);
        await tick();
        expect(said).toEqual([]);
    });

    it('restart MID-REPLY resumes instead of starting the reply over', async () => {
        const store = device();
        const first = launch(store);
        first.onMessages('s1', [prose('m1', 'One. Two. Three.', 100)]);
        await tick();
        expect(said).toEqual(['One.', 'Two.', 'Three.']);

        // Force quit. Nothing in the process survives; the mark on the disk does.
        first.setEnabled(false);
        said = [];
        const second = launch(store);
        // The agent was still writing, so the socket redelivers the message
        // with one more sentence on it. This is the line that used to read the
        // whole reply again.
        second.onMessages('s1', [prose('m1', 'One. Two. Three. Four.', 100)]);
        await tick();
        expect(said).toEqual(['Four.']);
    });

    it('restart AFTER a reply finished says nothing again, and reads the next one', async () => {
        const store = device();
        const first = launch(store);
        first.onMessages('s1', [prose('m1', 'One. Two.', 100)]);
        await tick();
        expect(said).toEqual(['One.', 'Two.']);

        first.setEnabled(false);
        said = [];
        const second = launch(store);
        // The transcript comes back as history, as it does on any relaunch,
        // and then the next reply lands live.
        second.onHistory('s1', [prose('m1', 'One. Two.', 100)]);
        second.onMessages('s1', [prose('m2', 'Three.', 200)]);
        await tick();
        expect(said).toEqual(['Three.']);
    });

    it('a session it has NEVER opened is not treated as read', async () => {
        const store = device();
        const first = launch(store, 's1');
        first.onMessages('s1', [prose('m1', 'One. Two.', 100)]);
        await tick();
        first.setEnabled(false);
        said = [];

        // A different session, on the same device, with a mark stored for s1.
        const second = launch(store, 's2');
        second.onMessages('s2', [prose('n1', 'Alpha. Beta.', 50)]);
        await tick();
        // Older than s1's mark by createdAt, and read in full anyway: the mark
        // is per session, so a session with none suppresses nothing.
        expect(said).toEqual(['Alpha.', 'Beta.']);
        expect(store.marks.has('s2')).toBe(true);
    });

    it('a transcript that RE-SPLITS differently does not replay', async () => {
        const store = device();
        const first = launch(store);
        first.onMessages('s1', [prose('m1', 'One. Two.', 100)]);
        first.onMessages('s1', [prose('m2', 'Three. Four.', 200)]);
        await tick();
        expect(said).toEqual(['One.', 'Two.', 'Three.', 'Four.']);

        first.setEnabled(false);
        said = [];
        const second = launch(store);
        // m1 comes back split into ONE sentence where it was two, and m2 the
        // same way. A stored timeline index would land in the middle of
        // either — the array is a different length now — and a message id with
        // an ordinal inside it lands nowhere at all: everything older than the
        // mark is behind it whatever its new shape, and the mark's own message
        // is decided by an ordinal that only has to survive ITS own split.
        second.onMessages('s1', [prose('m1', 'One, two.', 100)]);
        second.onMessages('s1', [prose('m2', 'Three, four.', 200)]);
        await tick();
        expect(said).toEqual([]);

        // ...and the reply after them is still read.
        second.onMessages('s1', [prose('m3', 'Five.', 300)]);
        await tick();
        expect(said).toEqual(['Five.']);
    });

    /**
     * The edge the ordinal cannot cover, written down rather than hoped away.
     *
     * If the message the mark SITS IN comes back split into more sentences
     * than it had, the ones past the ordinal are new as far as any key can
     * tell, and they are read. That is a sentence or two, at the position he
     * was already listening at, and it is the price of the key that makes
     * every other case right. The thing it must never do is replay the
     * message from the top, and it does not.
     */
    it('a message re-split into MORE sentences leaks its tail, never its top', async () => {
        const store = device();
        const first = launch(store);
        first.onMessages('s1', [prose('m1', 'Three. Four.', 200)]);
        await tick();
        expect(said).toEqual(['Three.', 'Four.']);

        first.setEnabled(false);
        said = [];
        const second = launch(store);
        second.onMessages('s1', [prose('m1', 'Three. And. Four.', 200)]);
        await tick();
        expect(said).toEqual(['Four.']);
    });

    it('the mark is device-local: two handsets keep two positions', async () => {
        const phone = device();
        const watch = device();

        // The phone hears both replies. The watch was in a drawer for the
        // second one, so it heard only the first.
        const onPhone = launch(phone, 's1');
        onPhone.onMessages('s1', [prose('m1', 'One.', 100)]);
        onPhone.onMessages('s1', [prose('m2', 'Two.', 200)]);
        await tick();
        expect(said).toEqual(['One.', 'Two.']);
        onPhone.setEnabled(false);

        said = [];
        const onWatch = launch(watch, 's1');
        onWatch.onMessages('s1', [prose('m1', 'One.', 100)]);
        await tick();
        expect(said).toEqual(['One.']);
        onWatch.setEnabled(false);

        expect(phone.marks.get('s1')).toEqual({ key: 'm2', createdAt: 200, ordinal: 0 });
        expect(watch.marks.get('s1')).toEqual({ key: 'm1', createdAt: 100, ordinal: 0 });

        // Restart both. The phone has nothing left to say; the watch still
        // owes him the reply it missed.
        said = [];
        const phoneAgain = launch(phone, 's1');
        phoneAgain.onMessages('s1', [prose('m1', 'One.', 100), prose('m2', 'Two.', 200)]);
        await tick();
        expect(said).toEqual([]);
        phoneAgain.setEnabled(false);

        said = [];
        const watchAgain = launch(watch, 's1');
        watchAgain.onMessages('s1', [prose('m1', 'One.', 100), prose('m2', 'Two.', 200)]);
        await tick();
        expect(said).toEqual(['Two.']);
    });

    it('a backlog piled up while the app was closed goes through the JUMP, not around it', async () => {
        const store = device();
        const first = launch(store);
        first.onMessages('s1', [prose('m1', 'One. Two.', 100)]);
        await tick();
        first.setEnabled(false);
        said = [];
        skips = 0;

        const second = launch(store);
        generating = true;
        second.onHistory('s1', [prose('m1', 'One. Two.', 100)]);
        // A lot arrived while he was away, and the agent is still writing.
        // Both batches land before the first one has finished being said, so
        // the queue is measured with a real backlog on it, as it would be.
        const long = Array.from({ length: 40 }, (_, i) => `Line ${i} with quite a few words in it.`).join(' ');
        second.onMessages('s1', [prose('m2', long, 200)]);
        second.onMessages('s1', [prose('m3', 'The newest thing.', 300)]);
        await tick();

        // The restored position fed the ordinary machinery: the backlog was
        // measured, the jump fired, and nothing from before the mark was said.
        expect(skips).toBeGreaterThan(0);
        expect(said).not.toContain('One.');
        expect(said).not.toContain('Two.');
        expect(said[said.length - 1]).toBe('The newest thing.');
        generating = false;
    });

    it('a tap back into the history does not drag the mark backwards', async () => {
        const store = device();
        const reader = launch(store);
        reader.onMessages('s1', [prose('m1', 'One. Two.', 100)]);
        reader.onMessages('s1', [prose('m2', 'Three. Four.', 200)]);
        await tick();
        const ahead = store.marks.get('s1');
        expect(ahead).toEqual({ key: 'm2', createdAt: 200, ordinal: 1 });

        said = [];
        store.writes.length = 0;
        expect(reader.seekToSentence('m1', 'One.')).toBe(true);
        await tick();
        expect(said).toEqual(['One.', 'Two.', 'Three.', 'Four.']);
        // He asked to hear them again; that does not un-say the newer ones.
        // Not one write, not even a write that moved back and then forward
        // again: a crash in the middle of the replay must not leave the mark
        // pointing at 'One.'
        expect(store.writes).toEqual([]);
        expect(store.marks.get('s1')).toEqual(ahead);
    });
});

describe('the stored positions are bounded and pruned (DROVE-193)', () => {
    function mark(key: string, createdAt: number, ordinal: number): Omit<ReadAloudResumeMark, 'at'> {
        return { key, createdAt, ordinal };
    }

    it('keeps one mark per session and hands the record back when nothing moved', () => {
        const first = applyReadAloudResume({}, 's1', mark('m1', 100, 0), 1);
        expect(Object.keys(first)).toEqual(['s1']);
        const again = applyReadAloudResume(first, 's1', mark('m1', 100, 0), 2);
        expect(again).toBe(first);
        const moved = applyReadAloudResume(first, 's1', mark('m1', 100, 1), 3);
        expect(Object.keys(moved)).toEqual(['s1']);
        expect(moved.s1.ordinal).toBe(1);
    });

    it('drops the oldest once there are more sessions than the limit', () => {
        let marks: Record<string, ReadAloudResumeMark> = {};
        for (let i = 0; i < readAloudResumeLimit + 5; i++) {
            marks = applyReadAloudResume(marks, `s${i}`, mark('m', i, 0), i);
        }
        expect(Object.keys(marks)).toHaveLength(readAloudResumeLimit);
        expect(marks.s0).toBeUndefined();
        expect(marks[`s${readAloudResumeLimit + 4}`]).toBeDefined();
    });

    it('drops a session’s position with the session', () => {
        const marks = applyReadAloudResume({}, 's1', mark('m1', 100, 0), 1);
        expect(pruneReadAloudResume(marks, 's1')).toEqual({});
        expect(pruneReadAloudResume(marks, 'nope')).toBe(marks);
    });
});
