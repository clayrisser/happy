import { describe, expect, it } from 'vitest';
import { resolveAgentInputPrimaryAction } from './agentInputPrimaryAction';

describe('resolveAgentInputPrimaryAction', () => {
    const base = {
        hasComposerContent: false,
        isSendBlocked: false,
        isSendDisabled: false,
        showAbortButton: false,
        canAbort: true,
    };

    it('shows Stop for a blank composer while the agent is thinking', () => {
        expect(resolveAgentInputPrimaryAction({
            ...base,
            showAbortButton: true,
        })).toBe('stop');
    });

    it('switches to Send as soon as a follow-up has content', () => {
        expect(resolveAgentInputPrimaryAction({
            ...base,
            hasComposerContent: true,
            showAbortButton: true,
        })).toBe('send');
    });

    it('does not show Stop when there is no abort handler', () => {
        expect(resolveAgentInputPrimaryAction({
            ...base,
            showAbortButton: true,
            canAbort: false,
        })).toBe('idle');
    });

    it('keeps an empty idle composer inactive', () => {
        expect(resolveAgentInputPrimaryAction(base)).toBe('idle');
    });

    /**
     * DROVE-206. The button used to become the waveform on an empty composer,
     * so the same spot on the screen was send or boss mode depending on what
     * you had typed. Clay: "the boss should not be in the message box… we
     * should have a send button, proper button." The waveform is a control of
     * its own on the row now, and an empty composer leaves this one DISABLED
     * rather than repurposed.
     *
     * There is no `canVoice` left to pass. These are the cases that used to
     * resolve to `voice`, asserted to reach `idle` instead, so the removal is
     * pinned rather than merely deleted.
     */
    it('leaves a send button disabled on an empty composer, never a waveform', () => {
        expect(resolveAgentInputPrimaryAction(base)).toBe('idle');
        // With an abort in flight the slot is Stop, which is the ONE face that
        // is genuinely another action, and it only appears while the agent is
        // working on a composer with nothing in it.
        expect(resolveAgentInputPrimaryAction({ ...base, showAbortButton: true })).toBe('stop');
        // Type one character and it is a live send button again.
        expect(resolveAgentInputPrimaryAction({ ...base, hasComposerContent: true })).toBe('send');
    });

    it('never resolves to a face the send button no longer has', () => {
        const cases = [
            base,
            { ...base, hasComposerContent: true },
            { ...base, showAbortButton: true },
            { ...base, isSendBlocked: true, hasComposerContent: true },
            { ...base, isSendDisabled: true },
            { ...base, showAbortButton: true, canAbort: false },
        ];
        for (const input of cases) {
            expect(['send', 'stop', 'blocked', 'idle'])
                .toContain(resolveAgentInputPrimaryAction(input));
        }
    });

    it('still offers Stop for a blank composer when steering is blocked', () => {
        expect(resolveAgentInputPrimaryAction({
            ...base,
            isSendBlocked: true,
            showAbortButton: true,
        })).toBe('stop');
    });

    it('preserves the blocked-send affordance for content', () => {
        expect(resolveAgentInputPrimaryAction({
            ...base,
            hasComposerContent: true,
            isSendBlocked: true,
            showAbortButton: true,
        })).toBe('blocked');
    });
});
