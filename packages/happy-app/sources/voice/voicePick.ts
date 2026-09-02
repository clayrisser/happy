import type { SpeechVoice, SpeechVoiceQuality } from 'drover-speech';

/**
 * Choosing the voice that reads a reply (DROVE-97, DROVE-390).
 *
 * iOS speaks with the compact default voice for the locale unless told
 * otherwise, and that is the robotic one. Every iPhone can hold enhanced
 * and premium voices for the same language, so the pick is: the voice the
 * user chose if it is installed, else the best quality installed for the
 * language, else nothing (and the synthesiser picks its own default).
 *
 * WHAT DROVE-390 CHANGED. The quality tie used to go to the NAME, and on a
 * phone with no enhanced or premium en-US voice every voice is a tie, the
 * novelty voices included since iOS 17: Albert comes first alphabetically,
 * so read-aloud spoke in a joke voice eight dB under Samantha. Now a novelty
 * voice is never picked at any tier (the user can still choose one), and
 * inside one quality the order is the language's system default, then the
 * stock compact voice, then whatever the phone listed first. No name
 * comparison anywhere.
 *
 * Pure so the rule is testable on a fixture list. Native holds the same rule
 * in modules/drover-speech/ios/DroverVoicePick.swift for a caller that passes
 * no identifier, and voicePick.spec.ts parses that file so the two cannot
 * drift.
 */

const qualityRank: Record<SpeechVoiceQuality, number> = {
    premium: 3,
    enhanced: 2,
    default: 1,
};

/**
 * The novelty voices as iOS 17 and 26 DISPLAY them, which is not always the
 * identifier tail (Deranged shows as Wobble, Hysterical as Jester, Princess
 * as Superstar). The same list as DroverVoicePick.noveltyNames, and the spec
 * holds them equal. Belt and braces for a `listVoices()` from a build before
 * 22, which sends no `novelty` flag.
 */
export const noveltyVoiceNames: readonly string[] = [
    'Albert', 'Bad News', 'Bahh', 'Bells', 'Boing', 'Bubbles', 'Cellos',
    'Good News', 'Jester', 'Organ', 'Superstar', 'Trinoids', 'Whisper',
    'Wobble', 'Zarvox',
];

/**
 * Every MacinTalk-era voice lives under this prefix, novelty or not: Fred,
 * Junior, Kathy and Ralph are the same 1990s family without the joke, and
 * none of them is a reading voice.
 */
export const noveltyIdentifierPrefix = 'com.apple.speech.synthesis.voice.';

/**
 * The compact voice iOS ships for a language, `com.apple.voice.compact.<tag>.<Name>`,
 * as against a Siri (`com.apple.ttsbundle.siri_*`), eloquence or super-compact one.
 */
export const stockCompactIdentifierPrefix = 'com.apple.voice.compact.';

/** Never read with, unless the user chose it by identifier. */
export function isNoveltyVoice(voice: SpeechVoice): boolean {
    if (voice.novelty === true) return true;
    if (voice.identifier.startsWith(noveltyIdentifierPrefix)) return true;
    return voice.quality === 'default' && noveltyVoiceNames.includes(voice.name);
}

function normalizeTag(tag: string): string {
    return tag.trim().replace(/_/g, '-').toLowerCase();
}

function primarySubtag(tag: string): string {
    return normalizeTag(tag).split('-')[0];
}

/**
 * The voices that can speak `language`: an exact tag match when there is
 * one (`en-US`), otherwise anything in the same language (`en-GB`, `en-AU`).
 */
export function voicesForLanguage(voices: SpeechVoice[], language: string | null | undefined): SpeechVoice[] {
    if (!language) return [];
    const wanted = normalizeTag(language);
    const exact = voices.filter((voice) => normalizeTag(voice.language) === wanted);
    if (exact.length > 0) return exact;
    const primary = primarySubtag(language);
    return voices.filter((voice) => primarySubtag(voice.language) === primary);
}

/**
 * The order a LIST on screen shows: best quality first, novelty voices at the
 * bottom of their quality, then by name so the list reads the same each
 * visit. The pick does not use it; a name never decides what is read with.
 */
export function sortVoicesByQuality(voices: SpeechVoice[]): SpeechVoice[] {
    return [...voices].sort((a, b) => {
        const rank = qualityRank[b.quality] - qualityRank[a.quality];
        if (rank !== 0) return rank;
        const novelty = Number(isNoveltyVoice(a)) - Number(isNoveltyVoice(b));
        if (novelty !== 0) return novelty;
        return a.name.localeCompare(b.name);
    });
}

/**
 * Premium over enhanced; inside one quality the system default when it is
 * one of them, else the first listed. Null when only compact voices are
 * installed for the language.
 */
function bestNaturalVoice(candidates: SpeechVoice[]): SpeechVoice | null {
    const top = Math.max(1, ...candidates.map((voice) => qualityRank[voice.quality]));
    if (top === 1) return null;
    const best = candidates.filter((voice) => qualityRank[voice.quality] === top);
    return best.find((voice) => voice.systemDefault === true) ?? best[0] ?? null;
}

/**
 * The voice to speak with, or null to let the synthesiser use its default.
 *
 * `chosenId` wins whenever it names an installed voice, whatever its
 * language or kind: a user who picked a British voice for English replies
 * meant it, and so did one who picked Zarvox. A chosen voice that is no
 * longer installed (a different device, a deleted download) falls through
 * to the tiers rather than to silence.
 *
 * The tiers, in order, are the clauses below, the same four as
 * DroverVoicePick.pick: the best natural voice, the language's system
 * default, the stock compact voice, then the first compact voice listed.
 */
export function pickVoice(
    voices: SpeechVoice[],
    language: string | null | undefined,
    chosenId?: string | null,
): SpeechVoice | null {
    if (chosenId) {
        const chosen = voices.find((voice) => voice.identifier === chosenId);
        if (chosen) return chosen;
    }
    const candidates = voicesForLanguage(voices, language).filter((voice) => !isNoveltyVoice(voice));
    if (candidates.length === 0) return null;
    const natural = bestNaturalVoice(candidates);
    if (natural) return natural;
    const standard = candidates.find((voice) => voice.systemDefault === true);
    if (standard) return standard;
    const stock = candidates.find((voice) => voice.identifier.startsWith(stockCompactIdentifierPrefix));
    if (stock) return stock;
    return candidates[0];
}

/** Whether the language has any voice better than the compact default. */
export function hasNaturalVoice(voices: SpeechVoice[], language: string | null | undefined): boolean {
    return voicesForLanguage(voices, language).some((voice) => voice.quality !== 'default');
}

/**
 * What the spec pins the Swift copy of this rule against (DROVE-390), read
 * off modules/drover-speech/ios/DroverVoicePick.swift the way
 * parseWristNudgeSwift reads the wrist's enum: the two constants both sides
 * must share, the clauses of `pick` in order so the TIERS are checked and not
 * only the outcomes, and every line that would let a name decide.
 */
export function parseVoicePickSwift(source: string): {
    noveltyNames: string[];
    noveltyIdentifierPrefix: string | null;
    stockCompactIdentifierPrefix: string | null;
    pickClauses: string[];
    nameOrderings: string[];
} {
    const namesBlock = source.match(/static let noveltyNames: Set<String> = \[([\s\S]*?)\]/);
    const noveltyNames = (namesBlock?.[1].match(/"[^"]+"/g) ?? []).map((quoted) => quoted.slice(1, -1));
    const noveltyIdentifierPrefix = source.match(/static let noveltyIdentifierPrefix = "([^"]+)"/)?.[1] ?? null;
    const stockCompactIdentifierPrefix = source.match(/static let stockCompactIdentifierPrefix = "([^"]+)"/)?.[1] ?? null;
    const body = source.match(/static func pick\([\s\S]*?\n    \}/)?.[0] ?? '';
    const pickClauses = body
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('if let ') || line.startsWith('return '));
    const nameOrderings = source
        .split('\n')
        .filter((line) => !line.trim().startsWith('///') && !line.trim().startsWith('//'))
        .filter((line) => /\bname\s*[<>]|\.name\.(compare|localized)|\.sorted\b|\.sort\(/.test(line));
    return { noveltyNames, noveltyIdentifierPrefix, stockCompactIdentifierPrefix, pickClauses, nameOrderings };
}
