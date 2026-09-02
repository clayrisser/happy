import { describe, expect, it } from 'vitest';
import { DictationCapture, type DictationEngine } from './dictationCapture';
import { dictationComposerEvents } from './dictationComposer';

/**
 * Dictation puts the sentence in the composer ONCE (DROVE-360).
 *
 * Clay dictated "Hello this is a recorded message and I'm gonna stop talking
 * right now" and the composer ended up holding it twice, back to back: "when I
 * stopped talking it basically copied the line again. It's very annoying, and
 * sometimes I'll stop talking and then try to edit a word and it jumps like
 * that and messes up the word I'm trying to edit."
 *
 * Two symptoms, two layers, and this file pins the half that lives in JS.
 *
 * THE DUPLICATE ITSELF IS NATIVE and is not reachable from here. It is
 * `startsNewUtterance` in DroverSpeechModule.swift reading `segmentClockSeen`
 * as though it answered "was the clock running when the baseline was taken?".
 * The on-device recogniser reports a dead segment clock on its partials and
 * winds a real one only on the FINAL result, so the final was the first result
 * to satisfy `start > 0`, flipped the flag on its way in, compared its honest
 * offset against a baseline of zero, and banked itself as a new utterance.
 * That is fixed there, and it rides the next build.
 *
 * NOT RE-IMPLEMENTED HERE ON PURPOSE. DROVE-140 shipped broken precisely
 * because a spec wrote down the JS side's belief about what native sends and
 * so agreed with itself while the two halves disagreed on the device. What
 * this file pins is what JS actually owns: whatever the recogniser hands over,
 * the composer's dictated span is REPLACED and never appended to, and a
 * transcript that settles after the user has started editing does not get the
 * field back.
 */

const sentence = "Hello this is a recorded message and I'm gonna stop talking right now";

/** A stop whose final lands when the test says so, not when the mic closes. */
class DeferredRecogniser implements DictationEngine {
    private settle: ((text: string) => void) | null = null;
    starts = 0;
    cancels = 0;

    start(): Promise<unknown> {
        this.starts += 1;
        return Promise.resolve(true);
    }

    stop(): Promise<string> {
        return new Promise<string>((resolve) => { this.settle = resolve; });
    }

    cancel(): void {
        this.cancels += 1;
    }

    /** The final Apple was still settling when the microphone closed. */
    async deliverFinal(text: string): Promise<void> {
        const settle = this.settle;
        this.settle = null;
        settle?.(text);
        await flush();
    }
}

/** Let the capture's promise chains run. */
async function flush(): Promise<void> {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

/** The mic and the composer, wired exactly as useVoiceComposer wires them. */
function harness(base = '') {
    const engine = new DeferredRecogniser();
    let composer = base;
    let draft = base;
    const writes: string[] = [];
    const capture = new DictationCapture(engine, dictationComposerEvents({
        base: () => draft,
        current: () => composer,
        setComposerText: (text) => { composer = text; writes.push(text); },
        send: () => { /* not under test here */ },
        onError: () => { /* not under test here */ },
        onChange: () => { /* the indicator, not the text */ },
    }), () => 1_000);
    return {
        engine,
        capture,
        writes,
        get composer() { return composer; },
        /** Open the mic, taking the base snapshot the screen takes. */
        hold() { draft = composer; capture.begin('hold'); },
        /**
         * Him editing a word in the composer. It is NOT a keystroke event
         * reaching the capture: he tapped stop first, so the mic is already
         * closed and nothing is listening for one. The field simply no longer
         * reads back as what dictation left there, which is the only evidence
         * there is.
         */
        edit(text: string) { composer = text; },
    };
}

describe('dictation writes the sentence once (DROVE-360)', () => {
    it('leaves one copy after partial, partial, final', async () => {
        const h = harness();
        h.hold();
        await flush();
        h.capture.partial('Hello this is a recorded');
        h.capture.partial(sentence);
        h.capture.recogniserEnded(sentence, 'final');
        await flush();

        expect(h.composer).toBe(sentence);
        // The words banked, the microphone reopened, and the capture is still
        // his to carry on talking into.
        expect(h.capture.current.active).toBe(true);
    });

    it('leaves one copy when the final settles 300ms after the stop', async () => {
        const h = harness();
        h.hold();
        await flush();
        h.capture.partial(sentence);
        expect(h.composer).toBe(sentence);

        h.capture.stop();
        await flush();
        // Apple's final for the utterance, landing after the microphone closed.
        await h.engine.deliverFinal(sentence);

        expect(h.composer).toBe(sentence);
    });

    it('leaves the edit alone when a late final lands on a word he is fixing', async () => {
        const h = harness();
        h.hold();
        await flush();
        h.capture.partial(sentence);

        h.capture.stop();
        await flush();
        // He is already fixing "gonna" while the final is still in flight.
        const fixed = sentence.replace("I'm gonna", 'I am going to');
        h.edit(fixed);
        const writesBefore = h.writes.length;

        await h.engine.deliverFinal(sentence);

        expect(h.composer).toBe(fixed);
        // And it did not merely land on the same string: nothing was written
        // at all, so there was no caret to move.
        expect(h.writes.length).toBe(writesBefore);
    });

    it('does not append the final onto the partial it finalises', async () => {
        const h = harness('draft ');
        h.hold();
        await flush();
        h.capture.partial('twenty two');
        h.capture.stop();
        await flush();
        // The final revising its own guess, which is the case that must keep
        // working: it REPLACES the partial rather than joining onto it.
        await h.engine.deliverFinal('22');

        expect(h.composer).toBe('draft 22');
    });

    it('still keeps both utterances across a pause (DROVE-263 stands)', async () => {
        const h = harness();
        h.hold();
        await flush();
        h.capture.partial('the first thing I said');
        // Apple finalising on silence banks it and reopens the microphone.
        h.capture.recogniserEnded('the first thing I said', 'final');
        await flush();
        h.capture.partial('and the second');
        h.capture.stop();
        await flush();
        await h.engine.deliverFinal('and the second');

        expect(h.composer).toBe('the first thing I said and the second');
    });
});
