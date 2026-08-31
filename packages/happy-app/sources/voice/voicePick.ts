import type { SpeechVoice, SpeechVoiceQuality } from 'drover-speech';

/**
 * Choosing the voice that reads a reply (DROVE-97).
 *
 * iOS speaks with the compact default voice for the locale unless told
 * otherwise, and that is the robotic one. Every iPhone can hold enhanced
 * and premium voices for the same language, so the pick is: the voice the
 * user chose if it is installed, else the best quality installed for the
 * language, else nothing (and the synthesiser picks its own default).
 *
 * Pure so the rule is testable on a fixture list; native mirrors it as a
 * fallback for a caller that passes no identifier.
 */

const qualityRank: Record<SpeechVoiceQuality, number> = {
    premium: 3,
    enhanced: 2,
    default: 1,
};

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

/** Stable order: best quality first, then by name so a tie is not random. */
export function sortVoicesByQuality(voices: SpeechVoice[]): SpeechVoice[] {
    return [...voices].sort((a, b) => {
        const rank = qualityRank[b.quality] - qualityRank[a.quality];
        if (rank !== 0) return rank;
        return a.name.localeCompare(b.name);
    });
}

/**
 * The voice to speak with, or null to let the synthesiser use its default.
 *
 * `chosenId` wins whenever it names an installed voice, whatever its
 * language: a user who picked a British voice for English replies meant it.
 * A chosen voice that is no longer installed (a different device, a deleted
 * download) falls through to the quality pick rather than to silence.
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
    const candidates = voicesForLanguage(voices, language);
    if (candidates.length === 0) return null;
    return sortVoicesByQuality(candidates)[0];
}

/** Whether the language has any voice better than the compact default. */
export function hasNaturalVoice(voices: SpeechVoice[], language: string | null | undefined): boolean {
    return voicesForLanguage(voices, language).some((voice) => voice.quality !== 'default');
}
