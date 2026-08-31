import * as React from 'react';
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
     * False for a surface that must never speak, an embedded side chat, a
     * disconnected session, so a background pane cannot narrate over the one
     * the user is actually looking at.
     */
    active: boolean;
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
    /** Finger down on the talk button. Absent when there is no button. */
    onTalkPressIn?: () => void;
    /** Finger up. Inside the tap window this latches; after it, it sends. */
    onTalkPressOut?: () => void;
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
    const { sessionId, active, voiceCallActive, getComposerText, setComposerText, send, onError } = options;
    const [readAloudEnabled, setReadAloudEnabled] = useLocalSettingMutable('readAloudEnabled');
    const [dictationEnabled] = useLocalSettingMutable('voiceDictationEnabled');
    const [talk, setTalk] = React.useState<DictationCaptureState>(idleTalk);
    const [talkState, setTalkState] = React.useState<MicButtonState>('idle');
    const [talkCancelArmed, setTalkCancelArmed] = React.useState(false);
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
        readAloud.setEnabled(active && readAloudEnabled && !voiceCallActive);
    }, [active, readAloudEnabled, voiceCallActive]);

    // Headphones coming out mid-reply stops it and turns it off (DROVE-119).
    // Watched only over exactly the window where a leak is possible: this
    // surface is the one reading, and reading is on. Turning it off tears
    // the guard down through this same dependency list.
    React.useEffect(() => {
        if (!(active && readAloudEnabled && !voiceCallActive)) return;
        return startAudioRouteGuard();
    }, [active, readAloudEnabled, voiceCallActive]);

    /** Feed the gesture reducer and carry out what it asks for. */
    const dispatch = React.useCallback((event: MicGestureEvent) => {
        const step = reduceMicGesture(gestureRef.current, event);
        gestureRef.current = step.next;
        setTalkState(step.next.state);
        setTalkCancelArmed(step.next.outside);
        for (const effect of step.effects) {
            switch (effect) {
                case 'open':
                    // The phone cannot listen and speak at once, and being
                    // read at while talking is unusable besides. Nothing is
                    // recording yet, so the interrupt listener has nothing
                    // to cut.
                    readAloud.interrupt('mic');
                    baseRef.current = callbacks.current.getComposerText();
                    capture.begin('hold');
                    hapticsLight();
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
    }, [capture]);

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
        const partials = addDictationPartialListener((text) => capture.partial(text));
        const ended = addDictationEndedListener((text) => capture.recogniserEnded(text));
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

    // Nothing is left recording when the screen goes away.
    React.useEffect(() => () => { capture.discard('left-session'); }, [capture]);

    const onReadAloudToggle = React.useCallback(() => {
        setReadAloudEnabled(!readAloudEnabled);
    }, [readAloudEnabled, setReadAloudEnabled]);

    const onTalkPressIn = React.useCallback(() => {
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
        dispatch({ type: 'pressIn', at: Date.now() });
    }, [capture, dispatch]);
    const onTalkPressOut = React.useCallback(() => {
        dispatch({ type: 'pressOut', at: Date.now() });
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
        talk: offersDictation ? talk : undefined,
    };
}
