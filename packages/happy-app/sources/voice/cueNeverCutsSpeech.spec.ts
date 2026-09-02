import { beforeEach, describe, expect, it } from 'vitest';
import { AudioCueMixer, cueStaleMs } from './audioCueMixer';
import { ReadAloudReader, type SpeakOptions } from './readAloud';
import { audioCuesDefaults, type AudioCues } from '@/sync/settings';
import type { Message } from '@/sync/typesMessage';

/**
 * A CUE NEVER STOPS, PAUSES, DUCKS OR DELAYS SPEECH (DROVE-174).
 *
 * Clay: "Damn don't let the sound effects stop talking". DROVE-112's own rule
 * was "nothing plays over speech" and it did not hold on the phone, for two
 * reasons that hid each other.
 *
 * The one that is not testable from here is in cuePlayer.ts: expo-audio built
 * every cue player with `keepAudioSessionActive` false, which wires
 * `onPlaybackComplete` to `deactivateSession`, which 100ms after a cue ends
 * calls `AVAudioSession.setActive(false)` if no EXPO-AUDIO player is playing.
 * It never asks whether the synthesiser is speaking. So every cue armed a
 * teardown of the session under whatever utterance started next. That is fixed
 * by one option and is asserted by reading the source rather than by running
 * it, because there is no AVAudioSession under vitest.
 *
 * The one this file DOES test is the timing rule. DROVE-112 asked "is speech
 * running?" at the instant a cue started, which says nothing about the ten
 * milliseconds later when the reader begins the next sentence. So this drives
 * the REAL reader with real material in flight and a real mixer beside it,
 * and asserts the thing Clay actually cares about: the utterances that go to
 * the synthesiser, in order, with nothing cut and nothing delayed.
 */

describe('a cue never cuts, pauses or delays speech', () => {
    let now = 0;
    let played: string[] = [];
    let spoken: string[] = [];
    let config: Required<AudioCues>;
    let reader: ReadAloudReader;
    let mixer: AudioCueMixer;
    /** Resolvers for the utterances still in flight, so a test can end them. */
    let inFlight: (() => void)[] = [];

    function message(id: string, text: string, createdAt: number): Message {
        return { id, localId: null, createdAt, kind: 'agent-text', text } as unknown as Message;
    }

    beforeEach(() => {
        now = 1_000_000;
        played = [];
        spoken = [];
        inFlight = [];
        config = { ...audioCuesDefaults };
        reader = new ReadAloudReader(
            {
                speak(text: string, _options?: SpeakOptions) {
                    spoken.push(text);
                    return new Promise<void>((resolve) => { inFlight.push(() => resolve()); });
                },
                stop() { },
            },
            { now: () => now },
        );
        reader.setEnabled(true);
        reader.focus('s1');
        reader.setSessionEnabled('s1', true);
        mixer = new AudioCueMixer({
            now: () => now,
            play: (id) => { played.push(id); },
            settings: () => config,
            speechPending: () => reader.speechPending,
        });
        mixer.setState({ reading: true, working: true, pendingKinds: [], agents: 0 });
    });

    /** End the utterance at the synthesiser, as the engine's promise would. */
    async function finishSentence(): Promise<void> {
        const done = inFlight.shift();
        done?.();
        // speakNow chains through catch and then, so the next sentence is a
        // few microtasks away rather than one.
        for (let i = 0; i < 6; i++) await Promise.resolve();
    }

    function tick(ms: number): void {
        for (let elapsed = 0; elapsed < ms; elapsed += 50) {
            now += 50;
            mixer.tick();
        }
    }

    it('holds a cue while a sentence is in flight and plays it in the gap', async () => {
        reader.onMessages('s1', [message('m1', 'One. Two.', now)]);
        await Promise.resolve();
        expect(spoken).toEqual(['One.']);

        // Speech has the route. The cue waits; it does not duck, pause or cut.
        mixer.setSpeaking(true);
        mixer.event('toolCall');
        tick(500);
        expect(played).toEqual([]);
        expect(spoken).toEqual(['One.']);

        // The sentence ends and the NEXT one starts at once. The cue is still
        // refused, because a gap with a sentence queued behind it is not a
        // gap — this is the case DROVE-112 got wrong.
        await finishSentence();
        mixer.setSpeaking(true);
        expect(spoken).toEqual(['One.', 'Two.']);
        tick(200);
        expect(played).toEqual([]);

        // Now the reply is finished and there is nothing queued. The cue plays.
        // The heartbeat is filtered out: it is ambient, it keeps its own
        // cadence, and this test is about the earcon (DROVE-197).
        await finishSentence();
        mixer.setSpeaking(false);
        tick(100);
        expect(played.filter((id) => id === 'toolCall')).toEqual(['toolCall']);
        // And the voice said everything it had, in order, uncut.
        expect(spoken).toEqual(['One.', 'Two.']);
    });

    it('drops the cue rather than the speech when no gap ever opens', async () => {
        reader.onMessages('s1', [message('m1', 'One. Two. Three. Four.', now)]);
        await Promise.resolve();
        mixer.setSpeaking(true);
        mixer.event('toolCall');

        // Four seconds of continuous speech: the cue has stopped being true.
        tick(cueStaleMs + 500);
        expect(played).toEqual([]);
        expect(mixer.dropped).toBe(1);
        expect(mixer.pending).toBe(0);

        // The voice is untouched by any of it.
        mixer.setSpeaking(false);
        await finishSentence();
        await finishSentence();
        await finishSentence();
        await finishSentence();
        expect(spoken).toEqual(['One.', 'Two.', 'Three.', 'Four.']);
    });

    it('never delays a sentence for a cue that is already sounding', async () => {
        // A cue in the air does not make the reader wait: it has no way to
        // ask, by design. This pins that the two are independent, which is
        // what "a cue never delays speech" means in code.
        mixer.event('reply');
        tick(50);
        expect(played).toEqual(['reply']);

        reader.onMessages('s1', [message('m1', 'Answer.', now)]);
        await Promise.resolve();
        expect(spoken).toEqual(['Answer.']);
    });

    it('says nothing at all with read-aloud off', () => {
        config = { ...config, on: false };
        mixer.event('toolCall');
        mixer.event('reply');
        tick(2_000);
        expect(played).toEqual([]);
    });
});
