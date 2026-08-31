/**
 * The one place that decides whether the voice is allowed to go quiet
 * (DROVE-179).
 *
 * Clay, three ways in one night: "Stop silencing the reading back when I'm
 * doing things. When reading button is on you should read while I type and do
 * things and scroll." Each previous fix was one caller found after he
 * complained. DROVE-146 took the scroll out. DROVE-162 took typing out.
 * DROVE-122 stopped a send cutting it. Three tickets, three callers, and the
 * fourth caller was always going to be there, because nothing in the code
 * said what a stop was FOR.
 *
 * So the reasons are a closed union and the table below is exhaustive. A new
 * caller cannot invent a reason without landing a line here, and the compiler
 * is what enforces that, the same way `dictationRestoresDraft` does for
 * `DictationEndReason`.
 *
 * THE RULE. While the reading button is on, the voice is a BACKGROUND
 * ACTIVITY. Nothing Clay does with his hands is a request for silence. The
 * only things that may stop it are the ones that either take the audio route
 * away or are him saying stop:
 *
 *   - he turned the button off;
 *   - the microphone needs the route (DROVE-143), which pauses and resumes
 *     from the same place;
 *   - a boss-mode call took the route;
 *   - a voice preview in settings wants the speaker for a moment.
 *
 * Everything else is a bug, and the way it is stopped from being a bug again
 * is that its reason is in this table with `false` next to it. A `false`
 * reason is not ignored: the captures are still told (a latched mic really
 * does have to stop when he types), the position is left exactly where it is,
 * and the sentence in flight keeps playing.
 *
 * Note what is NOT here. Tapping a sentence (DROVE-163) is a SEEK and never
 * reaches this table: `readFrom` cuts the utterance directly, because moving
 * the playhead is not stopping.
 *
 * And note what is not here because it never reached the reader in the first
 * place. The agent screen is a stack PUSH, so the chat stays mounted under it;
 * every sheet in this app is an in-tree overlay rather than a route; there is
 * no tab navigator; and nothing subscribes to AppState on the way to the
 * voice. Those three were traced, not assumed, and they need no reason here.
 * The one that DID reach it was the transport blip, through `setEnabled`.
 */

/**
 * Why speech was asked to stop, or in the case of the `false` rows, why every
 * CAPTURE was asked to stop while reading carried on. Carried for logs and
 * for the tests.
 */
export type ReadAloudInterruption =
    /** A keystroke in the composer. He is typing the next thing while listening. */
    | 'typed'
    /** He sent the message. The answer does not exist yet; silence buys nothing. */
    | 'sent'
    /** The microphone has the audio session (DROVE-143). */
    | 'mic'
    /** The session screen went away, but the session he was reading did not. */
    | 'left-session'
    /** Another session took focus. */
    | 'switched-session'
    /** He turned the reading button off. */
    | 'toggled-off'
    /** A boss-mode call took the audio route. */
    | 'call-started'
    /** Headphones out to the built-in speaker (DROVE-119). */
    | 'headphones-unplugged'
    /** A voice preview in settings wants the speaker to itself. */
    | 'preview'
    /** The app went to the background. A brief background is not a stop. */
    | 'backgrounded'
    /** The session's transport dropped. A reconnect is not a stop. */
    | 'disconnected';

/**
 * Does this reason stop the VOICE, or only the captures?
 *
 * `true` means the utterance in flight is cut, the audio session is handed
 * back and reading ends. `false` means the captures are told and the voice
 * carries on from exactly where it was, with nothing lost from the timeline.
 *
 * Every row that is `false` is a bug that was once real. They are kept as
 * named reasons rather than deleted so the caller still has something honest
 * to say, and so this file is the table the ticket asked for.
 */
export const readAloudStopsSpeech = {
    /**
     * DROVE-162. He is usually typing the next thing WHILE listening to the
     * current reply, which is the entire point of read-aloud on a phone. A
     * keystroke needs no audio route, which is exactly what separates it
     * from the mic.
     */
    typed: false,
    /**
     * DROVE-122. At the instant he sends, the reply being asked for does not
     * exist, so cutting here buys a silence as long as the model takes to
     * start writing. The old reply is dropped where the new turn's first
     * sentence lands, in `abandonTurnsBefore`.
     */
    sent: false,
    /**
     * DROVE-143. The recogniser cannot share the route: a `speak` sets the
     * session to `.playback` and the capture then reads 0 Hz / 0 channels and
     * is refused. This is a PAUSE, not an end. `setMicHeld(false)` pumps
     * again from the same position.
     */
    mic: true,
    /**
     * DROVE-179. The chat screen unmounting says nothing about whether he
     * still wants the reply read. He opened the agent screen, or a sheet
     * replaced the route, or the tablet's side panel took its turn. The
     * session he was reading is still the session he is in, so the voice
     * follows him: `blur` keeps the focus, the timeline and the playhead.
     */
    'left-session': false,
    /**
     * The focused session was REPLACED by a different one. Reading the old
     * reply over the new session's screen is the one case where carrying on
     * is worse than stopping: four sessions finishing at once would have the
     * phone narrating four replies over each other. The voice follows him to
     * the new session and starts reading that one instead, which is the
     * decision DROVE-179 asked to be written down.
     */
    'switched-session': true,
    /** He turned the button off. The only stop he actually asked for. */
    'toggled-off': true,
    /** A boss-mode call owns the audio route for its duration. */
    'call-started': true,
    /**
     * DROVE-189 REVERSED DROVE-119, because Clay asked for it in as many
     * words: read-aloud must not be disabled when headphones are removed.
     *
     * DROVE-119 turned reading OFF when AirPods came out to the built-in
     * speaker, on the theory that a private reply should not be played to the
     * room. The theory was mine to begin with and the cost is his: an AirPod
     * that drops for a second, a case that opens in a pocket, and the voice is
     * not paused but SWITCHED OFF, needing a deliberate press to come back.
     * That fires far more often than the room it was protecting.
     *
     * So the route change is now ANNOUNCED and nothing else: the toast still
     * says the sound moved to the speaker, and he decides. The captures are
     * still told, because a latched mic on the built-in microphone is a
     * different question and DROVE-119's guard was never wrong about that.
     */
    'headphones-unplugged': false,
    /** A settings preview wants the speaker for a second. */
    preview: true,
    /**
     * DROVE-179. iOS keeps a background audio session alive, and he backgrounds
     * the app constantly: to read a push, to check the watch, to answer a
     * message. Coming back to silence is the complaint. Nothing here takes the
     * route away, so nothing here stops the voice.
     *
     * DROVE-189 confirmed this row is right and found the silence elsewhere.
     * Backgrounding was never what stopped the voice; a rejected utterance
     * was, and it looked identical from the outside. This row staying `false`
     * is what makes the reader's stall-and-retry reachable at all, because a
     * reader that had stopped would have nothing left to retry.
     */
    backgrounded: false,
    /**
     * DROVE-179. A daemon reconnect or a websocket blip flips the session's
     * connected flag for a second or two. That is the transport, not him. The
     * sentences already in the timeline are still worth saying.
     */
    disconnected: false,
} satisfies Record<ReadAloudInterruption, boolean>;

/**
 * Every reason there is, at runtime. Derived from the table, so a test can
 * walk the whole union and the union cannot grow behind the test's back.
 */
export const readAloudInterruptions = Object.keys(readAloudStopsSpeech) as ReadAloudInterruption[];

/**
 * The gate. THE one question, asked in exactly one place: `interrupt()`.
 *
 * Callers never branch on the reason themselves. They name what happened and
 * this decides, which is what keeps the next caller from quietly adding a
 * fourth way to go silent.
 */
export function stopsSpeech(reason: ReadAloudInterruption): boolean {
    return readAloudStopsSpeech[reason];
}

/** The reasons that really do end the voice. For the table on the ticket and the tests. */
export const speechStoppingReasons = readAloudInterruptions.filter((reason) => stopsSpeech(reason));

/** The reasons that only stop the captures. Everything he does with his hands. */
export const captureOnlyReasons = readAloudInterruptions.filter((reason) => !stopsSpeech(reason));
