import { describe, expect, it } from 'vitest';
import { DictationCapture, utteranceRestarted, type DictationEngine } from './dictationCapture';
import { dictationComposerEvents } from './dictationComposer';

/**
 * A pause inside ONE recognition task never costs a sentence (DROVE-263).
 *
 * THE DIFFERENCE FROM dictationContinuity.spec.ts, and it is the whole reason
 * this file exists. That one pins the TASK boundary: Apple finalises an
 * utterance, `onDictationEnded` arrives with reason `final`, and the capture
 * banks it and reopens the microphone. Every test in it drives that signal by
 * hand, they all pass, and Clay's phone still wrote his second sentence over
 * his first three times running.
 *
 * Because that signal never comes. The request sets
 * `requiresOnDeviceRecognition = true`, and the on-device recogniser does not
 * finalise on a pause. It keeps ONE task running and opens a NEW RESULT
 * SEQUENCE, so the words after the pause arrive as a partial reporting the
 * second utterance ALONE, looking for all the world like the whole transcript.
 * No `final`, no task change, no ending: just a partial that is suddenly
 * shorter than the one before it. 070819ab handled the boundary Apple
 * announces and left the boundary Apple does not.
 *
 * So these tests never call `recogniserEnded`. They replay the partial stream
 * as the on-device recogniser actually produces it, and the assertion is the
 * invariant Clay stated: no incoming partial may shorten what he has already
 * said.
 *
 * WHAT THIS CANNOT PROVE. It replays synthetic partials, and synthetic
 * partials are exactly what let the last fix ship broken. It is the floor, not
 * the verification: the ticket wants real speech on a real device across three
 * or more pauses, and that needs a TestFlight build.
 */

class FakeRecogniser implements DictationEngine {
    starts = 0;
    private stopResolvers: ((text: string) => void)[] = [];

    start(): Promise<unknown> {
        this.starts += 1;
        return Promise.resolve(true);
    }

    stop(): Promise<string> {
        return new Promise<string>((resolve) => { this.stopResolvers.push(resolve); });
    }

    cancel(): void { /* nothing to throw away in these tests */ }

    settle(text: string): void {
        this.stopResolvers.shift()?.(text);
    }
}

async function flush(): Promise<void> {
    for (let i = 0; i < 8; i++) await Promise.resolve();
}

function harness(base = '') {
    const engine = new FakeRecogniser();
    let composer = base;
    let draft = base;
    const capture = new DictationCapture(engine, dictationComposerEvents({
        base: () => draft,
        setComposerText: (text) => { composer = text; },
        send: () => { /* not under test here */ },
        onError: () => { /* not under test here */ },
        onChange: () => { /* the indicator, not the text */ },
    }), () => 1_000);
    return {
        engine,
        capture,
        get composer() { return composer; },
        hold() { draft = composer; capture.begin('hold'); },
    };
}

/** The first utterance, long enough to be a sentence he would mind losing. */
const first = 'so the thing I wanted to say';

describe('a pause that Apple never announces', () => {
    /**
     * HIS OWN REPRO. Hold, speak, stop for a beat, speak again. The second
     * utterance arrives from empty inside the same task, and before this fix
     * it replaced the first outright.
     */
    it('keeps the first utterance when the next one arrives from empty', async () => {
        const h = harness();
        h.hold();
        await flush();

        h.capture.partial('so the thing');
        h.capture.partial(first);
        expect(h.composer).toBe(first);

        // The pause. No ending, no task change: the recogniser simply starts
        // reporting the next sentence from scratch.
        h.capture.partial('and then');
        expect(h.composer).toBe(`${first} and then`);

        h.capture.partial('and then I thought about it');
        expect(h.composer).toBe(`${first} and then I thought about it`);
    });

    it('holds every utterance across three pauses in a row', async () => {
        const h = harness();
        h.hold();
        await flush();

        h.capture.partial(first);
        h.capture.partial('and then');
        h.capture.partial('and then I thought about it');
        h.capture.partial('but also');
        h.capture.partial('but also we should go home');
        h.capture.partial('finally');
        h.capture.partial('finally that is all of it');

        expect(h.composer).toBe(
            `${first} and then I thought about it but also we should go home finally that is all of it`,
        );
    });

    /**
     * The stop after a pause resolves with the LIVE utterance only, because
     * that is all an un-banking module has. The banked sentences are the
     * capture's own and are joined back on where nothing can judge them away.
     */
    it('a stop after the pause commits both utterances, not the last one', async () => {
        const h = harness();
        h.hold();
        await flush();

        h.capture.partial(first);
        h.capture.partial('and then');
        h.capture.partial('and then I thought about it');

        h.capture.stop();
        h.engine.settle('and then I thought about it');
        await flush();

        expect(h.composer).toBe(`${first} and then I thought about it`);
    });

    /** Partials re-join onto whatever the composer already held. */
    it('appends to a draft that was already in the composer', async () => {
        const h = harness('draft');
        h.hold();
        await flush();

        h.capture.partial(first);
        h.capture.partial('and then');

        expect(h.composer).toBe(`draft ${first} and then`);
    });
});

describe('what must NOT be banked', () => {
    /**
     * The revision this whole mechanism has to survive. A recogniser rewriting
     * its own guess is not a new sentence, and banking it would say it twice.
     */
    it('a recogniser revising its own guess still revises it', async () => {
        const h = harness();
        h.hold();
        await flush();

        h.capture.partial('I need to fifty too');
        h.capture.partial('I need 22');

        expect(h.composer).toBe('I need 22');
    });

    /**
     * A module that banks utterances ITSELF sends a transcript that only ever
     * grows, and JS must add nothing to it. That double count is what the
     * first attempt at DROVE-140 shipped, and it is why the guard is written
     * so that it cannot fire on a growing stream.
     */
    it('adds nothing on a module that banks internally', async () => {
        const h = harness();
        h.hold();
        await flush();

        h.capture.partial(first);
        h.capture.partial(`${first} and then`);
        h.capture.partial(`${first} and then I thought about it`);

        expect(h.composer).toBe(`${first} and then I thought about it`);
    });
});

describe('utteranceRestarted', () => {
    it('is deaf to anything that contains what came before', () => {
        expect(utteranceRestarted(first, `${first} and then`)).toBe(false);
        expect(utteranceRestarted(`${first} and then`, first)).toBe(false);
    });

    it('is deaf while the live utterance is still short', () => {
        // An early revision replaces nearly all of a short utterance, and
        // banking it would duplicate it.
        expect(utteranceRestarted('um hello', 'hello')).toBe(false);
    });

    it('is deaf to a revision nearly as long as what it revises', () => {
        expect(utteranceRestarted(first, 'so the thing I wanted to hear')).toBe(false);
    });

    it('fires when a sentence is replaced by the opening of another', () => {
        expect(utteranceRestarted(first, 'and then')).toBe(true);
    });

    it('never fires on an empty side', () => {
        expect(utteranceRestarted('', 'and then')).toBe(false);
        expect(utteranceRestarted(first, '')).toBe(false);
    });
});
