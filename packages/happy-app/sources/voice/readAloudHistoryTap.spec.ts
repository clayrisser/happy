import { describe, expect, it } from 'vitest';
import type { Message } from '@/sync/typesMessage';
import { ReadAloudReader, type SpeakOptions, type SpeechEngine } from './readAloud';
import { readSentenceFromHere } from './readAloudTap';

/**
 * Double tap a message up in the HISTORY and it reads from there (DROVE-285).
 *
 * Clay: "when I scroll up and double tap because I wanted it to go read
 * something to me from the past, it doesn't read it."
 *
 * WHICH LINK WAS BROKEN, measured here rather than guessed: the gesture fired
 * and resolved its sentence fine — the tap wiring is per row and does not
 * care how old the row is — and `readSentenceFromHere` received it. What it
 * received it AGAINST was a timeline that had never ingested the message.
 * `onHistory` (DROVE-226) remembers paged-in history precisely so taps can
 * land on it, but it drops every page that arrives while the reader is OFF or
 * the session unfocused, and the transcript is fetched exactly once per
 * session: open the app, the pages come in, and only THEN does he switch
 * read-aloud on. Nothing re-feeds on enable or on focus (`freshFocus` starts
 * empty on purpose), so everything on screen from before the toggle is
 * permanently absent. The sentence lookup missed, and the block fallback
 * `seekTo(createdAt)` then scanned a timeline whose every entry was NEWER
 * than the tap — landing on the first live sentence (the wrong place, often
 * indistinguishable from a no-op) or, with nothing live yet, on nothing at
 * all (dead silence).
 *
 * THE FIX'S SHAPE: pointing at it IS the ask. A tap now guarantees the
 * transcript at or after the tapped createdAt is in the timeline before it
 * seeks — `ensureHistoryFrom` pulls the absent messages from the store
 * (`historyFor`) through the same `onHistory` ingestion, marked spoken, and
 * the seek's own mark-clearing does the rest. The two standing rules survive
 * untouched and are pinned below: two taps stay deliberate (the counting is
 * doubleTapPress's, unchanged), and history never reads UNASKED — ingestion
 * happens on the gesture, never on a scroll or a page arriving.
 */

class FakeEngine implements SpeechEngine {
    spoken: string[] = [];
    private resolvers: (() => void)[] = [];

    speak(text: string, _options?: SpeakOptions): Promise<unknown> {
        this.spoken.push(text);
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

    async drain(): Promise<void> {
        // Finish utterances until the reader stops offering new ones. Settle
        // FIRST each round: `speakNow` hands the engine its utterance on a
        // microtask, so the next resolver appears only after one.
        for (let i = 0; i < 64; i++) {
            await settle();
            if (this.resolvers.length === 0) return;
            this.finishOne();
        }
    }
}

async function settle(): Promise<void> {
    for (let i = 0; i < 8; i++) await Promise.resolve();
}

function prose(id: string, text: string, createdAt: number): Message {
    return { kind: 'agent-text', id, localId: null, createdAt, text } as Message;
}

/**
 * The app's real order of events: the transcript is in the STORE (fetched
 * once, when the session opened), and the reader was off or elsewhere when
 * its pages went past, so none of it is in the timeline.
 */
function opened(transcript: Message[]): { engine: FakeEngine; reader: ReadAloudReader } {
    const engine = new FakeEngine();
    const reader = new ReadAloudReader(engine, {
        historyFor: () => transcript,
    });
    // The pages arrived while read-aloud was OFF: dropped, as DROVE-226
    // demands for anything unasked.
    reader.onHistory('s1', transcript);
    reader.setEnabled(true);
    reader.focus('s1');
    reader.setSessionEnabled('s1', true);
    return { engine, reader };
}

const transcript = [
    prose('h1', 'Old one. Old two.', 100),
    prose('h2', 'Old three. Old four.', 200),
];

describe('double tap a message from before the reader was on (DROVE-285)', () => {
    it('reads from the tapped old sentence and on through the rest', async () => {
        const { engine, reader } = opened(transcript);
        reader.onMessages('s1', [prose('m1', 'A new reply.', 300)]);
        await engine.drain();
        expect(engine.spoken).toEqual(['A new reply.']);

        // He scrolls up and double taps a sentence from the past. Before the
        // fix this missed the timeline, fell back to seekTo, and re-read the
        // NEW reply instead: the wrong place, wearing a no-op's face.
        expect(readSentenceFromHere(reader, 's1', 'h1', 'Old two.', 100)).toBe(true);
        await engine.drain();
        expect(engine.spoken).toEqual([
            'A new reply.',
            'Old two.', 'Old three.', 'Old four.', 'A new reply.',
        ]);
    });

    it('reads even when nothing new has arrived since the toggle', async () => {
        const { engine, reader } = opened(transcript);
        await settle();
        expect(engine.spoken).toEqual([]);

        // The timeline is EMPTY: before the fix the block fallback had
        // nothing at or after the tap and the gesture died in silence — the
        // exact no-op he reported.
        expect(readSentenceFromHere(reader, 's1', 'h1', 'Old one.', 100)).toBe(true);
        await engine.drain();
        expect(engine.spoken).toEqual(['Old one.', 'Old two.', 'Old three.', 'Old four.']);
    });

    it('falls back to the block WITHIN the ingested history, not to the live head', async () => {
        const { engine, reader } = opened(transcript);
        reader.onMessages('s1', [prose('m1', 'A new reply.', 300)]);
        await engine.drain();

        // A sentence the renderer shows and the speaker dropped: the lookup
        // misses, and the fallback must land at the first sayable thing at or
        // after the TAP — in the history he pointed at, not at the live head.
        expect(readSentenceFromHere(reader, 's1', 'h2', 'Something it never said.', 200)).toBe(true);
        await engine.drain();
        expect(engine.spoken).toEqual([
            'A new reply.',
            'Old three.', 'Old four.', 'A new reply.',
        ]);
    });

    it('tapping the same old sentence twice does not duplicate the timeline', async () => {
        const withTail = [
            prose('h1', 'Old one. Old two.', 100),
            // An unpunctuated tail: `onHistory` counts only COMPLETE sentences
            // into `queuedChunks`, so a naive re-ingest would remember the
            // tail a second time.
            prose('h2', 'A trailing tail', 200),
        ];
        const { engine, reader } = opened(withTail);
        expect(readSentenceFromHere(reader, 's1', 'h1', 'Old two.', 100)).toBe(true);
        await engine.drain();
        expect(engine.spoken).toEqual(['Old two.', 'A trailing tail']);

        expect(readSentenceFromHere(reader, 's1', 'h1', 'Old two.', 100)).toBe(true);
        await engine.drain();
        // The deliberate re-read, exactly once more: nothing was ingested
        // twice.
        expect(engine.spoken).toEqual([
            'Old two.', 'A trailing tail',
            'Old two.', 'A trailing tail',
        ]);
    });
});

describe('the standing rules survive the ingest (DROVE-285)', () => {
    it('history paging still never reads unasked, historyFor or not', async () => {
        const { engine, reader } = opened(transcript);
        // Another page arrives while he merely scrolls: remembered, silent.
        reader.onHistory('s1', [prose('h0', 'Ancient words.', 50)]);
        await settle();
        expect(engine.spoken).toEqual([]);
    });

    it('a held session\'s stash is untouched by an ingest elsewhere (DROVE-289)', async () => {
        const engine = new FakeEngine();
        const s2Transcript = [prose('h1', 'Old in s2. Older in s2.', 100)];
        const reader = new ReadAloudReader(engine, {
            historyFor: (sessionId) => (sessionId === 's2' ? s2Transcript : []),
        });
        reader.setEnabled(true);
        reader.focus('s1');
        reader.setSessionEnabled('s1', true);
        reader.onMessages('s1', [prose('a1', 'S1 first. S1 second. S1 third.', 300)]);
        await settle();
        engine.finishOne();
        await settle();
        // 'S1 second.' is in the air; the switch holds s1 mid-reply. It made
        // a sound, so it stays spoken (DROVE-233's granularity) and the held
        // position is the sentence after it.
        reader.focus('s2');
        reader.setSessionEnabled('s2', true);
        expect(reader.hasHeldReading('s1')).toBe(true);

        // The tap in s2 ingests s2's history and reads it.
        expect(readSentenceFromHere(reader, 's2', 'h1', 'Old in s2.', 100)).toBe(true);
        await engine.drain();
        expect(engine.spoken).toEqual(['S1 first.', 'S1 second.', 'Old in s2.', 'Older in s2.']);

        // Back to s1: the held reading resumes at exactly the sentence the
        // switch was holding, neither re-read from the top nor skipped past.
        reader.focus('s1');
        await engine.drain();
        expect(engine.spoken).toEqual([
            'S1 first.', 'S1 second.', 'Old in s2.', 'Older in s2.',
            'S1 third.',
        ]);
    });
});
