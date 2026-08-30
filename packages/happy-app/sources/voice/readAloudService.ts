import { ReadAloudReader } from './readAloud';
import { speechEngine } from './speechEngine';

/**
 * The one reader the app owns (DROVE-30).
 *
 * A singleton because there is exactly one speaker on the device, and because
 * the two things that drive it live far apart: sync's applyMessages feeds it,
 * and the session screen tells it which session is in focus and whether the
 * user has asked for it at all.
 */
export const readAloud = new ReadAloudReader(speechEngine);
