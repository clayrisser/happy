import * as React from 'react';
import {
    cancelDictation,
    getDictationSupport,
    startDictation,
    stopDictation,
} from 'drover-speech';
import { useLocalSettingMutable } from '@/sync/storage';
import { readAloud } from './readAloudService';
import { canReadAloud } from './speechEngine';

/**
 * The composer's half of modes A and B (DROVE-30).
 *
 * Owns which session is being read, whether reading is on at all, and the
 * press-and-hold recording. Kept out of SessionView because the rules about
 * when speech has to stop are not obvious and belong in one place.
 */
export interface VoiceComposerOptions {
    sessionId: string;
    /**
     * False for a surface that must never speak — an embedded side chat, a
     * disconnected session — so a background pane cannot narrate over the one
     * the user is actually looking at.
     */
    active: boolean;
    /** A meta voice call is up. B and C cannot share the audio session. */
    voiceCallActive: boolean;
    appendToComposer: (text: string) => void;
    send: () => void;
    onError: (message: string) => void;
}

export interface VoiceComposerState {
    readAloudEnabled?: boolean;
    onReadAloudToggle?: () => void;
    onTalkStart?: () => void;
    onTalkEnd?: () => void;
    onTalkCancel?: () => void;
    isTalking?: boolean;
}

export function useVoiceComposer(options: VoiceComposerOptions): VoiceComposerState {
    const { sessionId, active, voiceCallActive, appendToComposer, send, onError } = options;
    const [readAloudEnabled, setReadAloudEnabled] = useLocalSettingMutable('readAloudEnabled');
    const [dictationEnabled] = useLocalSettingMutable('voiceDictationEnabled');
    const [isTalking, setIsTalking] = React.useState(false);
    const [dictationSupported, setDictationSupported] = React.useState(false);
    const recordingRef = React.useRef(false);

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
    // cuts whatever was mid-sentence.
    React.useEffect(() => {
        if (!active) {
            readAloud.blur(sessionId, 'left-session');
            return;
        }
        readAloud.focus(sessionId);
        return () => { readAloud.blur(sessionId, 'left-session'); };
    }, [sessionId, active]);

    // A live meta voice call wins: two audio consumers arguing over the
    // AVAudioSession category is the pitfall the ticket names, so read-aloud
    // goes quiet for the duration rather than fighting it.
    React.useEffect(() => {
        readAloud.setEnabled(active && readAloudEnabled && !voiceCallActive);
    }, [active, readAloudEnabled, voiceCallActive]);

    const onReadAloudToggle = React.useCallback(() => {
        setReadAloudEnabled(!readAloudEnabled);
    }, [readAloudEnabled, setReadAloudEnabled]);

    const onTalkStart = React.useCallback(() => {
        if (recordingRef.current) return;
        // The phone cannot listen and speak at once, and being read at while
        // talking is unusable besides.
        readAloud.interrupt('mic');
        recordingRef.current = true;
        setIsTalking(true);
        void startDictation().catch((error) => {
            recordingRef.current = false;
            setIsTalking(false);
            onError(error instanceof Error ? error.message : String(error));
        });
    }, [onError]);

    const onTalkEnd = React.useCallback(() => {
        if (!recordingRef.current) return;
        recordingRef.current = false;
        setIsTalking(false);
        void stopDictation()
            .then((text) => {
                const trimmed = text.trim();
                if (trimmed.length === 0) return;
                appendToComposer(trimmed);
                send();
            })
            .catch((error) => {
                onError(error instanceof Error ? error.message : String(error));
            });
    }, [appendToComposer, send, onError]);

    const onTalkCancel = React.useCallback(() => {
        if (!recordingRef.current) return;
        recordingRef.current = false;
        setIsTalking(false);
        void cancelDictation();
    }, []);

    // Nothing is left recording when the screen goes away.
    React.useEffect(() => () => {
        if (recordingRef.current) {
            recordingRef.current = false;
            void cancelDictation();
        }
    }, []);

    const offersReadAloud = active && canReadAloud();
    const offersDictation = active && dictationEnabled && dictationSupported;

    return {
        readAloudEnabled: offersReadAloud ? readAloudEnabled : undefined,
        onReadAloudToggle: offersReadAloud ? onReadAloudToggle : undefined,
        onTalkStart: offersDictation ? onTalkStart : undefined,
        onTalkEnd: offersDictation ? onTalkEnd : undefined,
        onTalkCancel: offersDictation ? onTalkCancel : undefined,
        isTalking: offersDictation ? isTalking : undefined,
    };
}
