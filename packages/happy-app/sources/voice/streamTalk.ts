/**
 * Stream-talk: replies read aloud as they arrive (DROVE-30), and the one
 * switch that turns it on or off.
 *
 * The switch is `localSettings.readAloudEnabled`, nothing else. Three
 * surfaces flip it: the speaker button on the composer's second row
 * (DROVE-98), the "Read replies aloud" row on the channel sheet (DROVE-72)
 * and Settings > Voice. `useVoiceComposer` reads the key once and hands the
 * composer `readAloudEnabled` plus `onReadAloudToggle`; this module says how
 * that value is drawn and announced, so the button, the sheet and the
 * settings row cannot disagree about what "on" looks like.
 *
 * Not the same thing as the drover Audio channel (`droverAnnounceAudio`,
 * droverChannels.ts): that one decides whether a Cattle Drover prompt is
 * spoken when it arrives and is mirrored to every Mac. Stream-talk is per
 * phone and is about the assistant's replies.
 */

export type StreamTalkIcon = 'volume-high' | 'volume-mute-outline';

export type StreamTalkToastKey =
    | 'agentInput.streamTalk.on'
    | 'agentInput.streamTalk.onHint'
    | 'agentInput.streamTalk.off'
    | 'agentInput.streamTalk.paused'
    | 'agentInput.streamTalk.resumed';

export interface StreamTalkButton {
    /** Drawn only when this surface has a reader; an embedded or disconnected chat has none. */
    shown: boolean;
    /** Read-aloud is enabled, paused included. What a TAP will turn off. */
    on: boolean;
    /** On and holding its place (DROVE-233). Never true while `on` is false. */
    paused: boolean;
    /** Speaker with waves while read-aloud is on, paused included; slashed off. */
    icon: StreamTalkIcon;
    /**
     * The accent disc under the glyph (DROVE-118), and since DROVE-233 it means
     * READING rather than merely enabled. See the note below.
     */
    filled: boolean;
    /** What the button reads as, and what a tap will say. */
    labelKey: StreamTalkToastKey;
}

export function streamTalkIcon(on: boolean): StreamTalkIcon {
    return on ? 'volume-high' : 'volume-mute-outline';
}

/**
 * Three states on one control, with no new hue (DROVE-233).
 *
 * DROVE-215's rule is that colour on this row means something is HAPPENING,
 * and a paused reader is not happening. DROVE-118 gave the speaker a filled
 * accent disc and composerControlColour.ts names it as this row's one
 * fill-carries-it exception. So the two carriers the button already has are
 * enough, and each one answers a different question:
 *
 *   THE GLYPH says whether read-aloud is ON. Slashed speaker off, speaker with
 *   waves on — paused included, because paused is on.
 *   THE FILL says whether it is READING right now. Accent disc while it is,
 *   nothing while it is not.
 *
 *      off      slashed speaker, no fill, glyph in the row's foreground
 *      paused   speaker with waves, NO fill, glyph in the row's foreground
 *      reading  speaker with waves, accent disc, glyph in the tint on it
 *
 * That is a narrowing of the fill rather than a new colour: it used to mean
 * "enabled" and now means "not paused", so the ordinary on-and-idle case is
 * drawn exactly as it was and only a pause takes the disc away. It is also the
 * fill saying the true thing for the first time — under DROVE-215 a disc that
 * was on whenever the feature was enabled was carrying a value, not a state.
 *
 * Paused and off are told apart by the SHAPE, which is what DROVE-141 and
 * DROVE-215 both say the shapes are for: "a slashed speaker" and "a speaker
 * with waves" is the same distinction the button has always drawn between off
 * and on, and it keeps meaning read-aloud is off or on.
 */
export function streamTalkButton(
    readAloudEnabled: boolean | undefined,
    paused = false,
): StreamTalkButton {
    const shown = readAloudEnabled !== undefined;
    const on = readAloudEnabled === true;
    // A pause cannot outlive the toggle. The reader enforces this too
    // (`setEnabled` clears it), and it is repeated here so a caller that
    // holds a stale flag draws two states rather than a fourth.
    const held = on && paused;
    return {
        shown,
        on,
        paused: held,
        icon: streamTalkIcon(on),
        filled: on && !held,
        labelKey: !on
            ? 'agentInput.streamTalk.off'
            : held ? 'agentInput.streamTalk.paused' : 'agentInput.streamTalk.on',
    };
}

/**
 * What a tap does: the next value of the key, and the toast that announces it.
 *
 * TURNING IT ON ALSO TEACHES THE GESTURE, once (DROVE-195). DROVE-163 moved
 * "read from this sentence" off a double tap and onto a single one, for good
 * reasons, and told nobody. Clay went on double-tapping, got the second tap
 * onto a different sentence or onto nothing, and reported the feature as
 * broken. It was not broken; it was unannounced, which from where he sits is
 * the same thing.
 *
 * The moment to say so is the moment the gesture starts working, which is
 * this toast and no other place: a tip on a settings page is read by nobody
 * and a permanent hint under the composer is clutter for someone who already
 * knows. `used` retires it, so it is a hint until he does it once and a plain
 * line forever after.
 */
export function flipStreamTalk(
    readAloudEnabled: boolean,
    sentenceTapUsed = true,
): { readAloudEnabled: boolean; toastKey: StreamTalkToastKey } {
    const next = !readAloudEnabled;
    if (!next) return { readAloudEnabled: next, toastKey: 'agentInput.streamTalk.off' };
    return {
        readAloudEnabled: next,
        toastKey: sentenceTapUsed ? 'agentInput.streamTalk.on' : 'agentInput.streamTalk.onHint',
    };
}

/**
 * What a LONG PRESS says (DROVE-233).
 *
 * The transport table decides what the press DID; this only names it, so the
 * button and the toast cannot describe two different things. `paused` is the
 * state it ended in.
 */
export function streamTalkPauseToast(paused: boolean): StreamTalkToastKey {
    return paused ? 'agentInput.streamTalk.paused' : 'agentInput.streamTalk.resumed';
}
