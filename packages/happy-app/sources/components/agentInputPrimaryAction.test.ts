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
 * SEND AND THE MIC, ON ONE BUTTON (DROVE-236).
 *
 * Clay: "collapse the send and audio button in a clever way into the same
 * button." The cases below are the whole rule, and the ones that matter are the
 * mid-dictation ones: a partial lands in the composer within a word, so a table
 * that reads `hasComposerContent` first turns the button into Send while the
 * mic is still open and under his thumb.
 */
describe('the collapsed send/mic button, at every composer state', () => {
    const base = {
        hasComposerContent: false,
        isSendBlocked: false,
        isSendDisabled: false,
        showAbortButton: false,
        canAbort: true,
        captureOpen: false,
        canDictate: true,
    };

    it('offers the mic on an empty composer where dictation is available', () => {
        expect(resolveAgentInputPrimaryAction(base)).toBe('mic');
    });

    it('is a disabled send button where dictation is NOT available', () => {
        // DROVE-206's rule for a phone with no recogniser, kept exactly.
        expect(resolveAgentInputPrimaryAction({ ...base, canDictate: false })).toBe('idle');
    });

    it('is SEND the moment there is something to send', () => {
        expect(resolveAgentInputPrimaryAction({ ...base, hasComposerContent: true })).toBe('send');
    });

    it('STAYS THE MIC MID-DICTATION, however much has been transcribed', () => {
        // THE TRAP. Partials land in the composer within a word, so this is the
        // state a naive "text means send" gets wrong, and it gets it wrong
        // under his thumb: the press meant to close the mic sends half a
        // sentence instead.
        expect(resolveAgentInputPrimaryAction({
            ...base,
            captureOpen: true,
            hasComposerContent: true,
        })).toBe('mic');
        // And before the first word, which is the same answer for the same
        // reason rather than by luck.
        expect(resolveAgentInputPrimaryAction({ ...base, captureOpen: true })).toBe('mic');
    });

    it('keeps the mic reachable while the agent works, so a latch can be closed', () => {
        // An open capture outranks Stop. Stop has the control row and the
        // header; a mic he opened has only the control that opened it.
        expect(resolveAgentInputPrimaryAction({
            ...base,
            captureOpen: true,
            showAbortButton: true,
        })).toBe('mic');
    });

    it('does not let a blocked gate or a disabled send hide an open mic', () => {
        expect(resolveAgentInputPrimaryAction({
            ...base,
            captureOpen: true,
            hasComposerContent: true,
            isSendBlocked: true,
        })).toBe('mic');
        expect(resolveAgentInputPrimaryAction({
            ...base,
            captureOpen: true,
            isSendDisabled: true,
        })).toBe('mic');
    });

    it('still gives Stop the empty composer while the agent is working', () => {
        // The mic is BELOW stop, deliberately: a blank composer mid-turn is the
        // one moment the thing wanted is a halt.
        expect(resolveAgentInputPrimaryAction({
            ...base,
            showAbortButton: true,
        })).toBe('stop');
    });

    it('never offers a mic the surface cannot open', () => {
        expect(resolveAgentInputPrimaryAction({
            ...base,
            canDictate: true,
            isSendDisabled: true,
        })).toBe('idle');
    });

    it('is never SEND unless there is content and the capture is closed', () => {
        // The DROVE-206 guarantee, stated as an invariant rather than as a list
        // of faces: the paper plane is drawn if and only if this returns
        // 'send', so a press on a plane always sends.
        const flags = [false, true];
        for (const hasComposerContent of flags) {
            for (const captureOpen of flags) {
                for (const isSendBlocked of flags) {
                    for (const isSendDisabled of flags) {
                        for (const showAbortButton of flags) {
                            for (const canDictate of flags) {
                                const action = resolveAgentInputPrimaryAction({
                                    ...base,
                                    hasComposerContent,
                                    captureOpen,
                                    isSendBlocked,
                                    isSendDisabled,
                                    showAbortButton,
                                    canDictate,
                                });
                                if (action === 'send') {
                                    expect(hasComposerContent).toBe(true);
                                    expect(captureOpen).toBe(false);
                                    expect(isSendBlocked).toBe(false);
                                    expect(isSendDisabled).toBe(false);
                                }
                                if (captureOpen) expect(action).toBe('mic');
                            }
                        }
                    }
                }
            }
        }
    });
});
