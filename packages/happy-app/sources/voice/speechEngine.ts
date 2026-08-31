import * as Localization from 'expo-localization';
import { isDroverSpeechAvailable, listVoices, speakUtterance, stopSpeaking, type SpeechVoice } from 'drover-speech';
import { storage } from '@/sync/storage';
import {
    asidePitchScale,
    asideRateCeiling,
    asideRateScale,
    resolveStreamTalk,
    streamTalkPitchRange,
    streamTalkRateRange,
} from '@/sync/settings';
import type { SpeakOptions, SpeechEngine } from './readAloud';
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
 *
 * DROVE-108: the queue may ask for a faster read when it is behind. That is
 * a multiplier on the chosen rate, clamped back into the speed slider's own
 * range, so catching up never sounds like a setting the user did not pick.
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
    async speak(text: string, options?: SpeakOptions) {
        const talk = resolveStreamTalk(storage.getState().settings);
        const language = speechLanguage();
        const voices = await installedVoices();
        const voice = pickVoice(voices, language, talk.voiceId);
        const aside = options?.aside === true;
        const scaled = talk.rate * (options?.rateScale ?? 1) * (aside ? asideRateScale : 1);
        // An aside is the title of a tool call, not the reply (DROVE-112), and
        // it has to sound like one. Its ceiling is the engine's rather than the
        // speed slider's: the slider bounds what the user picked for PROSE, and
        // a footnote read at exactly the same speed as the answer is the thing
        // this is trying not to be. Pitch carries the rest of the difference,
        // because the native module takes no per-utterance volume.
        const ceiling = aside ? asideRateCeiling : streamTalkRateRange.max;
        return speakUtterance(text, {
            rate: Math.min(ceiling, Math.max(streamTalkRateRange.min, scaled)),
            pitch: aside
                ? Math.min(streamTalkPitchRange.max, talk.pitch * asidePitchScale)
                : talk.pitch,
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
