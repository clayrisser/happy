import { describe, expect, it } from 'vitest';
import type { Message } from '@/sync/typesMessage';
import {
    asidePitchScale,
    resolveAudioCues,
    resolveSpokenRate,
    resolveStreamTalk,
    streamTalkPitchRange,
    thinkingPitchScale,
    thinkingRateScale,
} from '@/sync/settings';
import { extractThinkingText, isEmptyThinking } from '@/utils/thinkingText';
import { ReadAloudReader, type SpeakOptions, type SpeechEngine } from './readAloud';

/**
 * What a thought SOUNDS like, at the synthesiser (DROVE-181).
 *
 * readAloudThinking.spec.ts proves the queue: order, spoken-once, the gate,
 * the jump, the ramp. It asserts `opts.thinking === true` and stops there,
 * which is a flag, not a voice. The ticket asks for the distinct treatment
 * itself — "thinking is audibly distinct from the reply; say how" — and that
 * claim lives one layer down, in the rate and pitch speechEngine.ts hands
 * `speakUtterance`. A flag nobody acted on would pass that spec and be silent
 * in the ear.
 *
 * So this drives the REAL reader, wired the way readAloudService wires it —
 * the real `thinkingFor`, the real setting, the real unwrapping — into a fake
 * synth that resolves the ABSOLUTE rate and pitch with the same expressions
 * speechEngine uses. What is asserted is the number DroverSpeechModule would
 * be handed, not a multiplier.
 *
 * The answer, written down: a thought is read LOWER (pitch x0.85) and a shade
 * SLOWER (rate x0.96) than the reply. That is the opposite direction from an
 * aside, which is higher (x1.18) and quicker (x1.22), and deliberately so —
 * an aside is one line and can afford to be bright, a thought is a paragraph
 * and sometimes a minute of them. Volume was the obvious axis and the native
 * module takes none per utterance, so pitch carries it.
 */

interface Utterance {
    text: string;
    /** The absolute rate speechEngine would hand the native module. */
    rate: number;
    /** The absolute pitch speechEngine would hand the native module. */
    pitch: number;
    thinking: boolean;
    aside: boolean;
}

/** The slider somewhere other than its default, so a pass follows HIS numbers. */
const sliderRate = 0.45;
const sliderPitch = 1.1;

/**
 * speechEngine.ts, minus the native call.
 *
 * Copied expression for expression from `speechEngine.speak` on purpose: this
 * is the thing under test, and a spec that recomputed it its own way would
 * pass while the shipped engine did something else.
 */
class VoiceEngine implements SpeechEngine {
    spoken: Utterance[] = [];

    speak(text: string, options?: SpeakOptions): Promise<unknown> {
        const talk = resolveStreamTalk({ streamTalk: { rate: sliderRate, pitch: sliderPitch } });
        const aside = options?.aside === true;
        const thinking = !aside && options?.thinking === true;
        this.spoken.push({
            text,
            aside,
            thinking,
            rate: resolveSpokenRate(
                talk.rate,
                (options?.rateScale ?? 1) * (thinking ? thinkingRateScale : 1),
                aside,
            ),
            pitch: aside
                ? Math.min(streamTalkPitchRange.max, talk.pitch * asidePitchScale)
                : thinking
                    ? Math.max(streamTalkPitchRange.min, talk.pitch * thinkingPitchScale)
                    : talk.pitch,
        });
        return Promise.resolve();
    }

    stop(): void { }
}

function thought(id: string, text: string, createdAt: number): Message {
    // Wrapped in the italics markers the reducer actually stores, so the real
    // `extractThinkingText` has something to unwrap.
    return {
        id,
        localId: null,
        createdAt,
        kind: 'agent-text',
        isThinking: true,
        text: `*${text}*`,
    } as unknown as Message;
}

function prose(id: string, text: string, createdAt: number): Message {
    return { id, localId: null, createdAt, kind: 'agent-text', text } as unknown as Message;
}

/**
 * readAloudService's `thinkingFor`, verbatim, over a settings object carrying
 * only the switch — the shape a synced partial arrives in. The setting is read
 * through `resolveAudioCues` rather than a boolean literal so that a default
 * flipped in settings.ts is caught here.
 */
function thinkingForWith(speakThinking?: boolean) {
    return (message: Message): string | null => {
        // `{}` for audioCues is the untouched object: every field inside it is
        // optional, so this is "he never opened the settings" rather than a
        // switch set to a default written out here a second time.
        const cues = resolveAudioCues({
            audioCues: speakThinking === undefined ? {} : { speakThinking },
        });
        if (!cues.speakThinking) return null;
        if (message.kind !== 'agent-text') return null;
        if (typeof message.text !== 'string') return null;
        if (isEmptyThinking(message.text)) return null;
        return extractThinkingText(message.text);
    };
}

function realReader(engine: SpeechEngine, speakThinking?: boolean): ReadAloudReader {
    const talk = resolveStreamTalk({ streamTalk: { rate: sliderRate, pitch: sliderPitch } });
    const reader = new ReadAloudReader(engine, {
        now: () => 1_000_000,
        maxBacklogSeconds: () => talk.maxBacklogSeconds,
        jumpBacklogSeconds: () => talk.jumpBacklogSeconds,
        maxRateScale: () => (talk.rate > 0 ? talk.catchUpRate / talk.rate : 1),
        turnStillRunning: () => false,
        skipMarker: '',
        // A tool call's title, so the aside's direction can be compared in the
        // same run rather than asserted from the constants alone.
        asideFor: (message) =>
            message.kind === 'tool-call' ? (message.tool.description ?? null) : null,
        thinkingFor: thinkingForWith(speakThinking),
    });
    reader.setEnabled(true);
    reader.focus('s1');
    reader.setSessionEnabled('s1', true);
    return reader;
}

async function settle(): Promise<void> {
    for (let i = 0; i < 40; i++) await Promise.resolve();
}

/** The reply's own numbers, with nothing scaled: the baseline to differ from. */
const replyRate = resolveSpokenRate(sliderRate, 1, false);
const replyPitch = resolveStreamTalk({ streamTalk: { rate: sliderRate, pitch: sliderPitch } }).pitch;

describe('a thought does not sound like the answer (DROVE-181)', () => {
    it('reads the thought lower and slower than the reply it precedes', async () => {
        const engine = new VoiceEngine();
        const reader = realReader(engine);
        reader.onMessages('s1', [
            thought('t1', 'Let me check the file.', 1_000_000),
            prose('m1', 'The file is empty.', 1_000_001),
        ]);
        await settle();

        expect(engine.spoken.map((u) => u.text)).toEqual([
            'Let me check the file.',
            'The file is empty.',
        ]);
        const [said, reply] = engine.spoken;

        // The reply is the slider, untouched. Thinking must not drag it down.
        expect(reply.rate).toBe(replyRate);
        expect(reply.pitch).toBe(replyPitch);

        // The thought is the distinction, in both axes and in one direction.
        expect(said.pitch).toBeLessThan(reply.pitch);
        expect(said.rate).toBeLessThan(reply.rate);
        expect(said.pitch).toBeCloseTo(sliderPitch * thinkingPitchScale, 10);
        expect(said.rate).toBeCloseTo(resolveSpokenRate(sliderRate, thinkingRateScale, false), 10);
    });

    it('goes the OPPOSITE way from an aside, so a thought never sounds like a title', async () => {
        // The whole point of picking lower-and-slower. If both landed on the
        // same side of the reply, the two treatments would collide by ear and
        // a paragraph of reasoning would arrive sounding like a tool call.
        const engine = new VoiceEngine();
        const reader = realReader(engine);
        reader.onMessages('s1', [
            thought('t1', 'Reading it now.', 1_000_000),
            {
                kind: 'tool-call',
                id: 'c1',
                localId: null,
                createdAt: 1_000_001,
                children: [],
                tool: {
                    name: 'Bash',
                    state: 'running',
                    input: {},
                    createdAt: 1_000_001,
                    startedAt: null,
                    completedAt: null,
                    description: 'Listing the directory',
                },
            } as unknown as Message,
            prose('m1', 'It is empty.', 1_000_002),
        ]);
        await settle();

        const thinkingSaid = engine.spoken.find((u) => u.thinking);
        const asideSaid = engine.spoken.find((u) => u.aside);
        const replySaid = engine.spoken.find((u) => !u.thinking && !u.aside);
        expect(thinkingSaid).toBeDefined();
        expect(asideSaid).toBeDefined();
        expect(replySaid).toBeDefined();

        // Aside above the reply, thought below it, on both axes.
        expect(asideSaid!.pitch).toBeGreaterThan(replySaid!.pitch);
        expect(thinkingSaid!.pitch).toBeLessThan(replySaid!.pitch);
        expect(asideSaid!.rate).toBeGreaterThan(replySaid!.rate);
        expect(thinkingSaid!.rate).toBeLessThan(replySaid!.rate);
    });

    it('keeps the thought inside the engine pitch range at the bottom of the slider', async () => {
        // The floor is a real clamp, not decoration: 0.5 x 0.85 would sit
        // under the range the native module accepts.
        const floored = Math.max(streamTalkPitchRange.min, streamTalkPitchRange.min * thinkingPitchScale);
        expect(floored).toBe(streamTalkPitchRange.min);
        expect(floored).toBeGreaterThanOrEqual(streamTalkPitchRange.min);
    });

    it('lets the aside win if an utterance were somehow both', async () => {
        // Not reachable through the reader — the two enqueue paths are
        // exclusive — but the engine has to pick one, and a title is the
        // shorter claim, so it wins.
        const engine = new VoiceEngine();
        await engine.speak('Both', { aside: true, thinking: true });
        expect(engine.spoken[0].aside).toBe(true);
        expect(engine.spoken[0].thinking).toBe(false);
        expect(engine.spoken[0].pitch).toBeGreaterThan(replyPitch);
    });

    it('says nothing of the thinking with the setting off, and the reply keeps its own voice', async () => {
        const engine = new VoiceEngine();
        const reader = realReader(engine, false);
        reader.onMessages('s1', [
            thought('t1', 'Skipped entirely.', 1_000_000),
            prose('m1', 'Answer.', 1_000_001),
        ]);
        await settle();

        expect(engine.spoken.map((u) => u.text)).toEqual(['Answer.']);
        expect(engine.spoken.every((u) => !u.thinking)).toBe(true);
        // Turning thinking off leaves the rest of read-aloud exactly as it was.
        expect(engine.spoken[0].rate).toBe(replyRate);
        expect(engine.spoken[0].pitch).toBe(replyPitch);
    });

    it('defaults on, so an untouched settings object reads the thinking', async () => {
        expect(resolveAudioCues({ audioCues: {} }).speakThinking).toBe(true);
        const engine = new VoiceEngine();
        const reader = realReader(engine, undefined);
        reader.onMessages('s1', [thought('t1', 'Said by default.', 1_000_000)]);
        await settle();
        expect(engine.spoken.map((u) => u.text)).toEqual(['Said by default.']);
    });

    it('says nothing for a signature-only thinking block', async () => {
        // Claude Code writes almost every block as a signature with no words;
        // the real `isEmptyThinking` has to keep those out of the voice.
        const engine = new VoiceEngine();
        const reader = realReader(engine);
        reader.onMessages('s1', [thought('t1', '', 1_000_000), prose('m1', 'Answer.', 1_000_001)]);
        await settle();
        expect(engine.spoken.map((u) => u.text)).toEqual(['Answer.']);
    });

    it('puts the reading mark on the thinking message while its sentence is at the engine', async () => {
        // DROVE-125's mark, on a thought. The row that lights is the thinking
        // block's own, which is what `useSpokenSentence(messageId)` asks for,
        // and it is what makes the collapsed header legible without the block
        // expanding itself under his thumb.
        const held: (() => void)[] = [];
        const holding: SpeechEngine = {
            speak(text: string, options?: SpeakOptions) {
                void text;
                void options;
                return new Promise<void>((resolve) => { held.push(resolve); });
            },
            stop() { },
        };
        const reader = realReader(holding);
        reader.onMessages('s1', [
            thought('t1', 'Weighing it up.', 1_000_000),
            prose('m1', 'Decided.', 1_000_001),
        ]);
        await settle();

        expect(reader.playhead?.messageId).toBe('t1');
        expect(reader.playhead?.sentence).toBe('Weighing it up.');

        // And it moves off the thought onto the reply, rather than sticking.
        held.shift()?.();
        await settle();
        expect(reader.playhead?.messageId).toBe('m1');
        expect(reader.playhead?.sentence).toBe('Decided.');
    });
});
