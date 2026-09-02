import { beforeEach, describe, expect, it } from 'vitest';
import { ReadAloudReader, type SpeakOptions } from './readAloud';
import type { Message } from '@/sync/typesMessage';

/**
 * READING IS OFF UNTIL HE TURNS IT ON, AND STAYS HIS AFTERWARDS (DROVE-386).
 *
 * Clay, stating the whole rule in one breath: "By default when I create a new
 * session and go to it, why does it have reading enabled? Even if I close the
 * app and reopen the app, by default reading should not be enabled — even if
 * it was reading, if I close the app and reopen, it shouldn't. Now if I go
 * into the session and enable reading and then navigate away from it into
 * another session, of course it would keep reading, unless I turn on that
 * session — and if I have two sessions that have reading on, whichever one is
 * the active one will read, and if I navigate to another one that's actively
 * reading then the other one will pause until I go back to it. But if I
 * explicitly hit the pause button and then navigate away and go back to it,
 * you wouldn't unpause it until I explicitly unpause it."
 *
 * ## The table, which is what this file pins
 *
 * Per session, RUNTIME ONLY, never persisted:
 *
 *   off     not armed. Nothing is ever said out of it. Where a brand-new
 *           session is born, and where every session is after a relaunch.
 *   on      armed. Reads when it holds the voice.
 *   paused  armed, and HE stopped it. Only he lifts it.
 *
 * What the list draws is that flag crossed with who holds the voice, and it is
 * readingVoice.ts's `readingSessionState`, unchanged by this ticket:
 *
 *   off,    -            -> 'off'
 *   on,     holds voice  -> 'reading'
 *   on,     does not     -> 'yielded'   <- HELD: the system's pause
 *   paused, holds voice  -> 'paused'    <- HIS pause
 *   paused, does not     -> 'yielded', and it comes back PAUSED
 *
 * HELD VERSUS PAUSED IS THE POINT OF THE WHOLE TICKET. Both are amber, both
 * keep their sentence, and they are told apart by exactly one thing: coming
 * back lifts the held one and does not lift his. A `yielded` row cannot say
 * which it is, and does not need to — the difference is only ever observable
 * on the return, which is where every test below measures it.
 *
 * ## Why the real reader and a fake synth
 *
 * The rule is decided in readingVoice.ts and carried out with DROVE-289's
 * hold-and-restore, and this file deliberately exercises neither in isolation.
 * "A resumes where it was" is only true if the decision AND the machinery
 * agree, so the assertions are on what a synthesiser was actually asked to
 * say, in order, with utterances that finish when the test says so — an engine
 * that resolved instantly would read every reply to the end and no test here
 * could put a playhead anywhere but the tail.
 */

function prose(id: string, text: string, createdAt: number): Message {
    return { id, localId: null, createdAt, kind: 'agent-text', text } as unknown as Message;
}

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

    /** Let the utterance at the synthesiser finish. */
    finish(): void {
        const resolve = this.resolvers.shift();
        if (resolve === undefined) throw new Error('nothing is speaking');
        resolve();
    }
}

async function settle(): Promise<void> {
    for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe('reading is per session and starts off (DROVE-386)', () => {
    let engine: FakeEngine;
    let reader: ReadAloudReader;

    /**
     * The capability, as the settings screen leaves it: ON. Every test below
     * runs with read-aloud AVAILABLE, because a phone with the feature
     * switched off would pass all of them for the wrong reason.
     */
    beforeEach(() => {
        engine = new FakeEngine();
        reader = new ReadAloudReader(engine);
        reader.setEnabled(true);
    });

    /** Read two sentences of a reply out of `session`, leaving the rest unread. */
    async function readTwoOf(session: string, messageId: string, at: number): Promise<void> {
        reader.onMessages(session, [prose(messageId, 'One. Two. Three. Four.', at)]);
        await settle();
        engine.finish();
        await settle();
    }

    describe('row 1 — a brand-new session is off', () => {
        it('a session the reader has never been told about is not armed', () => {
            expect(reader.isSessionEnabled('brand-new')).toBe(false);
            expect(reader.readingStateOf('brand-new')).toBe('off');
        });

        it('opening it says nothing and takes no voice', async () => {
            reader.visit('brand-new');
            reader.onMessages('brand-new', [prose('m1', 'Hello there.', 10)]);
            await settle();

            expect(engine.spoken).toEqual([]);
            expect(reader.readingSessionId).toBe(null);
        });

        it('the capability being on is not what arms it — his thumb is', async () => {
            expect(reader.readingReport().defaultEnabled).toBe(true);
            expect(reader.isSessionEnabled('brand-new')).toBe(false);

            reader.setSessionEnabled('brand-new', true);
            reader.onMessages('brand-new', [prose('m1', 'Hello there.', 10)]);
            await settle();

            expect(engine.spoken).toEqual(['Hello there.']);
            expect(reader.readingStateOf('brand-new')).toBe('reading');
        });
    });

    describe('row 2 — a relaunch clears every session, on and paused alike', () => {
        /**
         * A NEW READER OVER THE SAME PERSISTED SETTING IS EXACTLY WHAT A
         * RELAUNCH IS: nothing in the process survives, and the setting on the
         * disk does. That is the same definition readAloudResume.spec.ts uses
         * for DROVE-193, and it is the only honest way to test this without a
         * device: the per-session map is a field, so a fresh instance is a
         * fresh launch by construction.
         */
        function relaunch(): ReadAloudReader {
            const fresh = new ReadAloudReader(engine);
            fresh.setEnabled(true);
            return fresh;
        }

        it('a session that was reading comes back off', async () => {
            reader.setSessionEnabled('a', true);
            await readTwoOf('a', 'ma', 10);
            expect(reader.readingStateOf('a')).toBe('reading');

            const after = relaunch();

            expect(after.isSessionEnabled('a')).toBe(false);
            expect(after.readingStateOf('a')).toBe('off');
            expect(after.readingSessionId).toBe(null);
        });

        it('a session HE paused comes back off too, not paused', async () => {
            // His pause is his until he lifts it — across a navigation. Not
            // across a relaunch: a phone that wakes up holding a place in
            // yesterday's session is the failure this whole area circles.
            reader.setSessionEnabled('a', true);
            await readTwoOf('a', 'ma', 10);
            reader.setPaused(true);
            expect(reader.readingStateOf('a')).toBe('paused');

            const after = relaunch();

            expect(after.readingStateOf('a')).toBe('off');
            expect(after.isPaused).toBe(false);
        });

        it('several armed sessions all come back off, and none of them speaks', async () => {
            reader.setSessionEnabled('a', true);
            reader.setSessionEnabled('b', true);
            reader.setSessionEnabled('c', true);

            const after = relaunch();
            const said = engine.spoken.length;
            for (const id of ['a', 'b', 'c']) {
                expect(after.isSessionEnabled(id), id).toBe(false);
                after.visit(id);
                after.onMessages(id, [prose(`new-${id}`, 'Something new.', 100)]);
            }
            await settle();

            expect(engine.spoken.length).toBe(said);
            expect(after.readingSessionId).toBe(null);
        });

        it('the capability itself DOES survive, which is what makes the rest a real test', () => {
            const after = relaunch();
            expect(after.readingReport().defaultEnabled).toBe(true);
        });
    });

    describe('row 3 — A on, navigating to an off B, and A keeps reading', () => {
        it('the voice does not move and nothing goes quiet', async () => {
            reader.setSessionEnabled('a', true);
            await readTwoOf('a', 'ma', 10);
            expect(engine.spoken).toEqual(['One.', 'Two.']);

            reader.visit('b');
            await settle();

            // He is LOOKING at b and LISTENING to a. That coming apart is the
            // feature, not a bug (DROVE-297).
            expect(reader.visitedSessionId).toBe('b');
            expect(reader.readingSessionId).toBe('a');
            expect(reader.readingStateOf('b')).toBe('off');

            // And a carries on out loud, in the background, rather than
            // stopping because the screen moved.
            engine.finish();
            await settle();
            expect(engine.spoken).toEqual(['One.', 'Two.', 'Three.']);
        });
    });

    describe('row 4 — A on and B on: B reads, A is HELD, and coming back resumes it', () => {
        it('B takes the voice and A holds its place', async () => {
            reader.setSessionEnabled('a', true);
            await readTwoOf('a', 'ma', 10);
            reader.setSessionEnabled('b', true);
            await settle();

            expect(reader.readingSessionId).toBe('b');
            expect(reader.readingStateOf('a')).toBe('yielded');
            expect(reader.hasHeldReading('a')).toBe(true);
            // Nothing more was said out of a: the take cut the utterance in
            // flight, it did not run a to the end first.
            expect(engine.spoken).toEqual(['One.', 'Two.']);
        });

        it('coming back to A resumes at its own sentence, with no gesture from him', async () => {
            reader.setSessionEnabled('a', true);
            await readTwoOf('a', 'ma', 10);
            reader.setSessionEnabled('b', true);
            reader.onMessages('b', [prose('mb', 'Alpha. Beta.', 20)]);
            await settle();
            expect(engine.spoken).toEqual(['One.', 'Two.', 'Alpha.']);

            reader.visit('a');
            await settle();

            // HELD, NOT PAUSED. He never touched the pause button, so nothing
            // is waiting on him: 'Three.' is the sentence after the one that
            // was cut, so it neither re-reads 'Two.' nor jumps to the tail.
            expect(reader.readingSessionId).toBe('a');
            expect(reader.readingStateOf('a')).toBe('reading');
            expect(reader.isPaused).toBe(false);
            expect(engine.spoken).toEqual(['One.', 'Two.', 'Alpha.', 'Three.']);
        });

        it('B is the one held when he goes back, and it resumes in its turn', async () => {
            // The ring closes: what A just did to B, B does to A, and neither
            // loses anything. This is the row he described as "whichever one
            // is the active one will read".
            reader.setSessionEnabled('a', true);
            await readTwoOf('a', 'ma', 10);
            reader.setSessionEnabled('b', true);
            reader.onMessages('b', [prose('mb', 'Alpha. Beta. Gamma.', 20)]);
            await settle();
            engine.finish();
            await settle();
            expect(engine.spoken).toEqual(['One.', 'Two.', 'Alpha.', 'Beta.']);

            reader.visit('a');
            await settle();
            expect(reader.readingStateOf('b')).toBe('yielded');
            expect(engine.spoken).toEqual(['One.', 'Two.', 'Alpha.', 'Beta.', 'Three.']);

            reader.visit('b');
            await settle();
            expect(reader.readingSessionId).toBe('b');
            expect(engine.spoken).toEqual([
                'One.', 'Two.', 'Alpha.', 'Beta.', 'Three.', 'Gamma.',
            ]);
        });
    });

    describe('row 5 — a session HE paused stays paused through a navigation', () => {
        it('away and back leaves it paused, and silent', async () => {
            reader.setSessionEnabled('a', true);
            await readTwoOf('a', 'ma', 10);
            reader.setPaused(true);
            expect(reader.readingStateOf('a')).toBe('paused');
            const said = engine.spoken.length;

            reader.visit('b');
            await settle();
            reader.visit('a');
            await settle();

            // THIS IS THE LINE THAT DISTINGUISHES HELD FROM PAUSED. Row 4's
            // return resumed on its own; this one must not, because the hold
            // is his.
            expect(reader.readingSessionId).toBe('a');
            expect(reader.readingStateOf('a')).toBe('paused');
            expect(reader.isPaused).toBe(true);
            expect(engine.spoken.length).toBe(said);
        });

        it('and stays paused even when another session took the voice in between', async () => {
            reader.setSessionEnabled('a', true);
            await readTwoOf('a', 'ma', 10);
            reader.setPaused(true);
            const said = engine.spoken.length;

            reader.setSessionEnabled('b', true);
            reader.onMessages('b', [prose('mb', 'Alpha. Beta.', 20)]);
            await settle();
            expect(engine.spoken).toEqual([...engine.spoken.slice(0, said), 'Alpha.']);

            reader.visit('a');
            await settle();

            expect(reader.readingStateOf('a')).toBe('paused');
            expect(engine.spoken.length).toBe(said + 1);
        });

        it('the arriving session does not inherit the pause he put on the one he left', async () => {
            reader.setSessionEnabled('a', true);
            await readTwoOf('a', 'ma', 10);
            reader.setPaused(true);

            reader.setSessionEnabled('b', true);
            await settle();

            expect(reader.readingStateOf('b')).toBe('reading');
            expect(reader.isPaused).toBe(false);
        });
    });

    describe('row 6 — only an explicit unpause resumes it', () => {
        it('unpausing carries on at the sentence it was holding', async () => {
            reader.setSessionEnabled('a', true);
            await readTwoOf('a', 'ma', 10);
            reader.setPaused(true);
            reader.visit('b');
            await settle();
            reader.visit('a');
            await settle();

            reader.setPaused(false);
            await settle();

            expect(reader.readingStateOf('a')).toBe('reading');
            expect(engine.spoken).toEqual(['One.', 'Two.', 'Three.']);
        });

        it('a reply arriving while it is paused waits rather than lifting the pause', async () => {
            reader.setSessionEnabled('a', true);
            await readTwoOf('a', 'ma', 10);
            reader.setPaused(true);
            const said = engine.spoken.length;

            reader.onMessages('a', [prose('mb', 'A brand new reply.', 50)]);
            await settle();
            expect(engine.spoken.length).toBe(said);

            reader.setPaused(false);
            await settle();
            expect(engine.spoken.length).toBeGreaterThan(said);
        });
    });

    describe('the two switches stay distinct', () => {
        it('turning the capability off is still the kill, per session and globally', async () => {
            reader.setSessionEnabled('a', true);
            await readTwoOf('a', 'ma', 10);
            reader.setSessionEnabled('b', true);
            await settle();
            expect(reader.hasHeldReading('a')).toBe(true);

            reader.setEnabled(false);

            expect(reader.isSessionEnabled('a')).toBe(false);
            expect(reader.isSessionEnabled('b')).toBe(false);
            expect(reader.hasHeldReading('a')).toBe(false);
            expect(reader.readingSessionId).toBe(null);
        });

        it('turning the capability back on re-arms nothing he had armed before', () => {
            reader.setSessionEnabled('a', true);
            reader.setEnabled(false);
            reader.setEnabled(true);

            expect(reader.isSessionEnabled('a')).toBe(false);
            expect(reader.readingReport().defaultEnabled).toBe(true);
        });

        it('a session he armed by hand reads even with the capability never touched', async () => {
            // The composer's own control is his, and the settings switch is
            // not a gate on it — which is exactly why DROVE-298 gates the
            // TERMINAL and not the thumb: starting audio on a phone in his
            // pocket from a Mac is the surprise, a thumb on the button is not.
            const quiet = new ReadAloudReader(engine);
            quiet.setSessionEnabled('a', true);
            quiet.onMessages('a', [prose('m1', 'Said anyway.', 10)]);
            await settle();

            expect(engine.spoken).toEqual(['Said anyway.']);
            expect(quiet.readingReport().defaultEnabled).toBe(false);
        });
    });
});
