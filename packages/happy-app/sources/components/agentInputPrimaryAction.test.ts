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

    it('falls back to boss mode on an empty composer when a call is available', () => {
        expect(resolveAgentInputPrimaryAction({
            ...base,
            canVoice: true,
        })).toBe('voice');
    });

    /**
     * DROVE-210. This used to be one action for two different things: the
     * button drew a waveform and a tap started an ElevenLabs call, while this
     * file's comment and this test both said dictation. On a phone that can
     * dictate, the biggest button on an empty composer is the microphone.
     */
    it('shows the microphone on an empty composer when dictation is available', () => {
        expect(resolveAgentInputPrimaryAction({
            ...base,
            canDictate: true,
        })).toBe('mic');
    });

    it('puts the microphone ahead of a boss-mode call', () => {
        expect(resolveAgentInputPrimaryAction({
            ...base,
            canDictate: true,
            canVoice: true,
        })).toBe('mic');
    });

    /**
     * `canVoice` is false for every second the session reads disconnected,
     * and DROVE-179 measured that flipping on any reconnect blip. That left
     * the primary `idle`, which draws a DISABLED button: the tap fires
     * nothing at all, no shake and no haptic. Dictation does not care about
     * the transport, so the mic face holds through the blip.
     */
    it('keeps the microphone through a blip that takes the call away', () => {
        expect(resolveAgentInputPrimaryAction({
            ...base,
            canDictate: true,
            canVoice: false,
        })).toBe('mic');
    });

    it('keeps Stop ahead of both voice faces while the agent is thinking', () => {
        expect(resolveAgentInputPrimaryAction({
            ...base,
            showAbortButton: true,
            canVoice: true,
        })).toBe('stop');
        expect(resolveAgentInputPrimaryAction({
            ...base,
            showAbortButton: true,
            canDictate: true,
        })).toBe('stop');
    });

    it('keeps Send ahead of both voice faces once there is content', () => {
        expect(resolveAgentInputPrimaryAction({
            ...base,
            hasComposerContent: true,
            canVoice: true,
        })).toBe('send');
        expect(resolveAgentInputPrimaryAction({
            ...base,
            hasComposerContent: true,
            canDictate: true,
        })).toBe('send');
    });

    /**
     * Dictation writes its partials into the composer, so a live capture makes
     * `hasComposerContent` true within a word or two. Without this the button
     * turned into Send under the thumb and the next tap fired a half-spoken
     * sentence with the mic still running (DROVE-210).
     */
    it('keeps the microphone while the mic is open, even with words in the composer', () => {
        expect(resolveAgentInputPrimaryAction({
            ...base,
            hasComposerContent: true,
            canDictate: true,
            micLive: true,
        })).toBe('mic');
    });

    it('keeps the microphone while the mic is open, even while the agent is thinking', () => {
        expect(resolveAgentInputPrimaryAction({
            ...base,
            showAbortButton: true,
            canDictate: true,
            micLive: true,
        })).toBe('mic');
    });

    it('goes back to Send the moment the mic closes', () => {
        expect(resolveAgentInputPrimaryAction({
            ...base,
            hasComposerContent: true,
            canDictate: true,
            micLive: false,
        })).toBe('send');
    });

    it('a live mic on a surface with no mic control changes nothing', () => {
        expect(resolveAgentInputPrimaryAction({
            ...base,
            hasComposerContent: true,
            micLive: true,
        })).toBe('send');
    });

    it('offers nothing at all when sending is disabled, mic included', () => {
        expect(resolveAgentInputPrimaryAction({
            ...base,
            isSendDisabled: true,
            canDictate: true,
            canVoice: true,
        })).toBe('idle');
    });

    it('still offers Stop for a blank composer when steering is blocked', () => {
        expect(resolveAgentInputPrimaryAction({
            ...base,
            isSendBlocked: true,
            showAbortButton: true,
            canVoice: true,
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
