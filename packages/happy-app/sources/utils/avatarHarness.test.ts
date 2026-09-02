import { describe, expect, it } from 'vitest';
import { HARNESS_NAMES, HARNESS_ORDER, NON_SPAWNABLE_HARNESS_NAMES, RETIRED_HARNESSES } from './harnessCatalog';
import { MONOCHROME_HARNESS_ICONS, resolveAvatarHarness, sessionHarnessFlavor } from './avatarHarness';

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

    // DROVE-393. cursor and openclaw were the last two harnesses in the bundle
    // with no badge, and the promanager session Clay pointed at was a `drover
    // cursor` pane. openclaw is retired, and retirement is about STARTING a
    // session; one that exists still says what it is, the same way
    // HARNESS_NAMES keeps its product name. This flips the earlier "retired
    // flavors stay badge-free" assertion on purpose.
    it('badges cursor and openclaw, whose icons shipped all along', () => {
        expect(resolveAvatarHarness('cursor')).toBe('cursor');
        expect(resolveAvatarHarness('openclaw')).toBe('openclaw');
    });

    it('resolves every harness the picker can start, from the real catalog', () => {
        for (const key of HARNESS_ORDER) {
            expect(resolveAvatarHarness(key, key === 'rig' ? 'rig' : null), key).toBe(key);
        }
        for (const key of RETIRED_HARNESSES) {
            expect(resolveAvatarHarness(key), key).toBe(key);
        }
        for (const key of Object.keys(HARNESS_NAMES)) {
            expect(resolveAvatarHarness(key, key === 'rig' ? 'rig' : null), key).not.toBeNull();
        }
    });

    // A session can BE a harness the picker cannot start: `happy acp opencode`
    // and a `drover opencode` pane both stamp `opencode` (harnessName.ts). It
    // is named in the catalog's non-spawnable record, and a name without a
    // mark is the pi bug again, so the mark comes from the same key.
    it('badges every harness the catalog names but cannot start', () => {
        expect(resolveAvatarHarness('opencode')).toBe('opencode');
        for (const key of Object.keys(NON_SPAWNABLE_HARNESS_NAMES)) {
            expect(resolveAvatarHarness(key), key).toBe(key);
        }
    });

    it('reads the two older Codex slugs as Codex', () => {
        expect(resolveAvatarHarness('gpt')).toBe('codex');
        expect(resolveAvatarHarness('openai')).toBe('codex');
    });

    it('does not badge an unknown flavor, or a transport', () => {
        expect(resolveAvatarHarness('future-harness')).toBeNull();
        // runAcp stamps `acp` on any ACP agent it has no name for. That is
        // the wire it came over, not what it is, so there is nothing to draw.
        expect(resolveAvatarHarness('acp')).toBeNull();
        expect(resolveAvatarHarness(null)).toBeNull();
        expect(resolveAvatarHarness(undefined, 'other-client')).toBeNull();
    });

    it('names the line-art marks that take the text colour, and only those', () => {
        expect([...MONOCHROME_HARNESS_ICONS].sort()).toEqual(['codex', 'cursor', 'rig']);
    });
});

describe('sessionHarnessFlavor', () => {
    it('is the stamped flavor when there is one', () => {
        expect(sessionHarnessFlavor({ flavor: 'cursor', claudeSessionId: 'abc' })).toBe('cursor');
        expect(sessionHarnessFlavor({ flavor: 'pi' })).toBe('pi');
    });

    // The Claude launcher is the only runner that writes claudeSessionId
    // (claudeLocalLauncher.ts), so its presence on a pre-flavor session is the
    // runner's own word that this is Claude.
    it('calls a flavorless session claude only when the Claude runner left its session id', () => {
        expect(sessionHarnessFlavor({ claudeSessionId: 'abc' })).toBe('claude');
        expect(sessionHarnessFlavor({ flavor: null, claudeSessionId: 'abc' })).toBe('claude');
    });

    // startedBy is stamped by every harness runner from the same CLI argument
    // (happy-cli/src/index.ts), so `daemon` on a flavorless session says who
    // launched it and nothing about what it is. A cursor pane the daemon
    // started would wear the claude badge on that evidence, which is the
    // exact mistake the badge exists to prevent.
    it('does not take startedBy as proof, and draws nothing for a bare session', () => {
        expect(sessionHarnessFlavor({ startedBy: 'daemon' })).toBeNull();
        expect(sessionHarnessFlavor({ startedBy: 'terminal' })).toBeNull();
        expect(sessionHarnessFlavor({})).toBeNull();
        expect(sessionHarnessFlavor(null)).toBeNull();
        expect(sessionHarnessFlavor(undefined)).toBeNull();
    });
});
