import { describe, expect, it } from 'vitest';
import type { SpeechVoice } from 'drover-speech';
import { hasNaturalVoice, pickVoice, sortVoicesByQuality, voicesForLanguage } from './voicePick';

/** What an iPhone with a couple of downloads reports, identifiers as iOS names them. */
const installed: SpeechVoice[] = [
    { identifier: 'com.apple.ttsbundle.siri_Nicky_en-US_compact', name: 'Nicky', language: 'en-US', quality: 'default' },
    { identifier: 'com.apple.voice.compact.en-US.Samantha', name: 'Samantha', language: 'en-US', quality: 'default' },
    { identifier: 'com.apple.voice.enhanced.en-US.Samantha', name: 'Samantha', language: 'en-US', quality: 'enhanced' },
    { identifier: 'com.apple.voice.premium.en-US.Zoe', name: 'Zoe', language: 'en-US', quality: 'premium' },
    { identifier: 'com.apple.voice.premium.en-US.Ava', name: 'Ava', language: 'en-US', quality: 'premium' },
    { identifier: 'com.apple.voice.enhanced.en-GB.Daniel', name: 'Daniel', language: 'en-GB', quality: 'enhanced' },
    { identifier: 'com.apple.voice.compact.fr-FR.Thomas', name: 'Thomas', language: 'fr-FR', quality: 'default' },
    { identifier: 'com.apple.voice.compact.de-DE.Anna', name: 'Anna', language: 'de-DE', quality: 'default' },
];

describe('pickVoice', () => {
    it('takes the highest quality installed for the language when nothing is chosen', () => {
        const picked = pickVoice(installed, 'en-US', null);
        expect(picked?.quality).toBe('premium');
        // Two premium voices: the tie is broken by name so the pick is stable.
        expect(picked?.name).toBe('Ava');
    });

    it('falls to enhanced when there is no premium voice', () => {
        const noPremium = installed.filter((voice) => voice.quality !== 'premium');
        expect(pickVoice(noPremium, 'en-US')?.identifier).toBe('com.apple.voice.enhanced.en-US.Samantha');
    });

    it('falls to the compact default when that is all there is', () => {
        expect(pickVoice(installed, 'fr-FR')?.name).toBe('Thomas');
    });

    it('prefers the chosen voice even over a better one', () => {
        expect(pickVoice(installed, 'en-US', 'com.apple.voice.enhanced.en-US.Samantha')?.name).toBe('Samantha');
    });

    it('honours a chosen voice from another region of the same language', () => {
        expect(pickVoice(installed, 'en-US', 'com.apple.voice.enhanced.en-GB.Daniel')?.name).toBe('Daniel');
    });

    it('ignores a chosen voice that is not installed here', () => {
        expect(pickVoice(installed, 'en-US', 'com.apple.voice.premium.en-US.Evan')?.name).toBe('Ava');
    });

    it('matches a bare language or an underscore tag to the same region', () => {
        expect(pickVoice(installed, 'en')?.quality).toBe('premium');
        expect(pickVoice(installed, 'en_GB')?.name).toBe('Daniel');
        expect(pickVoice(installed, 'en-AU')?.quality).toBe('premium');
    });

    it('returns null when the language has no voice at all', () => {
        expect(pickVoice(installed, 'ja-JP')).toBeNull();
        expect(pickVoice(installed, null)).toBeNull();
        expect(pickVoice([], 'en-US')).toBeNull();
    });
});

describe('voicesForLanguage and hasNaturalVoice', () => {
    it('lists the exact region first and widens to the language only when it must', () => {
        expect(voicesForLanguage(installed, 'en-US').map((voice) => voice.language)).toEqual(['en-US', 'en-US', 'en-US', 'en-US', 'en-US']);
        expect(voicesForLanguage(installed, 'en-AU').map((voice) => voice.name)).toContain('Daniel');
    });

    it('orders premium, enhanced, then default', () => {
        expect(sortVoicesByQuality(voicesForLanguage(installed, 'en-US')).map((voice) => voice.quality))
            .toEqual(['premium', 'premium', 'enhanced', 'default', 'default']);
    });

    it('knows when only compact voices are installed for a language', () => {
        expect(hasNaturalVoice(installed, 'en-US')).toBe(true);
        expect(hasNaturalVoice(installed, 'fr-FR')).toBe(false);
        expect(hasNaturalVoice(installed, 'ja-JP')).toBe(false);
    });
});
