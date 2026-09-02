import { describe, expect, it } from 'vitest';
import { parseMarkdown } from '@/components/markdown/parseMarkdown';
import { splitIntoSentenceRuns } from '@/components/markdown/sentenceTargets';
import type { Message } from '@/sync/typesMessage';
import { ReadAloudReader, type SpeakOptions, type SpeechEngine } from './readAloud';
import { readDetourFromHere } from './readAloudTap';
import { subagentDetourFrom, subagentSentences } from './subagentRead';

/**
 * Tapping a sentence inside a SUBAGENT (DROVE-195).
 *
 * Clay: "if you go to a subagent and tap a sentence from it while I'm in
 * reading mode it will read it." A scope the gesture never had, because the
 * agent screen draws a transcript fetched over its own RPC (DROVE-93) that
 * never reaches `readAloud.onMessages`.
 *
 * THE DECISION: the reader follows him in, as a DETOUR. The session keeps its
 * focus, its timeline and its place; the borrowed sentences are said first and
 * then the session carries on from exactly where it was. The alternative,
 * moving focus to the agent, throws the session's timeline away with nothing
 * to refill it and drops the replies that arrive meanwhile.
 */

class FakeEngine implements SpeechEngine {
    spoken: string[] = [];
    private resolvers: (() => void)[] = [];

    speak(text: string, _options?: SpeakOptions): Promise<unknown> {
        this.spoken.push(text);
        return new Promise<void>((resolve) => { this.resolvers.push(resolve); });
    }

    stop(): void {
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

function agentText(id: string, text: string, createdAt: number): Message {
    return { kind: 'agent-text', id, localId: null, createdAt, text } as Message;
}

function toolCall(id: string, createdAt: number): Message {
    return {
        kind: 'tool-call',
        id,
        localId: null,
        createdAt,
        tools: [{ name: 'Bash', state: 'completed', input: {}, createdAt }],
    } as unknown as Message;
}

/** What the agent screen publishes, out of order the way a record map is. */
const transcript: Message[] = [
    agentText('a2', 'Then I ran the suite. It was green.', 20),
    agentText('a1', 'I read the config first.', 10),
    toolCall('a3', 15),
];

/** The literal payload of MarkdownView's onPress, for a subagent row. */
function tapPayload(markdown: string, index: number): string {
    const runs = parseMarkdown(markdown).flatMap((block) =>
        (block.type === 'text' ? splitIntoSentenceRuns(block.content) : []));
    return runs[index].sentence;
}

describe('cutting a subagent transcript into sentences', () => {
    it('reads it in written order, whatever order the map hands it over in', () => {
        expect(subagentSentences(transcript)).toEqual([
            { messageId: 'a1', text: 'I read the config first.', createdAt: 10 },
            { messageId: 'a2', text: 'Then I ran the suite.', createdAt: 20 },
            { messageId: 'a2', text: 'It was green.', createdAt: 20 },
        ]);
    });

    it('skips everything that is not prose, so a tool card is not a target', () => {
        expect(subagentSentences([toolCall('a3', 15)])).toEqual([]);
        expect(subagentDetourFrom([toolCall('a3', 15)], 'a3', 'anything')).toEqual([]);
    });

    /**
     * A thinking block IS drawn with sentence targets on an agent screen, the
     * same as in the session, and its own words are not in the detour. A
     * target that does nothing is the failure this ticket is about, so the tap
     * starts from the first prose after it.
     */
    it('starts after a row with no prose of its own, rather than doing nothing', () => {
        const thinking = {
            kind: 'agent-text', id: 't1', localId: null, createdAt: 12,
            text: '*Weighing the options.*', isThinking: true,
        } as unknown as Message;
        const detour = subagentDetourFrom([...transcript, thinking], 't1', 'Weighing the options.');
        expect(detour.map((at) => at.text)).toEqual(['Then I ran the suite.', 'It was green.']);
    });

    it('is empty when there is nothing after the row at all', () => {
        const thinking = {
            kind: 'agent-text', id: 't9', localId: null, createdAt: 99,
            text: '*Last thought.*', isThinking: true,
        } as unknown as Message;
        expect(subagentDetourFrom([...transcript, thinking], 't9', 'Last thought.')).toEqual([]);
    });
});

describe('what a tap resolves to', () => {
    it('takes the tapped sentence and everything after it, across messages', () => {
        const tapped = tapPayload('Then I ran the suite. It was green.', 0);
        expect(subagentDetourFrom(transcript, 'a2', tapped).map((at) => at.text)).toEqual([
            'Then I ran the suite.',
            'It was green.',
        ]);
    });

    it('starts at the top of the tapped message when the sentence cannot be matched', () => {
        // The same fallback the session's tap takes (DROVE-146): the worst
        // case of a failed hit test is the block, never silence.
        expect(subagentDetourFrom(transcript, 'a2', 'Something it never said.').map((at) => at.text))
            .toEqual(['Then I ran the suite.', 'It was green.']);
    });

    it('carries the subagent message id, which is what puts the mark on the row', () => {
        const detour = subagentDetourFrom(transcript, 'a1', 'I read the config first.');
        expect(detour[0].messageId).toBe('a1');
    });
});

describe('the reader follows him into the subagent, then gives the session back', () => {
    function reading(): { reader: ReadAloudReader; engine: FakeEngine } {
        const engine = new FakeEngine();
        const reader = new ReadAloudReader(engine);
        reader.setEnabled(true);
        reader.focus('s1');
        reader.setSessionEnabled('s1', true);
        return { reader, engine };
    }

    async function midSession(): Promise<{ reader: ReadAloudReader; engine: FakeEngine }> {
        const { reader, engine } = reading();
        reader.onMessages('s1', [agentText('m1', 'Session one. Session two. Session three.', 1)]);
        await settle();
        expect(engine.spoken).toEqual(['Session one.']);
        return { reader, engine };
    }

    it('reads the agent from the tapped sentence to the end of its transcript', async () => {
        const { reader, engine } = await midSession();
        const detour = subagentDetourFrom(transcript, 'a2', 'Then I ran the suite.');
        expect(readDetourFromHere(reader, 's1', detour)).toBe(true);
        await settle();
        expect(engine.spoken[engine.spoken.length - 1]).toBe('Then I ran the suite.');

        engine.finishOne();
        await settle();
        expect(engine.spoken[engine.spoken.length - 1]).toBe('It was green.');
    });

    it('marks the subagent row it is speaking, so the tap confirms itself there too', async () => {
        const { reader } = await midSession();
        readDetourFromHere(reader, 's1', subagentDetourFrom(transcript, 'a1', 'I read the config first.'));
        await settle();
        expect(reader.playhead?.messageId).toBe('a1');
        expect(reader.playhead?.sentence).toBe('I read the config first.');
    });

    it('keeps the session focused and its place, and resumes there afterwards', async () => {
        const { reader, engine } = await midSession();
        readDetourFromHere(reader, 's1', subagentDetourFrom(transcript, 'a2', 'It was green.'));
        await settle();
        expect(reader.focusedSessionId).toBe('s1');
        expect(engine.spoken[engine.spoken.length - 1]).toBe('It was green.');

        engine.finishOne();
        await settle();
        // Straight back into the session at the sentence it was going to say.
        expect(engine.spoken[engine.spoken.length - 1]).toBe('Session two.');
        engine.finishOne();
        await settle();
        expect(engine.spoken[engine.spoken.length - 1]).toBe('Session three.');
    });

    it('keeps taking the session\'s new replies while the agent is being read', async () => {
        const { reader, engine } = await midSession();
        readDetourFromHere(reader, 's1', subagentDetourFrom(transcript, 'a1', 'I read the config first.'));
        await settle();

        // The session is still focused, so this lands in its timeline rather
        // than on the floor. A focus MOVE would have dropped it.
        reader.onMessages('s1', [agentText('m2', 'A later reply.', 30)]);
        await settle();
        expect(engine.spoken[engine.spoken.length - 1]).toBe('I read the config first.');

        for (let i = 0; i < 5; i++) {
            engine.finishOne();
            await settle();
        }
        expect(engine.spoken).toContain('A later reply.');
    });

    it('is dropped when he asks the session something new', async () => {
        const { reader, engine } = await midSession();
        readDetourFromHere(reader, 's1', subagentDetourFrom(transcript, 'a1', 'I read the config first.'));
        await settle();
        // Three sentences from the tap on, one at the engine and two held.
        expect(reader.detourPending).toBe(2);

        reader.onMessages('s1', [
            { kind: 'user-text', id: 'u2', localId: null, createdAt: 40, text: 'Do this instead.' } as Message,
            agentText('m3', 'On it.', 41),
        ]);
        await settle();
        expect(reader.detourPending).toBe(0);
    });

    it('does nothing at all while reading is off', async () => {
        const engine = new FakeEngine();
        const reader = new ReadAloudReader(engine);
        reader.focus('s1', 'toggled-off');
        expect(readDetourFromHere(reader, 's1', subagentDetourFrom(transcript, 'a1', 'I read the config first.')))
            .toBe(false);
        await settle();
        expect(engine.spoken).toEqual([]);
    });

    /** A tap is a seek, and a seek is not a reason to stop the microphone. */
    it('tells no capture anything', async () => {
        const { reader } = await midSession();
        const heard: string[] = [];
        reader.addInterruptListener((reason) => heard.push(reason));
        readDetourFromHere(reader, 's1', subagentDetourFrom(transcript, 'a1', 'I read the config first.'));
        await settle();
        expect(heard).toEqual([]);
    });

    /** A gate waiting on Clay still outranks an agent's transcript (DROVE-188). */
    it('lets a gate jump ahead of the borrowed transcript', async () => {
        const { reader, engine } = await midSession();
        readDetourFromHere(reader, 's1', subagentDetourFrom(transcript, 'a1', 'I read the config first.'));
        await settle();
        reader.sayUrgent('gate-1', 'Claude is asking you something.');
        engine.finishOne();
        await settle();
        expect(engine.spoken[engine.spoken.length - 1]).toBe('Claude is asking you something.');
    });
});
