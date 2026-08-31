import { describe, expect, it } from 'vitest';
import { resolveComposerPrimaryPress } from './composerPrimaryPress';

describe('resolveComposerPrimaryPress', () => {
    const voiceFace = { action: 'voice' as const, liveHasContent: false, canPress: true };

    it('a tap on the boss-mode face starts boss mode', () => {
        expect(resolveComposerPrimaryPress({ ...voiceFace, gesture: 'press' })).toBe('boss');
    });

    it('a long-press on the boss-mode face opens the channel sheet, not boss mode', () => {
        expect(resolveComposerPrimaryPress({ ...voiceFace, gesture: 'longPress' })).toBe('channels');
    });

    it('a long-press opens the sheet whatever face the button wears', () => {
        for (const action of ['send', 'stop', 'blocked', 'mic', 'voice'] as const) {
            expect(resolveComposerPrimaryPress({ gesture: 'longPress', action, liveHasContent: true, canPress: true })).toBe('channels');
        }
    });

    it('a tap with text in the composer sends, even on the stop or boss face', () => {
        expect(resolveComposerPrimaryPress({ gesture: 'press', action: 'stop', liveHasContent: true, canPress: true })).toBe('send');
        expect(resolveComposerPrimaryPress({ gesture: 'press', action: 'voice', liveHasContent: true, canPress: true })).toBe('send');
    });

    it('a tap on a blank composer while the agent works aborts', () => {
        expect(resolveComposerPrimaryPress({ gesture: 'press', action: 'stop', liveHasContent: false, canPress: true })).toBe('abort');
    });

    it('a tap on the locked face goes through send, which explains the lock', () => {
        expect(resolveComposerPrimaryPress({ gesture: 'press', action: 'blocked', liveHasContent: false, canPress: true })).toBe('send');
    });

    /**
     * DROVE-210. The mic face is the microphone, and a tap on it latches the
     * same capture the control-row capsule drives. It only ever latches: a
     * plain `onPress` fires once, on the lift, with no duration and no
     * coordinates, so there is no hold to recognise and nothing to slide off.
     * Push-to-talk and slide-to-cancel stay on the capsule.
     */
    describe('the mic face', () => {
        const micFace = { action: 'mic' as const, liveHasContent: false, canPress: true };

        it('latches the mic on a tap', () => {
            expect(resolveComposerPrimaryPress({ ...micFace, gesture: 'press' })).toBe('mic');
        });

        it('opens the channel sheet on a long-press, like every other face', () => {
            expect(resolveComposerPrimaryPress({ ...micFace, gesture: 'longPress' })).toBe('channels');
        });

        it('never starts a call: the two are different controls', () => {
            expect(resolveComposerPrimaryPress({ ...micFace, gesture: 'press' })).not.toBe('boss');
        });

        it('gives way to send the moment there is something to send', () => {
            expect(resolveComposerPrimaryPress({
                ...micFace,
                gesture: 'press',
                liveHasContent: true,
            })).toBe('send');
        });
    });

    it('a disabled button does nothing for either gesture', () => {
        expect(resolveComposerPrimaryPress({ ...voiceFace, gesture: 'press', canPress: false })).toBe('none');
        expect(resolveComposerPrimaryPress({ ...voiceFace, gesture: 'longPress', canPress: false })).toBe('none');
    });
});
