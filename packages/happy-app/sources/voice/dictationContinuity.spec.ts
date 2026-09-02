import { describe, expect, it } from 'vitest';
import {
    DictationCapture,
    MAX_SILENT_SEGMENTS,
    RECOGNISER_FINAL,
    type DictationEngine,
} from './dictationCapture';
import { dictationComposerEvents } from './dictationComposer';
import { DICTATION_LATCH_IDLE_MS } from './micMode';

/**
 * A capture keeps everything said across a pause (DROVE-140).
 *
 * Clay, three times now, the last in his own words: "if I stop talking while
 * I'm holding down the mic and then talk again it clears what I said."
 *
 * WHAT ACTUALLY HAPPENS ON HIS PHONE. Apple's recogniser ends an UTTERANCE
 * after about a second and a half of silence. That is a judgement about a
 * gap, not about whether he has finished, and the native module answered it by
 * tearing the whole capture down: `onDictationEnded` with reason `final`, the
 * microphone dead under his thumb, the button back to grey. Everything he said
 * next reached nothing at all, and the half-sentence left in the composer is
 * what he sees. A capture must outlive the recogniser that serves it.
 *
 * THE TWO THINGS THAT MADE THE LAST ATTEMPT MISS. First, its fix was Swift, so
 * it needed a TestFlight build and never reached the phone; the JS half shipped
 * alone and does nothing on a build that ends the capture. Second, the two
 * halves disagreed about what a partial CONTAINS: native sent the whole
 * capture, `partial()` read it as the latest task and prepended everything it
 * already had, so one pause said his sentence twice. The unit tests wrote down
 * the JS side of that disagreement and passed.
 *
 * SO THE RULE IS ONE RULE, AND IT IS ABOUT GROWTH, NOT ABOUT TASKS. A capture
 * is banked segments plus one live segment. Banked is append-only. The live
 * segment is whatever the recogniser last reported, and only it may be
 * revised, which is what keeps "to fifty too" turning into "22". A segment
 * closes on a signal from the recogniser, never on a comparison of strings,
 * because "yes" after "no" is a revision one way and a new sentence the other
 * and the words cannot tell you which.
 */

/**
 * The native module, driven by hand.
 *
 * `start`/`stop`/`cancel` are counted so a test can see the microphone
 * actually being reopened rather than take the transcript's word for it.
 */
class FakeRecogniser implements DictationEngine {
    starts = 0;
    stops = 0;
    cancels = 0;
    startFails: string | null = null;
    private stopResolvers: ((text: string) => void)[] = [];

    start(): Promise<unknown> {
        this.starts += 1;
        if (this.startFails) return Promise.reject(new Error(this.startFails));
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
    const errors: string[] = [];
    const capture = new DictationCapture(engine, dictationComposerEvents({
        base: () => draft,
        current: () => composer,
        setComposerText: (text) => { composer = text; },
        send: () => { sends += 1; },
        onError: (message) => { errors.push(message); },
        onChange: () => { /* the indicator, not the text */ },
    }), () => clock);
    return {
        engine,
        capture,
        errors,
        get composer() { return composer; },
        get sends() { return sends; },
        /** Finger down on the button. The mic opens on the press. */
        hold() { draft = composer; capture.begin('hold'); },
        /** The tap that opens a latched mic, as the gesture reducer drives it. */
        tapOpen() { draft = composer; capture.begin('hold'); capture.latch(); },
        /**
         * A silence long enough for Apple to end its utterance. The module
         * reports the whole of what that utterance heard and stops; the
         * capture is expected to bank it and open the microphone again.
         */
        async silence(heardSoFar: string) {
            capture.recogniserEnded(heardSoFar, RECOGNISER_FINAL);
            await flush();
        },
        advance(ms: number) { clock += ms; },
        tick() { capture.tick(clock); },
    };
}

describe('a hold that contains a silence', () => {
    /**
     * HIS OWN SEQUENCE, end to end. Hold, speak, stop talking long enough for
     * the recogniser to finalise, keep talking, lift. One transcript, in
     * order, and the lift sends all of it.
     */
    it('keeps everything said before and after the silence, and the lift sends it', async () => {
        const h = harness();
        h.hold();
        await flush();

        h.capture.partial('so the thing');
        h.capture.partial('so the thing I wanted');
        h.capture.partial('so the thing I wanted to say');
        expect(h.composer).toBe('so the thing I wanted to say');

        // He stops for a breath. Apple ends the utterance.
        h.advance(4_000);
        await h.silence('so the thing I wanted to say');

        // The microphone is still open, and the button with it.
        expect(h.capture.current.active).toBe(true);
        expect(h.engine.starts).toBe(2);
        // Nothing was taken away while he was quiet.
        expect(h.composer).toBe('so the thing I wanted to say');

        // He carries on. The new segment reports from empty, which is exactly
        // why it must be added to what came before rather than written over it.
        h.capture.partial('is that');
        h.capture.partial('is that we should ship it');
        expect(h.composer).toBe('so the thing I wanted to say is that we should ship it');

        h.capture.send();
        await flush();
        h.engine.settle('is that we should ship it');
        await flush();

        expect(h.composer).toBe('so the thing I wanted to say is that we should ship it');
        expect(h.sends).toBe(1);
    });

    it('survives several silences in one hold, so the fix is not a special case of one', async () => {
        const h = harness();
        h.hold();
        await flush();

        h.capture.partial('first');
        await h.silence('first');
        h.capture.partial('second');
        await h.silence('second');
        h.capture.partial('third');
        await h.silence('third');
        h.capture.partial('fourth');

        expect(h.composer).toBe('first second third fourth');
        expect(h.capture.current.active).toBe(true);
        // Four utterances, four microphones: one on the press and one per
        // silence.
        expect(h.engine.starts).toBe(4);
    });

    /**
     * The transcript is MONOTONIC across silences, checked step by step rather
     * than only at the end. This is the assertion that would have failed on
     * the shipped code in both of its directions: it shrank on a build that
     * ended the capture, and it duplicated on one that did not.
     */
    it('only ever grows: no step of a five-pause hold is shorter than the one before it', async () => {
        const h = harness();
        h.hold();
        await flush();
        const seen: string[] = [];
        const said = ['one', 'two', 'three', 'four', 'five', 'six'];
        for (let i = 0; i < said.length; i++) {
            h.capture.partial(said[i]);
            seen.push(h.composer);
            if (i < said.length - 1) {
                h.advance(3_000);
                await h.silence(said[i]);
                seen.push(h.composer);
            }
        }
        for (let i = 1; i < seen.length; i++) {
            expect(seen[i].startsWith(seen[i - 1])).toBe(true);
        }
        expect(h.composer).toBe('one two three four five six');
    });

    /**
     * A pause of any length. The silence itself never costs a word: what ends
     * a capture is a run of segments that hear NOTHING, and any word he says
     * resets that run, so the pauses can be as long and as many as he likes.
     */
    it('a pause immediately before the lift still sends everything', async () => {
        const h = harness();
        h.hold();
        await flush();
        h.capture.partial('ship it on monday');
        h.advance(6_000);
        await h.silence('ship it on monday');
        expect(h.capture.current.active).toBe(true);

        // The lift lands with the fresh segment still empty. Native has
        // nothing to add and resolves with "".
        h.capture.send();
        await flush();
        h.engine.settle('');
        await flush();

        expect(h.composer).toBe('ship it on monday');
        expect(h.sends).toBe(1);
    });

    it('a run of silent segments finally ends the capture, with every word kept and unsent', async () => {
        const h = harness();
        h.hold();
        await flush();
        h.capture.partial('this is all I had to say');
        await h.silence('this is all I had to say');
        // He has gone quiet for good. Each fresh utterance hears nothing.
        for (let i = 0; i < MAX_SILENT_SEGMENTS; i++) {
            expect(h.capture.current.active).toBe(true);
            await h.silence('');
        }
        await h.silence('');
        expect(h.capture.current.active).toBe(false);
        expect(h.composer).toBe('this is all I had to say');
        expect(h.sends).toBe(0);
    });

    it('a word resets the run, so a long hold of speech and pauses never gives up', async () => {
        const h = harness();
        h.hold();
        await flush();
        for (let round = 0; round < 4; round++) {
            // Two empty utterances, then one that hears something.
            await h.silence('');
            await h.silence('');
            h.capture.partial(`round ${round}`);
            await h.silence(`round ${round}`);
            expect(h.capture.current.active).toBe(true);
        }
        expect(h.composer).toBe('round 0 round 1 round 2 round 3');
    });
});

describe('what a segment boundary is, and what it is not', () => {
    /**
     * The half a string comparison always gets wrong: inside one segment the
     * recogniser is rewriting its own guess, and the new text wins however
     * little it resembles what it replaces.
     */
    it('a revision inside one segment still replaces, however different the words', async () => {
        const h = harness();
        h.hold();
        await flush();
        h.capture.partial('to fifty too');
        h.capture.partial('22');
        expect(h.composer).toBe('22');
        h.capture.partial('twenty two');
        expect(h.composer).toBe('twenty two');
    });

    it('a revision after a silence revises only the new segment, never the banked words', async () => {
        const h = harness();
        h.hold();
        await flush();
        h.capture.partial('the first sentence');
        await h.silence('the first sentence');
        h.capture.partial('and then');
        h.capture.partial('and then the second');
        h.capture.partial('then the second one');
        expect(h.composer).toBe('the first sentence then the second one');
    });

    /**
     * THE SEAM THAT BROKE. The native module reports everything heard since
     * the microphone opened, folding in any task it restarted itself, and it
     * stamps the task id on the side. A listener that banked on the id as well
     * would count the same words twice. This drives the module's real contract
     * and asserts the sentence is said once.
     */
    it('a partial carries the whole of what the open microphone heard, and is not added to itself', async () => {
        const h = harness();
        h.hold();
        await flush();
        // Task 1 inside one native capture.
        h.capture.partial('so the thing I wanted to say');
        // Native finalised task 1 and opened task 2 WITHOUT ending the
        // capture, so its payload already carries both.
        h.capture.partial('so the thing I wanted to say is that');
        h.capture.partial('so the thing I wanted to say is that we ship it');
        expect(h.composer).toBe('so the thing I wanted to say is that we ship it');
    });

    it('joins onto whatever was already typed, and does not disturb it', async () => {
        const h = harness('a draft already there');
        h.hold();
        await flush();
        h.capture.partial('spoken words');
        await h.silence('spoken words');
        h.capture.partial('more after the pause');
        expect(h.composer).toBe('a draft already there spoken words more after the pause');
    });

    /**
     * The final of the segment being closed may revise that segment. It may
     * not reach the ones before it: they are not in it and were never put to
     * it.
     */
    it('the final of a closing segment revises that segment and leaves the banked ones alone', async () => {
        const h = harness();
        h.hold();
        await flush();
        h.capture.partial('the first sentence');
        await h.silence('the first sentence');
        h.capture.partial('twenty two');
        await h.silence('22');
        expect(h.composer).toBe('the first sentence 22');
    });

    it('an error is not a pause: the capture ends and keeps the words', async () => {
        const h = harness();
        h.hold();
        await flush();
        h.capture.partial('what I had said');
        h.capture.recogniserEnded('what I had said', 'No speech detected');
        await flush();
        expect(h.capture.current.active).toBe(false);
        expect(h.composer).toBe('what I had said');
        expect(h.sends).toBe(0);
    });

    it('a microphone that will not reopen ends the capture and keeps the words', async () => {
        const h = harness();
        h.hold();
        await flush();
        h.capture.partial('everything I said');
        h.engine.startFails = 'the speech recogniser refused to start a task';
        await h.silence('everything I said');
        expect(h.capture.current.active).toBe(false);
        expect(h.composer).toBe('everything I said');
        expect(h.errors).toEqual(['the speech recogniser refused to start a task']);
    });
});

describe('the deliberate gestures still mean what they meant', () => {
    it('a slide-off cancel after several silences discards the whole capture', async () => {
        const h = harness('what was typed');
        h.hold();
        await flush();
        h.capture.partial('first');
        await h.silence('first');
        h.capture.partial('second');
        await h.silence('second');
        h.capture.partial('third');
        expect(h.composer).toBe('what was typed first second third');

        h.capture.cancel();
        await flush();
        expect(h.composer).toBe('what was typed');
        expect(h.sends).toBe(0);
    });

    it('the tap off a latch after a silence keeps the words and sends nothing', async () => {
        const h = harness();
        h.tapOpen();
        await flush();
        h.capture.partial('before');
        await h.silence('before');
        h.capture.partial('after');

        h.capture.stop();
        await flush();
        h.engine.settle('after');
        await flush();
        expect(h.composer).toBe('before after');
        expect(h.sends).toBe(0);
    });

    it('a silence does not run a latch\'s idle clock down while he is still talking', async () => {
        const h = harness();
        h.tapOpen();
        await flush();
        h.capture.partial('before');
        h.advance(DICTATION_LATCH_IDLE_MS - 1_000);
        await h.silence('before');
        h.capture.partial('after');
        // The new segment's words are speech, so the deadline moved with them.
        h.advance(2_000);
        h.tick();
        expect(h.capture.current.active).toBe(true);
        expect(h.composer).toBe('before after');
    });

    /**
     * The lift can land in the gap, because the gap is exactly the moment he
     * has stopped talking. Nothing is lost, and no microphone is left running
     * behind the capture that just ended.
     */
    it('a lift while the microphone is between recognisers still sends everything', async () => {
        const h = harness();
        h.hold();
        await flush();
        h.capture.partial('everything I said');
        // The utterance ends and the lift arrives before the reopen settles.
        h.capture.recogniserEnded('everything I said', RECOGNISER_FINAL);
        h.capture.send();
        await flush();
        h.engine.settle('');
        await flush();

        expect(h.composer).toBe('everything I said');
        expect(h.sends).toBe(1);
        // The reopen saw the capture end and did not open a second one.
        expect(h.engine.starts).toBe(1);
    });

    it('a cancel while the microphone is between recognisers still discards the capture', async () => {
        const h = harness('what was typed');
        h.hold();
        await flush();
        h.capture.partial('spoken');
        h.capture.recogniserEnded('spoken', RECOGNISER_FINAL);
        h.capture.cancel();
        await flush();

        expect(h.composer).toBe('what was typed');
        expect(h.engine.starts).toBe(1);
    });

    it('a fresh capture over committed words adds to them rather than reopening the last one', async () => {
        const h = harness();
        h.hold();
        await flush();
        h.capture.partial('first capture');
        h.capture.recogniserEnded('first capture', 'No speech detected');
        await flush();
        expect(h.composer).toBe('first capture');

        h.hold();
        await flush();
        h.capture.partial('second capture');
        expect(h.composer).toBe('first capture second capture');
    });
});
