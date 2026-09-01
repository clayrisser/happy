/**
 * Read-aloud is an audio player, and this is its transport (DROVE-233).
 *
 * Clay: "I was thinking it would actually have audio playing in the background
 * like an audio player I can pause and resume. In fact on my headphones I
 * should be able to pause and resume the reading." And: "if you long press the
 * read back it goes into pause so when you resume it goes back to where it was
 * reading."
 *
 * ## Pause is not off, and that is the whole ticket
 *
 * The speaker button had ONE axis, on/off, so there was nowhere for a paused
 * state to live and every surface that wanted to stop the voice had to turn
 * read-aloud off. Off throws the position away: `interrupt` moves the cursor
 * to the end of the timeline, which is right, because a queue nobody wants is
 * a queue nobody is holding a place in. Turning it back on then starts at the
 * newest content, which is DROVE-226's rule and also right. Neither of them is
 * a resume, and pressing a headphone should not have to be either.
 *
 *   OFF      read-aloud is disabled. Nothing will be read. The next start is a
 *            start: DROVE-226 puts it at new content.
 *   PAUSED   read-aloud is still ON and holding its place. The timeline keeps
 *            filling, nothing is spoken, and the cursor does not move.
 *   READING  the ordinary state. Speaking, or resting between sentences with
 *            material still to come.
 *
 * Paused is the same shape as `micHeld` in readAloud.ts, which has held a
 * place through a dictation since DROVE-143 and is documented there as "not
 * the same as disabled". The difference is that `micHeld` is the machine's and
 * this one is his: it survives a backgrounding, it is what three surfaces
 * drive, and it is drawn on the button.
 *
 * ## Three surfaces, one state
 *
 * The in-app speaker on a LONG PRESS, a single headphone press, and the
 * lock-screen play/pause button. They all land on `setPaused` on the one
 * reader, so pausing in his ears and resuming with his thumb continues at the
 * same sentence without either surface knowing the other exists.
 *
 * ## What resume means exactly, and why it is its own case
 *
 * A resume is neither a start nor a tap:
 *
 *   A START (DROVE-226) puts the cursor at new content and marks the history
 *   spoken. Resuming that way would jump him to the newest message and skip
 *   whatever he paused in the middle of.
 *
 *   A TAP (DROVE-146, DROVE-163) clears the spoken marks from a chosen point
 *   and reads on from there. Resuming that way would re-read what he had
 *   already heard.
 *
 *   A RESUME does neither. It touches nothing: not the cursor, not a spoken
 *   mark, not the timeline. Pause stops the utterance in flight and leaves
 *   every one of those exactly where it stood, and resume pumps. That is why
 *   there is no `resumeFrom` anywhere in this feature — the position is not
 *   restored, it was never lost.
 *
 * SENTENCE GRANULARITY, named rather than discovered. Pause stops the current
 * utterance mid-word, and DROVE-126 says a sentence that made a sound stays
 * spoken and never repeats. So a pause halfway through a sentence resumes at
 * the NEXT sentence, not at the half he missed. That is the correct reading of
 * "never re-reads a sentence already heard", and it is what makes pause safe
 * to press a hundred times: the position only ever moves forward.
 *
 * Mid-WORD resume is possible in principle — AVSpeechSynthesizer has
 * `pauseSpeaking(at:)`/`continueSpeaking()` and DroverSpeechModule already
 * uses that pair for interruptions and for dictation. Reaching it from here
 * would mean new native functions, so a new build, for the last few words of
 * one sentence. Not taken. Written down so the next person does not think it
 * was missed.
 *
 * ## The gestures
 *
 * Pure. No reader, no device, no timers — the table only, so the button, the
 * lock screen and the headphones cannot come to disagree about what a press
 * does, and so all of it is testable without react-native.
 */

/** What the reader is doing, as one value. */
export type ReadAloudTransport = 'off' | 'paused' | 'reading';

export function readAloudTransport(enabled: boolean, paused: boolean): ReadAloudTransport {
    if (!enabled) return 'off';
    return paused ? 'paused' : 'reading';
}

/**
 * Where a press came from.
 *
 * `tap` and `long-press` are the in-app speaker button. The three `remote-`
 * ones are the lock screen's two buttons and the headphone's single press,
 * which arrives as `toggle` because iOS reports it as `togglePlayPauseCommand`
 * (DROVE-225 has the full press table).
 */
export type TransportGesture =
    | 'tap'
    | 'long-press'
    | 'remote-play'
    | 'remote-pause'
    | 'remote-toggle';

export type TransportEffect =
    /** Enable read-aloud. A START, so DROVE-226 places the cursor at new content. */
    | 'turn-on'
    /** Disable it. The position goes with it. */
    | 'turn-off'
    /** Still on, still holding the place, silent. */
    | 'pause'
    /** Carry on from exactly where it stood. */
    | 'resume'
    /**
     * Open a live ElevenLabs call (DROVE-236). The one cell that is not
     * read-aloud at all, and it is reachable from the in-app long press only.
     */
    | 'boss-mode'
    /** This press means nothing in this state, and doing nothing is the answer. */
    | 'nothing';

/**
 * The whole table.
 *
 * Exhaustive on both axes on purpose, the same way headphoneAction is: a new
 * gesture or a new state cannot be added without landing a line here, in front
 * of a reviewer.
 *
 * THE TAP IS THE PLAY BUTTON (DROVE-327). Off it starts, reading it stops,
 * and PAUSED IT RESUMES. Clay, from his phone, after two tickets had this
 * cell the other way: "if it's paused and I single tap it should unpause
 * not end the reading. To go into pause though you hold it in."
 *
 * The argument the old cell made was that a tap is on/off and nothing else,
 * so a tap that resumed would give one control two axes on the same gesture.
 * That is true of a switch and false of a player, and this is a player: the
 * cheapest gesture on the button is the one that makes it talk, whatever
 * state it is in, the way every audio app on the phone works. What a tap
 * never does is pause, because the hold owns that.
 *
 * THE LONG PRESS IS PAUSE WHILE READING, OFF WHILE PAUSED, and boss mode
 * while off (DROVE-236). Pause and off both live on the hold, which is
 * what keeps the tap free to mean "read". A hold never starts reading:
 * starting is the tap's job, and a hold that started reading would be a
 * second way to start, with no position to hold, which is the confusion
 * DROVE-233 existed to end.
 *
 * The `off` cell used to be `nothing`. Clay collapsed the waveform and the
 * speaker into one control and gave that cell a job:
 *
 *     state     single press        long press
 *     normal    reading mode on     boss mode
 *     reading   back to normal      pause
 *     paused    resume              back to normal          (DROVE-327)
 *
 * The first two rows are his table verbatim (DROVE-236); the third is the
 * row he wrote from the phone when the button got it wrong.
 *
 * BOSS MODE IS NOT READ-ALOUD, and putting it here is a claim worth defending.
 * It earns the cell because the control is now one audio-out button and this
 * table is what that button means; leaving the decision in the renderer would
 * put the fourth cell somewhere the headphones and the lock screen cannot see
 * it, which is how three surfaces come to disagree. What the table does NOT do
 * is start the call: it names the effect and the composer performs it, so a
 * caller with no call to start (an embedded chat, or one already in a call)
 * does nothing with it and says so.
 *
 * A REMOTE PRESS NEVER OPENS A CALL EITHER (DROVE-236). Only `long-press`
 * reaches `boss-mode`; the three remote gestures are untouched by that cell,
 * so a squeeze in a pocket cannot dial anybody.
 *
 * A REMOTE PRESS NEVER TURNS READING ON. `play` from a pocket resumes a pause
 * and does nothing at all when read-aloud is off. This is DROVE-189's rule
 * kept rather than a new one: "a squeeze that turned the voice back on for a
 * session he had walked away from would be a surprise, and the button is one
 * tap away". What changes is only that there is now a pause for it to come
 * back from.
 */
export function transportEffect(
    gesture: TransportGesture,
    state: ReadAloudTransport,
): TransportEffect {
    switch (gesture) {
        case 'tap':
            switch (state) {
                case 'off': return 'turn-on';
                case 'paused': return 'resume';
                case 'reading': return 'turn-off';
            }
            break;
        case 'long-press':
            switch (state) {
                case 'off': return 'boss-mode';
                case 'paused': return 'turn-off';
                case 'reading': return 'pause';
            }
            break;
        case 'remote-play':
            return state === 'paused' ? 'resume' : 'nothing';
        case 'remote-pause':
            return state === 'reading' ? 'pause' : 'nothing';
        case 'remote-toggle':
            switch (state) {
                case 'off': return 'nothing';
                case 'paused': return 'resume';
                case 'reading': return 'pause';
            }
            break;
    }
    return 'nothing';
}

/**
 * The gesture a native remote command is, or null when it is not the transport
 * at all.
 *
 * `next` is the next reading-enabled session and `previous` is the microphone
 * (DROVE-300). Both belong to headphonePress.ts and neither is the transport.
 *
 * `next` DOES reach the reader, which is the one thing worth saying here: it
 * moves the focus, through nextSession.ts, and a focus move is not a play/pause
 * state. Returning a gesture for it would put the session skip through
 * `transportEffect`, where the only cells it could land in are pause, resume
 * and nothing — three wrong answers.
 */
export function remoteTransportGesture(command: string): TransportGesture | null {
    switch (command) {
        case 'play': return 'remote-play';
        case 'pause': return 'remote-pause';
        case 'toggle': return 'remote-toggle';
        default: return null;
    }
}
