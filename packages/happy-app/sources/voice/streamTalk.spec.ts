import { describe, expect, it } from 'vitest';
import { audioOutToast, flipStreamTalk, streamTalkIcon, streamTalkPauseToast } from './streamTalk';
import { transportEffect } from './readAloudTransport';
import { applyLocalSettings, localSettingsDefaults, localSettingsParse } from '@/sync/localSettings';
import { settingsDefaults } from '@/sync/settings';
import { en } from '@/text/_default';

/**
 * The button's own drawing moved to `components/composerAudioOut.spec.ts` when
 * the speaker and the waveform became one control (DROVE-236). What is left
 * here is read-aloud's half: the glyph pair, the tap's flip and the toasts.
 */
describe('the read-aloud half of the audio-out button', () => {
    it('draws waves on and a slash off, which is the glyph both models read', () => {
        expect(streamTalkIcon(true)).toBe('volume-high');
        expect(streamTalkIcon(false)).toBe('volume-mute-outline');
    });

    it('names the long press in its toast', () => {
        expect(streamTalkPauseToast(true)).toBe('agentInput.streamTalk.paused');
        expect(streamTalkPauseToast(false)).toBe('agentInput.streamTalk.resumed');
    });

    it('has a string for both, in the default text', () => {
        expect(en.agentInput.streamTalk.paused.length).toBeGreaterThan(0);
        expect(en.agentInput.streamTalk.resumed.length).toBeGreaterThan(0);
    });

    it('has a string for the three the collapse added (DROVE-236)', () => {
        expect(en.agentInput.audioOut.boss.length).toBeGreaterThan(0);
        expect(en.agentInput.audioOut.micStart.length).toBeGreaterThan(0);
        expect(en.agentInput.audioOut.micStop.length).toBeGreaterThan(0);
    });
});

describe('flipStreamTalk', () => {
    it('turns it on and says so', () => {
        expect(flipStreamTalk(false)).toEqual({ readAloudEnabled: true, toastKey: 'agentInput.streamTalk.on' });
    });

    it('turns it off and says so', () => {
        expect(flipStreamTalk(true)).toEqual({ readAloudEnabled: false, toastKey: 'agentInput.streamTalk.off' });
    });

    it('flips the one local key the sheet and Settings > Voice flip', () => {
        // The channel sheet row and the settings switch write
        // localSettings.readAloudEnabled through useLocalSettingMutable, and
        // since DROVE-297 that key is the DEFAULT a session inherits rather
        // than the switch on any one of them. The composer's control writes
        // the session's own switch on the reader instead, which is why turning
        // reading on in one session no longer turns it on in every other.
        expect(localSettingsDefaults.readAloudEnabled).toBe(false);
        const on = applyLocalSettings(localSettingsDefaults, { readAloudEnabled: flipStreamTalk(false).readAloudEnabled });
        expect(on.readAloudEnabled).toBe(true);
        expect(localSettingsParse(on).readAloudEnabled).toBe(true);
        const off = applyLocalSettings(on, { readAloudEnabled: flipStreamTalk(on.readAloudEnabled).readAloudEnabled });
        expect(off.readAloudEnabled).toBe(false);
    });
});

/**
 * ONE TOAST FOR BOTH GESTURES (DROVE-327). The tap goes through the transport
 * table now, so it can resume as well as start or stop, and the toast is named
 * from the EFFECT rather than from which gesture it was. A tap on a paused
 * reader used to toast "Not reading replies aloud" — and meant it.
 */
describe('audioOutToast', () => {
    it('names each read-aloud effect, whichever gesture caused it', () => {
        expect(audioOutToast('turn-on')).toBe('agentInput.streamTalk.on');
        expect(audioOutToast('turn-off')).toBe('agentInput.streamTalk.off');
        expect(audioOutToast('pause')).toBe('agentInput.streamTalk.paused');
        expect(audioOutToast('resume')).toBe('agentInput.streamTalk.resumed');
    });

    it('says nothing for a call or a no-op: those are not read-aloud news', () => {
        expect(audioOutToast('boss-mode')).toBeNull();
        expect(audioOutToast('nothing')).toBeNull();
    });

    it('teaches the sentence tap on the way on, once, like the flip did (DROVE-195)', () => {
        expect(audioOutToast('turn-on', false)).toBe('agentInput.streamTalk.onHint');
        expect(audioOutToast('turn-on', true)).toBe('agentInput.streamTalk.on');
        // And only on the way on: resuming is not the moment the gesture
        // becomes available, it already was.
        expect(audioOutToast('resume', false)).toBe('agentInput.streamTalk.resumed');
        expect(audioOutToast('turn-off', false)).toBe('agentInput.streamTalk.off');
    });

    it('a tap on a paused reader says RESUMED, never off (DROVE-327)', () => {
        const tapOnPaused = transportEffect('tap', 'paused');
        expect(audioOutToast(tapOnPaused)).toBe('agentInput.streamTalk.resumed');
        expect(audioOutToast(tapOnPaused)).not.toBe('agentInput.streamTalk.off');
    });

    it('agrees with the long press toast it replaced', () => {
        expect(audioOutToast('pause')).toBe(streamTalkPauseToast(true));
        expect(audioOutToast('resume')).toBe(streamTalkPauseToast(false));
    });
});

/**
 * DROVE-100: the toast has to say which of the two audio settings moved, or
 * the button reads as the one on the channel sheet that speaks prompts.
 */
describe('the toast names what it flipped', () => {
    it('says it is reading replies, not a bare on', () => {
        expect(en.agentInput.streamTalk.on).toBe('Reading replies aloud');
        expect(en.agentInput.streamTalk.off).toBe('Not reading replies aloud');
    });

    it('uses the same words as the read-replies row on the channel sheet', () => {
        expect(en.agentInput.channels.readReplies).toBe('Read replies aloud');
        expect(en.agentInput.streamTalk.on).toContain('replies aloud');
    });

    it('never flips the drover audio channel', () => {
        // The button writes readAloudEnabled and nothing else; droverAnnounceAudio
        // is synced and only the "Speak prompts when they arrive" row moves it.
        const flipped = flipStreamTalk(false);
        expect(Object.keys(flipped)).toEqual(['readAloudEnabled', 'toastKey']);
        expect(settingsDefaults.droverAnnounceAudio).toBe(false);
    });
});

/**
 * THE GESTURE ANNOUNCES ITSELF, ONCE (DROVE-195).
 *
 * DROVE-163 moved "read from this sentence" from a double tap to a single one
 * and told nobody, so Clay kept double-tapping and reported the feature broken.
 * It was not broken. The toast that fires when he turns reading on is the one
 * moment the gesture becomes available, so that is where it is said, and using
 * the gesture once retires the line.
 */
describe('the toast teaches the sentence tap until it has been used', () => {
    it('hints on the first time reading is turned on', () => {
        expect(flipStreamTalk(false, false)).toEqual({
            readAloudEnabled: true,
            toastKey: 'agentInput.streamTalk.onHint',
        });
    });

    it('goes back to the plain line once he has tapped a sentence', () => {
        expect(flipStreamTalk(false, true).toastKey).toBe('agentInput.streamTalk.on');
    });

    it('never hints on the way off, where the gesture is not the news', () => {
        expect(flipStreamTalk(true, false).toastKey).toBe('agentInput.streamTalk.off');
        expect(flipStreamTalk(true, true).toastKey).toBe('agentInput.streamTalk.off');
    });

    it('says the gesture in his words: one tap, on a sentence', () => {
        expect(en.agentInput.streamTalk.onHint).toBe(
            'Reading replies aloud. Tap a sentence to read from there',
        );
        // The plain line is still inside it, so the two never disagree about
        // what turning it on did.
        expect(en.agentInput.streamTalk.onHint).toContain(en.agentInput.streamTalk.on);
    });

    it('remembers on the device, off by default, and is not a preference', () => {
        expect(localSettingsDefaults.sentenceTapUsed).toBe(false);
        const used = applyLocalSettings(localSettingsDefaults, { sentenceTapUsed: true });
        expect(used.sentenceTapUsed).toBe(true);
        expect(localSettingsParse(used).sentenceTapUsed).toBe(true);
    });
});
