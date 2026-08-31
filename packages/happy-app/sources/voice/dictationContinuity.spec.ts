import { describe, expect, it } from 'vitest';
import { DictationCapture, type DictationEngine } from './dictationCapture';
import { dictationComposerEvents } from './dictationComposer';
import { DICTATION_LATCH_IDLE_MS } from './micMode';

/**
 * A latch keeps everything said across a pause (DROVE-140).
 *
 * Clay: "when I'm silent and then talk again it's overwriting what I said."
 * This is not the loss DROVE-120 fixed. Nothing here DISCARDS: the words are
 * replaced, which is what happens when Apple's recogniser finalises after a
 * pause and the native module opens a fresh recognition task. A fresh task
 * reports from empty, so its first partial is the sentence AFTER the pause,
 * and writing it over the composer erases the sentence before it.
 *
 * The thing that cannot be done by comparing strings is telling that first
 * partial of a new task from the recogniser revising its own guess. "Yes"
 * after "no" is a correction when the recogniser changed its mind and a new
 * sentence when he said them a breath apart, and no amount of prefix testing
 * separates the two. So the decision is keyed on the TASK the words came from:
 * the same task REVISES, a new task APPENDS. These tests are written in those
 * terms on purpose, and the one below that revises inside a task with text
 * that looks nothing like what it replaces is the reason.
 */

/** A recogniser the test drives by hand. */
class FakeRecogniser implements DictationEngine {
    starts = 0;
    stops = 0;
    cancels = 0;
    private stopResolvers: ((text: string) => void)[] = [];

    start(): Promise<unknown> {
        this.starts += 1;
        return Promise.resolve(true);
    }

    stop(): Promise<string> {
        this.stops += 1;
        return new Promise<string>((resolve) => { this.stopResolvers.push(resolve); });
    }

    cancel(): void {
        this.cancels += 1;
    }

    settle(text: string): void {
        this.stopResolvers.shift()?.(text);
    }
}

async function flush(): Promise<void> {
    for (let i = 0; i < 8; i++) await Promise.resolve();
}

/** The mic and the composer, wired the way useVoiceComposer wires them. */
function harness(base = '') {
    const engine = new FakeRecogniser();
    let clock = 1_000;
    let composer = base;
    let draft = base;
    let sends = 0;
    const capture = new DictationCapture(engine, dictationComposerEvents({
        base: () => draft,
        setComposerText: (text) => { composer = text; },
        send: () => { sends += 1; },
        onError: () => { /* nothing in this file errors */ },
        onChange: () => { /* the indicator, not the text */ },
    }), () => clock);
    return {
        engine,
        capture,
        get composer() { return composer; },
        get sends() { return sends; },
        /** The tap that opens a latched mic, as the gesture reducer drives it. */
        tapOpen() { draft = composer; capture.begin('hold'); capture.latch(); },
        advance(ms: number) { clock += ms; },
        tick() { capture.tick(clock); },
    };
}

describe('a latched capture across a pause', () => {
    /**
     * THE TICKET'S OWN SEQUENCE, end to end: tap, speak, go quiet long enough
     * for Apple to finalise, speak again, tap off. Everything he said is in
     * the composer, in the order he said it, and nothing was sent.
     */
    it('keeps everything said before and after the silence, in order', async () => {
        const h = harness();
        h.tapOpen();

        // Task 1: the first sentence, revised in place as it lands.
        h.capture.partial('so the thing', 1);
        h.capture.partial('so the thing I wanted', 1);
        h.capture.partial('so the thing I wanted to say', 1);
        expect(h.composer).toBe('so the thing I wanted to say');

        // The silence. Apple finalises task 1 on its own and the module opens
        // task 2 on the same microphone. Nothing arrives in JS for it.
        h.advance(4_000);

        // Task 2: he carries on. Its transcript starts from empty, which is
        // precisely why it must APPEND rather than replace.
        h.capture.partial('is that', 2);
        h.capture.partial('is that we should ship it', 2);
        expect(h.composer).toBe('so the thing I wanted to say is that we should ship it');

        // The second tap. Native resolves with the whole capture, both tasks.
        h.capture.stop();
        await flush();
        h.engine.settle('so the thing I wanted to say is that we should ship it');
        await flush();

        expect(h.composer).toBe('so the thing I wanted to say is that we should ship it');
        expect(h.sends).toBe(0);
    });

    it('survives three tasks, so the fix is not a special case of two', () => {
        const h = harness();
        h.tapOpen();
        h.capture.partial('one', 1);
        h.capture.partial('two', 2);
        h.capture.partial('three', 3);
        expect(h.composer).toBe('one two three');
    });

    /**
     * The other half of the rule, and the half a string comparison gets wrong:
     * inside ONE task the recogniser is rewriting its own guess, and the new
     * text wins however little it resembles what it replaces.
     */
    it('a revision inside one task still replaces, however different the words', () => {
        const h = harness();
        h.tapOpen();
        h.capture.partial('to fifty too', 1);
        h.capture.partial('22', 1);
        expect(h.composer).toBe('22');
        h.capture.partial('twenty two', 1);
        expect(h.composer).toBe('twenty two');
    });

    it('a revision after a task change revises only the new task, never the banked words', () => {
        const h = harness();
        h.tapOpen();
        h.capture.partial('the first sentence', 1);
        h.capture.partial('and then', 2);
        h.capture.partial('and then the second', 2);
        h.capture.partial('then the second one', 2);
        expect(h.composer).toBe('the first sentence then the second one');
    });

    it('joins onto whatever was already typed, and does not disturb it', () => {
        const h = harness('a draft already there');
        h.tapOpen();
        h.capture.partial('spoken words', 1);
        h.capture.partial('more after the pause', 2);
        expect(h.composer).toBe('a draft already there spoken words more after the pause');
    });

    it('a new task keeps the latch alive, so a pause does not run the idle clock down', () => {
        const h = harness();
        h.tapOpen();
        h.capture.partial('before', 1);
        h.advance(DICTATION_LATCH_IDLE_MS - 1_000);
        h.capture.partial('after', 2);
        // The new task's words are speech, so the deadline moved with them.
        h.advance(2_000);
        h.tick();
        expect(h.capture.current.active).toBe(true);
        expect(h.composer).toBe('before after');
    });

    it('the recogniser giving up mid-capture keeps both tasks, unsent', () => {
        const h = harness();
        h.tapOpen();
        h.capture.partial('before the pause', 1);
        h.capture.partial('after the pause', 2);
        // Native reports the whole capture, not the last task alone.
        h.capture.recogniserEnded('before the pause after the pause', 2);
        expect(h.composer).toBe('before the pause after the pause');
        expect(h.sends).toBe(0);
        expect(h.capture.current.active).toBe(false);
    });

    it('a hold lifted after a pause sends everything, not only the last task', async () => {
        const h = harness();
        h.tapOpen();
        h.capture.partial('first half', 1);
        h.capture.partial('second half', 2);
        h.capture.send();
        await flush();
        h.engine.settle('first half second half');
        await flush();
        expect(h.composer).toBe('first half second half');
        expect(h.sends).toBe(1);
    });

    it('a task counter that restarts on the next capture does not bleed across', () => {
        const h = harness();
        h.tapOpen();
        h.capture.partial('first capture', 1);
        h.capture.recogniserEnded('first capture', 1);
        expect(h.composer).toBe('first capture');
        // A fresh capture over the committed words. Task 1 again, and it must
        // append to the draft rather than re-open the last capture's bank.
        h.tapOpen();
        h.capture.partial('second capture', 1);
        expect(h.composer).toBe('first capture second capture');
    });

    /**
     * THE HONEST DEGRADATION. A build whose native side reports no task id
     * cannot continue past Apple's finalisation either, so every partial
     * replacing is still correct there: the capture ENDS at the pause with the
     * words in the composer, and the next press appends to them. The mic
     * closing is visible; losing a sentence would not be.
     */
    describe('on a build that reports no task', () => {
        it('every partial replaces, exactly as it always did', () => {
            const h = harness();
            h.tapOpen();
            h.capture.partial('hello');
            h.capture.partial('hello there');
            expect(h.composer).toBe('hello there');
        });

        it('the pause ends the capture with the words kept, and the next press adds to them', () => {
            const h = harness();
            h.tapOpen();
            h.capture.partial('before the pause');
            h.capture.recogniserEnded('before the pause');
            expect(h.capture.current.active).toBe(false);
            expect(h.composer).toBe('before the pause');
            expect(h.sends).toBe(0);

            h.tapOpen();
            h.capture.partial('after the pause');
            expect(h.composer).toBe('before the pause after the pause');
        });
    });
});
