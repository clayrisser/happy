import * as React from 'react';
import { AppState } from 'react-native';
import * as Application from 'expo-application';
import {
    addDictationEndedListener,
    addDictationPartialListener,
    cancelDictation,
    dictationReportsProgress,
    getDictationSupport,
    isDroverSpeechAvailable,
    startDictation,
    stopDictation,
} from 'drover-speech';
import { useLocalSettingMutable } from '@/sync/storage';
import { t } from '@/text';
import { hapticsLight, hapticsSelection } from '@/components/haptics';
import { readAloud } from './readAloudService';
import { startAudioRouteGuard } from './audioRouteGuardService';
import { canReadAloud } from './speechEngine';
import { DictationCapture, type DictationCaptureState } from './dictationCapture';
import { dictationComposerEvents } from './dictationComposer';
import {
    HOLD_MIN_MS,
    idleMicGesture,
    reduceMicGesture,
    type MicButtonState,
    type MicGesture,
    type MicGestureEvent,
} from './micButton';
import { dictationBlock, unknownBuild } from './dictationCapability';
import type { TransportEffect } from './readAloudTransport';
import { audioOutRow, pressAudioOut } from './audioOutPress';
import { registerDictationSurface } from './dictationSurface';

/**
 * The composer's half of modes A and B (DROVE-30), and the talk button's
 * behaviour (DROVE-74).
 *
 * Owns which session is being read, whether reading is on at all, and the
 * mic in both of its ergonomics on one button: press-and-hold to talk, tap
 * to latch. The gesture is decided in micButton.ts and the capture rules in
 * dictationCapture.ts; this wires the button, the native recogniser's
 * events, the composer text and the interrupts to them. Kept out of
 * SessionView because the rules about when speech and capture have to stop
 * are not obvious and belong in one place.
 */
export interface VoiceComposerOptions {
    sessionId: string;
    /**
     * False for a surface that must never speak: an embedded side chat, so a
     * background pane cannot narrate over the one the user is actually
     * looking at.
     *
     * DROVE-179 took the session's CONNECTEDNESS out of this. It used to be
     * `!embedded && !isDisconnected`, and `isDisconnected` flips true for a
     * second or two on every daemon reconnect, websocket blip and foreground
     * resync. Through `setEnabled` below that reached `interrupt('toggled-off')`,
     * which is the one reason the gate calls a real stop, so a blip read as
     * the user having pressed the button. That was the last silencer left
     * after DROVE-146, DROVE-162 and DROVE-122, and it is the reason he was
     * still hitting this. A dropped transport now stops the CAPTURES and
     * leaves the voice alone, see `disconnected` below.
     */
    active: boolean;
    /**
     * The session's transport is down. Not a reason to go quiet (DROVE-179):
     * the sentences already in the timeline are still worth saying and the
     * reconnect is usually over before the sentence is. It IS a reason to
     * close the mic, since there is nothing to dictate to.
     */
    sessionDisconnected?: boolean;
    /** A boss-mode call is up. B and C cannot share the audio session, and neither can A. */
    voiceCallActive: boolean;
    /** What the composer holds right now. Read once when the mic opens. */
    getComposerText: () => string;
    /**
     * Replace the composer's text. Called on every partial while the mic is
     * open, so the words appear as they are spoken, revised in place.
     */
    setComposerText: (text: string) => void;
    send: () => void;
    onError: (message: string) => void;
}

export interface VoiceComposerState {
    readAloudEnabled?: boolean;
    /**
     * The tap on the one audio-out button (DROVE-327).
     *
     * Start from off, stop while reading, RESUME from paused. It goes through
     * the transport table like the long press does and returns what the table
     * chose, so the composer can say it. It used to be `onReadAloudToggle`, a
     * bare flip of this session's switch that never asked the table — which is
     * how a tap on a paused reader turned it off.
     */
    onAudioOutPress?: () => TransportEffect;
    /** On and holding its place (DROVE-233). Only ever true beside `readAloudEnabled`. */
    readAloudPaused?: boolean;
    /**
     * The long press on the one audio-out button (DROVE-233, DROVE-236).
     *
     * It reads the transport table, APPLIES the read-aloud half itself, and
     * hands back the effect the table chose. The composer performs the one
     * effect this layer cannot: `boss-mode`, which is a call and belongs to
     * SessionView. So the decision is made once, here, where the headphone and
     * the lock screen make theirs.
     */
    onAudioOutLongPress?: () => TransportEffect;
    /**
     * Finger down on the talk button. `touchAt` is the OS's touch clock, which
     * is what the tap-versus-hold split is measured on (DROVE-140). Absent
     * when there is no button.
     */
    onTalkPressIn?: (touchAt?: number) => void;
    /** Finger up. Released before the hold is recognised this latches; after it, it sends. */
    onTalkPressOut?: (touchAt?: number) => void;
    /** The finger crossed the button's edge while still down. */
    onTalkSlide?: (inside: boolean) => void;
    /**
     * One tap on a control with no touch stream: the composer's primary
     * button (DROVE-210). Latches the mic open, and stops a latched one.
     */
    onTalkTap?: () => void;
    /** Drop the recording without transcribing. */
    onTalkCancel?: () => void;
    /** What the button draws: idle, held, latched. */
    talkState?: MicButtonState;
    /**
     * The finger is down but off the button, so the lift will cancel. The
     * banner says so before it happens (DROVE-105).
     */
    talkCancelArmed?: boolean;
    /**
     * The press has been recognised as a HOLD while the finger is still down,
     * so the lift will SEND (DROVE-140). Before this the press is still a tap
     * and lifting would latch, which is a different promise and has to look
     * different on the banner (DROVE-142).
     */
    talkSendArmed?: boolean;
    /** Everything the live indicator draws from. */
    talk?: DictationCaptureState;
}

const idleTalk: DictationCaptureState = {
    active: false,
    mode: null,
    since: null,
    transcript: '',
    idleAt: null,
    settling: false,
};

/** Module scope so `useSyncExternalStore` gets a stable pair and never resubscribes. */
const subscribeReadAloudTransport = (onChange: () => void) => readAloud.addTransportListener(onChange);

export function useVoiceComposer(options: VoiceComposerOptions): VoiceComposerState {
    const { sessionId, active, sessionDisconnected = false, voiceCallActive, getComposerText, setComposerText, send, onError } = options;
    const [dictationEnabled] = useLocalSettingMutable('voiceDictationEnabled');
    const [talk, setTalk] = React.useState<DictationCaptureState>(idleTalk);
    const [talkState, setTalkState] = React.useState<MicButtonState>('idle');
    const [talkCancelArmed, setTalkCancelArmed] = React.useState(false);
    const [talkSendArmed, setTalkSendArmed] = React.useState(false);
    const [dictationSupported, setDictationSupported] = React.useState(false);
    // This session's reading, as one of four faces (DROVE-297). It lives on the
    // reader, not in local settings, so the button subscribes to it rather than
    // owning it (DROVE-233): four surfaces drive it — this button, a headphone
    // squeeze, the lock screen, the wrist — and a fifth now, the terminal
    // (DROVE-298), so a copy in React state would be a copy that drifts.
    const readingState = React.useSyncExternalStore(
        subscribeReadAloudTransport,
        React.useCallback(() => readAloud.readingStateOf(sessionId), [sessionId]),
        React.useCallback(() => readAloud.readingStateOf(sessionId), [sessionId]),
    );
    // Amber covers both ways of holding a place: HIS pause, and the yield to a
    // session that took the voice (DROVE-297). Both are "on, not speaking,
    // keeping its sentence", which is exactly what the amber face says, so the
    // capsule needs no fifth state to tell the truth here. The fold is
    // `audioOutRow`'s, the same one the two presses below read, so the face
    // drawn and the row pressed cannot come apart (DROVE-327).
    const audioOutState = audioOutRow(readingState);
    const readAloudEnabled = audioOutState !== 'off';
    const readAloudPaused = audioOutState === 'paused';

    // The callbacks change identity with the screen; the capture does not.
    // Refs keep the one controller pointed at the current ones.
    const callbacks = React.useRef({ getComposerText, setComposerText, send, onError });
    callbacks.current = { getComposerText, setComposerText, send, onError };

    // What the composer held when the mic opened. Every partial is re-joined
    // onto this, and the final transcript replaces the last partial the same
    // way (dictationDraft.ts).
    const baseRef = React.useRef('');
    const gestureRef = React.useRef<MicGesture>(idleMicGesture);
    /**
     * The timer that turns a press into a hold while the finger is still down
     * (DROVE-140). Cleared by every lift and every ending, so a timer never
     * outlives the press that started it.
     */
    const holdTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    const captureRef = React.useRef<DictationCapture | null>(null);
    if (captureRef.current === null) {
        captureRef.current = new DictationCapture(
            {
                start: () => startDictation(),
                stop: () => stopDictation(),
                cancel: () => cancelDictation(),
            },
            // The composer side lives in dictationComposer.ts, not here, so
            // the invariant it holds (a capture ending never costs words,
            // DROVE-120) is tested against the same code the app runs.
            dictationComposerEvents({
                base: () => baseRef.current,
                // Read LIVE, so a late final can tell a composer it still owns
                // from one the user has edited since (DROVE-360).
                current: () => callbacks.current.getComposerText(),
                setComposerText: (text) => callbacks.current.setComposerText(text),
                send: () => callbacks.current.send(),
                onError: (message) => callbacks.current.onError(message),
                onChange: (state) => setTalk(state),
            }),
        );
    }
    const capture = captureRef.current;

    // Whether this device can transcribe locally at all. Asked once, up front,
    // so an unsupported locale simply has no talk button rather than a button
    // that fails on first press.
    React.useEffect(() => {
        let cancelled = false;
        void getDictationSupport().then((support) => {
            if (!cancelled) setDictationSupported(support.supported);
        });
        return () => { cancelled = true; };
    }, []);

    // Only one session is ever read, and arriving here is not a claim on it
    // (DROVE-297). `visit` asks the rule: this session takes the voice if its
    // own reading is switched on, and otherwise the session he was listening
    // to carries on talking while he reads this one. Leaving takes the focus
    // away, which also cuts whatever was mid-sentence, and, through the
    // interrupt listener below, whatever was being recorded.
    React.useEffect(() => {
        if (!active) {
            readAloud.blur(sessionId, 'left-session');
            return;
        }
        readAloud.visit(sessionId);
        return () => { readAloud.blur(sessionId, 'left-session'); };
    }, [sessionId, active]);

    // THE MASTER SWITCH IS NOT THIS HOOK'S, AND THAT IS DROVE-301 (it used to
    // be an effect here). The persisted setting is the DEFAULT a session
    // inherits (DROVE-297), it is app-wide, and it is now read app-wide, at
    // module scope in readAloudService.ts beside `startBackgroundAudio` and the
    // headphone presses. Turning read-aloud on from Settings, the channels
    // screen or the sheet therefore reaches the reader with no session screen
    // mounted at all, and a cold launch with it persisted on comes up armed
    // rather than publishing `'off'` and tearing the lock-screen card down.
    //
    // It also retires this file's own hazard rather than managing it: two of
    // these hooks can be mounted at once, the chat and an embedded side chat,
    // and the embedded one writing `false` would have silenced whatever the
    // user was looking at. No surface writes it now.

    // A live boss-mode call wins: two audio consumers arguing over the
    // AVAudioSession category is the pitfall the ticket names, so read-aloud
    // goes quiet for the duration rather than fighting it. Its own input
    // rather than an `&&` on the line above, because a call has to silence a
    // session he switched on by hand even when the default is off — and has to
    // give it back afterwards rather than making him switch it on again.
    React.useEffect(() => {
        if (!active) return;
        readAloud.setSuspended(voiceCallActive);
    }, [active, voiceCallActive]);

    // The transport dropped, or the app went to the background. Neither takes
    // the audio route away, so neither stops the voice; both end a capture,
    // because there is nothing to dictate into (DROVE-179). The gate decides
    // that, not this file: all these do is name what happened.
    React.useEffect(() => {
        if (!active || !sessionDisconnected) return;
        readAloud.interrupt('disconnected');
    }, [active, sessionDisconnected]);

    React.useEffect(() => {
        if (!active) return;
        const subscription = AppState.addEventListener('change', (next) => {
            if (next === 'background' || next === 'inactive') readAloud.interrupt('backgrounded');
        });
        return () => { subscription.remove(); };
    }, [active]);

    // Headphones coming out mid-reply stops it and turns it off (DROVE-119).
    // Watched only over exactly the window where a leak is possible: this
    // surface is the one reading, and reading is on. Turning it off tears
    // the guard down through this same dependency list.
    React.useEffect(() => {
        if (!(active && readAloudEnabled && !voiceCallActive)) return;
        return startAudioRouteGuard();
    }, [active, readAloudEnabled, voiceCallActive]);

    /**
     * The dispatcher, reachable from the hold timer without making `dispatch`
     * depend on itself.
     */
    const dispatchRef = React.useRef<(event: MicGestureEvent) => void>(() => { });

    const clearHoldTimer = React.useCallback(() => {
        if (holdTimerRef.current === null) return;
        clearTimeout(holdTimerRef.current);
        holdTimerRef.current = null;
    }, []);

    /** Feed the gesture reducer and carry out what it asks for. */
    const dispatch = React.useCallback((event: MicGestureEvent) => {
        // No timer outlives its press: a lift or an ending settles the gesture
        // and a late holdConfirm would be about a finger that is already up.
        if (event.type === 'pressOut' || event.type === 'ended') clearHoldTimer();
        const step = reduceMicGesture(gestureRef.current, event);
        gestureRef.current = step.next;
        setTalkState(step.next.state);
        setTalkCancelArmed(step.next.outside);
        setTalkSendArmed(step.next.state === 'held' && step.next.confirmed);
        for (const effect of step.effects) {
            switch (effect) {
                case 'open':
                    // The phone cannot listen and speak at once, and being
                    // read at while talking is unusable besides. The mic holds
                    // the session for the WHOLE capture, so the reader is
                    // gated rather than merely cut: a reply still streaming in
                    // would otherwise queue another sentence a moment later
                    // and take the audio category back under the recogniser
                    // (DROVE-143). Nothing is recording yet, so the interrupt
                    // listener has nothing to cut.
                    readAloud.setMicHeld(true);
                    readAloud.interrupt('mic');
                    baseRef.current = callbacks.current.getComposerText();
                    capture.begin('hold');
                    hapticsLight();
                    break;
                case 'watchHold':
                    // The tap-versus-hold split is decided HERE, under the
                    // finger, and the tick it fires is how the boundary is
                    // felt rather than guessed (DROVE-140).
                    clearHoldTimer();
                    holdTimerRef.current = setTimeout(() => {
                        holdTimerRef.current = null;
                        dispatchRef.current({ type: 'holdConfirm' });
                    }, HOLD_MIN_MS);
                    break;
                case 'latch':
                    capture.latch();
                    break;
                case 'send':
                    capture.send();
                    break;
                case 'stop':
                    // The tap off a latch: the words land in the composer and
                    // stay there. Nothing is sent (DROVE-105).
                    capture.stop();
                    break;
                case 'cancel':
                    capture.cancel();
                    break;
                case 'tick':
                    hapticsSelection();
                    break;
            }
        }
    }, [capture, clearHoldTimer]);

    dispatchRef.current = dispatch;

    // The capture ending for any reason other than the gesture (idle stop,
    // interrupt, the recogniser giving up, a start that failed) lets the
    // button go too, so it never shows latched over a dead mic.
    React.useEffect(() => {
        if (talk.active) return;
        if (gestureRef.current.state === 'idle') return;
        dispatch({ type: 'ended' });
    }, [talk.active, dispatch]);

    // Anything that stops speech stops capture (DROVE-30). One subscription,
    // every reason, decided inside the capture.
    React.useEffect(() => readAloud.addInterruptListener((reason) => capture.interrupt(reason)), [capture]);

    // What the recogniser hears, and whether it gave up on its own.
    React.useEffect(() => {
        // A partial is everything heard since the microphone opened, so it
        // replaces the live segment and is never appended to itself; the
        // sentences from before the last pause are the capture's own business
        // (DROVE-140).
        //
        // The REASON is what makes a pause a pause. `final` is Apple
        // finalising an utterance on silence, and the capture reopens the
        // microphone on it rather than ending under his thumb. Dropping this
        // argument on the floor is what left him with a dead mic mid-hold on
        // every build that does not restart the task natively.
        const partials = addDictationPartialListener((text) => capture.partial(text));
        const ended = addDictationEndedListener((text, reason) => capture.recogniserEnded(text, reason));
        return () => {
            partials.remove();
            ended.remove();
        };
    }, [capture]);

    // The idle clock, only while a latch is live. Half-second ticks so the
    // stop lands within a breath of the deadline the ticket states.
    const wantsClock = talk.active && talk.idleAt !== null;
    React.useEffect(() => {
        if (!wantsClock) return;
        const interval = setInterval(() => capture.tick(Date.now()), 500);
        return () => clearInterval(interval);
    }, [wantsClock, capture]);

    // The reader gets the audio session back only once the native side has
    // finished with it. `settling` is part of that window: the recogniser is
    // still resolving the last stop and has not released the category yet
    // (DROVE-143).
    React.useEffect(() => {
        if (talk.active || talk.settling) return;
        readAloud.setMicHeld(false);
    }, [talk.active, talk.settling]);

    // Nothing is left recording when the screen goes away, and nothing is left
    // holding the reader silent either.
    React.useEffect(() => () => {
        capture.discard('left-session');
        readAloud.setMicHeld(false);
        clearHoldTimer();
    }, [capture, clearHoldTimer]);

    /**
     * The tap: start, stop, or RESUME this session's reading (DROVE-297,
     * DROVE-327).
     *
     * Through the transport table, which it never was: `onReadAloudToggle`
     * flipped `setSessionEnabled(sessionId, !enabled)` directly, and paused is
     * enabled, so a tap on a paused reader switched it off and threw the
     * position away. Clay: "if it's paused and I single tap it should unpause
     * not end the reading." `pressAudioOut` reads the row this button DRAWS
     * and does what the table says there.
     *
     * Still straight at the reader and still this session's own switch: it
     * used to write the persisted global, which is why turning it on in one
     * session turned it on in every other one and walking into any of them
     * took the voice. Switching this session on still goes through the one
     * take-the-voice rule and pauses whoever was speaking, at their sentence.
     */
    const onAudioOutPress = React.useCallback((): TransportEffect => {
        return pressAudioOut(readAloud, sessionId, 'tap');
    }, [sessionId]);

    /**
     * The long press (DROVE-233): pause while reading, off from paused
     * (DROVE-327), boss mode from off (DROVE-236).
     *
     * Straight at the reader rather than through the local setting, and that
     * is the point: `localSettings.readAloudEnabled` is persisted and survives
     * a relaunch, and a pause must not — coming back to a phone that is
     * silently holding a place in a session from yesterday is the failure the
     * whole ticket is about avoiding. It is runtime state on the one reader,
     * which is also what lets the headphones and the lock screen share it.
     * DROVE-297 made the per-session SWITCH runtime for the same reason: a
     * phone that wakes up armed to read four sessions is that same failure
     * with more voices.
     *
     * IT READS THE ROW THIS BUTTON DRAWS, not the voice's state (DROVE-327).
     * The two are the same whenever the session on screen holds the voice,
     * which is nearly always. They differ when a terminal or a headphone press
     * has moved the voice to another session: the button is amber then, and a
     * hold that read the voice would have acted on a session he was not
     * looking at while the face in front of him said otherwise.
     */
    const onAudioOutLongPress = React.useCallback((): TransportEffect => {
        // `boss-mode` is returned untouched (DROVE-236). Read-aloud is off in
        // that cell, so there is nothing here to do with it, and the composer
        // starts the call.
        return pressAudioOut(readAloud, sessionId, 'long-press');
    }, [sessionId]);

    /**
     * May this press move the gesture at all? Checked before any state moves,
     * so the button never goes red over a recording nothing will ever read
     * back (DROVE-105).
     */
    const canPress = React.useCallback(() => {
        // The recogniser is still settling the last stop: a press now would
        // open nothing and leave the button claiming otherwise.
        if (capture.current.settling) return false;
        const block = dictationBlock({
            moduleAvailable: isDroverSpeechAvailable(),
            reportsProgress: dictationReportsProgress(),
            build: Application.nativeBuildVersion,
        });
        if (block) {
            callbacks.current.onError(block.kind === 'unsupported'
                ? t('agentInput.dictate.noSpeechModule')
                : t('agentInput.dictate.needsNewerBuild', { build: block.build ?? unknownBuild }));
            return false;
        }
        return true;
    }, [capture]);

    const onTalkPressIn = React.useCallback((touchAt?: number) => {
        if (!canPress()) return;
        dispatch({ type: 'pressIn', at: Date.now(), touchAt });
    }, [canPress, dispatch]);
    const onTalkPressOut = React.useCallback((touchAt?: number) => {
        dispatch({ type: 'pressOut', at: Date.now(), touchAt });
    }, [dispatch]);
    const onTalkSlide = React.useCallback((inside: boolean) => {
        dispatch({ type: 'slide', inside });
    }, [dispatch]);
    /**
     * One tap on a control that has no touch stream (DROVE-210).
     *
     * Some controls report a press and nothing else: the headphone double
     * press, the lock screen, the watch. No press-in, no duration, no
     * coordinates. So the tap is fed to the same reducer as a press and a lift
     * at the SAME instant. Zero elapsed is under HOLD_MIN_MS on any clock,
     * which is exactly the definition of a tap, so it can only ever latch, and
     * on a mic that is already latched it can only ever stop.
     *
     * THE COMPOSER'S MIC IS NO LONGER ONE OF THEM (DROVE-269). It ran on this
     * for two tickets and that is what cost push-to-talk; it has the full
     * touch stream again, so it reaches `onTalkPressIn` and the three below.
     * Push-to-talk and slide-to-cancel are back on the screen with it.
     *
     * Same reducer, same capture, same banner, so a latch opened on any of
     * them is stopped by any other.
     */
    const onTalkTap = React.useCallback(() => {
        // A finger is already down on the mic. Two controls driving one
        // gesture at once is the only way that happens -- a headphone squeeze
        // mid-hold -- and the lift belongs to the finger, not to this tap.
        if (gestureRef.current.pressedAt !== null) return;
        if (!canPress()) return;
        const at = Date.now();
        dispatch({ type: 'pressIn', at });
        dispatch({ type: 'pressOut', at });
    }, [canPress, dispatch]);
    const onTalkCancel = React.useCallback(() => capture.discard('left-session'), [capture]);

    const offersReadAloud = active && canReadAloud();
    // No talk button during a call: the pill's mic IS the mic then, and a
    // second recogniser on the same audio session is the fight named above.
    const offersDictation = active && dictationEnabled && dictationSupported && !voiceCallActive;

    /**
     * This composer is on screen, so the headphone press has somewhere better
     * to go than the draft (DROVE-302).
     *
     * THE SUBSCRIPTION IS NOT HERE ANY MORE, and that is the whole of the
     * ticket. It used to be: a `HeadphoneMic` and an `addRemoteCommandListener`
     * lived in this hook, so the triple press could only ever reach a session
     * screen that happened to be mounted. React native does not unmount the
     * tree when the app leaves the screen, so the gesture DID work in his
     * pocket while a session was open, which is why it tested fine; background
     * the app from the session LIST and the press landed on nothing at all,
     * with no cue to say so. Clay's requirement is that the mappings behave
     * the same foreground and backgrounded, and a subscription owned by a
     * screen cannot meet it.
     *
     * The owner is micPress.ts now, started once beside the double press in
     * readAloudService.ts. This hook's part is to say that a composer exists
     * for this session, so the press routes into the SAME capture the thumb
     * drives rather than opening a second one underneath it. When nothing has
     * registered, the press still lands: headlessDictation.ts writes into the
     * session draft instead.
     *
     * DROVE-300's refusal did not move with it — it moved INTO `micTarget`,
     * where it finally has a test. A triple press after a double press, with
     * this screen still up and the voice on another session, refuses audibly
     * rather than putting words in a composer he is not listening to.
     *
     * `tap` goes through a ref so the registration itself is stable: the
     * callback changes identity with every render, and re-registering on each
     * one would churn the surface listeners for nothing.
     */
    const talkTapRef = React.useRef(onTalkTap);
    talkTapRef.current = onTalkTap;
    React.useEffect(() => {
        if (!offersDictation) return;
        return registerDictationSurface({
            session: sessionId,
            capturing: () => capture.current.active,
            tap: () => talkTapRef.current(),
        });
    }, [offersDictation, sessionId, capture]);

    return {
        readAloudEnabled: offersReadAloud ? readAloudEnabled : undefined,
        onAudioOutPress: offersReadAloud ? onAudioOutPress : undefined,
        readAloudPaused: offersReadAloud ? readAloudPaused : undefined,
        onAudioOutLongPress: offersReadAloud ? onAudioOutLongPress : undefined,
        onTalkPressIn: offersDictation ? onTalkPressIn : undefined,
        onTalkPressOut: offersDictation ? onTalkPressOut : undefined,
        onTalkSlide: offersDictation ? onTalkSlide : undefined,
        onTalkTap: offersDictation ? onTalkTap : undefined,
        onTalkCancel: offersDictation ? onTalkCancel : undefined,
        talkState: offersDictation ? talkState : undefined,
        talkCancelArmed: offersDictation ? talkCancelArmed : undefined,
        talkSendArmed: offersDictation ? talkSendArmed : undefined,
        talk: offersDictation ? talk : undefined,
    };
}
