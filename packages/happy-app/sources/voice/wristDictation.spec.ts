import { describe, expect, it } from 'vitest';

import { WristDictation, type WristDictationEngine } from './wristDictation';

function harness(stopWith = 'the whole thing') {
    const heard: { capture: string; seq: number; text: string; final: boolean }[] = [];
    const errors: { capture: string; message: string }[] = [];
    const engine: WristDictationEngine & { started: string[]; cancelled: number } = {
        started: [],
        cancelled: 0,
        start(capture: string) {
            this.started.push(capture);
            return Promise.resolve(true);
        },
        stop: () => Promise.resolve(stopWith),
        cancel() {
            this.cancelled += 1;
        },
    };
    const wrist = new WristDictation(engine, {
        heard: (capture, seq, text, final) => heard.push({ capture, seq, text, final }),
        error: (capture, message) => errors.push({ capture, message }),
    });
    return { wrist, engine, heard, errors };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('WristDictation (DROVE-130)', () => {
    it('holds the capture open across a pause and never takes words back', async () => {
        const { wrist, heard } = harness();
        wrist.open('c1');
        await settle();
        wrist.partial('fix the login race');
        // THE PAUSE. With requiresOnDeviceRecognition the recogniser does not
        // finalise: it opens a new result sequence and reports it FROM EMPTY.
        // Forwarding that empty to the wrist is DROVE-263 wearing a hat.
        wrist.partial('');
        wrist.partial('   ');
        expect(heard.map((h) => h.text)).toEqual(['fix the login race']);
        // He carries on. The native module has already banked, so what arrives
        // is the whole capture.
        wrist.partial('fix the login race and push it');
        expect(heard.at(-1)?.text).toBe('fix the login race and push it');
        expect(heard.every((h) => !h.final)).toBe(true);
    });

    it('numbers partials so the wrist can drop a stale one', async () => {
        const { wrist, heard } = harness();
        wrist.open('c1');
        await settle();
        wrist.partial('one');
        wrist.partial('one two');
        wrist.partial('one two three');
        expect(heard.map((h) => h.seq)).toEqual([0, 1, 2]);
        expect(heard.every((h) => h.capture === 'c1')).toBe(true);
        // An unchanged partial is not worth a message.
        wrist.partial('one two three');
        expect(heard).toHaveLength(3);
    });

    it('lets a revision be shorter, because a revision legitimately is', async () => {
        const { wrist, heard } = harness();
        wrist.open('c1');
        await settle();
        wrist.partial('um hello there');
        wrist.partial('hello');
        expect(heard.at(-1)?.text).toBe('hello');
    });

    it('keeps the words when the final says less than the wrist is showing', async () => {
        // The module clears its transcript when the recogniser finalises on
        // its own, so a stop landing afterwards resolves with "".
        const { wrist, heard } = harness('');
        wrist.open('c1');
        await settle();
        wrist.partial('everything he actually said');
        wrist.close('c1');
        await settle();
        const last = heard.at(-1);
        expect(last?.final).toBe(true);
        expect(last?.text).toBe('everything he actually said');
    });

    it('does not send to the session on stop; the words go back to the wrist', async () => {
        const { wrist, heard } = harness('say this to the session');
        wrist.open('c1');
        await settle();
        wrist.partial('say this');
        wrist.close('c1');
        await settle();
        // Everything this class emits is a `heard` back to the wrist. Sending
        // is the wrist's own deliberate act, over the existing `say` path.
        expect(heard.at(-1)).toEqual({
            capture: 'c1',
            seq: 1,
            text: 'say this to the session',
            final: true,
        });
        expect(wrist.openCapture).toBeNull();
    });

    it('ignores a stop or a discard for a capture that is not open', async () => {
        const { wrist, engine, heard } = harness();
        wrist.open('c1');
        await settle();
        wrist.partial('live');
        wrist.close('c0');
        wrist.discard('c0');
        await settle();
        expect(wrist.openCapture).toBe('c1');
        expect(engine.cancelled).toBe(0);
        expect(heard.filter((h) => h.final)).toHaveLength(0);
    });

    it('throws the audio away on a discard and tells the wrist nothing', async () => {
        const { wrist, engine, heard } = harness();
        wrist.open('c1');
        await settle();
        wrist.partial('never mind');
        const before = heard.length;
        wrist.discard('c1');
        await settle();
        expect(engine.cancelled).toBe(1);
        expect(heard).toHaveLength(before);
        expect(wrist.openCapture).toBeNull();
    });

    it('closes the capture when the recogniser ends by itself, keeping the words', async () => {
        const { wrist, heard, errors } = harness();
        wrist.open('c1');
        await settle();
        wrist.partial('half a sentence');
        wrist.ended('', 'the recogniser gave up');
        expect(heard.at(-1)?.text).toBe('half a sentence');
        expect(heard.at(-1)?.final).toBe(true);
        // A latched recorder must never look live over a dead task.
        expect(wrist.openCapture).toBeNull();
        expect(errors.at(-1)?.message).toBe('the recogniser gave up');
    });

    it('tells the wrist when the recogniser refuses to start', async () => {
        const errors: { capture: string; message: string }[] = [];
        const closed: { capture: string; final: boolean }[] = [];
        const failing = new WristDictation(
            {
                start: () => Promise.reject(new Error('no on-device model for en-GB')),
                stop: () => Promise.resolve(''),
                cancel: () => {},
            },
            {
                heard: (capture, _seq, _text, final) => closed.push({ capture, final }),
                error: (capture, message) => errors.push({ capture, message }),
            },
        );
        failing.open('c9');
        await settle();
        expect(errors).toEqual([{ capture: 'c9', message: 'no on-device model for en-GB' }]);
        expect(failing.openCapture).toBeNull();
        // The wrist is closed by a final `heard`, not by the error: there is
        // exactly one thing that ends a capture.
        expect(closed).toEqual([{ capture: 'c9', final: true }]);
    });

    it('lets a newer press win when the two devices disagree about state', async () => {
        const { wrist, engine } = harness();
        wrist.open('c1');
        await settle();
        wrist.open('c2');
        await settle();
        expect(engine.cancelled).toBe(1);
        expect(engine.started).toEqual(['c1', 'c2']);
        expect(wrist.openCapture).toBe('c2');
    });

    it('drops partials arriving while nothing is open', () => {
        const { wrist, heard } = harness();
        wrist.partial('nobody asked for this');
        wrist.ended('nor this');
        expect(heard).toHaveLength(0);
    });
});
