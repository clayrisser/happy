import { audioRoute, routeHasHeadphones } from 'drover-speech';
import { getDroverWatchStatus } from 'drover-watch';
import { storage } from '@/sync/storage';
import { resolveSpeakReplies, type SpeakerChoice } from '@/sync/settings';
import { watchRouteHasHeadphones } from './watchSpeaker';

/**
 * Which device speaks a reply (DROVE-92).
 *
 * Apple's rule, followed rather than fought: audio plays on the device the
 * headphones are paired to. Headphones on the phone's route means the phone
 * speaks (it has the full stream and the better voices); headphones on the
 * watch's route means the watch speaks through them; neither means the
 * phone. The user can pin either device in settings. Exactly one device
 * speaks a sentence, ever, which is what `pickSpeaker` returning one name
 * rather than a set guarantees.
 *
 * The watch is never picked while it is unreachable: `sendMessage` only
 * reaches a frontmost watch app, so a sentence sent to one that is not
 * looking is a sentence nobody hears. The phone speaks instead.
 */

export type Speaker = 'phone' | 'watch';

export interface SpeakerInput {
    setting: SpeakerChoice;
    phoneRouteHasHeadphones: boolean;
    watchReachable: boolean;
    watchRouteHasHeadphones: boolean;
}

export function pickSpeaker(input: SpeakerInput): Speaker {
    if (input.setting === 'phone') return 'phone';
    if (!input.watchReachable) return 'phone';
    if (input.setting === 'watch') return 'watch';
    // auto: the device whose route has headphones, the phone when both or
    // neither do.
    if (input.phoneRouteHasHeadphones) return 'phone';
    if (input.watchRouteHasHeadphones) return 'watch';
    return 'phone';
}

/** The pick for the next sentence, off the live setting and both routes. */
export function resolveSpeaker(): Speaker {
    return pickSpeaker({
        setting: resolveSpeakReplies(storage.getState().settings),
        phoneRouteHasHeadphones: routeHasHeadphones(audioRoute()),
        watchReachable: getDroverWatchStatus().reachable,
        watchRouteHasHeadphones: watchRouteHasHeadphones(),
    });
}
