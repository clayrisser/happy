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
        for (const action of ['send', 'stop', 'blocked', 'voice'] as const) {
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

    it('a disabled button does nothing for either gesture', () => {
        expect(resolveComposerPrimaryPress({ ...voiceFace, gesture: 'press', canPress: false })).toBe('none');
        expect(resolveComposerPrimaryPress({ ...voiceFace, gesture: 'longPress', canPress: false })).toBe('none');
    });
});
