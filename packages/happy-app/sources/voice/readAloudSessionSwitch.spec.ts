import { beforeEach, describe, expect, it } from 'vitest';
import { ReadAloudReader, type SpeakOptions } from './readAloud';
import type { Message } from '@/sync/typesMessage';

/**
 * Each session keeps its own read position, and a switch holds and resumes it
 * (DROVE-289).
 *
 * Clay: "whichever session I switch to, it starts reading from where IT left
 * off — that's the ideal. If I'm switching I don't wanna jump ahead... it's
 * like when you press on the audio, it pauses." His analogy is the design: a
 * switch away is a pause taken per session, and arriving back resumes from
 * that session's OWN held position. Never the tail, never the previous
 * session's place.
 *
 * THE MEASUREMENT this file exists for is the one his complaint names: no
 * switch may ever advance any session's playhead. Before this ticket `focus`
 * threw the whole reading away, so coming back re-fed the transcript as
 * history, marked spoken, and resumed at the TAIL — everything unread when he
 * left was silently skipped. That is the "jumping ahead". Every test here
 * drives the real reader with two sessions and asserts positions on both
 * sides of a switch, because the bug is invisible with one session.
 */

function prose(id: string, text: string, createdAt: number): Message {
    return { id, localId: null, createdAt, kind: 'agent-text', text } as unknown as Message;
}

function userText(id: string, createdAt: number, text = 'and now this'): Message {
    return { kind: 'user-text', id, localId: null, createdAt, text } as Message;
}

/**
 * An engine whose utterances finish when the test says so, because holding a
 * position mid-reply is the whole subject: an engine that resolves instantly
 * reads every reply to the end and no test here could put a playhead anywhere
 * but the tail.
 */
class FakeEngine {
    spoken: string[] = [];
    stops = 0;
    private resolvers: Array<() => void> = [];

    speak(text: string, _options?: SpeakOptions): Promise<unknown> {
        this.spoken.push(text);
        return new Promise<void>((resolve) => { this.resolvers.push(resolve); });
    }

    /** A stop settles the utterance in flight, as the real engine's does. */
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

describe('per-session read position across a switch (DROVE-289)', () => {
    let engine: FakeEngine;
    let reader: ReadAloudReader;

    beforeEach(() => {
        engine = new FakeEngine();
        reader = new ReadAloudReader(engine);
        reader.setEnabled(true);
        reader.focus('s1');
    });

    it('holds the position on a switch away, and the switch itself says nothing', async () => {
        reader.onMessages('s1', [prose('m1', 'One. Two. Three. Four.', 10)]);
        await settle();
        engine.finish();
        await settle();
        engine.finish();
        await settle();
        // 'Three.' is at the synthesiser when he switches.
        expect(engine.spoken).toEqual(['One.', 'Two.', 'Three.']);

        const before = engine.spoken.length;
        reader.focus('s2');
        await settle();
        // The utterance in flight is cut, nothing new is said, and the old
        // session is holding its place.
        expect(engine.spoken.length).toBe(before);
        expect(reader.speechPending).toBe(false);
        expect(reader.hasHeldReading('s1')).toBe(true);
        expect(reader.focusedSessionId).toBe('s2');
    });

    it('resumes at the held sentence and reads on THROUGH what arrived while he was away', async () => {
        reader.onMessages('s1', [prose('m1', 'One. Two. Three. Four.', 10)]);
        await settle();
        engine.finish();
        await settle();
        engine.finish();
        await settle();
        expect(engine.spoken).toEqual(['One.', 'Two.', 'Three.']);

        reader.focus('s2');
        await settle();
        // A reply lands in s1 while he is in s2. The held timeline keeps
        // filling, exactly as a paused one's does (DROVE-233), and none of it
        // is spoken yet.
        reader.onMessages('s1', [prose('m2', 'Five. Six.', 20)]);
        await settle();
        expect(engine.spoken).toEqual(['One.', 'Two.', 'Three.']);

        reader.focus('s1');
        await settle();
        engine.finish();
        await settle();
        engine.finish();
        await settle();
        // 'Three.' made a sound before the cut, so it stays spoken and the
        // resume starts at the NEXT sentence (DROVE-233's granularity). Then
        // straight through the while-away reply: no re-read, no jump to the
        // tail, no skipped material (DROVE-263).
        expect(engine.spoken).toEqual(['One.', 'Two.', 'Three.', 'Four.', 'Five.', 'Six.']);
    });

    it('each session resumes at ITS OWN held position, never the other one’s', async () => {
        reader.onMessages('s1', [prose('a1', 'A one. A two. A three. A four.', 10)]);
        await settle();
        engine.finish();
        await settle();
        // 'A two.' in flight; switch with A three/A four unread.
        reader.focus('s2');
        await settle();
        reader.onMessages('s2', [prose('b1', 'B one. B two. B three.', 20)]);
        await settle();
        engine.finish();
        await settle();
        // 'B two.' in flight; switch back with B three unread.
        reader.focus('s1');
        await settle();
        // s1 resumes at A three — its own held sentence, not s2's place and
        // not s1's tail.
        engine.finish();
        await settle();
        reader.focus('s2');
        await settle();
        // And s2 resumes at B three, untouched by everything s1 said.
        engine.finish();
        await settle();
        expect(engine.spoken).toEqual([
            'A one.', 'A two.',
            'B one.', 'B two.',
            'A three.', 'A four.',
            'B three.',
        ]);
    });

    it('a session that was never reading starts nothing on arrival', async () => {
        reader.onMessages('s1', [prose('m1', 'One. Two.', 10)]);
        await settle();
        reader.focus('s2');
        await settle();
        const before = engine.spoken.length;
        // Its transcript loads, as it does on any open (DROVE-226): silence.
        reader.onHistory('s2', [prose('h1', 'Old words in s2.', 1)]);
        await settle();
        expect(engine.spoken.length).toBe(before);
        expect(reader.speechPending).toBe(false);
        expect(reader.playhead).toBeNull();
    });

    it('his pause survives the round trip, and only his gesture lifts it', async () => {
        reader.onMessages('s1', [prose('m1', 'One. Two. Three.', 10)]);
        await settle();
        engine.finish();
        await settle();
        reader.setPaused(true);
        expect(reader.isPaused).toBe(true);

        reader.focus('s2');
        await settle();
        // The pause is s1's, not the reader's: s2 arrives unpaused.
        expect(reader.isPaused).toBe(false);

        reader.focus('s1');
        await settle();
        // Arriving back does NOT auto-resume a session HE paused: it is
        // paused at its held position, amber face and all (DROVE-233/258).
        expect(reader.isPaused).toBe(true);
        expect(engine.spoken).toEqual(['One.', 'Two.']);

        reader.setPaused(false);
        await settle();
        expect(engine.spoken).toEqual(['One.', 'Two.', 'Three.']);
    });

    it('turning read-aloud off throws every held position away', async () => {
        reader.onMessages('s1', [prose('m1', 'One. Two. Three.', 10)]);
        await settle();
        reader.focus('s2');
        await settle();
        expect(reader.hasHeldReading('s1')).toBe(true);

        reader.setEnabled(false);
        expect(reader.hasHeldReading('s1')).toBe(false);

        // Coming back on is a START (DROVE-233): the old position is gone,
        // nothing old is resumed, and only new content is read (DROVE-226).
        reader.setEnabled(true);
        const before = engine.spoken.length;
        reader.focus('s1');
        await settle();
        expect(engine.spoken.length).toBe(before);
        reader.onMessages('s1', [prose('m2', 'The newest message.', 20)]);
        await settle();
        expect(engine.spoken[engine.spoken.length - 1]).toBe('The newest message.');
    });

    it('tells the transport listeners on a switch, which is what carries it to the wrist', async () => {
        let fires = 0;
        reader.addTransportListener(() => { fires += 1; });
        reader.focus('s2');
        expect(fires).toBeGreaterThan(0);
        const afterFirst = fires;
        reader.focus('s1');
        // Both directions: collectReading names the session (DROVE-275), and
        // its publish rides these listeners; a silent switch would leave the
        // watch narrating the old session until the next heartbeat.
        expect(fires).toBeGreaterThan(afterFirst);
    });

    it('a gate answered while he was away is not read on his return', async () => {
        reader.onMessages('s1', [prose('m1', 'One. Two.', 10)]);
        await settle();
        // 'One.' is in flight, so the gate line queues behind it (DROVE-188).
        reader.sayUrgent('g1', 'A gate is waiting.');
        reader.focus('s2');
        await settle();
        // Answered from the terminal while he is in s2.
        reader.cancelUrgent('g1');
        reader.focus('s1');
        await settle();
        engine.finish();
        await settle();
        expect(engine.spoken).toEqual(['One.', 'Two.']);
        expect(engine.spoken).not.toContain('A gate is waiting.');
    });

    it('a gate still waiting outranks the transcript on his return', async () => {
        reader.onMessages('s1', [prose('m1', 'One. Two.', 10)]);
        await settle();
        reader.sayUrgent('g1', 'A gate is waiting.');
        reader.focus('s2');
        await settle();
        reader.focus('s1');
        await settle();
        // The gate first — he is being waited on — then the held position.
        expect(engine.spoken[engine.spoken.length - 1]).toBe('A gate is waiting.');
        engine.finish();
        await settle();
        expect(engine.spoken[engine.spoken.length - 1]).toBe('Two.');
    });

    it('a new turn while away steps the held cursor, exactly as it does while paused', async () => {
        reader.onMessages('s1', [prose('m1', 'One. Two. Three. Four.', 10)]);
        await settle();
        engine.finish();
        await settle();
        // 'Two.' in flight, Three/Four backlogged.
        reader.focus('s2');
        await settle();
        // He asks s1 something new from another surface and the answer lands.
        // DROVE-108's standing rule runs while held exactly as it runs while
        // paused: the older turn's unspoken tail is abandoned and the marker
        // is owed once. The SWITCH moved nothing; the new TURN did.
        reader.onMessages('s1', [
            userText('u1', 20),
            prose('m2', 'The answer.', 21),
        ]);
        await settle();
        reader.focus('s1');
        await settle();
        expect(reader.skipCount).toBe(1);
        expect(engine.spoken).toContain('Skipping ahead.');
        engine.finish();
        await settle();
        expect(engine.spoken[engine.spoken.length - 1]).toBe('The answer.');
        expect(engine.spoken).not.toContain('Three.');
        expect(engine.spoken).not.toContain('Four.');
    });

    it('reopening a held session re-reads nothing when its transcript reloads', async () => {
        reader.onMessages('s1', [prose('m1', 'One. Two.', 10)]);
        await settle();
        engine.finish();
        await settle();
        engine.finish();
        await settle();
        expect(engine.spoken).toEqual(['One.', 'Two.']);

        reader.focus('s2');
        await settle();
        reader.focus('s1');
        await settle();
        // The screen refetches the page it already had (DROVE-226). The held
        // bookkeeping recognises every sentence, so nothing is said twice
        // (DROVE-126) and nothing is waiting.
        reader.onHistory('s1', [prose('m1', 'One. Two.', 10)]);
        await settle();
        expect(engine.spoken).toEqual(['One.', 'Two.']);
        expect(reader.speechPending).toBe(false);
    });
});
