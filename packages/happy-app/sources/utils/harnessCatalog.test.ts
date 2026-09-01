import { describe, expect, it } from 'vitest';

import { HARNESS_NAMES, isRetiredHarness, listAvailableHarnesses } from './harnessCatalog';

describe('harness catalog', () => {
    it('names Happy and Antigravity by product, not by CLI id', () => {
        expect(HARNESS_NAMES.rig).toBe('Cattle Drover');
        expect(HARNESS_NAMES.agy).toBe('Antigravity');
    });

    it('retires Gemini and OpenClaw only', () => {
        expect(isRetiredHarness('gemini')).toBe(true);
        expect(isRetiredHarness('openclaw')).toBe(true);
        expect(isRetiredHarness('claude')).toBe(false);
        // Antigravity is what Gemini's own error message redirects people to.
        expect(isRetiredHarness('agy')).toBe(false);
    });

    it('lists only installed harnesses, in pick order', () => {
        const harnesses = listAvailableHarnesses({
            availability: { claude: true, codex: true, agy: true },
            happyAgentAvailable: true,
            selected: 'claude',
        });

        expect(harnesses.map((harness) => harness.key)).toEqual(['claude', 'codex', 'agy', 'rig']);
        expect(harnesses.map((harness) => harness.name)).toEqual([
            'Claude Code',
            'Codex',
            'Antigravity',
            'Cattle Drover',
        ]);
    });

    it('never offers a retired harness, even with its CLI installed', () => {
        const harnesses = listAvailableHarnesses({
            availability: { claude: true, gemini: true, openclaw: true },
            happyAgentAvailable: false,
            selected: 'claude',
        });

        expect(harnesses.map((harness) => harness.key)).toEqual(['claude']);
    });

    // The "keep the current selection listed" rule must not apply here, or a
    // stale draft would pin someone to an agent they can no longer start.
    it('does not keep a retired harness listed just because it is selected', () => {
        const harnesses = listAvailableHarnesses({
            availability: { claude: true, gemini: true },
            happyAgentAvailable: false,
            selected: 'gemini',
        });

        expect(harnesses.map((harness) => harness.key)).toEqual(['claude']);
    });

    it('keeps a real name for a retired harness so old sessions still read right', () => {
        expect(HARNESS_NAMES.gemini).toBe('Gemini');
        expect(HARNESS_NAMES.openclaw).toBe('OpenClaw');
    });

    it('drops Happy when no connected machine can run it', () => {
        const harnesses = listAvailableHarnesses({
            availability: { claude: true, codex: true },
            happyAgentAvailable: false,
            selected: 'claude',
        });

        expect(harnesses.map((harness) => harness.key)).toEqual(['claude', 'codex']);
    });

    it('keeps the current selection listed even once its CLI disappears', () => {
        const harnesses = listAvailableHarnesses({
            availability: { claude: false, codex: true },
            happyAgentAvailable: false,
            selected: 'claude',
        });

        expect(harnesses.map((harness) => harness.key)).toEqual(['claude', 'codex']);
    });

    it('never lists Antigravity without an explicit installation report', () => {
        expect(listAvailableHarnesses({
            availability: { claude: true, agy: false },
            happyAgentAvailable: false,
            selected: 'agy',
        }).map((harness) => harness.key)).toEqual(['claude']);

        expect(listAvailableHarnesses({
            availability: null,
            happyAgentAvailable: false,
            selected: 'agy',
        }).map((harness) => harness.key)).toEqual(['claude', 'codex']);
    });

    it('falls back to the whole catalog when a machine reports no capabilities', () => {
        expect(listAvailableHarnesses({
            availability: null,
            happyAgentAvailable: false,
            selected: null,
        }).map((harness) => harness.key)).toEqual(['claude', 'codex']);

        expect(listAvailableHarnesses({
            availability: {},
            happyAgentAvailable: false,
            selected: null,
        }).map((harness) => harness.key)).toEqual(['claude', 'codex', 'rig']);
    });
});

// DROVE-316. pi is in the picker at last, and the ORDER of the two events is
// the rule this block exists to keep: the happy-cli runner landed first, and
// only then did `pi` become a NewSessionAgentType and get a slot here. A name
// in HARNESS_ORDER is a promise that the daemon can spawn it, and a promise
// with no runner behind it is a tap that opens a tmux window and then calls a
// session that never appears a success.
describe('pi in the picker', () => {
    it('has a product name rather than a CLI id', () => {
        // A row reading "pi" beside "Claude Code" reads as a typo.
        expect(HARNESS_NAMES.pi).toBe('Pi');
    });

    it('is offered once the daemon reports a pi install', () => {
        const harnesses = listAvailableHarnesses({
            availability: { claude: true, pi: true },
            happyAgentAvailable: false,
            selected: 'claude',
        });
        expect(harnesses.map((h) => h.key)).toEqual(['claude', 'pi']);
        expect(harnesses.map((h) => h.name)).toEqual(['Claude Code', 'Pi']);
    });

    it('is LAST, because it is the specialist', () => {
        const harnesses = listAvailableHarnesses({
            availability: { claude: true, codex: true, cursor: true, pi: true },
            happyAgentAvailable: true,
            selected: 'claude',
        });
        expect(harnesses.map((h) => h.key)).toEqual(['claude', 'codex', 'cursor', 'rig', 'pi']);
    });

    it('is never offered without an explicit installation report', () => {
        // Same rule as Antigravity and Cursor, with a reason of its own: pi is
        // the LOCAL-model harness, so offering it on a machine that has no pi
        // is a spawn that fails after the window has already opened.
        expect(listAvailableHarnesses({
            availability: { claude: true, pi: false },
            happyAgentAvailable: false,
            selected: 'claude',
        }).map((h) => h.key)).toEqual(['claude']);

        expect(listAvailableHarnesses({
            availability: { claude: true },
            happyAgentAvailable: false,
            selected: 'claude',
        }).map((h) => h.key)).toEqual(['claude']);
    });

    it('is not resurrected by a stale draft that still selects it', () => {
        // The "keep the current selection listed" rule is exempted for pi for
        // the same reason it is for Antigravity: the row cannot be turned on
        // from the phone, so showing it strands whoever taps it.
        expect(listAvailableHarnesses({
            availability: { claude: true, pi: false },
            happyAgentAvailable: false,
            selected: 'pi',
        }).map((h) => h.key)).toEqual(['claude']);
    });

    it('is absent from the no-capabilities fallback', () => {
        // An older daemon reports nothing at all. Speculating that it has pi
        // produces exactly the failing tap this whole rule is about.
        expect(listAvailableHarnesses({
            availability: null,
            happyAgentAvailable: false,
            selected: 'pi',
        }).map((h) => h.key)).toEqual(['claude', 'codex']);
    });
});
