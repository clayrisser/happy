import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseMarkdown } from '@/components/markdown/parseMarkdown';
import { splitIntoSentenceRuns } from '@/components/markdown/sentenceTargets';
import type { Message } from '@/sync/typesMessage';
import { ReadAloudReader, type SpeakOptions, type SpeechEngine } from './readAloud';
import { readSentenceFromHere } from './readAloudTap';

/**
 * A TAP ON A SENTENCE, ALL THE WAY THROUGH (DROVE-195, regesture DROVE-235).
 *
 * Clay reported "double tap on sentence to read from it didn't work", and
 * then, later: "I thought I had told you DOUBLE press changes where we read
 * not single." He had. DROVE-163 had made it a single tap, so the answer to
 * the first report was that nobody told him it changed, and the answer to the
 * second is this branch: it is a DOUBLE tap again.
 *
 * The pieces each had a test and the chain between them did not, so this walks
 * the whole of it with nothing faked but the synthesiser: the reply is real
 * markdown, `parseMarkdown` gives the blocks the renderer draws,
 * `splitIntoSentenceRuns` cuts them into the pressable runs a finger lands on,
 * and `run.sentence` is verbatim what `MarkdownView`'s press hands to
 * `MessageView`, which hands it to `readSentenceFromHere` against the real
 * reader fed by the real `onMessages`.
 *
 * What is NOT covered here is React: vitest runs on node and the suite is
 * `.ts` only, so the `<Text onPress>` per run is read rather than mounted. The
 * gesture itself is therefore pinned two ways: the counting is measured in
 * `components/doubleTapPress.spec.ts`, and the wiring is read out of the
 * source at the bottom of this file.
 *
 * ANSWER: it works. Every sentence of a rendered reply resolves to itself.
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

function agentText(id: string, text: string, createdAt = 1): Message {
    return { kind: 'agent-text', id, localId: null, createdAt, text } as Message;
}

/** Exactly what a finger can land on, in the order it is drawn. */
function tappableSentences(markdown: string): string[] {
    return parseMarkdown(markdown).flatMap((block) => {
        if (block.type === 'text' || block.type === 'header') {
            return splitIntoSentenceRuns(block.content).map((run) => run.sentence);
        }
        if (block.type === 'list' || block.type === 'numbered-list') {
            return block.items.flatMap((item: { spans: unknown }) =>
                splitIntoSentenceRuns(item.spans as never).map((run) => run.sentence));
        }
        return [];
    });
}

const reply = [
    'Landed the change and pushed it.',
    'Two files moved in `sources/voice`, and the **rest** is untouched.',
    'Nothing else needs doing.',
].join(' ');

describe('a double tap on a sentence of a rendered reply (DROVE-195, DROVE-235)', () => {
    function reading(): { reader: ReadAloudReader; engine: FakeEngine } {
        const engine = new FakeEngine();
        const reader = new ReadAloudReader(engine);
        reader.setEnabled(true);
        reader.focus('s1');
        reader.setSessionEnabled('s1', true);
        return { reader, engine };
    }

    it('cuts the reply into three runs, which is what the finger sees', () => {
        expect(tappableSentences(reply)).toHaveLength(3);
    });

    it('reads from the sentence that was touched, not the top of the block', async () => {
        const { reader, engine } = reading();
        reader.onMessages('s1', [agentText('m1', reply)]);
        await settle();
        expect(engine.spoken).toEqual(['Landed the change and pushed it.']);

        // The third run, double tapped. `runs[2]` is the literal payload
        // MarkdownView hands over once the second press lands.
        const runs = tappableSentences(reply);
        expect(readSentenceFromHere(reader, 's1', 'm1', runs[2], 1)).toBe(true);
        await settle();
        expect(engine.spoken[engine.spoken.length - 1]).toBe('Nothing else needs doing.');
    });

    it('lands the mark on the sentence that was tapped, at once', async () => {
        const { reader, engine } = reading();
        reader.onMessages('s1', [agentText('m1', reply)]);
        await settle();

        const runs = tappableSentences(reply);
        readSentenceFromHere(reader, 's1', 'm1', runs[1], 1);
        await settle();
        // The confirmation the gesture gives itself: the yellow mark is the
        // playhead, keyed by message and sentence, and it is on the run that
        // was pressed before the engine has said anything else.
        expect(reader.playhead?.messageId).toBe('m1');
        expect(reader.playhead?.sentence).toBe(engine.spoken[engine.spoken.length - 1]);
        expect(runs[1]).toContain('Two files moved');
    });

    it('resolves EVERY run of the reply to itself, so no sentence is a dead target', async () => {
        const runs = tappableSentences(reply);
        for (const run of runs) {
            const { reader, engine } = reading();
            reader.onMessages('s1', [agentText('m1', reply)]);
            await settle();
            expect(readSentenceFromHere(reader, 's1', 'm1', run, 1)).toBe(true);
            await settle();
            // A miss would fall back to the block and say the first sentence.
            expect(reader.playhead?.sentence).not.toBeUndefined();
            if (run !== runs[0]) {
                expect(engine.spoken[engine.spoken.length - 1]).not.toBe(runs[0]);
            }
        }
    });

    it('works the same on a bullet list, where the runs live inside items', async () => {
        const markdown = '- The first item. It has two sentences.\n- The second item.';
        const runs = tappableSentences(markdown);
        expect(runs).toEqual(['The first item.', 'It has two sentences.', 'The second item.']);

        const { reader, engine } = reading();
        reader.onMessages('s1', [agentText('m1', markdown)]);
        await settle();
        expect(readSentenceFromHere(reader, 's1', 'm1', 'The second item.', 1)).toBe(true);
        await settle();
        expect(engine.spoken[engine.spoken.length - 1]).toBe('The second item.');
    });

    /**
     * Four presses on one run are two double taps, and the second must land
     * where the first did rather than drift. Repeating the gesture on the same
     * sentence is a no-op you can hear, not a wander.
     */
    it('is not made worse by repeating the gesture', async () => {
        const { reader, engine } = reading();
        reader.onMessages('s1', [agentText('m1', reply)]);
        await settle();
        const runs = tappableSentences(reply);

        readSentenceFromHere(reader, 's1', 'm1', runs[1], 1);
        await settle();
        readSentenceFromHere(reader, 's1', 'm1', runs[1], 1);
        await settle();
        expect(reader.playhead?.sentence).toBe(engine.spoken[engine.spoken.length - 1]);
        expect(engine.spoken[engine.spoken.length - 1]).toContain('Two files moved');
    });

    /** DROVE-179's gate must not see a seek as a stop. */
    it('tells no capture anything, so the gate never sees it', async () => {
        const { reader } = reading();
        const heard: string[] = [];
        reader.addInterruptListener((reason) => heard.push(reason));
        reader.onMessages('s1', [agentText('m1', reply)]);
        await settle();

        readSentenceFromHere(reader, 's1', 'm1', tappableSentences(reply)[2], 1);
        await settle();
        expect(heard).toEqual([]);
    });
});

const sourcesRoot = resolve(__dirname, '..');

function read(relative: string): string {
    return readFileSync(join(sourcesRoot, relative), 'utf8');
}

/** Every source file under `sources/`, tests left out. */
function sourceFiles(dir: string = sourcesRoot): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            return entry.name === 'node_modules' ? [] : sourceFiles(full);
        }
        if (!/\.tsx?$/.test(entry.name)) return [];
        if (/\.(spec|test)\.tsx?$/.test(entry.name)) return [];
        return [full];
    });
}

/**
 * The gesture, read out of the renderer (DROVE-235).
 *
 * vitest cannot mount the Text, so the wiring is asserted against the source.
 * Coarse, and it catches the exact regression this ticket is about: a press
 * bound straight to `onSentencePress` is a single tap again.
 */
describe('the sentence press is two taps (DROVE-235)', () => {
    const markdownView = read('components/markdown/MarkdownView.tsx');

    it('routes the sentence run press through the double-tap counter', () => {
        expect(markdownView).toContain('useDoubleTapPress(seek)');
        expect(markdownView).toContain('onPress={onPress}');
    });

    it('binds no press straight to onSentencePress, which is the single tap', () => {
        expect(markdownView).not.toContain('onPress={() => onSentencePress(');
    });

    /**
     * The collision, settled by target. A code block is its own component and
     * is handed no sentence press, so its own double tap (DROVE-95,
     * DROVE-149) is the only handler inside a fence. It keeps the gesture: it
     * is older, more local, and a code block is not something Clay asks to be
     * read from.
     */
    it('hands a code block no sentence press at all', () => {
        const signature = markdownView.slice(
            markdownView.indexOf('function RenderCodeBlock'),
            markdownView.indexOf('function RenderCodeBlock') + 400,
        );
        expect(signature).not.toContain('onSentencePress');
        expect(markdownView).toContain('<RenderCodeBlock content={block.content}');
        const call = markdownView.slice(
            markdownView.indexOf('<RenderCodeBlock content={block.content}'),
            markdownView.indexOf('<RenderCodeBlock content={block.content}') + 260,
        );
        expect(call).not.toContain('onSentencePress');
    });

    it('leaves a code fence with no tappable sentence in it', () => {
        const markdown = 'Here is the fix.\n\n```sh\nmake test. And again.\n```\n\nThat is all.';
        expect(tappableSentences(markdown)).toEqual(['Here is the fix.', 'That is all.']);
    });
});

/**
 * ONE ROUTE TO THE PLAYHEAD, still (DROVE-146, DROVE-226).
 *
 * Changing the gesture must not add a second way in. Reading starts at new
 * content unless Clay taps, and the tap is the only steer; DROVE-146's
 * block-level double tap stayed deleted.
 */
describe('exactly one route moves the read position (DROVE-146)', () => {
    const seekEntryPoints = [
        'readAloudFromHere',
        'readAloudSentenceFromHere',
        'readAloudSubagentSentenceFromHere',
    ];

    it('has one surface calling a seek, and it is the sentence press', () => {
        const callers = sourceFiles()
            .filter((file) => !file.includes(join('sources', 'voice')))
            .filter((file) => seekEntryPoints.some((name) => readFileSync(file, 'utf8').includes(`${name}(`)));
        expect(callers.map((file) => file.slice(sourcesRoot.length + 1))).toEqual([
            join('components', 'MessageView.tsx'),
        ]);
    });

    it('never reaches the block-level seek from a gesture', () => {
        const messageView = read('components/MessageView.tsx');
        expect(messageView).not.toContain('readAloudFromHere(');
        expect(messageView).toContain('readAloudSentenceFromHere(');
    });

    /**
     * Every press MessageView draws is the same one callback: the reply body,
     * the thinking block, and the thinking block's forward of it. So there is
     * one destination however many surfaces show prose.
     */
    it('gives every prose surface the same single handler', () => {
        const messageView = read('components/MessageView.tsx');
        const bindings = messageView.match(/onSentencePress=\{[^}]+\}/g) ?? [];
        expect(bindings.length).toBeGreaterThan(0);
        expect(new Set(bindings)).toEqual(new Set([
            'onSentencePress={readFromSentence}',
            // ThinkingBlock passing the same callback down to MarkdownView.
            'onSentencePress={props.onSentencePress}',
        ]));
    });
});
