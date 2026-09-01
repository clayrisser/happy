import { beforeEach, describe, expect, it } from 'vitest';
import { ReadAloudReader, type SpeakOptions } from './readAloud';
import type { ReadingSessionState } from './readingVoice';
import type { TransportEffect } from './readAloudTransport';
import { audioOutRow, pressAudioOut, type AudioOutGesture } from './audioOutPress';
import type { Message } from '@/sync/typesMessage';

/**
 * Every state, every gesture, over the REAL reader (DROVE-327).
 *
 * Clay: "if it's paused and I single tap it should unpause not end the
 * reading. To go into pause though you hold it in."
 *
 * The table below is the spec, row for row. It is walked against a real
 * `ReadAloudReader` rather than against `transportEffect` alone, because the
 * bug was not in the table: the composer's tap never consulted it and flipped
 * the session's switch directly. A test on the pure table would have stayed
 * green while the phone kept turning reading off. So each row puts the reader
 * INTO the state, presses, and reads the state back — and the rows that
 * resume also check the sentence that comes out next, which is what "resume"
 * means to him.
 */

function prose(id: string, text: string, createdAt: number): Message {
    return { id, localId: null, createdAt, kind: 'agent-text', text } as unknown as Message;
}

/** An engine whose utterances finish when the test says so. */
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

    get speaking(): boolean {
        return this.resolvers.length > 0;
    }
}

async function settle(): Promise<void> {
    for (let i = 0; i < 20; i++) await Promise.resolve();
}

/**
 * THE TABLE. A wrong cell fails by name.
 *
 *   state     tap                 hold
 *   off       turn-on → reading   boss-mode → off (the composer dials)
 *   reading   turn-off → off      pause → paused
 *   paused    resume → reading    turn-off → off
 *   yielded   resume → reading    turn-off → off
 *
 * `yielded` is the row the transport table does not have: armed, holding a
 * place, another session speaking. The composer draws it on the paused face,
 * so it presses like paused, and "resume" there is taking the voice back.
 */
const table: ReadonlyArray<{
    state: ReadingSessionState;
    gesture: AudioOutGesture;
    effect: TransportEffect;
    after: ReadingSessionState;
}> = [
    { state: 'off', gesture: 'tap', effect: 'turn-on', after: 'reading' },
    { state: 'off', gesture: 'long-press', effect: 'boss-mode', after: 'off' },
    { state: 'reading', gesture: 'tap', effect: 'turn-off', after: 'off' },
    { state: 'reading', gesture: 'long-press', effect: 'pause', after: 'paused' },
    { state: 'paused', gesture: 'tap', effect: 'resume', after: 'reading' },
    { state: 'paused', gesture: 'long-press', effect: 'turn-off', after: 'off' },
    { state: 'yielded', gesture: 'tap', effect: 'resume', after: 'reading' },
    { state: 'yielded', gesture: 'long-press', effect: 'turn-off', after: 'off' },
];

describe('the composer button, every state and every gesture (DROVE-327)', () => {
    let engine: FakeEngine;
    let reader: ReadAloudReader;

    /**
     * Put session `a` into `state`, with two of four sentences already heard
     * wherever there is a position to hold, so a wrong resume shows up as a
     * wrong sentence and not only as a wrong state.
     */
    async function bring(state: ReadingSessionState): Promise<void> {
        if (state === 'off') {
            reader.visit('a');
            return;
        }
        reader.setSessionEnabled('a', true);
        reader.visit('a');
        reader.onMessages('a', [prose('ma', 'One. Two. Three. Four.', 10)]);
        await settle();
        engine.finish();
        await settle();
        expect(engine.spoken).toEqual(['One.', 'Two.']);
        if (state === 'paused') {
            reader.setPaused(true);
        } else if (state === 'yielded') {
            // Enabling another session takes the voice (invariant 4, the shape
            // `drover read <session>` drives from a terminal) while he is still
            // looking at `a`.
            reader.setSessionEnabled('c', true);
        }
        await settle();
        expect(reader.readingStateOf('a')).toBe(state);
    }

    beforeEach(() => {
        engine = new FakeEngine();
        reader = new ReadAloudReader(engine);
        // The shipped default is off; every session below is armed by hand.
        reader.setEnabled(false);
    });

    for (const row of table) {
        it(`${row.state} + ${row.gesture} → ${row.effect}, leaving it ${row.after}`, async () => {
            await bring(row.state);
            const effect = pressAudioOut(reader, 'a', row.gesture);
            await settle();
            expect(effect, 'the effect the table chose').toBe(row.effect);
            expect(reader.readingStateOf('a'), 'the state the button will draw next').toBe(row.after);
        });
    }

    it('walks the whole table: no row is missing and none is duplicated', () => {
        // Four states, two gestures, eight cells. A row that goes missing from
        // the table above would silently drop a transition from the walk.
        const cells = new Set(table.map((row) => `${row.state}/${row.gesture}`));
        expect(cells.size).toBe(8);
        for (const state of ['off', 'reading', 'paused', 'yielded'] as const) {
            for (const gesture of ['tap', 'long-press'] as const) {
                expect(cells.has(`${state}/${gesture}`), `${state}/${gesture}`).toBe(true);
            }
        }
    });

    it('folds the four session states onto the three rows the table has', () => {
        expect(audioOutRow('off')).toBe('off');
        expect(audioOutRow('reading')).toBe('reading');
        expect(audioOutRow('paused')).toBe('paused');
        // The amber face: on, silent, holding a place. Same row as his pause.
        expect(audioOutRow('yielded')).toBe('paused');
    });
});

describe('a tap on a paused reader RESUMES, at the sentence it paused on (DROVE-327)', () => {
    let engine: FakeEngine;
    let reader: ReadAloudReader;

    beforeEach(async () => {
        engine = new FakeEngine();
        reader = new ReadAloudReader(engine);
        reader.setEnabled(false);
        reader.setSessionEnabled('a', true);
        reader.visit('a');
        reader.onMessages('a', [prose('ma', 'One. Two. Three. Four.', 10)]);
        await settle();
        engine.finish();
        await settle();
        expect(engine.spoken).toEqual(['One.', 'Two.']);
        // Paused mid-'Two.', as a hold on the button or a headphone press would.
        pressAudioOut(reader, 'a', 'long-press');
        await settle();
        expect(reader.readingStateOf('a')).toBe('paused');
    });

    it('does not turn reading off, which is the bug', async () => {
        pressAudioOut(reader, 'a', 'tap');
        await settle();
        expect(reader.isSessionEnabled('a'), 'the tap disabled the session').toBe(true);
        expect(reader.readingSessionId, 'the tap released the voice').toBe('a');
        expect(reader.readingStateOf('a')).toBe('reading');
    });

    it('carries on at the NEXT unsaid sentence: nothing re-read, nothing skipped', async () => {
        pressAudioOut(reader, 'a', 'tap');
        await settle();
        // 'Three.', not 'One.' (a START would re-read, DROVE-226 is not a
        // resume) and not 'Two.' again (DROVE-126: a sentence that made a
        // sound stays spoken).
        expect(engine.spoken).toEqual(['One.', 'Two.', 'Three.']);
        engine.finish();
        await settle();
        expect(engine.spoken).toEqual(['One.', 'Two.', 'Three.', 'Four.']);
    });

    it('never jumps to content that landed while it was paused (DROVE-226 is a start, not a resume)', async () => {
        reader.onMessages('a', [prose('mb', 'Five.', 20)]);
        await settle();
        expect(engine.spoken, 'something was said while paused').toEqual(['One.', 'Two.']);
        pressAudioOut(reader, 'a', 'tap');
        await settle();
        engine.finish();
        await settle();
        engine.finish();
        await settle();
        expect(engine.spoken).toEqual(['One.', 'Two.', 'Three.', 'Four.', 'Five.']);
    });

    it('is the round trip he asked for: hold pauses, tap resumes, hold pauses again', async () => {
        pressAudioOut(reader, 'a', 'tap');
        await settle();
        expect(reader.readingStateOf('a')).toBe('reading');
        pressAudioOut(reader, 'a', 'long-press');
        await settle();
        expect(reader.readingStateOf('a')).toBe('paused');
        pressAudioOut(reader, 'a', 'tap');
        await settle();
        expect(reader.readingStateOf('a')).toBe('reading');
        // Every sentence came out exactly once, in order. The second hold
        // landed mid-'Three.', and a sentence that made a sound stays spoken
        // (DROVE-126, DROVE-233's sentence granularity), so the second resume
        // carries on at 'Four.' rather than saying 'Three.' twice.
        expect(engine.spoken).toEqual(['One.', 'Two.', 'Three.', 'Four.']);
    });
});

describe('a hold on a paused reader turns it OFF, and off throws the place away (DROVE-327)', () => {
    let engine: FakeEngine;
    let reader: ReadAloudReader;

    beforeEach(async () => {
        engine = new FakeEngine();
        reader = new ReadAloudReader(engine);
        reader.setEnabled(false);
        reader.setSessionEnabled('a', true);
        reader.visit('a');
        reader.onMessages('a', [prose('ma', 'One. Two. Three. Four.', 10)]);
        await settle();
        engine.finish();
        await settle();
        pressAudioOut(reader, 'a', 'long-press');
        await settle();
        expect(reader.readingStateOf('a')).toBe('paused');
    });

    it('releases the voice and starts nothing else', async () => {
        const said = engine.spoken.length;
        pressAudioOut(reader, 'a', 'long-press');
        await settle();
        expect(reader.readingStateOf('a')).toBe('off');
        expect(reader.readingSessionId).toBe(null);
        expect(engine.spoken.length).toBe(said);
        expect(engine.speaking).toBe(false);
    });

    it('the next tap is a START at new content, not a resume (DROVE-226, DROVE-233)', async () => {
        pressAudioOut(reader, 'a', 'long-press');
        await settle();
        expect(reader.hasHeldReading('a')).toBe(false);
        pressAudioOut(reader, 'a', 'tap');
        await settle();
        expect(reader.readingStateOf('a')).toBe('reading');
        // Nothing owed from before the toggle.
        expect(engine.spoken).toEqual(['One.', 'Two.']);
        reader.onMessages('a', [prose('mb', 'Five.', 20)]);
        await settle();
        expect(engine.spoken).toEqual(['One.', 'Two.', 'Five.']);
    });
});

describe('a tap on a YIELDED session takes the voice back at its own place (DROVE-327, DROVE-289)', () => {
    let engine: FakeEngine;
    let reader: ReadAloudReader;

    beforeEach(async () => {
        engine = new FakeEngine();
        reader = new ReadAloudReader(engine);
        reader.setEnabled(false);
        reader.setSessionEnabled('a', true);
        reader.visit('a');
        reader.onMessages('a', [prose('ma', 'One. Two. Three. Four.', 10)]);
        await settle();
        engine.finish();
        await settle();
        expect(engine.spoken).toEqual(['One.', 'Two.']);
    });

    it('resumes on the next unsaid sentence and yields the other session at its place', async () => {
        reader.setSessionEnabled('c', true);
        await settle();
        reader.onMessages('c', [prose('mc', 'C one. C two.', 30)]);
        await settle();
        expect(reader.readingStateOf('a')).toBe('yielded');
        expect(engine.spoken).toEqual(['One.', 'Two.', 'C one.']);

        // The amber face on A's composer, tapped. Same face as paused, same
        // answer: read on from here.
        const effect = pressAudioOut(reader, 'a', 'tap');
        await settle();
        expect(effect).toBe('resume');
        expect(reader.readingSessionId).toBe('a');
        expect(reader.readingStateOf('a')).toBe('reading');
        expect(reader.readingStateOf('c')).toBe('yielded');
        expect(reader.hasHeldReading('c')).toBe(true);
        expect(engine.spoken).toEqual(['One.', 'Two.', 'C one.', 'Three.']);
    });

    it('lifts a pause that was his before the yield, rather than coming back silent', async () => {
        // He paused A, then a terminal moved the voice to C. Coming back by
        // tapping A's amber face must READ, not restore the pause and sit
        // there — a tap is an instruction to read (DROVE-275).
        reader.setPaused(true);
        reader.setSessionEnabled('c', true);
        await settle();
        expect(reader.readingStateOf('a')).toBe('yielded');

        pressAudioOut(reader, 'a', 'tap');
        await settle();
        expect(reader.readingStateOf('a')).toBe('reading');
        expect(engine.spoken[engine.spoken.length - 1]).toBe('Three.');
    });

    it('a hold on a yielded session switches it off without touching the voice', async () => {
        reader.setSessionEnabled('c', true);
        await settle();
        const effect = pressAudioOut(reader, 'a', 'long-press');
        await settle();
        expect(effect).toBe('turn-off');
        expect(reader.readingStateOf('a')).toBe('off');
        expect(reader.hasHeldReading('a')).toBe(false);
        // C never had the voice taken from it: switching A off is not a claim.
        expect(reader.readingSessionId).toBe('c');
    });
});

describe('what the performer does NOT do', () => {
    it('leaves the reader alone on boss-mode: that cell is the composer\'s call', () => {
        const calls: string[] = [];
        const effect = pressAudioOut({
            readingStateOf: () => 'off',
            setSessionEnabled: (id, on) => { calls.push(`enable ${id} ${on}`); },
            setPaused: (p) => { calls.push(`pause ${p}`); },
            takeVoice: (id) => { calls.push(`take ${id}`); },
        }, 'a', 'long-press');
        expect(effect).toBe('boss-mode');
        expect(calls).toEqual([]);
    });

    it('only takes the voice for a yielded session, never for his own pause', () => {
        const calls: string[] = [];
        const target = (state: ReadingSessionState) => ({
            readingStateOf: () => state,
            setSessionEnabled: (id: string, on: boolean) => { calls.push(`enable ${id} ${on}`); },
            setPaused: (p: boolean) => { calls.push(`pause ${p}`); },
            takeVoice: (id: string) => { calls.push(`take ${id}`); },
        });
        pressAudioOut(target('paused'), 'a', 'tap');
        expect(calls).toEqual(['pause false']);
        calls.length = 0;
        pressAudioOut(target('yielded'), 'a', 'tap');
        // The take comes FIRST, so the pump lifts the right session's queue.
        expect(calls).toEqual(['take a', 'pause false']);
    });
});
