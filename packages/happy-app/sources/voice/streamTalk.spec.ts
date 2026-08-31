import { describe, expect, it } from 'vitest';
import { flipStreamTalk, streamTalkButton, streamTalkIcon, streamTalkPauseToast } from './streamTalk';
import { applyLocalSettings, localSettingsDefaults, localSettingsParse } from '@/sync/localSettings';
import { settingsDefaults } from '@/sync/settings';
import { en } from '@/text/_default';

describe('streamTalkButton', () => {
    it('is hidden when the surface has no reader', () => {
        const button = streamTalkButton(undefined);
        expect(button.shown).toBe(false);
        expect(button.on).toBe(false);
    });

    it('draws a filled speaker when stream-talk is on', () => {
        const button = streamTalkButton(true);
        expect(button).toEqual({
            shown: true,
            on: true,
            paused: false,
            icon: 'volume-high',
            filled: true,
            labelKey: 'agentInput.streamTalk.on',
        });
    });

    it('draws a slashed speaker when stream-talk is off', () => {
        const button = streamTalkButton(false);
        expect(button).toEqual({
            shown: true,
            on: false,
            paused: false,
            icon: 'volume-mute-outline',
            filled: false,
            labelKey: 'agentInput.streamTalk.off',
        });
    });

    it('uses the same icon rule the sheet and the settings row can share', () => {
        expect(streamTalkIcon(true)).toBe('volume-high');
        expect(streamTalkIcon(false)).toBe('volume-mute-outline');
    });
});

/**
 * Three states on one control, on the two carriers it already had (DROVE-233).
 *
 * The GLYPH says whether read-aloud is on. The FILL says whether it is reading
 * right now, which is DROVE-215's rule that a colour names something happening.
 * No new hue is introduced, and that is the assertion worth pinning: paused is
 * drawn in exactly the colours off is drawn in, and told apart by its shape.
 */
describe('the speaker button paused (DROVE-233)', () => {
    it('keeps the ON glyph while paused, because paused is on', () => {
        const button = streamTalkButton(true, true);
        expect(button.on).toBe(true);
        expect(button.paused).toBe(true);
        expect(button.icon).toBe('volume-high');
    });

    it('takes the fill OFF while paused, because nothing is happening', () => {
        // DROVE-215: colour on this row means something is happening right
        // now. A paused reader is not happening, so the accent disc goes.
        expect(streamTalkButton(true, true).filled).toBe(false);
        expect(streamTalkButton(true, false).filled).toBe(true);
    });

    it('invents no hue: paused wears exactly what off wears', () => {
        const paused = streamTalkButton(true, true);
        const off = streamTalkButton(false);
        expect(paused.filled).toBe(off.filled);
    });

    it('tells paused from off by the SHAPE, which is what shapes are for', () => {
        expect(streamTalkButton(true, true).icon).not.toBe(streamTalkButton(false).icon);
    });

    it('narrows the fill rather than changing it: on and idle is drawn as it was', () => {
        // The common case has to be untouched, or every session looks different
        // for a feature most presses never reach.
        expect(streamTalkButton(true, false).filled).toBe(true);
        expect(streamTalkButton(true).filled).toBe(true);
    });

    it('never reports paused beside an off reader', () => {
        const button = streamTalkButton(false, true);
        expect(button.paused).toBe(false);
        expect(button.filled).toBe(false);
        expect(button.icon).toBe('volume-mute-outline');
    });

    it('is three distinct readings, not two and a half', () => {
        const drawings = [
            streamTalkButton(false),
            streamTalkButton(true, true),
            streamTalkButton(true, false),
        ].map((b) => `${b.icon}/${b.filled}`);
        expect(new Set(drawings).size).toBe(3);
    });

    it('reads each state out to a screen reader as its own line', () => {
        expect(streamTalkButton(false).labelKey).toBe('agentInput.streamTalk.off');
        expect(streamTalkButton(true, true).labelKey).toBe('agentInput.streamTalk.paused');
        expect(streamTalkButton(true, false).labelKey).toBe('agentInput.streamTalk.on');
    });

    it('names the long press in its toast', () => {
        expect(streamTalkPauseToast(true)).toBe('agentInput.streamTalk.paused');
        expect(streamTalkPauseToast(false)).toBe('agentInput.streamTalk.resumed');
    });

    it('has a string for both, in the default text', () => {
        expect(en.agentInput.streamTalk.paused.length).toBeGreaterThan(0);
        expect(en.agentInput.streamTalk.resumed.length).toBeGreaterThan(0);
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
        // The composer button, the channel sheet row and the settings switch
        // all write localSettings.readAloudEnabled through useLocalSettingMutable;
        // there is no second key for the composer to drift from.
        expect(localSettingsDefaults.readAloudEnabled).toBe(false);
        const on = applyLocalSettings(localSettingsDefaults, { readAloudEnabled: flipStreamTalk(false).readAloudEnabled });
        expect(on.readAloudEnabled).toBe(true);
        expect(localSettingsParse(on).readAloudEnabled).toBe(true);
        const off = applyLocalSettings(on, { readAloudEnabled: flipStreamTalk(on.readAloudEnabled).readAloudEnabled });
        expect(off.readAloudEnabled).toBe(false);
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
