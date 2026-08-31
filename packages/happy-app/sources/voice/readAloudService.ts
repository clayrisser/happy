import { ReadAloudReader } from './readAloud';
import { speechEngine } from './speechEngine';
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
 * The lag threshold is read from settings at every pump (DROVE-97), so the
 * slider applies to the next sentence rather than the next launch.
 */
export const readAloud = new ReadAloudReader(speechEngine, {
    maxLagSeconds: () => resolveStreamTalk(storage.getState().settings).maxLagSeconds,
});
