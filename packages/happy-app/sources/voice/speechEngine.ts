import * as Localization from 'expo-localization';
import { isDroverSpeechAvailable, listVoices, speakUtterance, stopSpeaking, type SpeechVoice } from 'drover-speech';
import { storage } from '@/sync/storage';
import { resolveStreamTalk } from '@/sync/settings';
import type { SpeechEngine } from './readAloud';
import { pickVoice } from './voicePick';

/**
 * Native speech engine for read-aloud (DROVE-30).
 *
 * Thin on purpose: everything about WHAT to say lives in speakable.ts and
 * everything about WHEN lives in readAloud.ts, so swapping AVSpeechSynthesizer
 * for a cloud voice later is a change to this file alone.
 *
 * DROVE-97: each utterance carries the voice, rate and pitch from settings.
 * The voice is picked here, in JS, by pickVoice over the installed list, so
 * the rule is the tested one; native applies the same rule only when JS
 * passes no identifier.
 */

let voicesCache: SpeechVoice[] | null = null;

/** Installed voices, fetched once per launch; a later call refreshes. */
export async function installedVoices(refresh = false): Promise<SpeechVoice[]> {
    if (voicesCache === null || refresh) {
        voicesCache = await listVoices();
    }
    return voicesCache;
}

/**
 * The language replies are read in: the voice-assistant language when the
 * user set one, else the device's. There is no per-reply detection; a
 * session that answers in another language gets that language's voice only
 * if the user picks it.
 */
export function speechLanguage(): string {
    const chosen = storage.getState().settings.voiceAssistantLanguage;
    if (chosen) return chosen;
    return Localization.getLocales()?.[0]?.languageTag ?? 'en-US';
}

export const speechEngine: SpeechEngine = {
    async speak(text: string) {
        const talk = resolveStreamTalk(storage.getState().settings);
        const language = speechLanguage();
        const voices = await installedVoices();
        const voice = pickVoice(voices, language, talk.voiceId);
        return speakUtterance(text, {
            rate: talk.rate,
            pitch: talk.pitch,
            voiceId: voice?.identifier ?? talk.voiceId,
            language,
        });
    },
    stop() {
        return stopSpeaking();
    },
};

/** False on a build with no native speech module — Android today. */
export const canReadAloud = (): boolean => isDroverSpeechAvailable();
