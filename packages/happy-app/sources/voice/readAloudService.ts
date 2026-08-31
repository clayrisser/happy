import { ReadAloudReader } from './readAloud';
import { speechEngine } from './speechEngine';
import { createRoutedSpeechEngine } from './routedSpeechEngine';
import { resolveSpeaker } from './speaker';
import { cueWatchReplyStart, watchSpeechEngine } from './watchSpeaker';
import { storage } from '@/sync/storage';
import { resolveStreamTalk } from '@/sync/settings';

/**
 * The one reader the app owns (DROVE-30).
 *
 * A singleton because there is exactly one speaker on the device, and because
 * the two things that drive it live far apart: sync's applyMessages feeds it,
 * and the session screen tells it which session is in focus and whether the
 * user has asked for it at all.
 *
 * The skip-ahead threshold is read from settings at every pump (DROVE-97,
 * reworked in DROVE-108), so the slider applies to the next sentence rather
 * than the next launch, and the session's own generating flag is read the
 * same way: only a reply still being written may ever be cut short.
 *
 * Each sentence goes to one device (DROVE-92): this phone's synthesiser or
 * the watch's, picked per sentence by the speaker setting and which route
 * has headphones. The wrist gets its reply-start buzz either way.
 */
export const readAloud = new ReadAloudReader(
    createRoutedSpeechEngine({
        phone: speechEngine,
        watch: watchSpeechEngine,
        pick: resolveSpeaker,
        onReplyStart: () => cueWatchReplyStart(),
    }),
    {
        maxBacklogSeconds: () => resolveStreamTalk(storage.getState().settings).maxBacklogSeconds,
        // Whether the agent is still generating. Without it the queue has to
        // infer that from how text arrives; with it, a finished reply can
        // never be cut short whatever the arrival stamps look like.
        turnStillRunning: (sessionId) => storage.getState().sessions[sessionId]?.thinking === true,
    },
);
