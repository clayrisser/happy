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

/**
 * SEND AND THE MIC, ON TWO BUTTONS AGAIN (DROVE-264, reversing DROVE-236).
 *
 * Clay: "I don't think we should combine the send and the microphone button
 * because I might wanna type some stuff and then hit the microphone and then
 * say some stuff."
 *
 * WHAT THESE CASES ARE FOR, now that the mic is not one of the answers. The
 * DROVE-236 suite spent most of its length on the mid-dictation states, because
 * a partial lands in the composer within a word and a table reading
 * `hasComposerContent` first turned the button into Send while the mic was open
 * under his thumb. The mic is its own control now, so that trap has no subject
 * and its guard is gone from the table. What is left to pin is that removing
 * the guard did not remove the GUARANTEE: the plane is drawn if and only if a
 * press sends.
 */
describe('the send button, at every composer state', () => {
    const base = {
        hasComposerContent: false,
        isSendBlocked: false,
        isSendDisabled: false,
        showAbortButton: false,
        canAbort: true,
    };

    it('is a disabled send button on an empty composer, not a mic', () => {
        // DROVE-206's rule, back where it was: an empty composer draws a send
        // button that cannot fire. DROVE-236 had this returning `mic`; the mic
        // is beside it now, so the empty composer's answer is what this file
        // always claimed it was.
        expect(resolveAgentInputPrimaryAction(base)).toBe('idle');
    });

    it('is SEND the moment there is something to send', () => {
        expect(resolveAgentInputPrimaryAction({ ...base, hasComposerContent: true })).toBe('send');
    });

    it('SENDS DICTATED WORDS, which is the whole reason the two came apart', () => {
        // Clay's composition: type a bit, dictate the rest, send. The words in
        // the field are the words in the field however they got there, so a
        // capture being open changes nothing here. Under DROVE-236 this state
        // returned `mic` and the press closed the capture instead.
        expect(resolveAgentInputPrimaryAction({ ...base, hasComposerContent: true })).toBe('send');
    });

    it('still gives Stop the empty composer while the agent is working', () => {
        expect(resolveAgentInputPrimaryAction({ ...base, showAbortButton: true })).toBe('stop');
    });

    it('lets a follow-up outrank Stop, so a message can be queued mid-turn', () => {
        expect(resolveAgentInputPrimaryAction({
            ...base,
            hasComposerContent: true,
            showAbortButton: true,
        })).toBe('send');
    });

    it('says a blocked gate rather than hiding it', () => {
        expect(resolveAgentInputPrimaryAction({
            ...base,
            hasComposerContent: true,
            isSendBlocked: true,
        })).toBe('blocked');
    });

    it('has no mic face left at all, at any combination of flags', () => {
        // The claim the split makes structural. DROVE-236 defended "a plane
        // means a press sends" with an ordering inside this function; it is now
        // defended by there being nothing else this can return.
        const flags = [false, true];
        for (const hasComposerContent of flags) {
            for (const isSendBlocked of flags) {
                for (const isSendDisabled of flags) {
                    for (const showAbortButton of flags) {
                        for (const canAbort of flags) {
                            const action = resolveAgentInputPrimaryAction({
                                hasComposerContent,
                                isSendBlocked,
                                isSendDisabled,
                                showAbortButton,
                                canAbort,
                            });
                            expect(['send', 'stop', 'blocked', 'idle']).toContain(action);
                            if (action === 'send') {
                                expect(hasComposerContent).toBe(true);
                                expect(isSendBlocked).toBe(false);
                                expect(isSendDisabled).toBe(false);
                            }
                        }
                    }
                }
            }
        }
    });
});
