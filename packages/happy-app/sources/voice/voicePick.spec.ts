import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SpeechVoice } from 'drover-speech';
import {
    hasNaturalVoice,
    isNoveltyVoice,
    noveltyIdentifierPrefix,
    noveltyVoiceNames,
    parseVoicePickSwift,
    pickVoice,
    sortVoicesByQuality,
    stockCompactIdentifierPrefix,
    voicesForLanguage,
} from './voicePick';

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

/**
 * A stock iPhone with nothing downloaded, as `listVoices()` reports it from a
 * build before 22: no `novelty` or `systemDefault` flags, and the MacinTalk
 * voices iOS 17 added, Albert listed first so listing order alone cannot
 * save the pick (DROVE-390).
 */
const compactPhone: SpeechVoice[] = [
    { identifier: 'com.apple.speech.synthesis.voice.Albert', name: 'Albert', language: 'en-US', quality: 'default' },
    { identifier: 'com.apple.speech.synthesis.voice.BadNews', name: 'Bad News', language: 'en-US', quality: 'default' },
    { identifier: 'com.apple.speech.synthesis.voice.Fred', name: 'Fred', language: 'en-US', quality: 'default' },
    { identifier: 'com.apple.ttsbundle.siri_Nicky_en-US_compact', name: 'Nicky', language: 'en-US', quality: 'default' },
    { identifier: 'com.apple.voice.compact.en-US.Samantha', name: 'Samantha', language: 'en-US', quality: 'default' },
    { identifier: 'com.apple.eloquence.en-US.Eddy', name: 'Eddy', language: 'en-US', quality: 'default' },
    { identifier: 'com.apple.speech.synthesis.voice.Deranged', name: 'Wobble', language: 'en-US', quality: 'default' },
    { identifier: 'com.apple.speech.synthesis.voice.Zarvox', name: 'Zarvox', language: 'en-US', quality: 'default' },
    { identifier: 'com.apple.voice.compact.en-GB.Daniel', name: 'Daniel', language: 'en-GB', quality: 'default' },
];

const samantha = 'com.apple.voice.compact.en-US.Samantha';

/** The same phone on build 22, which flags what iOS itself knows. */
function flagged(voices: SpeechVoice[], systemDefault: string): SpeechVoice[] {
    return voices.map((voice) => ({
        ...voice,
        novelty: voice.identifier.startsWith(noveltyIdentifierPrefix) || undefined,
        systemDefault: voice.identifier === systemDefault || undefined,
    }));
}

describe('pickVoice', () => {
    it('takes the highest quality installed for the language when nothing is chosen', () => {
        const picked = pickVoice(installed, 'en-US', null);
        expect(picked?.quality).toBe('premium');
        // Two premium voices: the tie goes to the one iOS listed first, never
        // to the name. Ava sorts before Zoe and still does not win (DROVE-390).
        expect(picked?.identifier).toBe('com.apple.voice.premium.en-US.Zoe');
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
        expect(pickVoice(installed, 'en-US', 'com.apple.voice.premium.en-US.Evan')?.identifier)
            .toBe('com.apple.voice.premium.en-US.Zoe');
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

describe('pickVoice on a phone with only compact voices (DROVE-390)', () => {
    it('reads with Samantha, not Albert, on a build that sends no flags', () => {
        expect(pickVoice(compactPhone, 'en-US')?.identifier).toBe(samantha);
    });

    it('reads with Samantha on build 22, now as the system default', () => {
        expect(pickVoice(flagged(compactPhone, samantha), 'en-US')?.identifier).toBe(samantha);
    });

    it('does not move when the names change', () => {
        // Every non-novelty voice renamed to sort first: the identifiers are
        // what the tiers read, so the pick is the same voice.
        const renamed = compactPhone.map((voice) => (isNoveltyVoice(voice) ? voice : { ...voice, name: `Aaa ${voice.name}` }));
        expect(pickVoice(renamed, 'en-US')?.identifier).toBe(samantha);
        const premiumsRenamed = installed.map((voice) =>
            voice.name === 'Ava' ? { ...voice, name: 'Aaa' } : voice.name === 'Zoe' ? { ...voice, name: 'Zzz' } : voice,
        );
        expect(pickVoice(premiumsRenamed, 'en-US')?.identifier).toBe('com.apple.voice.premium.en-US.Zoe');
    });

    it('puts the system default ahead of the stock compact voice', () => {
        const nicky = 'com.apple.ttsbundle.siri_Nicky_en-US_compact';
        expect(pickVoice(flagged(compactPhone, nicky), 'en-US')?.identifier).toBe(nicky);
    });

    it('still lets an enhanced or premium voice beat every compact voice, the default included', () => {
        const enhanced: SpeechVoice = { identifier: 'com.apple.voice.enhanced.en-US.Samantha', name: 'Samantha', language: 'en-US', quality: 'enhanced' };
        expect(pickVoice([...flagged(compactPhone, samantha), enhanced], 'en-US')?.identifier).toBe(enhanced.identifier);
    });

    it('never returns a novelty voice at any tier', () => {
        const noveltyOnly = compactPhone.filter((voice) => isNoveltyVoice(voice));
        expect(noveltyOnly.length).toBeGreaterThan(0);
        expect(pickVoice(noveltyOnly, 'en-US')).toBeNull();
        // Even flagged as the system default (the user set Spoken Content to
        // Albert), it is not what replies are read with.
        expect(pickVoice(flagged(compactPhone, 'com.apple.speech.synthesis.voice.Albert'), 'en-US')?.identifier).toBe(samantha);
    });

    it('returns a novelty voice only when the user chose that exact one', () => {
        expect(pickVoice(compactPhone, 'en-US', 'com.apple.speech.synthesis.voice.Zarvox')?.name).toBe('Zarvox');
    });

    it('takes the first non-novelty voice listed when there is no default and no stock compact', () => {
        const [albert, , , nicky, , eddy] = compactPhone;
        expect(pickVoice([albert, eddy, nicky], 'en-US')?.identifier).toBe(eddy.identifier);
    });

    it('widens a region with no voice to the language and still lands on Samantha', () => {
        expect(pickVoice(compactPhone, 'en-AU')?.identifier).toBe(samantha);
    });
});

describe('isNoveltyVoice', () => {
    it('knows a novelty voice by the flag, the identifier shape or the name', () => {
        expect(isNoveltyVoice({ identifier: 'com.apple.voice.compact.en-US.Nova', name: 'Nova', language: 'en-US', quality: 'default', novelty: true })).toBe(true);
        expect(isNoveltyVoice({ identifier: 'com.apple.speech.synthesis.voice.Fred', name: 'Fred', language: 'en-US', quality: 'default' })).toBe(true);
        expect(isNoveltyVoice({ identifier: 'com.apple.voice.compact.en-US.Whisper', name: 'Whisper', language: 'en-US', quality: 'default' })).toBe(true);
    });

    it('does not mistake Samantha or an eloquence voice for one', () => {
        expect(isNoveltyVoice(compactPhone[4])).toBe(false);
        expect(isNoveltyVoice(compactPhone[5])).toBe(false);
    });

    it('names all fifteen novelty voices as iOS displays them', () => {
        expect(noveltyVoiceNames).toContain('Wobble');
        expect(noveltyVoiceNames).toContain('Jester');
        expect(noveltyVoiceNames).toContain('Superstar');
        expect(noveltyVoiceNames).toHaveLength(15);
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

    it('lists the novelty voices after the real ones of the same quality', () => {
        const names = sortVoicesByQuality(voicesForLanguage(compactPhone, 'en-US')).map((voice) => voice.name);
        expect(names.slice(0, 3)).toEqual(['Eddy', 'Nicky', 'Samantha']);
        expect(names[3]).toBe('Albert');
    });

    it('knows when only compact voices are installed for a language', () => {
        expect(hasNaturalVoice(installed, 'en-US')).toBe(true);
        expect(hasNaturalVoice(installed, 'fr-FR')).toBe(false);
        expect(hasNaturalVoice(installed, 'ja-JP')).toBe(false);
    });
});

/**
 * The Swift copy of the rule is pinned to this one (DROVE-390), the way
 * wristNudges.spec.ts pins the phone to the wrist: a list that grows here and
 * not there is a voice the native fallback still reads with.
 */
const speechDir = resolve(__dirname, '../../modules/drover-speech');
const pickSwift = readFileSync(resolve(speechDir, 'ios/DroverVoicePick.swift'), 'utf8');
const moduleSwift = readFileSync(resolve(speechDir, 'ios/DroverSpeechModule.swift'), 'utf8');
const parsed = parseVoicePickSwift(pickSwift);

describe('the Swift pick holds the same rule', () => {
    it('names the same novelty voices, in the same order', () => {
        expect(parsed.noveltyNames).toEqual([...noveltyVoiceNames]);
    });

    it('uses the same identifier shapes', () => {
        expect(parsed.noveltyIdentifierPrefix).toBe(noveltyIdentifierPrefix);
        expect(parsed.stockCompactIdentifierPrefix).toBe(stockCompactIdentifierPrefix);
    });

    it('runs the tiers in order: natural, system default, stock compact, first listed', () => {
        expect(parsed.pickClauses).toHaveLength(4);
        expect(parsed.pickClauses[0]).toMatch(/bestNatural/);
        expect(parsed.pickClauses[1]).toMatch(/systemDefault/);
        expect(parsed.pickClauses[2]).toMatch(/stockCompact/);
        expect(parsed.pickClauses[3]).toMatch(/^return candidates\.first$/);
    });

    it('drops novelty voices before any tier runs', () => {
        const body = pickSwift.match(/static func pick\([\s\S]*?\n    \}/)?.[0] ?? '';
        const filterLine = body.split('\n').findIndex((line) => line.includes('!isNovelty('));
        const firstClause = body.split('\n').findIndex((line) => line.trim().startsWith('if let '));
        expect(filterLine).toBeGreaterThan(0);
        expect(filterLine).toBeLessThan(firstClause);
    });

    it('never lets a name decide, and never sorts', () => {
        expect(parsed.nameOrderings).toEqual([]);
    });

    it('is what the module falls back to, with no name or sort of its own', () => {
        const body = moduleSwift.match(/private func bestVoice\([\s\S]*?\n    \}/)?.[0] ?? '';
        expect(body).toMatch(/DroverVoicePick\.pick\(/);
        expect(body).not.toMatch(/\.name\b/);
        expect(body).not.toMatch(/\.max\b|\.sorted\b|\.sort\(/);
    });

    it('is what listVoices reports the flags from', () => {
        const body = moduleSwift.match(/AsyncFunction\("listVoices"\)[\s\S]*?\n        \}/)?.[0] ?? '';
        expect(body).toMatch(/"novelty"/);
        expect(body).toMatch(/"systemDefault"/);
        expect(body).toMatch(/DroverVoicePick\.isNovelty\(/);
        expect(moduleSwift).toMatch(/AVSpeechSynthesisVoice\(language: /);
    });

    it('is compiled against a fixture list by the speech harness', () => {
        const runner = readFileSync(resolve(speechDir, 'scripts/test-pick.sh'), 'utf8');
        expect(runner).toMatch(/ios\/DroverVoicePick\.swift/);
        expect(runner).toMatch(/tests\/VoicePickTests\.swift/);
        const harness = readFileSync(resolve(speechDir, 'tests/VoicePickTests.swift'), 'utf8');
        expect(harness).toMatch(/Samantha, not Albert/);
    });

    it('is mirrored by the loudness script, which measures the voice the reader uses', () => {
        const script = readFileSync(resolve(__dirname, '../../scripts/render-stream-voice.swift'), 'utf8');
        const body = script.match(/func pickVoice\([\s\S]*?\n\}/)?.[0] ?? '';
        expect(body).toMatch(/isNovelty\(/);
        expect(body).not.toMatch(/\bname\s*[<>]|\.sorted\b/);
    });
});
