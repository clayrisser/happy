import { beforeEach, describe, expect, it } from 'vitest';
import { ReadAloudReader, type SpeakOptions } from './readAloud';
import type { Message } from '@/sync/typesMessage';

/**
 * Pause holds the place; off throws it away (DROVE-233).
 *
 * Clay: "I was thinking it would actually have audio playing in the background
 * like an audio player I can pause and resume. In fact on my headphones I
 * should be able to pause and resume the reading."
 *
 * THE MEASUREMENT this file exists for is the pair at the top of "resume is
 * its own case": a resume must not re-read what he heard (which is what a TAP
 * would do) and must not jump to the newest message (which is what a START
 * would do). Both are asserted against a timeline with material on either side
 * of the pause, because either bug is invisible on a one-sentence reply.
 */

function prose(id: string, text: string, createdAt: number): Message {
    return { id, localId: null, createdAt, kind: 'agent-text', text } as unknown as Message;
}

describe('pause and resume', () => {
    let said: string[];
    let stops: number;
    let reader: ReadAloudReader;

    async function settle(): Promise<void> {
        for (let i = 0; i < 20; i++) await Promise.resolve();
    }

    beforeEach(() => {
        said = [];
        stops = 0;
        reader = new ReadAloudReader({
            speak(text: string, _options?: SpeakOptions) {
                said.push(text);
                return Promise.resolve();
            },
            stop() { stops += 1; },
        });
        reader.setEnabled(true);
        reader.focus('s1');
        reader.setSessionEnabled('s1', true);
    });

    it('starts unpaused', () => {
        expect(reader.isPaused).toBe(false);
    });

    it('says nothing while paused, and the material is still owed', async () => {
        reader.setPaused(true);
        reader.onMessages('s1', [prose('m1', 'One. Two. Three.', 1)]);
        await settle();
        expect(said).toEqual([]);
        // Owed, which is what makes it a pause rather than a drop: it is all
        // said on the resume below, in order and from the start.
        reader.setPaused(false);
        await settle();
        expect(said).toEqual(['One.', 'Two.', 'Three.']);
    });

    it('reports no PENDING speech while paused, so the cues are not held hostage', async () => {
        // DROVE-174 stops a cue landing in the gap between two sentences. A
        // pause is not a gap — it lasts until he presses something — and
        // treating it as one would hold every earcon until it went stale and
        // silence the heartbeat for the duration.
        reader.onMessages('s1', [prose('m1', 'One. Two. Three.', 1)]);
        reader.setPaused(true);
        expect(reader.speechPending).toBe(false);
        reader.setPaused(false);
        expect(reader.speechPending).toBe(true);
    });

    it('resumes at the sentence it stopped on, not at the top of the reply', async () => {
        // THIS TEST WAS VACUOUS UNTIL DROVE-275, and it is worth saying why
        // rather than quietly fixing it. It read two replies straight through
        // and never called `setPaused` once, under a comment that claimed "a
        // second reply, paused after its first sentence". It asserted that
        // ordinary reading works, wearing the name of the resume position, and
        // it would have passed with pause deleted from the reader outright.
        //
        // That is the exact shape of the thing this ticket exists to end: a
        // player feature with a green test beside it that Clay had never once
        // seen work. A test that cannot fail is worse than no test, because it
        // is counted.
        //
        // The engine gates here so a pause can land BETWEEN two sentences of
        // one reply, which the shared `reader` above cannot do — its `speak`
        // resolves immediately, so a whole reply is spoken before any pause
        // could be asked for.
        const gate: { release: (() => void) | null } = { release: null };
        const held = new ReadAloudReader({
            speak(text: string) {
                said.push(text);
                return new Promise<void>((resolve) => { gate.release = resolve; });
            },
            stop() { stops += 1; },
        });
        held.setEnabled(true);
        held.focus('s1');
        held.setSessionEnabled('s1', true);
        held.onMessages('s1', [prose('m1', 'One. Two. Three. Four.', 1)]);
        await settle();
        expect(said).toEqual(['One.']);

        // Stopped on the SECOND sentence, which is the position both failure
        // modes miss in opposite directions: a resume that restarted the reply
        // would say 'One.' twice, and one that behaved like a START would jump
        // to the newest material and skip 'Three.'.
        gate.release?.();
        await settle();
        expect(said).toEqual(['One.', 'Two.']);

        held.setPaused(true);
        gate.release?.();
        await settle();
        expect(said).toEqual(['One.', 'Two.']);

        held.setPaused(false);
        for (let i = 0; i < 12; i++) { gate.release?.(); await settle(); }
        expect(said).toEqual(['One.', 'Two.', 'Three.', 'Four.']);
    });

    it('THE MEASUREMENT: a resume re-reads nothing and skips nothing', async () => {
        // Four sentences land at once and the engine takes them one at a time,
        // so a pause after the first leaves three owed.
        const gate: { release: (() => void) | null } = { release: null };
        const held = new ReadAloudReader({
            speak(text: string) {
                said.push(text);
                return new Promise<void>((resolve) => { gate.release = resolve; });
            },
            stop() { stops += 1; },
        });
        held.setEnabled(true);
        held.focus('s1');
        held.setSessionEnabled('s1', true);
        held.onMessages('s1', [prose('m1', 'One. Two. Three. Four.', 1)]);
        await settle();
        expect(said).toEqual(['One.']);

        // Paused mid-utterance, exactly as a headphone press would.
        held.setPaused(true);
        gate.release?.();
        await settle();
        expect(said).toEqual(['One.']);

        // More lands while he is paused. It must not be jumped to.
        held.onMessages('s1', [prose('m2', 'Five.', 2)]);
        await settle();
        expect(said).toEqual(['One.']);

        held.setPaused(false);
        for (let i = 0; i < 12; i++) { gate.release?.(); await settle(); }
        // No 'One.' twice (DROVE-126 stands), and nothing between 'Two.' and
        // 'Five.' skipped (DROVE-226's start is not what a resume is).
        expect(said).toEqual(['One.', 'Two.', 'Three.', 'Four.', 'Five.']);
    });

    it('a sentence cut mid-word by a pause stays spoken and never repeats (DROVE-126)', async () => {
        const gate: { release: (() => void) | null } = { release: null };
        const held = new ReadAloudReader({
            speak(text: string) {
                said.push(text);
                return new Promise<void>((resolve) => { gate.release = resolve; });
            },
            stop() { stops += 1; },
        });
        held.setEnabled(true);
        held.focus('s1');
        held.setSessionEnabled('s1', true);
        held.onMessages('s1', [prose('m1', 'One. Two.', 1)]);
        await settle();
        expect(said).toEqual(['One.']);
        held.setPaused(true);
        gate.release?.();
        await settle();
        held.setPaused(false);
        for (let i = 0; i < 6; i++) { gate.release?.(); await settle(); }
        expect(said.filter((line) => line === 'One.')).toHaveLength(1);
    });

    it('stops the voice on a pause', async () => {
        const gate: { release: (() => void) | null } = { release: null };
        const held = new ReadAloudReader({
            speak(text: string) {
                said.push(text);
                return new Promise<void>((resolve) => { gate.release = resolve; });
            },
            stop() { stops += 1; },
        });
        held.setEnabled(true);
        held.focus('s1');
        held.setSessionEnabled('s1', true);
        held.onMessages('s1', [prose('m1', 'One. Two.', 1)]);
        await settle();
        const before = stops;
        held.setPaused(true);
        expect(stops).toBeGreaterThan(before);
        gate.release?.();
    });

    it('drops the playhead on a pause, so no row claims to be being read', async () => {
        const gate: { release: (() => void) | null } = { release: null };
        const held = new ReadAloudReader({
            speak(text: string) {
                said.push(text);
                return new Promise<void>((resolve) => { gate.release = resolve; });
            },
            stop() { stops += 1; },
        });
        held.setEnabled(true);
        held.focus('s1');
        held.setSessionEnabled('s1', true);
        held.onMessages('s1', [prose('m1', 'One. Two.', 1)]);
        await settle();
        expect(held.playhead?.sentence).toBe('One.');
        held.setPaused(true);
        expect(held.playhead).toBeNull();
        gate.release?.();
    });
});

describe('pause is not off, and off is not pause', () => {
    let said: string[];
    let reader: ReadAloudReader;

    async function settle(): Promise<void> {
        for (let i = 0; i < 20; i++) await Promise.resolve();
    }

    beforeEach(() => {
        said = [];
        reader = new ReadAloudReader({
            speak(text: string, _options?: SpeakOptions) {
                said.push(text);
                return Promise.resolve();
            },
            stop() { },
        });
        reader.setEnabled(true);
        reader.focus('s1');
        reader.setSessionEnabled('s1', true);
    });

    it('a pause leaves read-aloud ON, which is what keeps the session held', () => {
        reader.setPaused(true);
        expect(reader.isEnabled).toBe(true);
        expect(reader.isPaused).toBe(true);
    });

    it('cannot be paused while read-aloud is off', () => {
        reader.setEnabled(false);
        reader.setPaused(true);
        expect(reader.isPaused).toBe(false);
    });

    it('turning read-aloud off clears the pause', () => {
        reader.setPaused(true);
        reader.setEnabled(false);
        expect(reader.isPaused).toBe(false);
    });

    it('turning read-aloud on is a START, not a resume (DROVE-226)', async () => {
        reader.onMessages('s1', [prose('m1', 'One. Two.', 1)]);
        await settle();
        said = [];
        reader.setPaused(true);
        reader.setEnabled(false);
        reader.setEnabled(true);
        // The kill took the session's switch with it, so switching the
        // capability back on is not enough to speak again (DROVE-386).
        reader.setSessionEnabled('s1', true);
        expect(reader.isPaused).toBe(false);
        // Nothing owed from before the toggle: interrupt moved the cursor to
        // the end and the pause went with the queue it was holding.
        reader.onMessages('s1', [prose('m2', 'Three.', 2)]);
        await settle();
        expect(said).toEqual(['Three.']);
    });

    it('an interrupt that throws the queue away releases the pause', async () => {
        reader.onMessages('s1', [prose('m1', 'One.', 1)]);
        await settle();
        reader.setPaused(true);
        // Switching session clears the timeline (DROVE-179), so a position
        // held in it no longer exists and holding one would be a reader that
        // is on, silent, and waiting on nothing.
        reader.interrupt('switched-session');
        expect(reader.isPaused).toBe(false);
        said = [];
        reader.onMessages('s1', [prose('m2', 'Two.', 2)]);
        await settle();
        expect(said).toEqual(['Two.']);
    });

    it('sending a message does NOT release the pause (DROVE-122)', async () => {
        // `sent` is one of the reasons that does not stop the voice, so the
        // queue and the place in it both survive. He asked for silence and
        // typing the next question is not him taking it back.
        reader.setPaused(true);
        reader.userSent();
        expect(reader.isPaused).toBe(true);
    });

    it('typing does not pause, and does not un-pause either (DROVE-162)', async () => {
        reader.setPaused(true);
        reader.userTyped();
        expect(reader.isPaused).toBe(true);
    });
});

describe('the three surfaces share one state', () => {
    let said: string[];
    let reader: ReadAloudReader;
    let flips: number;

    async function settle(): Promise<void> {
        for (let i = 0; i < 20; i++) await Promise.resolve();
    }

    beforeEach(() => {
        said = [];
        flips = 0;
        reader = new ReadAloudReader({
            speak(text: string, _options?: SpeakOptions) {
                said.push(text);
                return Promise.resolve();
            },
            stop() { },
        });
        reader.setEnabled(true);
        reader.focus('s1');
        reader.setSessionEnabled('s1', true);
        reader.addTransportListener(() => { flips += 1; });
    });

    it('tells its listeners when the pause flips, so the button and the card agree', () => {
        reader.setPaused(true);
        expect(flips).toBe(1);
        reader.setPaused(false);
        expect(flips).toBe(2);
    });

    it('says nothing when the state has not changed', () => {
        reader.setPaused(false);
        expect(flips).toBe(0);
        reader.setPaused(true);
        reader.setPaused(true);
        expect(flips).toBe(1);
    });

    it('tells them when read-aloud is toggled, which is what puts the card up', () => {
        const before = flips;
        reader.setEnabled(false);
        expect(flips).toBeGreaterThan(before);
        const off = flips;
        reader.setEnabled(true);
        expect(flips).toBeGreaterThan(off);
    });

    it('paused on one surface resumes correctly from another', async () => {
        reader.onMessages('s1', [prose('m1', 'One. Two. Three.', 1)]);
        await settle();
        said = [];
        // Nothing in the reader knows which surface asked; that is the point.
        reader.setPaused(true);
        reader.onMessages('s1', [prose('m2', 'Four.', 2)]);
        await settle();
        expect(said).toEqual([]);
        reader.setPaused(false);
        await settle();
        expect(said).toEqual(['Four.']);
    });
});

describe('pause beside the other things that silence the reader', () => {
    let said: string[];
    let reader: ReadAloudReader;

    async function settle(): Promise<void> {
        for (let i = 0; i < 20; i++) await Promise.resolve();
    }

    beforeEach(() => {
        said = [];
        reader = new ReadAloudReader({
            speak(text: string, _options?: SpeakOptions) {
                said.push(text);
                return Promise.resolve();
            },
            stop() { },
        });
        reader.setEnabled(true);
        reader.focus('s1');
        reader.setSessionEnabled('s1', true);
    });

    it('a mic release does not resume a pause (DROVE-143)', async () => {
        reader.setPaused(true);
        reader.setMicHeld(true);
        reader.setMicHeld(false);
        reader.onMessages('s1', [prose('m1', 'One.', 1)]);
        await settle();
        expect(said).toEqual([]);
        expect(reader.isPaused).toBe(true);
    });

    it('coming back to the foreground does not resume a pause either (DROVE-189)', async () => {
        reader.setBackgrounded(true);
        reader.setPaused(true);
        reader.onMessages('s1', [prose('m1', 'One.', 1)]);
        await settle();
        reader.setBackgrounded(false);
        await settle();
        expect(said).toEqual([]);
        expect(reader.isPaused).toBe(true);
    });

    it('a gate line waits for the resume rather than jumping a pause (DROVE-188)', async () => {
        reader.setPaused(true);
        reader.sayUrgent('g1', 'Can I run this?');
        await settle();
        expect(said).toEqual([]);
        reader.setPaused(false);
        await settle();
        expect(said).toEqual(['Can I run this?']);
    });
});
