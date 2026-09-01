/**
 * Stream-talk: replies read aloud as they arrive (DROVE-30), and the one
 * switch that turns it on or off.
 *
 * THE SWITCH IS PER SESSION SINCE DROVE-297, and it lives on the reader:
 * `readAloud.setSessionEnabled`. The composer's audio-out control writes it,
 * and so does DROVE-298's `drover read` from a terminal, both through the one
 * take-the-voice rule in readingVoice.ts.
 *
 * `localSettings.readAloudEnabled` is still here and is still persisted, but
 * it is now the DEFAULT a session nobody has said anything about inherits.
 * Two surfaces write it: the "Read replies aloud" row on the channel sheet
 * (DROVE-72) and Settings > Voice. The composer used to be the third, and that
 * is exactly the bug this ticket fixed — switching reading on in one session
 * switched it on in every other one, so walking into any of them took the
 * voice.
 *
 * `useVoiceComposer` hands the composer `readAloudEnabled` plus
 * `onAudioOutPress`; the value is this session's own, and the press goes
 * through the transport table (DROVE-327) so a tap on a paused reader resumes
 * rather than flipping the switch. This module says how it is drawn and
 * announced, so the button, the sheet and the settings row cannot disagree
 * about what "on" looks like.
 *
 * Not the same thing as the drover Audio channel (`droverAnnounceAudio`,
 * droverChannels.ts): that one decides whether a Cattle Drover prompt is
 * spoken when it arrives and is mirrored to every Mac. Stream-talk is per
 * phone and is about the assistant's replies.
 */

import type { TransportEffect } from './readAloudTransport';

export type StreamTalkIcon = 'volume-high' | 'volume-mute-outline';

export type StreamTalkToastKey =
    | 'agentInput.streamTalk.on'
    | 'agentInput.streamTalk.onHint'
    | 'agentInput.streamTalk.off'
    | 'agentInput.streamTalk.paused'
    | 'agentInput.streamTalk.resumed';

/**
 * THE BUTTON MODEL LIVES IN `components/composerAudioOut.ts` (DROVE-236).
 *
 * DROVE-233 had `streamTalkButton` here, drawing three states on a speaker.
 * The speaker is gone: Clay collapsed it with the waveform into one audio-out
 * button, so what is drawn is four things and one of them is a call, which is
 * not stream-talk and does not belong in this file. Two models of one button
 * would be two things to keep in step, which is what every note in this
 * directory is about not doing.
 *
 * What stayed here is what is genuinely read-aloud's: the glyph pair, the
 * tap's flip, and the toast the long press says. `audioOutButton` reads the
 * first of those rather than restating it.
 */

/**
 * The speaker pair, and it says ONE thing: whether read-aloud is on.
 *
 * A speaker with waves on, a slashed speaker off. PAUSED IS ALSO ON and wore
 * the waves until DROVE-258 gave it pause bars of its own; that third face is
 * the BUTTON's, not stream-talk's, so it lives in composerAudioOut.ts beside
 * the disc it is drawn on. This pair is unchanged, and a caller that only
 * wants the on/off reading still gets exactly it.
 */
export function streamTalkIcon(on: boolean): StreamTalkIcon {
    return on ? 'volume-high' : 'volume-mute-outline';
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

/**
 * What ANY press on the audio-out button says, from the effect it had
 * (DROVE-327).
 *
 * One naming for both gestures, because both go through the table now and a
 * tap can resume as well as start or stop. `boss-mode` and `nothing` say
 * nothing here: the first is a call the composer announces its own way, and
 * the second did nothing worth a line.
 */
export function audioOutToast(
    effect: TransportEffect,
    sentenceTapUsed = true,
): StreamTalkToastKey | null {
    switch (effect) {
        case 'turn-on': return flipStreamTalk(false, sentenceTapUsed).toastKey;
        case 'turn-off': return 'agentInput.streamTalk.off';
        case 'pause': return streamTalkPauseToast(true);
        case 'resume': return streamTalkPauseToast(false);
        case 'boss-mode':
        case 'nothing':
            return null;
    }
}
