import { describe, expect, it } from 'vitest';
import { resolveComposerPrimaryPress } from './composerPrimaryPress';

describe('resolveComposerPrimaryPress', () => {
    const sendFace = { action: 'send' as const, liveHasContent: true, canPress: true };

    it('a tap with text in the composer sends', () => {
        expect(resolveComposerPrimaryPress({ ...sendFace, gesture: 'press' })).toBe('send');
    });

    it('a long-press opens the channel sheet, not send', () => {
        expect(resolveComposerPrimaryPress({ ...sendFace, gesture: 'longPress' })).toBe('channels');
    });

    it('a long-press opens the sheet whatever face the button wears', () => {
        for (const action of ['send', 'stop', 'blocked', 'idle'] as const) {
            expect(resolveComposerPrimaryPress({ gesture: 'longPress', action, liveHasContent: true, canPress: true })).toBe('channels');
        }
    });

    it('a tap with text in the composer sends, even on the stop face', () => {
        expect(resolveComposerPrimaryPress({ gesture: 'press', action: 'stop', liveHasContent: true, canPress: true })).toBe('send');
    });

    it('a tap on a blank composer while the agent works aborts', () => {
        expect(resolveComposerPrimaryPress({ gesture: 'press', action: 'stop', liveHasContent: false, canPress: true })).toBe('abort');
    });

    it('a tap on the locked face goes through send, which explains the lock', () => {
        expect(resolveComposerPrimaryPress({ gesture: 'press', action: 'blocked', liveHasContent: false, canPress: true })).toBe('send');
    });

    it('a disabled button does nothing for either gesture', () => {
        expect(resolveComposerPrimaryPress({ ...sendFace, gesture: 'press', canPress: false })).toBe('none');
        expect(resolveComposerPrimaryPress({ ...sendFace, gesture: 'longPress', canPress: false })).toBe('none');
    });

    /**
     * DROVE-206. Boss mode was one of this table's answers, reached only when
     * the button wore the waveform on an empty composer, which is exactly the
     * thing Clay asked to be taken out of the message box. It is a control of
     * its own on the row now and calls the mic handler directly, so no gesture
     * on the send button can start a voice turn.
     */
    it('never starts boss mode, and since DROVE-264 never opens a mic either', () => {
        const dispatches = new Set<string>();
        for (const action of ['send', 'stop', 'blocked', 'idle'] as const) {
            for (const gesture of ['press', 'longPress'] as const) {
                for (const liveHasContent of [true, false]) {
                    for (const canPress of [true, false]) {
                        dispatches.add(resolveComposerPrimaryPress({ gesture, action, liveHasContent, canPress }));
                    }
                }
            }
        }
        expect(dispatches).not.toContain('boss');
        // `mic` joined in DROVE-236 and has left again in DROVE-264: the
        // microphone is its own button with its own press, so no gesture on
        // this one touches a capture. Boss mode never came back.
        expect(dispatches).not.toContain('mic');
        expect([...dispatches].sort()).toEqual(['abort', 'channels', 'none', 'send']);
    });

    /**
     * DROVE-264, and it is the assertion the split exists for.
     *
     * DROVE-236 had to check a `mic` face BEFORE the live text, because a
     * capture open on THIS button filled the composer with partials and a press
     * mid-sentence had to close the mic rather than send half a line. Two
     * controls cannot flip into each other, so the guard is gone and a press
     * with dictated words in the field sends them. That is Clay's composition:
     * type a bit, dictate the rest, send.
     */
    it('sends dictated content, because the mic is no longer this button', () => {
        expect(resolveComposerPrimaryPress({
            gesture: 'press', action: 'send', liveHasContent: true, canPress: true,
        })).toBe('send');
    });

    /**
     * An idle button is disabled, so `canPress` refuses it before the face is
     * read. It stays in the table anyway: a later state that enables the
     * button on an empty composer lands on send, which shakes and explains
     * itself, rather than on a hole.
     */
    it('sends rather than falling through when an idle button is somehow pressable', () => {
        expect(resolveComposerPrimaryPress({ gesture: 'press', action: 'idle', liveHasContent: false, canPress: true })).toBe('send');
        expect(resolveComposerPrimaryPress({ gesture: 'press', action: 'idle', liveHasContent: false, canPress: false })).toBe('none');
    });
});
