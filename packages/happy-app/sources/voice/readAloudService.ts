import { ReadAloudReader } from './readAloud';
import { speechEngine } from './speechEngine';
import { createRoutedSpeechEngine } from './routedSpeechEngine';
import { createCuedSpeechEngine } from './cuedSpeechEngine';
import { audioCues } from './audioCueService';
import { resolveSpeaker } from './speaker';
import { cueWatchReplyStart, watchSpeechEngine } from './watchSpeaker';
import { storage } from '@/sync/storage';
import { resolveAudioCues, resolveStreamTalk } from '@/sync/settings';
import { extractThinkingText, isEmptyThinking } from '@/utils/thinkingText';
import { readDetourFromHere, readFromHere, readSentenceFromHere } from './readAloudTap';
import { subagentDetourFrom } from './subagentRead';
import { getSubagentMessages } from '@/sync/subagentMessages';
import { startBackgroundAudio } from './backgroundAudio';

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
        jumpBacklogSeconds: () => resolveStreamTalk(storage.getState().settings).jumpBacklogSeconds,
        // The two speeds, as the one ratio the queue deals in (DROVE-116).
        // Clay picks two absolute rates, a normal one and a fast one; the
        // reader only ever asks for a MULTIPLIER on whatever rate the engine
        // is about to use, so the fast speed reaches it as fast/normal and
        // speechEngine multiplies straight back to the number he chose.
        // Read per pump like the thresholds, so either slider applies to the
        // next sentence rather than the next launch.
        maxRateScale: () => {
            const talk = resolveStreamTalk(storage.getState().settings);
            return talk.rate > 0 ? talk.catchUpRate / talk.rate : 1;
        },
        // Whether the agent is still generating. Without it the queue has to
        // infer that from how text arrives; with it, a finished reply can
        // never be cut short whatever the arrival stamps look like.
        turnStillRunning: (sessionId) => storage.getState().sessions[sessionId]?.thinking === true,
        skipMarker: '',
        onSkip: () => audioCues.skipped(),
        asideFor: (message, sessionId) => audioCues.titleFor(message, sessionId),
        // The model's reasoning, said in its place (DROVE-181). The setting
        // and the unwrapping both live out here so the queue stays a queue.
        thinkingFor: (message) => {
            if (!resolveAudioCues(storage.getState().settings).speakThinking) return null;
            if (message.kind !== 'agent-text') return null;
            if (typeof message.text !== 'string') return null;
            if (isEmptyThinking(message.text)) return null;
            return extractThinkingText(message.text);
        },
    },
);

/**
 * Tap a section and reading moves there (DROVE-146). The wiring only; the rule
 * about when a tap counts is in readAloudTap.ts.
 */
export function readAloudFromHere(sessionId: string, createdAt: number): boolean {
    return rememberSentenceTap(readFromHere(readAloud, sessionId, createdAt));
}

/**
 * Tap a SENTENCE and reading starts from that sentence (DROVE-163), falling
 * back to the block when the queue does not have it.
 */
export function readAloudSentenceFromHere(
    sessionId: string,
    messageId: string,
    sentence: string,
    createdAt: number,
): boolean {
    return rememberSentenceTap(readSentenceFromHere(readAloud, sessionId, messageId, sentence, createdAt));
}

/**
 * Tap a sentence on a SUBAGENT screen and the reading follows him there
 * (DROVE-195).
 *
 * The agent screen holds a transcript the reader has never seen, so the
 * sentences are handed over rather than looked up. What comes back is a
 * detour: the session keeps its focus, its timeline and its place, and gets
 * it back the moment the agent's transcript runs out. The reasoning is in
 * `readAloud.readDetour`.
 *
 * False means nothing moved, and there are only three ways to get it: read
 * aloud is off, this is not the session being read, or there is no prose at or
 * after the row. None of them is a position worth inventing.
 */
export function readAloudSubagentSentenceFromHere(
    sessionId: string,
    agentId: string,
    messageId: string,
    sentence: string,
): boolean {
    const messages = getSubagentMessages(sessionId, agentId);
    return rememberSentenceTap(
        readDetourFromHere(readAloud, sessionId, subagentDetourFrom(messages, messageId, sentence)),
    );
}

/**
 * He used the gesture, so the app can stop telling him about it (DROVE-195).
 *
 * DROVE-163 moved the tap from a double to a single and announced it nowhere,
 * which is the whole of why this ticket exists. The read-aloud toast carries
 * the hint until this flips, and is a plain line after. Written here rather
 * than in the component so both taps retire it, the session's and the
 * subagent's alike.
 */
function rememberSentenceTap(moved: boolean): boolean {
    if (moved && !storage.getState().localSettings.sentenceTapUsed) {
        storage.getState().applyLocalSettings({ sentenceTapUsed: true });
    }
    return moved;
}

audioCues.attach(readAloud);
startBackgroundAudio(readAloud);
