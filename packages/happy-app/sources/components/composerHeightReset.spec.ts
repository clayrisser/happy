/**
 * THE COMPOSER COMES BACK TO ONE LINE WHEN THE FIELD IS EMPTIED (DROVE-350).
 *
 * Clay, from his phone: "After speaking into the speech bubble and then
 * submitting, it leaves all this random empty space, like if I'm talking into
 * the speech and then just submit." The photograph is the composer holding the
 * empty placeholder at the top of a bubble still as tall as the four dictated
 * lines, with the `+` / capsule / mic / send row under the void.
 *
 * WHAT WAS ACTUALLY WRONG. The chat's field had no resolved height at all. The
 * text row carries a floor and a ceiling (`composerBubbleLayout.ts`) and
 * everything between them was the native TextInput's own intrinsic
 * measurement. Home has never worked that way: it measures a hidden `Text` and
 * runs it through `resolveMultiTextInputLayout`, which already answers the
 * one-line floor for an empty value whatever it last measured. That `hasText`
 * guard is the whole difference, and it is why Home shrank back and the chat
 * did not.
 *
 * WHY DICTATION IS THE ROUTE THAT SHOWS IT. Both of the writes involved are
 * PROGRAMMATIC: the transcript arrives through `dictationComposerEvents` ->
 * `setTextAndSelection`, and the send clears the field the same way. Neither is
 * a keystroke, so neither carries a native text-change event, and an iOS field
 * measures from the most recent attributed string it was told about — which
 * falls back to the state the native view last reported when the react tree's
 * own string has not moved since that report. So the tall measurement outlives
 * the clear, and nothing in the chat recomputed a height from the value.
 *
 * SO THIS SPEC DRIVES THE MIC'S OWN TRANSITIONS, not a restatement of them.
 * `dictationComposerEvents` is the same factory `useVoiceComposer` wires to the
 * recogniser, and its port is the chat's: `setComposerText` is
 * `setDictatedMessage` and `send` is the send's `clearMessage`. The one thing
 * the spec adds is the iOS behaviour under test — a content size that is
 * reported while the words arrive and NOT reported again when the field is
 * emptied. If the height ever went back to being intrinsic, that missing report
 * is what would strand it, and these three cases are what would fail.
 *
 * NOTHING HERE COMPUTES AN OFFSET, and nothing waits. The bubble's height is
 * read back through `resolveMobileComposerBubbleHeight`, the same resolver the
 * layout is measured with everywhere else (DROVE-214, DROVE-320).
 */
import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const { host, theme, flatten } = vi.hoisted(() => {
    const flatten = (style: unknown): Record<string, unknown> => {
        if (!style) {
            return {};
        }
        if (Array.isArray(style)) {
            return style.reduce<Record<string, unknown>>(
                (merged, entry) => Object.assign(merged, flatten(entry)),
                {},
            );
        }
        return { ...(style as Record<string, unknown>) };
    };
    return {
        host: (name: string) => (props: any) => React.createElement(name, props, props.children),
        theme: {
            dark: true,
            colors: {
                input: { text: '#ffffff', placeholder: '#888888', background: '#111111' },
            },
        },
        flatten,
    };
});

vi.mock('react-native', () => ({
    Platform: {
        OS: 'ios',
        select: (options: Record<string, unknown>) => ('ios' in options ? options.ios : options.default),
    },
    View: host('View'),
    Text: host('Text'),
    TextInput: host('TextInput'),
}));
vi.mock('react-native-unistyles', () => ({ useUnistyles: () => ({ theme }) }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));

import { MultiTextInput, type MultiTextInputHandle } from './MultiTextInput';
import {
    MOBILE_COMPOSER_BUBBLE_BASE_HEIGHT,
    MOBILE_COMPOSER_METRICS,
    MOBILE_COMPOSER_TEXT_ROW_BASE_HEIGHT,
    resolveMobileComposerBubbleHeight,
} from './agentInputLayout';
import { dictationComposerEvents } from '@/voice/dictationComposer';

beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

const padding = MOBILE_COMPOSER_METRICS.inputPaddingTop + MOBILE_COMPOSER_METRICS.inputPaddingBottom;

/** Four lines of speech, as tall as the recogniser had grown the field. */
const dictated = 'first thing I said\nthen the second\nand a third\nand a fourth';
/** What the field measures at once four lines are in it, padding included. */
const fourLines = MOBILE_COMPOSER_METRICS.inputLineHeight * 4 + padding;

/**
 * The chat's field, mounted the way `AgentInput` mounts it.
 *
 * `createNodeMock` stands in for the native view the caret is applied to; the
 * component reaches for `setSelection` in a layout effect after every
 * imperative write, which is exactly the path dictation and send both take.
 */
function mountField() {
    const ref = React.createRef<MultiTextInputHandle>();
    let renderer: any;
    act(() => {
        renderer = create(
            React.createElement(MultiTextInput, {
                ref,
                defaultValue: '',
                placeholder: 'Type a message …',
                maxHeight: MOBILE_COMPOSER_METRICS.inputMaxHeight,
                lineHeight: MOBILE_COMPOSER_METRICS.inputLineHeight,
                paddingTop: MOBILE_COMPOSER_METRICS.inputPaddingTop,
                paddingBottom: MOBILE_COMPOSER_METRICS.inputPaddingBottom,
            } as any),
            { createNodeMock: () => ({ setSelection() {}, focus() {}, blur() {} }) },
        );
    });

    const field = () => renderer.root.findByType('TextInput' as any);
    /** The height the field is actually drawn at. */
    const fieldHeight = () => flatten(field().props.style).height as number;
    /**
     * The bubble the layout engine resolves for that field. The row's padding
     * is the field's own, so the TEXT's height is what the bubble resolver
     * takes — the same argument `resolveMobileComposerTextRowHeight` documents.
     */
    const bubbleHeight = () => resolveMobileComposerBubbleHeight(fieldHeight() - padding);
    /** iOS telling the field how tall its content measured. */
    const measures = (height: number) => act(() => {
        field().props.onContentSizeChange({ nativeEvent: { contentSize: { width: 320, height } } });
    });
    /** A keystroke, which is the one write that DOES come from the native side. */
    const types = (text: string) => act(() => { field().props.onChangeText(text); });
    /** Whatever the screen writes into the field: dictation, or the send's clear. */
    const writes = (text: string) => act(() => {
        ref.current?.setTextAndSelection(text, { start: text.length, end: text.length });
    });

    /** What the field holds now, the way `getComposerText` reads it. */
    const value = () => ref.current?.getText() ?? '';

    return { ref, field, fieldHeight, bubbleHeight, measures, types, writes, value };
}

/**
 * The chat's composer port, driven by the real dictation factory.
 *
 * `base` is what the composer held when the mic opened, `setComposerText` is
 * `ChatComposer.setDictatedMessage` and `send` is what `handleSend` does to the
 * field — `clearMessage`, an imperative write of the empty string. Nothing here
 * is a re-implementation: it is the same three calls the screen makes.
 */
function micDriving(composer: ReturnType<typeof mountField>, base = '') {
    return dictationComposerEvents({
        base: () => base,
        current: () => composer.value(),
        setComposerText: (text) => composer.writes(text),
        send: () => composer.writes(''),
        onError: () => {},
        onChange: () => {},
    });
}

describe('the composer’s height comes back with the empty field (DROVE-350)', () => {
    it('is the one-line bubble after a dictated message is sent', () => {
        const composer = mountField();
        const mic = micDriving(composer);

        // The words arrive as partials, each one the whole utterance so far,
        // and the field grows under them. iOS reports the new content size for
        // these because the text is on screen and being laid out.
        mic.onPartial('first thing I said');
        composer.measures(MOBILE_COMPOSER_METRICS.inputLineHeight + padding);
        mic.onPartial(dictated);
        composer.measures(fourLines);
        expect(composer.fieldHeight()).toBe(fourLines);
        expect(composer.bubbleHeight()).toBeGreaterThan(MOBILE_COMPOSER_BUBBLE_BASE_HEIGHT);

        // The lift on the mic: the transcript is committed and sent, so the
        // send clears the field. NOTHING reports a content size for that — the
        // clear is programmatic, and that is the whole bug.
        mic.onCommit(dictated, true, 'send');

        expect(composer.fieldHeight()).toBe(MOBILE_COMPOSER_TEXT_ROW_BASE_HEIGHT);
        expect(composer.bubbleHeight()).toBe(MOBILE_COMPOSER_BUBBLE_BASE_HEIGHT);
    });

    it('is the one-line bubble after three typed lines are sent', () => {
        const composer = mountField();
        const typed = 'one\ntwo\nthree';

        // The keyboard path: every character comes back from the native side,
        // so both the text and the measurement are the field's own.
        composer.types(typed);
        composer.measures(MOBILE_COMPOSER_METRICS.inputLineHeight * 3 + padding);
        expect(composer.bubbleHeight()).toBeGreaterThan(MOBILE_COMPOSER_BUBBLE_BASE_HEIGHT);

        // Send is the same imperative clear whichever way the words got there.
        composer.writes('');

        expect(composer.fieldHeight()).toBe(MOBILE_COMPOSER_TEXT_ROW_BASE_HEIGHT);
        expect(composer.bubbleHeight()).toBe(MOBILE_COMPOSER_BUBBLE_BASE_HEIGHT);
    });

    it('is the one-line bubble after a dictation is cancelled without sending', () => {
        const composer = mountField();
        const mic = micDriving(composer);

        mic.onPartial(dictated);
        composer.measures(fourLines);
        expect(composer.bubbleHeight()).toBeGreaterThan(MOBILE_COMPOSER_BUBBLE_BASE_HEIGHT);

        // The slide-off cancel (DROVE-105): the one end reason that takes the
        // words back. `dictationRestoresDraft.cancel` is true, so the factory
        // writes the base — empty here — and nothing is sent.
        mic.onDiscard('cancel');

        expect(composer.fieldHeight()).toBe(MOBILE_COMPOSER_TEXT_ROW_BASE_HEIGHT);
        expect(composer.bubbleHeight()).toBe(MOBILE_COMPOSER_BUBBLE_BASE_HEIGHT);
    });

    it('does not collapse a cancel that puts a draft BACK to one line', () => {
        // The other half of the same guarantee, and the case a lazy fix fails.
        // Only the EMPTY value has a height that can be derived without
        // measuring anything; a restored two-line draft does not, so it goes
        // back to the field's own measurement rather than being pinned to the
        // floor. An implementation that just answered "one line" whenever it
        // had no fresh measurement would pass the three cases above and eat
        // half of Clay's draft here.
        const composer = mountField();
        const draft = 'what I had already typed\nbefore I started talking';
        const mic = micDriving(composer, draft);

        composer.writes(draft);
        composer.measures(MOBILE_COMPOSER_METRICS.inputLineHeight * 2 + padding);
        mic.onPartial('and then I said this as well');
        composer.measures(MOBILE_COMPOSER_METRICS.inputLineHeight * 3 + padding);

        mic.onDiscard('cancel');

        expect(composer.field().props.value).toBe(draft);
        expect(composer.fieldHeight()).not.toBe(MOBILE_COMPOSER_TEXT_ROW_BASE_HEIGHT);
    });

    it('never exceeds the field’s own ceiling however long the dictation runs', () => {
        // The cap is the resolver's, not a second number: a recogniser that
        // runs for a minute must not grow the bubble past `inputMaxHeight`.
        const composer = mountField();
        const mic = micDriving(composer);

        mic.onPartial('a very long thing '.repeat(40));
        composer.measures(MOBILE_COMPOSER_METRICS.inputMaxHeight * 4);

        expect(composer.fieldHeight()).toBe(MOBILE_COMPOSER_METRICS.inputMaxHeight);
    });
});
