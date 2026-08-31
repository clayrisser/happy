import type { StreamTalkIcon, StreamTalkToastKey } from '@/voice/streamTalk';
import { streamTalkIcon } from '@/voice/streamTalk';
import { readAloudTransport, type ReadAloudTransport } from '@/voice/readAloudTransport';

/**
 * ONE AUDIO-OUT BUTTON, where there were two (DROVE-236).
 *
 * Clay: "collapse boss mode and reading mode into a single button. Long press
 * for boss mode. Single press to reading mode. When in reading mode long press
 * to pause. Single press to go back to normal."
 *
 *     state     single press        long press
 *     normal    reading mode on     boss mode
 *     reading   back to normal      pause
 *
 * WHAT DECIDES AND WHAT DRAWS. The table is `transportEffect` in
 * readAloudTransport.ts, beside the headphone and lock-screen presses, exactly
 * where DROVE-233 put it so three surfaces cannot come to mean different
 * things. This file only draws, and it is separate from `streamTalk.ts` for the
 * same reason: stream-talk is read-aloud, and this button is read-aloud AND a
 * call. One of them can be reasoned about without the other.
 *
 * ## Three states and a call, on two carriers, with no colour per state
 *
 * DROVE-215's rule is that colour on this row means something is HAPPENING
 * right now. Three reading states plus boss mode is four things, and four hues
 * would break that rule four times over. So they ride the two carriers the
 * button already had, and each carrier answers ONE question:
 *
 *   THE GLYPH says whether read-aloud is ON. Slashed speaker off, speaker with
 *   waves on, paused included, because paused is on. That is DROVE-233's
 *   sentence and it is unchanged.
 *   THE FILL says what is happening NOW, and nothing else:
 *
 *      normal    slashed speaker, no fill
 *      paused    speaker with waves, no fill
 *      reading   speaker with waves, accent disc
 *      boss      speaker as it stood, RECORDING disc
 *
 * Normal and paused are told apart by the glyph. Paused and reading by the
 * fill. Normal and reading by both. Nothing needs a hue of its own, and the two
 * hues that ARE used are the two entries `composerControlColour.ts` already
 * has: `accent` for a voice reading now, `recording` for a live mic, which is
 * what the waveform wore when a call was up before this collapse.
 *
 * A LIVE CALL OUTRANKS READING FOR THE FILL, and it can, because starting a
 * call interrupts read-aloud (`readAloud.interrupt('call-started')`). There is
 * no state where both are truly speaking, so the precedence is a tie-break on
 * paper rather than a choice about which matters more.
 *
 * ## What the collapse costs, named rather than discovered
 *
 * BOSS MODE IS NOW REACHED THROUGH READ-ALOUD'S CONTROL, so it inherits two of
 * that control's conditions. It is drawn only where there is a reader, and it
 * is reachable only while read-aloud is OFF, because a long press in any
 * on-state is the pause. Both follow from Clay's table rather than from a
 * choice made here: he gave the `normal` row's long press to boss mode and the
 * `reading` row's to pause, and a control cannot have three long presses.
 *
 * SO WITH READING ON, A CALL IS TWO GESTURES: tap the button to stop reading,
 * then long press. There is no other entry point in the app today, which is
 * worth writing down rather than leaving to be discovered. It is the price of
 * the collapse and Clay set it; if it turns out to bite, the cell to argue
 * about is `long-press` on `paused`, which currently resumes.
 *
 * THE GLYPH DOES NOT BECOME A WAVEFORM DURING A CALL. That was the temptation
 * and it is wrong: the glyph's job is to say what a TAP will do, a tap always
 * means read-aloud on or off, and a button that showed a waveform while its tap
 * toggled reading would be the DROVE-206 failure again in a smaller box.
 */

export type AudioOutGlyph = StreamTalkIcon;

/** What is under the glyph, and it only ever names something happening now. */
export type AudioOutFill = 'none' | 'accent' | 'recording';

export interface AudioOutButton {
    /** Drawn only where there is a reader; an embedded or disconnected chat has none. */
    shown: boolean;
    /** Read-aloud is enabled, paused included. What a TAP will turn off. */
    on: boolean;
    /** On and holding its place (DROVE-233). Never true while `on` is false. */
    paused: boolean;
    /** Which of Clay's two rows the long press is reading. */
    state: ReadAloudTransport;
    glyph: AudioOutGlyph;
    fill: AudioOutFill;
    /** What the button reads as to a screen reader, and what a tap will say. */
    labelKey: AudioOutLabelKey;
}

export type AudioOutLabelKey = StreamTalkToastKey | 'agentInput.audioOut.boss';

export interface AudioOutInput {
    /** `undefined` where this surface has no reader at all. */
    readAloudEnabled: boolean | undefined;
    /** DROVE-233's pause, read off the reader. */
    paused?: boolean;
    /** An ElevenLabs call is up or dialling (DROVE-206's waveform, folded in). */
    bossActive?: boolean;
}

export function audioOutButton({
    readAloudEnabled,
    paused = false,
    bossActive = false,
}: AudioOutInput): AudioOutButton {
    const shown = readAloudEnabled !== undefined;
    const on = readAloudEnabled === true;
    // A pause cannot outlive the toggle. The reader enforces this too
    // (`setEnabled` clears it), and it is repeated here so a caller holding a
    // stale flag draws one of the three states rather than a fourth.
    const held = on && paused;
    const state = readAloudTransport(on, held);
    return {
        shown,
        on,
        paused: held,
        state,
        glyph: streamTalkIcon(on),
        fill: bossActive ? 'recording' : state === 'reading' ? 'accent' : 'none',
        labelKey: bossActive
            ? 'agentInput.audioOut.boss'
            : !on
                ? 'agentInput.streamTalk.off'
                : held ? 'agentInput.streamTalk.paused' : 'agentInput.streamTalk.on',
    };
}
