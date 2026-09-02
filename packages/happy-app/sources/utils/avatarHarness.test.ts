import { describe, expect, it } from 'vitest';
import { resolveAvatarHarness } from './avatarHarness';

describe('resolveAvatarHarness', () => {
    it('keeps the existing Claude, Codex, and Antigravity mappings', () => {
        expect(resolveAvatarHarness('claude')).toBe('claude');
        expect(resolveAvatarHarness('codex')).toBe('codex');
        expect(resolveAvatarHarness('agy')).toBe('agy');
    });

    // DROVE-379. A `drover pi` row carried no harness mark at all, so in a
    // project card it was indistinguishable from the claude sessions beside
    // it — which is what "the pi session never showed up" turned out to mean.
    it('badges pi, which is an active harness with a shipped icon', () => {
        expect(resolveAvatarHarness('pi')).toBe('pi');
    });

    it('uses Happy for the Rig client regardless of provider flavor', () => {
        expect(resolveAvatarHarness('codex', 'rig')).toBe('rig');
        expect(resolveAvatarHarness(null, 'rig')).toBe('rig');
    });

    // DROVE-381. gemini's retirement expired (harnessCatalog.ts has the why),
    // and DROVE-379 had already flagged that the returning row would carry no
    // mark. The icon was in the bundle the whole time.
    it('badges gemini, back from retirement with the icon it always shipped', () => {
        expect(resolveAvatarHarness('gemini')).toBe('gemini');
    });

    it('does not badge retired or unknown flavors', () => {
        expect(resolveAvatarHarness('openclaw')).toBeNull();
        expect(resolveAvatarHarness('future-harness')).toBeNull();
        expect(resolveAvatarHarness(null)).toBeNull();
        expect(resolveAvatarHarness(undefined, 'other-client')).toBeNull();
    });
});