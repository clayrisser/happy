import { describe, expect, it } from 'vitest';
import type { Message } from '@/sync/typesMessage';
import { composerVoiceEvent, type ComposerVoiceEvent } from './composerVoice';
import { ReadAloudReader, type SpeakOptions, type SpeechEngine } from './readAloud';

/**
 * Typing must not stop the voice (DROVE-162).
 *
 * Clay: "And don't stop talking when I'm typing." Driven against the REAL
 * reader rather than a spy, because the failure was never in a decision, it
 * was in what `interrupt` does: it cuts the utterance, walks the position to
 * the end of the timeline and drops the pending tails. Only a real reader,
 * with real sentences queued behind it, can show that none of that happened.
 */

class FakeEngine implements SpeechEngine {
    spoken: string[] = [];
    stops = 0;
    private resolvers: (() => void)[] = [];

    speak(text: string, _options?: SpeakOptions): Promise<unknown> {
        this.spoken.push(text);
        return new Promise<void>((resolve) => { this.resolvers.push(resolve); });
    }

    stop(): void {
        this.stops += 1;
        const pending = this.resolvers;
        this.resolvers = [];
        for (const resolve of pending) resolve();
    }

    finishOne(): void {
        this.resolvers.shift()?.();
    }
}

async function settle(): Promise<void> {
    for (let i = 0; i < 8; i++) await Promise.resolve();
}

function agentText(id: string, text: string, createdAt = 1): Message {
    return { kind: 'agent-text', id, localId: null, createdAt, text } as Message;
}

/** Everything a composer does while a reply is being read, in order. */
const wholeSession: ComposerVoiceEvent[] = [
    'focus',
    'keyboard-shown',
    'keystroke',
    'keystroke',
    'keystroke',
    'keyboard-hidden',
    'keyboard-shown',
    'keystroke',
    'blur',
];

describe('the composer and the voice (DROVE-162)', () => {
    function reading(): { reader: ReadAloudReader; engine: FakeEngine } {
        const engine = new FakeEngine();
        const reader = new ReadAloudReader(engine);
        reader.setEnabled(true);
        reader.focus('s1');
        return { reader, engine };
    }

    it('keeps reading through focus, a whole sentence of keystrokes and the keyboard', async () => {
        const { reader, engine } = reading();
        reader.onMessages('s1', [agentText('m1', 'One. Two. Three. Four.')]);
        await settle();
        expect(engine.spoken).toEqual(['One.']);

        for (const event of wholeSession) composerVoiceEvent(reader, event);
        await settle();

        // Nothing was cut, nothing was dropped, and the reading is still
        // exactly where it was.
        expect(engine.stops).toBe(0);
        expect(engine.spoken).toEqual(['One.']);
        expect(reader.isSpeaking).toBe(true);
        expect(reader.playhead?.sentence).toBe('One.');

        // And it carries on into the rest of the reply of its own accord.
        engine.finishOne();
        await settle();
        expect(engine.spoken).toEqual(['One.', 'Two.']);
    });

    it('never goes quiet however fast the typing is', async () => {
        const { reader, engine } = reading();
        reader.onMessages('s1', [agentText('m1', 'One. Two. Three.')]);
        await settle();

        // A sentence typed at speed, with the reply advancing underneath it.
        for (let i = 0; i < 60; i++) {
            composerVoiceEvent(reader, 'keystroke');
            if (i === 19 || i === 39) {
                engine.finishOne();
                await settle();
            }
        }
        // Sixty keystrokes and the third sentence is still being said. The
        // only `stop` a reader ever makes on its own is the one that releases
        // the audio session when it has drained, and it has not drained.
        expect(engine.stops).toBe(0);
        expect(engine.spoken).toEqual(['One.', 'Two.', 'Three.']);
        expect(reader.isSpeaking).toBe(true);
    });

    it('tells every capture, on every keystroke, that it is over', () => {
        const { reader } = reading();
        const heard: string[] = [];
        reader.addInterruptListener((reason) => heard.push(reason));

        for (const event of wholeSession) composerVoiceEvent(reader, event);

        // Four keystrokes, four notifications, and nothing from focus, blur or
        // the keyboard: a live transcription is over the moment he types over
        // it (DROVE-30), and none of the rest says anything about the mic.
        expect(heard).toEqual(['typed', 'typed', 'typed', 'typed']);
    });

    /**
     * Dictation writes the composer through the same onChangeText as a
     * keystroke (DROVE-74). Read as typing it would tell the mic to stop
     * because of its own transcript.
     */
    it('ignores dictation writing the composer', () => {
        const { reader } = reading();
        const heard: string[] = [];
        reader.addInterruptListener((reason) => heard.push(reason));

        composerVoiceEvent(reader, 'dictation-write');
        composerVoiceEvent(reader, 'dictation-write');

        expect(heard).toEqual([]);
    });

    it('still keeps the DROVE-122 behaviour on send', async () => {
        const { reader, engine } = reading();
        reader.onMessages('s1', [agentText('m1', 'One. Two. Three.')]);
        await settle();

        composerVoiceEvent(reader, 'keystroke');
        reader.userSent();
        await settle();

        // The reply being asked for does not exist yet, so the old one is
        // still what there is to say.
        expect(engine.stops).toBe(0);
        engine.finishOne();
        await settle();
        expect(engine.spoken).toEqual(['One.', 'Two.']);
    });

    /**
     * The one thing that DOES still stop the voice, and must (DROVE-143). A
     * recogniser cannot share the audio route with a synthesiser; a keyboard
     * has never needed it.
     */
    it('still hands the audio session to the mic, and resumes where it was', async () => {
        const { reader, engine } = reading();
        reader.onMessages('s1', [agentText('m1', 'One. Two. Three.')]);
        await settle();
        expect(engine.spoken).toEqual(['One.']);

        composerVoiceEvent(reader, 'keystroke');
        reader.setMicHeld(true);
        await settle();
        expect(engine.stops).toBe(1);
        expect(reader.isSpeaking).toBe(false);

        // Typing while the mic is down changes nothing either way.
        composerVoiceEvent(reader, 'keystroke');
        await settle();
        expect(engine.spoken).toEqual(['One.']);

        reader.setMicHeld(false);
        await settle();
        // Straight on from the same place: nothing was thrown away and
        // nothing is said twice.
        expect(engine.spoken).toEqual(['One.', 'Two.']);
    });
});
