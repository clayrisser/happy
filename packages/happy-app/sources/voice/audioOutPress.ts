import type { ReadingSessionState } from './readingVoice';
import {
    readAloudTransport,
    transportEffect,
    type ReadAloudTransport,
    type TransportEffect,
} from './readAloudTransport';

/**
 * The composer's audio-out button: a tap or a hold, applied to the reader
 * (DROVE-327).
 *
 * Clay, from his phone, on a control that had been touched before: "if it's
 * paused and I single tap it should unpause not end the reading. To go into
 * pause though you hold it in."
 *
 * ## What was wrong, exactly
 *
 * Two things, and they agreed with each other, which is why the bug read as a
 * decision rather than a defect.
 *
 * The TABLE (`transportEffect`) said a tap while paused turns read-aloud off.
 * And the composer's tap never asked the table at all: `onReadAloudToggle` in
 * useVoiceComposer flipped `setSessionEnabled(sessionId, !enabled)`, and
 * paused IS enabled, so a tap on a paused reader disabled it. The position
 * went with it (off subsumes pause, DROVE-233), so the next tap was a START
 * at the newest content (DROVE-226) and the place he had paused on was gone.
 *
 * Only the long press consulted the table, and it read the VOICE's state
 * (`readAloud.isEnabled`, `readAloud.isPaused`) while the button was drawn
 * from the SESSION's (`readingStateOf`, DROVE-297). The two are the same when
 * the session on screen holds the voice, which is nearly always, and differ
 * exactly when a terminal or a headphone press has moved the voice elsewhere
 * — where the button draws amber and the hold would have acted on a session
 * he was not looking at.
 *
 * ## What this is
 *
 * ONE PERFORMER FOR BOTH GESTURES. It reads the state the button DRAWS, asks
 * the table what the press means there, and carries it out on the reader.
 * So what is drawn, what a tap does and what a hold does cannot diverge: they
 * are three readings of one row.
 *
 * Pure, over an interface, for the same reason readAloudTap.ts is: the whole
 * table can then be walked against the real reader in a test, with no React
 * and no device, and a wrong transition fails by name.
 *
 * ## Resume is two different calls, and the table cannot tell them apart
 *
 * `paused` is HIS pause on the voice this session holds: resume is
 * `setPaused(false)`, which pumps from exactly where it stood (DROVE-233 —
 * nothing restored, nothing was lost).
 *
 * `yielded` is armed but another session has the voice. The composer draws
 * it on the same amber face as paused, because to him it is the same thing:
 * on, silent, holding a place. So a tap on it has to mean the same thing too,
 * and here resuming means TAKING THE VOICE BACK, which is DROVE-289's held
 * position restored by `takeVoice`. The `setPaused(false)` after it lifts a
 * pause that was his before the yield and came back with the stash; when
 * there was none it is a no-op. Leaving yielded on the old path would have
 * put two behaviours behind one glyph, which is the shape of the bug this
 * file exists to end.
 */

/** The two gestures the in-app button has. The remote ones are backgroundAudio's. */
export type AudioOutGesture = 'tap' | 'long-press';

/** The reader, as this needs to ask it. Every member is a `ReadAloudReader` method. */
export interface AudioOutTarget {
    /** What the button draws for this session (DROVE-297). */
    readingStateOf(sessionId: string): ReadingSessionState;
    /** This session's switch, through the one take-the-voice rule (DROVE-297). */
    setSessionEnabled(sessionId: string, enabled: boolean): void;
    /** His pause on the voice, holding position (DROVE-233). */
    setPaused(paused: boolean): void;
    /** Give a yielded session the voice back at its held place (DROVE-289, DROVE-300). */
    takeVoice(sessionId: string): void;
}

/**
 * The row of the table this session is on.
 *
 * The fold the composer has always drawn: `yielded` wears the paused face,
 * because it is on, silent and holding a place, and the table has no fourth
 * row for it. Defined once here so the face and the press read the same row.
 */
export function audioOutRow(state: ReadingSessionState): ReadAloudTransport {
    return readAloudTransport(state !== 'off', state === 'paused' || state === 'yielded');
}

/**
 * Apply a press on the composer's audio-out button to the reader, and say
 * what it did.
 *
 * `boss-mode` and `nothing` are returned untouched: the first is a call and
 * belongs to the composer (DROVE-236), the second is the table saying this
 * press means nothing here.
 */
export function pressAudioOut(
    target: AudioOutTarget,
    sessionId: string,
    gesture: AudioOutGesture,
): TransportEffect {
    const state = target.readingStateOf(sessionId);
    const effect = transportEffect(gesture, audioOutRow(state));
    switch (effect) {
        case 'turn-on':
            target.setSessionEnabled(sessionId, true);
            break;
        case 'turn-off':
            target.setSessionEnabled(sessionId, false);
            break;
        case 'pause':
            target.setPaused(true);
            break;
        case 'resume':
            // BEFORE the pause is lifted, never after: `setPaused(false)`
            // pumps, and pumping the OTHER session's queue and then moving
            // the focus would say a sentence from the wrong place first.
            if (state === 'yielded') target.takeVoice(sessionId);
            target.setPaused(false);
            break;
        case 'boss-mode':
        case 'nothing':
            break;
    }
    return effect;
}
