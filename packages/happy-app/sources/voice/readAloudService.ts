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
import { startReadingDefault } from './readingDefault';
import { startNextSessionPress } from './nextSession';
import { startMicPress } from './micPress';
import { HeadlessDictation } from './headlessDictation';
import { readingCycleFrom } from './readingCycle';
import { mountedDictationSurface, onDictationSurfaceChange } from './dictationSurface';
import { dictationBlock } from './dictationCapability';
import { cueDurationMs, cueSpec } from './audioCues';
import * as Application from 'expo-application';
import {
    addDictationEndedListener,
    addDictationPartialListener,
    addRemoteCommandListener,
    cancelDictation,
    dictationReportsProgress,
    isDroverSpeechAvailable,
    remoteTriplePressAvailable,
    startDictation,
    stopDictation,
} from 'drover-speech';

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
        // The transcript as the store holds it, for a double tap on a message
        // from before the reader was on (DROVE-285). Read only inside the
        // tap's `ensureHistoryFrom`, never on a scroll or a page arriving.
        historyFor: (sessionId) => storage.getState().sessionMessages[sessionId]?.messages ?? [],
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

/**
 * The persisted setting reaches the reader with no screen mounted (DROVE-301).
 *
 * FIRST, AND THAT ORDER IS THE FIX. `startBackgroundAudio` publishes on its
 * first `apply()`, so a reader still sitting at its `defaultEnabled = false`
 * would have it publish `'off'` at launch — which native takes as a command to
 * tear the remote commands down and clear the card. Arming the default before
 * that call means a cold launch with read-aloud persisted ON comes up holding
 * the session and publishing `'reading'`, and the lock screen has a card from
 * the first second.
 *
 * WIRED HERE for the reason DROVE-300 and DROVE-302 wired the double and triple
 * presses here: this module has no react in it and runs once at import, so the
 * setting lands whether a SessionView is mounted, unmounted, or was never
 * opened this launch. Settings -> Voice, the channels screen and
 * `DroverChannelsSheet` write nothing but the local setting, and this is what
 * turns that write into an app that is actually reading.
 */
startReadingDefault({
    read: () => storage.getState().localSettings.readAloudEnabled,
    subscribe: (listener) => storage.subscribe(listener),
    setEnabled: (enabled) => readAloud.setEnabled(enabled),
});

startBackgroundAudio(readAloud);

/**
 * The double press skips to the next reading-enabled session (DROVE-300).
 *
 * WIRED HERE, BESIDE `startBackgroundAudio`, AND THAT IS THE WHOLE POINT.
 * Clay's requirement is that the headphone mappings behave the same with the
 * app in the foreground and with it backgrounded in streaming mode. This
 * module has no react in it and runs once at import, so the subscription
 * outlives every screen: the press lands on the one reader whether a
 * SessionView is mounted, unmounted, or was never opened this launch. The
 * lock screen's play/pause has worked this way since DROVE-189 and this is
 * the same shape.
 *
 * EVERY SEMANTIC HERE IS BORROWED, which is the other half of the point.
 * `isSessionEnabled` and `takeVoice` are DROVE-297's — one switch per session,
 * and a take that pauses whoever was holding the voice — and the pause under
 * that take is DROVE-289's hold-and-restore, so the outgoing session keeps its
 * whole position and the incoming one resumes at its own. Never a stop, never
 * a jump ahead. DROVE-300 adds a ring step and nothing else.
 *
 * `takeVoice` rather than `visit` because he is NOT visiting: the phone is in
 * his pocket. They differ by one assignment, `visited`, which is the session
 * he is looking at and must not move for a press he made with the screen off.
 */
startNextSessionPress({
    cycle: () => readingCycleFrom(
        storage.getState().sessions,
        (sessionId) => readAloud.isSessionEnabled(sessionId),
    ),
    current: () => readAloud.readingSessionId,
    take: (sessionId) => readAloud.takeVoice(sessionId),
    subscribe: (listener) => addRemoteCommandListener(listener),
});

/**
 * The triple press opens the microphone, mounted screen or not (DROVE-302).
 *
 * WIRED HERE FOR THE SAME REASON THE DOUBLE PRESS IS. Clay: "the headphone
 * mappings should work the same if the app is in the foreground or if the app
 * is background and we are in streaming mode." Two of the three presses met
 * that because both are subscribed at module scope; the mic did not, because
 * it lived in `useVoiceComposer` and only `SessionView` mounts that. Background
 * the app from the session LIST and the press reached no subscription at all.
 * This module has no react in it and runs once at import, so the press lands
 * whether a SessionView is mounted, unmounted, or was never opened this launch.
 *
 * WHERE THE WORDS GO when nothing is mounted is the session DRAFT, which the
 * store already keeps per session and `ChatComposer` hydrates from on open. So
 * a sentence said into a pocket is waiting in the composer of the session he
 * was listening to. It is never SENT: only a lift sends (DROVE-105) and a
 * headphone press has no lift.
 *
 * EVERY DICTATION SEMANTIC IS BORROWED. `HeadlessDictation` runs the same
 * `DictationCapture` over the same recogniser with the same
 * `dictationComposerEvents` the screen uses, so DROVE-140's pause handling,
 * DROVE-120's "a capture ending never costs words" and DROVE-263's restart
 * guard are inherited rather than restated.
 */
const headlessDictation = new HeadlessDictation({
    engine: {
        start: () => startDictation(),
        stop: () => stopDictation(),
        cancel: () => cancelDictation(),
    },
    draft: (session) => storage.getState().sessions[session]?.draft ?? '',
    setDraft: (session, text) => storage.getState().updateSessionDraft(session, text),
    micHeld: (held) => readAloud.setMicHeld(held),
    cutReading: () => readAloud.interrupt('mic'),
    // Nobody can read an alert from a pocket, so a microphone that would not
    // open says so with the one sound that exists for it (DROVE-174).
    onError: () => audioCues.ack('micRefused'),
    onInterrupt: (listener) => readAloud.addInterruptListener(listener),
    onPartial: (listener) => {
        const subscription = addDictationPartialListener(listener);
        return () => subscription.remove();
    },
    onEnded: (listener) => {
        const subscription = addDictationEndedListener(listener);
        return () => subscription.remove();
    },
    interval: (run, ms) => {
        const timer = setInterval(run, ms);
        return () => clearInterval(timer);
    },
    now: () => Date.now(),
});

startMicPress({
    available: () => remoteTriplePressAvailable(),
    holder: () => readAloud.readingSessionId,
    mounted: () => mountedDictationSurface(),
    onSurfaceChange: (listener) => onDictationSurfaceChange(listener),
    headless: headlessDictation,
    blocked: () => dictationBlock({
        moduleAvailable: isDroverSpeechAvailable(),
        reportsProgress: dictationReportsProgress(),
        build: Application.nativeBuildVersion,
    }) !== null,
    ack: (id) => audioCues.ack(id),
    duration: (id) => cueDurationMs(cueSpec(id)),
    delay: (run, ms) => {
        const timer = setTimeout(run, ms);
        return () => clearTimeout(timer);
    },
    subscribe: (listener) => addRemoteCommandListener(listener),
});
