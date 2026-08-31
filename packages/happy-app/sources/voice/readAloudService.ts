import { ReadAloudReader } from './readAloud';
import { speechEngine } from './speechEngine';
import { createRoutedSpeechEngine } from './routedSpeechEngine';
import { createCuedSpeechEngine } from './cuedSpeechEngine';
import { audioCues } from './audioCueService';
import { resolveSpeaker } from './speaker';
import { cueWatchReplyStart, watchSpeechEngine } from './watchSpeaker';
import { storage } from '@/sync/storage';
import { resolveStreamTalk } from '@/sync/settings';
import { readFromHere } from './readAloudTap';

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
 *
 * DROVE-112 wrapped that engine once more and gave the reader two hooks. The
 * wrapper is how the cue mixer knows the voice has the audio route, which is
 * what makes "a cue never plays over a spoken sentence" true rather than
 * hoped for. `asideFor` gives the reader the one-line title of a tool call, a
 * terminal call or an agent as it spawns, to say in its place in the
 * transcript. And `skipMarker: ''` deletes the spoken "Skipping ahead." in
 * favour of the earcon `onSkip` plays, which is what Clay asked for: "don't
 * say skipping ahead, it should be like a ding or a beep or something".
 */
export const readAloud = new ReadAloudReader(
    createCuedSpeechEngine(
        createRoutedSpeechEngine({
            phone: speechEngine,
            watch: watchSpeechEngine,
            pick: resolveSpeaker,
            onReplyStart: () => cueWatchReplyStart(),
        }),
        audioCues,
    ),
    {
        maxBacklogSeconds: () => resolveStreamTalk(storage.getState().settings).maxBacklogSeconds,
        // Whether the agent is still generating. Without it the queue has to
        // infer that from how text arrives; with it, a finished reply can
        // never be cut short whatever the arrival stamps look like.
        turnStillRunning: (sessionId) => storage.getState().sessions[sessionId]?.thinking === true,
        skipMarker: '',
        onSkip: () => audioCues.skipped(),
        asideFor: (message, sessionId) => audioCues.titleFor(message, sessionId),
    },
);

/**
 * Double tap a section and reading moves there (DROVE-146). The wiring only;
 * the rule about when a tap counts is in readAloudTap.ts.
 */
export function readAloudFromHere(sessionId: string, createdAt: number): boolean {
    return readFromHere(readAloud, sessionId, createdAt);
}

audioCues.attach(readAloud);
