import * as Localization from 'expo-localization';
import { isDroverSpeechAvailable, listVoices, speakUtterance, stopSpeaking, type SpeechVoice } from 'drover-speech';
import { storage } from '@/sync/storage';
import {
    asidePitchScale,
    resolveSpokenRate,
    resolveStreamTalk,
    streamTalkPitchRange,
    thinkingPitchScale,
    thinkingRateScale,
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
 * a multiplier on the chosen rate, clamped against the absolute engine-safe
 * ceiling rather than the speed slider's own maximum (DROVE-116) — see the
 * comment on `ceiling` below for why that distinction is the whole feature.
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
        // Thinking, read LOWER and a shade slower than the reply (DROVE-181).
        // An aside and a thought are never both set; if they somehow were, the
        // aside wins, because a title is the shorter claim.
        const thinking = !aside && options?.thinking === true;
        // The rate is resolveSpokenRate's business (settings.ts): an aside is
        // the title of a tool call and has to sound like one (DROVE-112), and
        // the catch-up is clamped against the engine's ceiling rather than the
        // speed slider's (DROVE-116). Pitch carries the rest of the aside's
        // difference, because the native module takes no per-utterance volume.
        return speakUtterance(text, {
            rate: resolveSpokenRate(
                talk.rate,
                (options?.rateScale ?? 1) * (thinking ? thinkingRateScale : 1),
                aside,
            ),
            pitch: aside
                ? Math.min(streamTalkPitchRange.max, talk.pitch * asidePitchScale)
                : thinking
                    ? Math.max(streamTalkPitchRange.min, talk.pitch * thinkingPitchScale)
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
