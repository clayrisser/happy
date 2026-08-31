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
    | 'agentInput.streamTalk.off';

export interface StreamTalkButton {
    /** Drawn only when this surface has a reader; an embedded or disconnected chat has none. */
    shown: boolean;
    on: boolean;
    /** Filled speaker when on, slashed when off. */
    icon: StreamTalkIcon;
    /** What the button reads as, and what a tap will say. */
    labelKey: StreamTalkToastKey;
}

export function streamTalkIcon(on: boolean): StreamTalkIcon {
    return on ? 'volume-high' : 'volume-mute-outline';
}

/**
 * The composer's model of the button from the value `useVoiceComposer`
 * hands it: `undefined` means no reader on this surface, so no button.
 */
export function streamTalkButton(readAloudEnabled: boolean | undefined): StreamTalkButton {
    const shown = readAloudEnabled !== undefined;
    const on = readAloudEnabled === true;
    return {
        shown,
        on,
        icon: streamTalkIcon(on),
        labelKey: on ? 'agentInput.streamTalk.on' : 'agentInput.streamTalk.off',
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
