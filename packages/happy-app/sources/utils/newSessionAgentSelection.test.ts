import { describe, expect, it } from 'vitest';

import { resolveMachineAgent } from './newSessionAgentSelection';

describe('resolveMachineAgent', () => {
    it('replaces a stale Claude draft with the installed Codex CLI', () => {
        expect(resolveMachineAgent('claude', {
            claude: false,
            codex: true,
            openclaw: false,
            gemini: false,
        })).toBe('codex');
    });

    it('keeps an installed selection', () => {
        expect(resolveMachineAgent('codex', {
            claude: true,
            codex: true,
        })).toBe('codex');
    });

    it('selects Rig on a Rig-only machine', () => {
        expect(resolveMachineAgent('claude', {
            rig: true,
            claude: false,
            codex: false,
        })).toBe('rig');
    });

    it('keeps the persisted selection when capability metadata is missing', () => {
        expect(resolveMachineAgent('claude', undefined)).toBe('claude');
    });

    it('keeps the persisted selection when no CLI is reported', () => {
        expect(resolveMachineAgent('claude', {
            claude: false,
            codex: false,
            openclaw: false,
            gemini: false,
        })).toBe('claude');
    });

    // OpenClaw is shelved, so a draft pointing at it has to move even though
    // the binary is still on the machine.
    it('migrates off a retired harness whose CLI is still installed', () => {
        expect(resolveMachineAgent('openclaw', {
            openclaw: true,
            claude: true,
            codex: true,
        })).toBe('claude');

        expect(resolveMachineAgent('openclaw', {
            openclaw: true,
            codex: true,
        })).toBe('codex');
    });

    it('migrates off a retired harness when capability metadata is missing', () => {
        expect(resolveMachineAgent('openclaw', undefined)).toBe('claude');
    });

    // Gemini used to be the other half of both cases above. DROVE-381 un-retired
    // it, so a draft on gemini now STAYS on gemini where the CLI is reported —
    // migrating it would be the stale-draft bug pointed the other way.
    it('leaves a gemini draft alone now that gemini is offered again', () => {
        expect(resolveMachineAgent('gemini', {
            gemini: true,
            claude: true,
            codex: true,
        })).toBe('gemini');

        // Still replaced when the machine says it has no gemini, by the same
        // rule that moves any other uninstalled selection.
        expect(resolveMachineAgent('gemini', {
            gemini: false,
            claude: true,
        })).toBe('claude');
    });
});
