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
    onReadAloudToggle?: () => void;
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

export function useVoiceComposer(options: VoiceComposerOptions): VoiceComposerState {
    const { sessionId, active, sessionDisconnected = false, voiceCallActive, getComposerText, setComposerText, send, onError } = options;
    const [readAloudEnabled, setReadAloudEnabled] = useLocalSettingMutable('readAloudEnabled');
    const [dictationEnabled] = useLocalSettingMutable('voiceDictationEnabled');
    const [talk, setTalk] = React.useState<DictationCaptureState>(idleTalk);
    const [talkState, setTalkState] = React.useState<MicButtonState>('idle');
    const [talkCancelArmed, setTalkCancelArmed] = React.useState(false);
    const [talkSendArmed, setTalkSendArmed] = React.useState(false);
    const [dictationSupported, setDictationSupported] = React.useState(false);

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

    // Only one session is ever read. Leaving takes the focus away, which also
    // cuts whatever was mid-sentence, and, through the interrupt listener
    // below, whatever was being recorded.
    React.useEffect(() => {
        if (!active) {
            readAloud.blur(sessionId, 'left-session');
            return;
        }
        readAloud.focus(sessionId);
        return () => { readAloud.blur(sessionId, 'left-session'); };
    }, [sessionId, active]);

    // A live boss-mode call wins: two audio consumers arguing over the
    // AVAudioSession category is the pitfall the ticket names, so read-aloud
    // goes quiet for the duration rather than fighting it.
    React.useEffect(() => {
        // Only the surface that FOCUSES may drive the global flag (DROVE-179).
        // Two of these hooks can be mounted at once, the chat and an embedded
        // side chat, and the embedded one writing `false` here would silence
        // whatever the user is actually looking at.
        if (!active) return;
        readAloud.setEnabled(readAloudEnabled && !voiceCallActive);
    }, [active, readAloudEnabled, voiceCallActive]);

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
        // The task id is what makes a pause continue rather than overwrite
        // (DROVE-140); it is undefined on a build that cannot restart a task,
        // where every partial replaces exactly as it always did.
        const partials = addDictationPartialListener((text, task) => capture.partial(text, task));
        const ended = addDictationEndedListener((text, _reason, task) => capture.recogniserEnded(text, task));
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

    const onReadAloudToggle = React.useCallback(() => {
        setReadAloudEnabled(!readAloudEnabled);
    }, [readAloudEnabled, setReadAloudEnabled]);

    const onTalkPressIn = React.useCallback((touchAt?: number) => {
        // The recogniser is still settling the last stop: a press now would
        // open nothing and leave the button claiming otherwise.
        if (capture.current.settling) return;
        // A module that cannot report is refused HERE, before any state
        // moves, so the button never goes red over a recording nothing will
        // ever read back (DROVE-105).
        const block = dictationBlock({
            moduleAvailable: isDroverSpeechAvailable(),
            reportsProgress: dictationReportsProgress(),
            build: Application.nativeBuildVersion,
        });
        if (block) {
            callbacks.current.onError(block.kind === 'unsupported'
                ? t('agentInput.dictate.noSpeechModule')
                : t('agentInput.dictate.needsNewerBuild', { build: block.build ?? unknownBuild }));
            return;
        }
        dispatch({ type: 'pressIn', at: Date.now(), touchAt });
    }, [capture, dispatch]);
    const onTalkPressOut = React.useCallback((touchAt?: number) => {
        dispatch({ type: 'pressOut', at: Date.now(), touchAt });
    }, [dispatch]);
    const onTalkSlide = React.useCallback((inside: boolean) => {
        dispatch({ type: 'slide', inside });
    }, [dispatch]);
    const onTalkCancel = React.useCallback(() => capture.discard('left-session'), [capture]);

    const offersReadAloud = active && canReadAloud();
    // No talk button during a call: the pill's mic IS the mic then, and a
    // second recogniser on the same audio session is the fight named above.
    const offersDictation = active && dictationEnabled && dictationSupported && !voiceCallActive;

    return {
        readAloudEnabled: offersReadAloud ? readAloudEnabled : undefined,
        onReadAloudToggle: offersReadAloud ? onReadAloudToggle : undefined,
        onTalkPressIn: offersDictation ? onTalkPressIn : undefined,
        onTalkPressOut: offersDictation ? onTalkPressOut : undefined,
        onTalkSlide: offersDictation ? onTalkSlide : undefined,
        onTalkCancel: offersDictation ? onTalkCancel : undefined,
        talkState: offersDictation ? talkState : undefined,
        talkCancelArmed: offersDictation ? talkCancelArmed : undefined,
        talkSendArmed: offersDictation ? talkSendArmed : undefined,
        talk: offersDictation ? talk : undefined,
    };
}
