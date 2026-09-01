import type { Message } from '@/sync/typesMessage';
import { chunkStreamed } from './sentenceStream';
import { sameSentence } from './sentenceMatch';
import { stripToSpeakableProse } from './speakable';
import { stopsSpeech, type ReadAloudInterruption } from './readAloudGate';
import {
    readingSessionState,
    voiceMove,
    type ReadingSessionState,
    type VoiceMove,
} from './readingVoice';

/**
 * The read-aloud queue (DROVE-30, mode B).
 *
 * Fed from the same seam the meta voice agent already reads, applyMessages in
 * sync/sync.ts, and speaks one sentence at a time so that stopping lands
 * mid-sentence rather than at the end of a paragraph. The engine is injected
 * so this whole thing is testable without a device.
 *
 * DROVE-97 added two things. The synthesiser only ever gets whole sentences:
 * a message's unfinished tail is held until the message grows, a later
 * message arrives, or a short hold expires. And it added the skip-ahead cut.
 *
 * DROVE-108 rewrote that cut, because the first measure of it was wrong.
 * It compared how long ago a sentence arrived with how long ago it was
 * spoken, and speech is ALWAYS slower than generation, so past about forty
 * words every reply looked stale and the middle of a normal answer was
 * thrown away. The rule now is:
 *
 *   - A finished turn is read to the end. There is nothing newer to be
 *     current with, so the backlog IS the answer.
 *   - While a turn is still being written, the backlog may be cut, but only
 *     when it is more than the threshold of UNSPOKEN AUDIO (estimated from
 *     word count and the speaking rate, not from a sentence's age) and new
 *     text is still arriving.
 *   - A new turn abandons the previous turn's unspoken tail and says the
 *     marker once. That is the case that was actually asked for.
 *
 * And rather than cut at the first opportunity, a voice that is behind reads
 * a little faster; a cut loses information, a faster read does not.
 *
 * DROVE-122 moved WHEN that last rule fires. Sending a message used to call
 * interrupt('sent'), which stopped the voice dead at the moment the user's
 * text landed. Nothing of the answer exists yet at that moment, so the phone
 * went quiet for as long as the model took to start writing. `userSent()`
 * replaces it: every capture still stops, because the dictation that produced
 * the message is over, but reading carries on. The cut then happens where it
 * already did, in `abandonTurnsBefore` off the back of `enqueue`, which is by
 * construction the new turn's FIRST SPEAKABLE SENTENCE. One marker, as
 * before. If the old reply drains first, the reader simply rests: there is
 * nothing left to say and silence is then correct.
 *
 * Nothing new bounds how long that stale tail may run, on purpose. The
 * backlog rules above already do it, and the window is only ever as long as
 * the model takes to produce one sentence.
 *
 * DROVE-116 gave those rules the two numbers they were missing. Clay: "when
 * you're getting behind, instead of just jumping to the newest stuff, could
 * you first start talking faster, and then only if you get too far behind you
 * jump", and "we can also set when it jumps". There are now two thresholds,
 * both his: `maxBacklogSeconds` is where the voice starts reading faster, and
 * `jumpBacklogSeconds` is where the tail is dropped. Before, the cut fired at
 * the same number the ramp started at, so the ramp had no band to run in and
 * the answer was always a jump; and its ceiling was 1.15x, which the engine
 * then clamped back into the speed slider's own range, so a fast slider
 * cancelled the catch-up outright. See `catchUpRate`.
 *
 * DROVE-162 took typing out of the reader entirely. `userTyped` tells the
 * captures to stop and leaves the voice alone, the way `userSent` already
 * did: Clay is usually typing the next thing while listening to the current
 * reply. The mic gate below is untouched, because the mic really does need
 * the audio route and a keyboard does not.
 *
 * DROVE-177, an hour after DROVE-116 shipped. Clay: "why are you talking so
 * fast when not behind". The ramp was applied to every sentence whose backlog
 * was over the speed-up threshold, with no regard for whether anything was
 * still arriving, while the jump next to it had that guard from the start. So
 * a finished reply of forty-odd words, which is most replies, was read faster
 * from its first sentence to somewhere near its last. Nobody heard it before
 * because the engine clamped the product back into the speed slider's range
 * and the ramp topped out at 1.15x; DROVE-116 lifted both, and the leak
 * became the whole reply at the catch-up rate. Now the ramp and the cut share
 * one question, `stillArriving()`: behind means there is newer PROSE the
 * voice is falling further from, and only then does it read faster. A reply
 * that has landed whole, a stream that has stopped, or a turn the agent has
 * finished is read at exactly the normal rate, however long it is.
 *
 * The same ticket settled how a spoken title (DROVE-112) counts. Toward the
 * backlog's LENGTH, yes: it takes air time like any sentence, and a title is
 * a few words with a per-run cap, so it cannot inflate the measure for long.
 * As an ARRIVAL, no: a title landing means the agent is working, not writing,
 * and there is nothing in it to catch up to. Before this a run of tool calls
 * kept the arrival window open on its own, so the ramp stayed up (and the cut
 * stayed armed) through a whole tool run with no new prose in sight.
 *
 * DROVE-114 turned the private cursor into a PLAYHEAD. The queue is no longer
 * a queue that forgets what it said: every sentence stays in `timeline` and
 * `cursor` is a position in it, so reading can be moved backwards as well as
 * forwards. One thing moves it from outside, `seekTo(createdAt)`, and one
 * thing is published outwards, `playhead`: the sentence at the engine with
 * the message it came from, so a row can mark it without reaching in here.
 *
 * DROVE-146 cut the SCROLL out of that. DROVE-114 had wired the chat list's
 * visible range to both the position and a bound on how far reading could
 * run, so scrolling seeked and the bottom of the screen stopped the voice.
 * Clay: "It will go back up if you double tap. Double tap a section and
 * that's what changes the reading, not scrolling." So scrolling is free
 * again, and moving the voice is one deliberate gesture. The bound is gone
 * with it: nothing outside can stop reading any more, which is why read-aloud
 * cannot go silent with nothing in the log.
 *
 * DROVE-126's invariant stays, and its job is narrower now:
 *
 *   A SENTENCE THAT HAS BEEN SPOKEN IS NEVER SPOKEN AGAIN, ON ITS OWN.
 *
 * See `skipSpoken`. Nothing the queue does by itself repeats. A tap is not
 * the queue doing something by itself: it is a request to read from there, so
 * it clears the marks from that point and reads on.
 *
 * DROVE-163 made that tap land on the SENTENCE rather than the block. Clay:
 * "Whatever SENTENCE I tap is where you start reading". `seekToSentence` is
 * the way in, and it is a lookup rather than a measurement: every sentence
 * already carries the message it came from, so given the rendered text under
 * the finger the queue can find its own copy of it. `seekTo` stays as the
 * fallback for a tap that resolves to no sentence.
 *
 * DROVE-112 added a second KIND of thing to say and took one away, and both
 * are hooks rather than logic, because none of the policy belongs here:
 *
 *   - `asideFor` offers every message to the caller and takes back a one-line
 *     title for a tool call, a terminal call or an agent spawning. It becomes
 *     a sentence in the timeline at that message's createdAt, which is the
 *     only way to be sure it is said in its place rather than after the reply
 *     has moved past it, and which gets it the spoken-once invariant and the
 *     skip-ahead cut for nothing. `SpeakOptions.aside` tells the engine to
 *     read it faster and higher so it does not sound like the reply.
 *   - `onSkip` fires on every cut, and `skipMarker` may now be empty. Clay:
 *     "don't say skipping ahead, it should be like a ding or a beep or
 *     something". So the app passes no words and plays an earcon instead.
 *
 * DROVE-181 added the THIRD kind of thing to say. Clay: "Read thought
 * processes too". Thinking blocks were skipped outright; `thinkingFor` offers
 * every message the same way `asideFor` does and takes back the thought to
 * say. It becomes a sentence in the timeline at that message's createdAt, so
 * it is spoken BEFORE the reply it precedes by construction rather than by a
 * scheduler, and it inherits spoken-once, the mic gate, the catch-up and the
 * jump for nothing — which is what makes a minute of thinking skippable to
 * reach the answer, with the skip earcon saying so. `SpeakOptions.thinking`
 * tells the engine to read it LOWER, not faster: a thought is long, and the
 * treatment an aside gets (faster and higher) would make a paragraph of it
 * exhausting. A thought is not an ARRIVAL either, for the same reason a title
 * is not (DROVE-177): the model thinking is not the model writing, and letting
 * it hold the arrival window open would bring the catch-up rate back on a
 * reply that has already landed whole.
 *
 * DROVE-188 added the one thing allowed to JUMP THE QUEUE. Clay: "When a
 * question comes in you need to read it to me." A gate waiting on him blocks a
 * session, which costs him time directly, so `sayUrgent` puts a line in front
 * of everything else queued. It cannot cut a sentence mid-word, and it does
 * not have to try: `pump` only ever runs when nothing is at the synthesiser,
 * so "finish this sentence, then say the gate" falls out of where the check
 * sits. `cancelUrgent` un-says a gate answered before its line was reached.
 *
 * DROVE-189 stopped the reader silencing itself in the background, in two
 * passes, and the second one is the one that mattered.
 *
 * The first: `rest` releases the audio session when the queue drains, which is
 * right in the foreground (ducked music comes back up) and fatal behind the
 * lock screen, because an app with the audio background mode stays alive only
 * while its session is ACTIVE. A drained queue let iOS suspend the process and
 * the next reply arrived at an app that was not running. `setBackgrounded`
 * fixes that, and it needs no new build.
 *
 * The second, after Clay reported the same thing a third time: keeping the app
 * ALIVE was necessary and not sufficient. `engine.speak` REJECTS when the
 * audio session refuses the utterance, which is what an unfinished
 * interruption looks like from JS, and `speakNow` swallowed the rejection and
 * pumped the next sentence, which was refused too, marking each one `spoken`
 * as it went. One refusing second consumed the entire reply and left nothing
 * to read when the session came back. `refused`, `isStalled` and
 * `audioSessionRecovered` are that fix: a REJECTED utterance never made a
 * sound, so it is put back and the queue waits, while a RESOLVED one stays
 * spoken however short it was, which is what keeps DROVE-126 true.
 *
 * DROVE-226 gave DROVE-126's invariant the half it was missing. Clay, having
 * said it before: "I TOLD YOU START READING ONLY NEW FUCKING MESSAGING unless
 * I double tap a specific place to start."
 *
 * The rule is that reading speaks what has ARRIVED. It never walks back into
 * the conversation on its own; the one thing that starts it anywhere else is
 * his tap, which is a deliberate act (DROVE-146, DROVE-163, DROVE-195).
 *
 * What broke it was not the queue, it was the seam. `onMessages` is fed from
 * applyMessages, and applyMessages carries the TRANSCRIPT as well as the live
 * stream: opening a session fetches the most recent page, and a background
 * prefetch then pages BACKWARDS through the rest of it. Every one of those
 * pages arrived here looking exactly like a reply landing, so the reader said
 * them. An older page cannot even be recognised by its turn: the turn only
 * moves on a user message NEWER than the one that opened it, so a page of
 * ancient history is stamped with the CURRENT turn, appended after the newest
 * reply, and read out in full. That is the conversation narrated backwards,
 * which is what he is describing.
 *
 * So the seam says which it is rather than the reader guessing. `onHistory` is
 * the transcript as it already stood: its sentences go into the timeline, in
 * their place in time, marked SPOKEN. Nothing there is given up. A sentence in
 * the timeline is a sentence his tap can find, so DROVE-163 still starts
 * wherever he points, and `skipSpoken` is what makes the queue itself step
 * over every one of them. `onMessages` keeps its whole meaning: what has just
 * arrived.
 *
 * DROVE-189 was the first suspect and it is ruled out with a measurement. Its
 * rewind is exactly one utterance wide: `refused` un-marks the one sentence
 * the session rejected, `putBack` moves the cursor no further back than that
 * sentence's own index, and the retry resumes there rather than at the top of
 * the reply. `readAloudOnlyNew.spec.ts` holds the numbers.
 *
 * PAUSE IS A THIRD STATE, not a third way to be off (DROVE-233). `setPaused`
 * stops the voice and moves nothing — not the cursor, not a spoken mark — so a
 * resume is a plain `pump` from where it stood. That makes it neither a START
 * (which the paragraph above places at new content) nor a TAP (which clears
 * spoken marks and reads from a chosen point), and it is spelled as its own
 * case for exactly that reason. readAloudTransport.ts holds the model.
 *
 * A SESSION SWITCH IS A PAUSE, PER SESSION (DROVE-289). Clay: "whichever
 * session I switch to, it starts reading from where IT left off — that's the
 * ideal. If I'm switching I don't wanna jump ahead... it's like when you press
 * on the audio, it pauses." His analogy is the design. `focus` used to throw
 * the whole reading away — timeline, cursor, marks — so coming back to a
 * session resumed at its TAIL: everything unread when he left was re-fed as
 * history, marked spoken, and never said. That is the "jumping ahead" he
 * named.
 *
 * Now the reader keeps one held reading PER SESSION (`held`). Switching away
 * stashes the whole position exactly as a pause holds it: nothing advances,
 * nothing is dropped, the sentence that was cut mid-word keeps its spoken mark
 * (DROVE-233's sentence granularity), and — the pause analogy carried all the
 * way — the timeline KEEPS FILLING while he is elsewhere: arrivals for a held
 * session go into its held timeline unspoken (`fillHeld`), so a resume reads
 * on THROUGH what landed while he was away rather than skipping it. Switching
 * back restores that session's own position and resumes from it, and only
 * from it: never the tail, never the previous session's place. A session with
 * no held reading starts exactly as before — silent until something arrives
 * (DROVE-226), reading arrivals because the reader follows him (DROVE-179's
 * written-down decision in readAloudNeverSilent.spec.ts).
 *
 * HIS pause survives the round trip: a session paused when he left it is
 * paused when he returns, amber face and all (DROVE-233/258), and only his
 * gesture lifts it. Turning read-aloud OFF still throws every position away,
 * the held ones included — off subsumes pause, per session too.
 */

/**
 * Why speech stopped, or why every CAPTURE stopped while reading carried on.
 *
 * The union and the decision both moved to `readAloudGate.ts` in DROVE-179,
 * re-exported here so every existing importer is unchanged. That file is the
 * table: a reason is either one that stops the voice or one that does not,
 * and the compiler will not let a new caller skip saying which.
 */
export type { ReadAloudInterruption } from './readAloudGate';

/** Per-utterance knobs: the catch-up rate (DROVE-108) and asides (DROVE-112). */
export interface SpeakOptions {
    /**
     * Multiplier on the configured speaking rate, 1 at rest. Bounded by the
     * reader (see `defaultMaxRateScale`) and clamped again by the engine to
     * whatever the platform and the speed slider allow.
     */
    rateScale?: number;
    /**
     * This is not the reply, it is a one-line ASIDE: the title of a tool call,
     * a terminal call or an agent as it spawns (DROVE-112). The engine reads it
     * faster and higher so a tool call never sounds like Claude talking. The
     * reader knows nothing else about it; where the text comes from is
     * `asideFor`'s business.
     */
    aside?: boolean;
    /**
     * This is the model THINKING, not answering (DROVE-181). The engine reads
     * it lower and a shade slower, which is the opposite direction from an
     * aside on purpose: an aside is one line and can afford to be quick, a
     * thought is a paragraph and quick would be exhausting. Volume would have
     * been the obvious axis and the native module takes none per utterance.
     */
    thinking?: boolean;
}

export interface SpeechEngine {
    /** Speak one utterance; settles when it is over, finished or cut. */
    speak(text: string, options?: SpeakOptions): Promise<unknown>;
    /** Cut whatever is speaking now, and hand the audio session back. */
    stop(): Promise<unknown> | void;
}

/**
 * The sentence at the engine right now (DROVE-114), or null when nothing of
 * the transcript is being said. Published rather than reached for: the row
 * that marks it never touches the queue.
 */
export interface ReadAloudPlayhead {
    /** The sentence as it was handed to the synthesiser. */
    sentence: string;
    /** The message it was taken from, so one row can claim it. */
    messageId: string;
    /** That message's createdAt, which is the ordering the seek uses. */
    createdAt: number;
    /** Which turn it belongs to (DROVE-108). */
    turn: number;
}

export type ReadAloudPlayheadListener = (playhead: ReadAloudPlayhead | null) => void;

export interface ReadAloudOptions {
    /** Clock, injectable for the tests. */
    now?: () => number;
    /**
     * How many seconds of UNSPOKEN AUDIO may pile up, while newer prose is
     * still arriving, before the voice starts reading FASTER. Read at every
     * pump rather than once, so a slider in settings takes effect on the next
     * sentence instead of the next launch.
     */
    maxBacklogSeconds?: () => number;
    /**
     * How many seconds of unspoken audio may pile up before the tail is
     * dropped outright (DROVE-116). Its own number rather than twice
     * `maxBacklogSeconds`, which is what it used to be in the comments and
     * was not even that in the code: the cut fired at exactly the number the
     * ramp started at, so the voice jumped without ever having sped up.
     * Left out, it defaults to twice the speed-up threshold, which is the
     * shape DROVE-108 described.
     */
    jumpBacklogSeconds?: () => number;
    /** What is said when the backlog is dropped. */
    skipMarker?: string;
    /**
     * How long an unfinished tail waits for more text before it is spoken as
     * it stands. Messages usually arrive whole, so this mostly covers a reply
     * whose last sentence has no full stop.
     */
    holdMs?: number;
    /**
     * How long to wait before offering a refused utterance to the audio
     * session again (DROVE-189). The refusal is almost always an interruption
     * that has not ended yet, so this is a poll for "may I speak now", and it
     * only ever runs while a sentence is owed.
     */
    retryDelayMs?: number;
    /**
     * Speaking rate used to turn a word count into seconds of audio. A rough
     * constant on purpose: it decides when the queue is "too long", and the
     * platform's own mapping from the rate slider to words a minute is not
     * public anyway.
     */
    wordsPerMinute?: number;
    /**
     * How close together two batches of text have to land to count as a
     * stream. Longer than this between the last two and the turn is treated
     * as finished, so what is left is read out in full however long it is.
     */
    arrivalWindowMs?: number;
    /**
     * Is this session still generating? The strongest evidence that there is
     * something newer to be current with, and the only one that does not have
     * to be inferred. Left out, the arrival stamps decide alone.
     */
    turnStillRunning?: (sessionId: string) => boolean;
    /**
     * The most the catch-up may speed the voice up, as a multiplier on the
     * chosen rate. A function since DROVE-116, and read at every pump like
     * the thresholds are: the app derives it from two absolute speeds Clay
     * picks (the normal one and the fast one), so dragging either slider has
     * to apply to the next sentence rather than the next launch.
     */
    maxRateScale?: () => number;
    /**
     * The one line to say for a message that is not prose: the title of a tool
     * call, a terminal call or an agent spawning (DROVE-112). Null for a
     * message that has nothing to announce, which is almost all of them.
     *
     * Injected rather than derived here because WHAT is worth saying, and how
     * often, is a policy with its own settings and its own fold, and none of
     * that belongs in a queue. What the queue gives it is the thing it could
     * not get anywhere else: a place in the timeline at the message's own
     * createdAt, so the title is spoken among the sentences around it rather
     * than after the reply has moved past it, and the spoken-once invariant
     * and the skip-ahead cut apply to it exactly as they do to prose.
     *
     * It is called at most once per message per delivery, from inside the
     * ordered walk, and it may keep state; `sessionId` is passed so it can
     * drop that state when focus moves.
     */
    asideFor?: (message: Message, sessionId: string) => string | null;
    /**
     * The backlog was dropped. Fires once per cut, before anything is said,
     * so the audio cue system can play the skip earcon that replaced the
     * spoken marker (DROVE-112).
     */
    onSkip?: () => void;
    /**
     * The model's reasoning for a thinking message, as prose to say, or null
     * (DROVE-181).
     *
     * Injected for the same reason `asideFor` is: whether thinking is read at
     * all is a SETTING, and how the reasoning is pulled out of the message is
     * the CLI's transport detail. Neither belongs in a queue. What the queue
     * gives it is the thing it could not get anywhere else — a place in the
     * timeline at the message's own createdAt, so the thought is said before
     * the reply it precedes and never after it.
     */
    thinkingFor?: (message: Message, sessionId: string) => string | null;
    /**
     * The session's transcript as the STORE holds it, for a tap's on-demand
     * ingest (DROVE-285). The timeline only ever held what arrived while the
     * reader was on and focused: `onHistory` drops every page that goes past
     * while it is off or elsewhere, and the transcript is fetched once per
     * session, so everything from before the toggle was permanently absent
     * and a double tap up in the history resolved to nothing. Injected like
     * `asideFor` because where the transcript lives is the store's business,
     * not a queue's; read only inside `ensureHistoryFrom`, which is reached
     * only from his tap — never from a scroll or a page arriving.
     */
    historyFor?: (sessionId: string) => readonly Message[];
}

/**
 * Seconds of unspoken audio, not seconds of delay: at 150 words a minute
 * this is about 37 words, roughly two or three sentences still to say while
 * the reply keeps growing.
 */
export const defaultMaxBacklogSeconds = 15;
/**
 * What a cut says.
 *
 * Empty means say nothing, which is what the app passes now: Clay, on the
 * spoken marker, "don't say skipping ahead, it should be like a ding or a beep
 * or something". The earcon costs 120ms to say what a second of speech was
 * saying, and it says it in the middle of catching up, which is exactly when
 * the extra second hurts most. `onSkip` fires either way, so the sound and the
 * words are one decision rather than two things that could both happen. The
 * default keeps the words, so a caller that wires up no cue is not left with a
 * silent skip, which would be worse than a wordy one (DROVE-108, DROVE-112).
 */
export const defaultSkipMarker = 'Skipping ahead.';
/** Ordinary read-aloud prose lands near this; the estimate needs no better. */
export const defaultWordsPerMinute = 150;
/**
 * Two batches of text more than this far apart are not a stream. It has to
 * be long enough to bridge the gap a short tool call leaves between two
 * blocks of prose, and short enough that one big block landing after a pause
 * is read out rather than cut.
 */
export const defaultArrivalWindowMs = 4000;
/**
 * Bounds on the catch-up, when the caller supplies none.
 *
 * DROVE-108 shipped 1.15, which was the timid half of why catch-up never
 * saved a jump: 15 percent buys nothing against a real backlog, and the
 * engine then clamped even that back into the speed slider's range. 1.5x is
 * where audiobook listeners already sit. It ramps in linearly and reaches
 * the top at the jump threshold, so the whole band between speeding up and
 * jumping is spent reading faster (DROVE-116).
 */
export const defaultMaxRateScale = 1.5;
const defaultHoldMs = 1500;

/**
 * How long a refused utterance waits before it is offered again (DROVE-189).
 *
 * Two seconds because the thing being waited on is an audio-session
 * interruption: a call, Siri, a notification sound. Those are measured in
 * seconds. Short enough that he does not notice the gap when it clears,
 * long enough that a session which will refuse for a minute costs thirty
 * wake-ups rather than thirty thousand. While the app is suspended the timer
 * does not fire at all, so the idle cost is zero.
 */
export const defaultSpeechRetryDelayMs = 2000;

/**
 * The catch-up multiplier for a backlog, as a pure function so the shape can
 * be checked with the real numbers (DROVE-177).
 *
 * Exactly 1 at and below `speedUp`, then linear across the band to `maxScale`
 * at `jump`, and `maxScale` beyond it; the tail is dropped there instead. The
 * whole band between the two thresholds is spent reading faster, which is
 * what Clay asked for: "instead of just jumping to the newest stuff, could
 * you first start talking faster, and then only if you get too far behind
 * you jump". Before DROVE-116 the ramp ended at twice `speedUp` while the
 * cut fired at `speedUp` itself, so it had no band to run in at all.
 *
 * Whether the ramp APPLIES is the reader's decision, not this function's: it
 * is only ever used while newer prose is still arriving (DROVE-177).
 */
export function catchUpScale(backlogSeconds: number, speedUp: number, jump: number, maxScale: number): number {
    if (speedUp <= 0 || backlogSeconds <= speedUp) return 1;
    const band = jump - speedUp;
    const over = band > 0 ? Math.min(1, (backlogSeconds - speedUp) / band) : 1;
    return 1 + over * (maxScale - 1);
}

interface QueuedSentence {
    text: string;
    /** Precomputed so the backlog estimate is a sum, not a re-split. */
    words: number;
    /** Which turn this sentence belongs to; an older one is abandoned. */
    turn: number;
    /** The message it came from, for the playhead and for the seek. */
    messageId: string;
    /** That message's createdAt: the one ordering the view and the queue share. */
    createdAt: number;
    /**
     * It has been handed to the synthesiser once. Never again on the queue's
     * own initiative (DROVE-126). On the sentence rather than in the cursor
     * because the cursor moves backwards now, so it cannot be the record of
     * what was said. A tap clears it from that point (DROVE-146, DROVE-163).
     */
    spoken: boolean;
    /**
     * A title rather than prose (DROVE-112). It rides the timeline like any
     * other sentence, and differs only in how the engine reads it.
     */
    aside: boolean;
    /**
     * The model thinking rather than answering (DROVE-181). Same deal: it
     * rides the timeline, and only the engine treats it differently.
     */
    thinking: boolean;
}

interface HeldTail {
    text: string;
    turn: number;
    createdAt: number;
}

/**
 * One session's reading, held across a switch away (DROVE-289).
 *
 * The exact fields a pause preserves, because a switch IS a pause taken per
 * session: the position (`timeline`, `cursor`, every spoken mark inside the
 * sentences), the bookkeeping that stops a redelivery re-reading a reply
 * (`queuedChunks`), the turn the session was on, and whether HE had paused it.
 * The arrival stamps are deliberately NOT held: a restored reading is never
 * "falling behind", so it resumes at the normal rate until its own live
 * stream re-establishes itself (DROVE-177's question answered fresh).
 */
interface HeldReading {
    timeline: QueuedSentence[];
    cursor: number;
    queuedChunks: Map<string, number>;
    pendingTails: Map<string, HeldTail>;
    latestCreatedAt: number;
    turn: number;
    turnOpenedAt: number;
    markerDue: boolean;
    /** He paused it before he left; it is still his to lift (DROVE-233). */
    paused: boolean;
    lastPosition: number | null;
    urgent: { key: string; text: string }[];
    detour: QueuedSentence[];
}

/**
 * How many switched-away sessions keep their reading. Beyond this the one
 * held longest ago is let go and falls back to the old behaviour (silent
 * until something arrives). A bound because a held timeline is the whole
 * transcript's sentences, and he rotates a handful of sessions, not dozens.
 */
export const maxHeldReadings = 8;

/**
 * One sentence out of a transcript the reader is NOT following (DROVE-195).
 *
 * A subagent's transcript is fetched by its own screen and never reaches
 * `onMessages`, so the reader has no copy of it and could not seek into it.
 * These are handed in whole by whoever is drawing that transcript. The
 * `messageId` is the subagent message's own, which is what puts the reading
 * mark on the row the finger landed on.
 */
export interface ReadAloudDetourSentence {
    readonly messageId: string;
    readonly text: string;
    readonly createdAt: number;
}

/** Words in a sentence, for the audio-duration estimate. */
function countWords(text: string): number {
    const parts = text.trim().split(/\s+/);
    return parts.length === 1 && parts[0] === '' ? 0 : parts.length;
}

/**
 * Told every time speech is cut, and why.
 *
 * This is how "anything that stops speech also stops capture" is made true
 * by construction rather than by remembering to (DROVE-30): the composer's
 * mic listens here, so a new reason to cut speech added later cuts capture
 * with it.
 */
export type ReadAloudInterruptListener = (reason: ReadAloudInterruption) => void;

export class ReadAloudReader {
    private readonly engine: SpeechEngine;
    private readonly now: () => number;
    private readonly maxBacklogSeconds: () => number;
    private readonly jumpBacklogSeconds: () => number;
    private readonly skipMarker: string;
    private readonly holdMs: number;
    private readonly retryDelayMs: number;
    private readonly wordsPerMinute: number;
    private readonly arrivalWindowMs: number;
    private readonly maxRateScale: () => number;
    private readonly turnStillRunning: ((sessionId: string) => boolean) | null;
    private readonly asideFor: ((message: Message, sessionId: string) => string | null) | null;
    private readonly onSkip: (() => void) | null;
    private readonly thinkingFor: ((message: Message, sessionId: string) => string | null) | null;
    private readonly historyFor: ((sessionId: string) => readonly Message[]) | null;
    private readonly interruptListeners = new Set<ReadAloudInterruptListener>();
    private readonly playheadListeners = new Set<ReadAloudPlayheadListener>();
    private readonly transportListeners = new Set<() => void>();
    /**
     * Does the session the VOICE is on read? (DROVE-297.)
     *
     * Derived, and kept equal to `enabledFor(this.focused)` at the two places
     * either side can move: a focus change and `setSessionEnabled`. Everything
     * inside this class asks it exactly as it always did — the queue, the
     * gate lines, the tap — because from in here the question has not changed:
     * is the reading this reader is holding one that may be spoken?
     */
    private enabled = false;
    /**
     * Reading, per session (DROVE-297). Absent means "inherit `defaultEnabled`".
     *
     * RUNTIME, never persisted, for exactly the reason the pause is runtime
     * (DROVE-233): coming back to a phone that is silently armed to read four
     * sessions from yesterday is the failure this area keeps producing. A cold
     * start therefore has every session inheriting the one persisted setting,
     * which is the behaviour that shipped before this ticket.
     */
    private sessionEnabled = new Map<string, boolean>();
    /**
     * What a session the reader has not been told about inherits — the
     * persisted `localSettings.readAloudEnabled`, written by the settings
     * screens and by nothing else since DROVE-297 moved the composer's control
     * onto the session.
     *
     * With this on and no session individually switched off, every session is
     * enabled, so navigating takes the voice exactly as it did before this
     * ticket. That is the explicit reconciliation with DROVE-179's "the reader
     * follows him", which is pinned in readAloudNeverSilent.spec.ts and is not
     * being walked back: it is what happens when there is nothing to
     * distinguish the sessions by.
     */
    private defaultEnabled = false;
    /**
     * A boss-mode call has the audio route (DROVE-236). Everything is quiet
     * for its duration, per-session switches included, and none of them is
     * forgotten: a call is not him turning reading off.
     */
    private suspended = false;
    /**
     * The session he is LOOKING at, which since DROVE-297 need not be the one
     * being read. Navigating into a session whose reading is off leaves the
     * voice where it was, so the screen and the voice come apart on purpose.
     */
    private visited: string | null = null;
    /**
     * The microphone holds the audio session, so the reader says nothing
     * (DROVE-143). Not the same as disabled: the timeline keeps filling and
     * reading picks up from where it stood as soon as the mic lets go.
     */
    private micHeld = false;
    /**
     * HE paused it (DROVE-233). Same shape as `micHeld` and for the same
     * reason: the timeline keeps filling, nothing is spoken, and the cursor
     * does not move, so resuming carries on at the sentence it stopped on.
     *
     * Distinct from `enabled` because off throws the position away and pause
     * is the state that keeps it. Only reachable while enabled: `setEnabled`
     * clears it in both directions, and `interrupt` clears it too, because a
     * queue the user threw away is not a queue anyone is holding a place in.
     *
     * The whole model, the three gestures that drive it and why a resume is
     * neither a start nor a tap are in readAloudTransport.ts.
     */
    private paused = false;
    private focused: string | null = null;
    /**
     * Every sentence this session has produced, in order, spoken or not. It is
     * kept rather than shifted off because scrolling up has to be able to read
     * something again (DROVE-114).
     */
    private timeline: QueuedSentence[] = [];
    /** Where reading is. Everything before it has been said at least once. */
    private cursor = 0;
    private speaking = false;
    /**
     * Bumped on every interruption. An utterance that settles under an old
     * generation is a straggler from before the cut and must not pull the next
     * one off a queue that has since been cleared.
     */
    private generation = 0;
    private started = false;
    /**
     * How many complete sentences of a given message have already been queued.
     * Messages arrive whole today (the CLI forwards complete JSONL lines), but
     * applyMessages reports a message as changed whenever anything about it
     * changes, so without this a redelivery would read the whole reply again.
     */
    private queuedChunks = new Map<string, number>();
    /** Each message's unfinished tail, waiting for more text. */
    private pendingTails = new Map<string, HeldTail>();
    private holdTimer: ReturnType<typeof setTimeout> | null = null;
    /**
     * The audio session refused the last utterance, so nothing was said
     * (DROVE-189).
     *
     * Not the same state as silence. A refusal means the sentence never
     * reached a speaker, so it is still owed; while this is set the queue
     * stops handing sentences over rather than burning them one per
     * rejection. `retryTimer` is the only thing that clears it on its own.
     */
    private stalled = false;
    private retryTimer: ReturnType<typeof setTimeout> | null = null;
    /** Consecutive refusals; for the tests and for logs. */
    private refusals = 0;
    private latestCreatedAt = 0;
    /** How many times the backlog was dropped; for the tests and for logs. */
    private skips = 0;
    /**
     * Which turn is being read. A message from the user opens the next one,
     * and content from a newer turn abandons whatever is left of the older.
     */
    private turn = 0;
    /** createdAt of the user message that opened the current turn. */
    private turnOpenedAt = 0;
    /** The turn of the sentence being spoken right now. */
    private speakingTurn: number | null = null;
    /** A skip has happened and the marker has not been said yet. */
    private markerDue = false;
    /** The turn the arrival stamps below belong to. */
    private arrivalTurn = -1;
    /**
     * When the batch BEFORE the most recent one landed, or -Infinity while
     * only one has. One number, and it carries all three things the cut has
     * to know: that text has come in more than one batch, that the last two
     * were close together, and that it has not stopped.
     */
    private previousArrivalAt = Number.NEGATIVE_INFINITY;
    private lastArrivalAt = 0;
    /**
     * The same pair, counting THINKING as well as prose (DROVE-181).
     *
     * DROVE-177 made the ramp and the cut share one question, and reading the
     * thinking splits them again, on purpose and in one direction only:
     *
     *   THE RAMP asks "is there newer PROSE I am falling behind?" and a thought
     *   is not prose. Letting it count would put the catch-up rate back on a
     *   reply that had already landed whole, which is the exact leak DROVE-177
     *   closed an hour after DROVE-116 opened it.
     *
     *   THE CUT asks "is there something newer to skip TO?" and a thought
     *   absolutely is. Without this a minute of reasoning followed by the
     *   answer is a minute of waiting, because a turn whose only prose batch is
     *   the answer itself never looks like a stream. "A minute of thinking is
     *   skippable to reach the answer" is the acceptance criterion, and this is
     *   what makes it true.
     */
    private previousSayableArrivalAt = Number.NEGATIVE_INFINITY;
    private lastSayableArrivalAt = 0;
    /** The sentence at the engine, published to whoever marks it. */
    private playheadValue: ReadAloudPlayhead | null = null;
    /**
     * Where reading was when it last had something to say. The playhead goes
     * null between utterances and while nothing is speaking at all, and a
     * scroll arriving in that gap still has to know where the voice had got
     * to, or it would treat an idle reader as being nowhere and re-read the
     * screen every time the list twitched.
     */
    private lastPosition: number | null = null;
    /**
     * Lines that jump the queue (DROVE-188). A gate waiting on Clay is the one
     * thing that outranks the transcript, because a blocked session costs him
     * time and a paragraph of reply does not.
     */
    private urgent: { key: string; text: string }[] = [];
    /**
     * A transcript borrowed from another surface, read once and then given
     * back (DROVE-195). See `readDetour`.
     */
    private detour: QueuedSentence[] = [];
    /**
     * The app is not in the foreground (DROVE-189). Reading carries on; what
     * changes is that a drained queue no longer hands the audio session back,
     * because letting go of it in the background is what lets iOS suspend the
     * app and end reading for good.
     */
    private backgrounded = false;
    /**
     * Every switched-away session's reading, keyed by sessionId (DROVE-289).
     * Insertion order is hold order, which is what the eviction walks.
     */
    private heldReadings = new Map<string, HeldReading>();

    constructor(engine: SpeechEngine, options: ReadAloudOptions = {}) {
        this.engine = engine;
        this.now = options.now ?? Date.now;
        this.maxBacklogSeconds = options.maxBacklogSeconds ?? (() => defaultMaxBacklogSeconds);
        this.jumpBacklogSeconds = options.jumpBacklogSeconds ?? (() => this.maxBacklogSeconds() * 2);
        this.skipMarker = options.skipMarker ?? defaultSkipMarker;
        this.holdMs = options.holdMs ?? defaultHoldMs;
        this.retryDelayMs = options.retryDelayMs ?? defaultSpeechRetryDelayMs;
        this.wordsPerMinute = options.wordsPerMinute ?? defaultWordsPerMinute;
        this.arrivalWindowMs = options.arrivalWindowMs ?? defaultArrivalWindowMs;
        this.maxRateScale = options.maxRateScale ?? (() => defaultMaxRateScale);
        this.turnStillRunning = options.turnStillRunning ?? null;
        this.asideFor = options.asideFor ?? null;
        this.onSkip = options.onSkip ?? null;
        this.thinkingFor = options.thinkingFor ?? null;
        this.historyFor = options.historyFor ?? null;
    }

    get isSpeaking(): boolean {
        return this.speaking;
    }

    /** Sentences still to say from the position, spoken or not counted twice. */
    get pending(): number {
        return Math.max(0, this.timeline.length - this.cursor);
    }

    get skipCount(): number {
        return this.skips;
    }

    get isEnabled(): boolean {
        return this.enabled;
    }

    /**
     * Is the voice waiting on an audio session it was refused (DROVE-189)?
     *
     * True between a rejected utterance and the retry that succeeds. Nothing
     * has been lost while it is true; the sentence that was refused is still
     * at the front of the queue.
     */
    get isStalled(): boolean {
        return this.stalled;
    }

    /** How many utterances the session has refused in a row. For the tests. */
    get refusalCount(): number {
        return this.refusals;
    }

    get focusedSessionId(): string | null {
        return this.focused;
    }

    /** The sentence at the engine, or null. */
    get playhead(): ReadAloudPlayhead | null {
        return this.playheadValue;
    }

    /**
     * Where reading IS, as a createdAt, whether or not a sentence is being
     * said this instant. Null only before anything has ever been read.
     */
    get readPosition(): number | null {
        return this.playheadValue?.createdAt ?? this.lastPosition;
    }

    /** Returns the unsubscribe. */
    addPlayheadListener(listener: ReadAloudPlayheadListener): () => void {
        this.playheadListeners.add(listener);
        return () => { this.playheadListeners.delete(listener); };
    }

    /**
     * The MASTER switch: what a session nobody has said anything about reads
     * (DROVE-297 re-pointed this; the settings screens still drive it).
     *
     * Turning it off is the kill: every per-session switch and every held
     * position goes with it, because off subsumes pause and this is off
     * everywhere at once (DROVE-289). Turning it on is a default, not a
     * command — a session he has explicitly switched off stays off.
     *
     * Only ever called on a real flip. Two chat surfaces can be mounted and
     * both run the effect that calls this on mount, so a redundant call has to
     * be free: one that cleared the per-session switches would wipe them on
     * every navigation.
     */
    setEnabled(enabled: boolean): void {
        if (this.defaultEnabled === enabled) return;
        this.defaultEnabled = enabled;
        if (!enabled) {
            this.sessionEnabled.clear();
            // Off throws EVERY position away, the held ones included
            // (DROVE-289): a held reading is a pause taken per session, and
            // off subsumes pause. Coming back on is a START wherever he is.
            this.heldReadings.clear();
        }
        this.applyEnabled(this.enabledFor(this.focused));
    }

    /**
     * A call took the audio route (DROVE-236), and gives it back.
     *
     * Its own input rather than another argument to `setEnabled`, because the
     * two say different things. A call must silence a session he switched on
     * himself even when the master default is off, and it must give that
     * session back afterwards rather than making him switch it on again.
     */
    setSuspended(suspended: boolean): void {
        if (this.suspended === suspended) return;
        this.suspended = suspended;
        this.applyEnabled(this.enabledFor(this.focused));
    }

    /** Is reading switched on for this session? Its own switch, or the default. */
    private enabledFor(sessionId: string | null): boolean {
        if (this.suspended) return false;
        if (sessionId === null) return this.defaultEnabled;
        return this.sessionEnabled.get(sessionId) ?? this.defaultEnabled;
    }

    /** Is reading switched on for this session? (DROVE-297.) */
    isSessionEnabled(sessionId: string): boolean {
        return this.enabledFor(sessionId);
    }

    /**
     * The session the VOICE is on: the focused one, and only while its reading
     * is switched on (DROVE-297).
     *
     * Not the same as `focusedSessionId`, which is whose timeline this reader
     * is holding. A session he switched off keeps its focus for a moment — the
     * screen is still there — but it has given the voice up, and every rule in
     * readingVoice.ts is written about the voice.
     */
    get readingSessionId(): string | null {
        return this.enabled ? this.focused : null;
    }

    /** The session he is LOOKING at, which need not be the one being read. */
    get visitedSessionId(): string | null {
        return this.visited;
    }

    /** What the list draws for this session (DROVE-297). */
    readingStateOf(sessionId: string): ReadingSessionState {
        return readingSessionState({
            session: sessionId,
            holder: this.readingSessionId,
            enabled: this.enabledFor(sessionId),
            paused: this.paused,
        });
    }

    /**
     * Switch this session's reading on or off, and let the rule decide what
     * that does to the voice (DROVE-297).
     *
     * The composer's read-aloud control lands here, and so does DROVE-298's
     * `drover read <session>` / `drover read off` from the terminal. One rule,
     * two entry points: both go through `voiceMove`, so a terminal cannot
     * invent semantics the thumb does not have.
     */
    setSessionEnabled(sessionId: string, enabled: boolean): void {
        const was = this.enabledFor(sessionId);
        this.sessionEnabled.set(sessionId, enabled);
        if (was === enabled) return;
        // OFF SUBSUMES PAUSE, PER SESSION (DROVE-289 decision 4), and it does
        // so whether or not this session had the voice. Switching a YIELDED
        // session off has to drop its held place too, or coming back on would
        // resume in the middle of a reply from before he switched it off —
        // which is the resume-at-a-stale-position failure, reached the long
        // way round.
        if (!enabled) this.heldReadings.delete(sessionId);
        this.applyMove(voiceMove(enabled ? 'enable' : 'disable', {
            holder: this.readingSessionId,
            session: sessionId,
            enabled: was,
        }));
    }

    /**
     * He navigated to this session (DROVE-297).
     *
     * Replaces the bare `focus` the chat screen used to call. The difference is
     * the whole ticket: arriving somewhere is not a claim on the voice. If this
     * session's reading is on it TAKES the voice, resuming at its own held
     * position and pausing whoever had it. If it is off, nothing moves and the
     * session he was listening to carries on talking while he reads this one.
     */
    visit(sessionId: string, reason: ReadAloudInterruption = 'switched-session'): void {
        this.visited = sessionId;
        this.applyMove(voiceMove('visit', {
            holder: this.readingSessionId,
            session: sessionId,
            enabled: this.enabledFor(sessionId),
        }), reason);
    }

    /**
     * Carry out what the rule decided, with DROVE-289's machinery.
     *
     * `take` is `focus`, which already holds the outgoing session's whole
     * position and restores the target's own — so "pauses the one that was
     * reading" and "resumes at its own place" are the same two lines that
     * shipped in DROVE-289 rather than a second implementation of them.
     */
    private applyMove(move: VoiceMove, reason: ReadAloudInterruption = 'switched-session'): void {
        if (move.kind === 'keep') return;
        if (move.kind === 'release') {
            // The voice falls silent and nothing else claims it: turning one
            // session off must never start another one talking. The position
            // is thrown away by `applyEnabled`, which interrupts; the stashed
            // one, if any, went with `setSessionEnabled`.
            this.applyEnabled(false);
            return;
        }
        if (this.focused === move.session) {
            // Already the focused session, switched back on. `focus` would
            // return early, so the arming is done here; the queue was thrown
            // away when it went off, so this is a START at new content
            // (DROVE-226), not a resume.
            this.applyEnabled(true);
            this.pump();
            return;
        }
        this.focus(move.session, reason);
    }

    /**
     * The live gate moved: the voice's session was switched on or off, a call
     * took the route or gave it back, or the master flipped.
     *
     * OFF SUBSUMES PAUSE, in both directions (DROVE-233). Going off throws the
     * position away, so there is nothing left to be holding. Coming on is a
     * START, which DROVE-226 places at new content — the one thing a resume
     * must never be. Either way the button comes back to two states and a
     * pause cannot survive as a state nothing can see.
     */
    private applyEnabled(enabled: boolean): void {
        if (this.enabled === enabled) return;
        this.enabled = enabled;
        this.setPausedSilently(false);
        if (!enabled) {
            this.interrupt('toggled-off');
            this.notifyTransport();
            return;
        }
        // Switched back on with a sentence still owed to a session that
        // refused it (DROVE-189). Ask again now rather than on the timer.
        this.audioSessionRecovered();
        this.notifyTransport();
    }

    get isMicHeld(): boolean {
        return this.micHeld;
    }

    /** Is he holding it? (DROVE-233.) False whenever read-aloud is off. */
    get isPaused(): boolean {
        return this.paused;
    }

    /**
     * Pause or resume, from any of the three surfaces (DROVE-233).
     *
     * The long press on the speaker, a single headphone press and the lock
     * screen all land here, which is what makes "pause in my ears, resume with
     * my thumb" continue at the same sentence: there is one state and one
     * position, and neither surface owns either.
     *
     * PAUSING touches nothing but the utterance in flight. Not the cursor, not
     * a spoken mark, not the timeline, not the tails. `cutCurrentUtterance`
     * bumps the generation so the cut utterance's promise cannot pump the next
     * sentence behind our back, and stops there. The sentence that was
     * speaking keeps its `spoken` mark, because DROVE-126 says a sentence that
     * made a sound stays spoken however little of it was heard — so a resume
     * carries on at the NEXT sentence and can never re-read.
     *
     * RESUMING is `pump`, and that is all it is. The position was never lost,
     * so there is nothing to restore.
     *
     * A pause is not an interrupt and does not notify the interrupt listeners:
     * it stops the voice, it does not throw the reading away, and a capture
     * that would stop for a real interrupt has no reason to stop for this.
     */
    setPaused(paused: boolean): void {
        // Nothing to hold a place in. A pause that could outlive the toggle
        // would be a silent reader claiming to be on.
        if (paused && !this.enabled) return;
        if (this.paused === paused) return;
        this.paused = paused;
        if (paused) {
            this.cutCurrentUtterance();
        } else {
            // The commonest reason the last utterance was refused is that
            // something else had the session, and the pause outlived it
            // (DROVE-189).
            this.audioSessionRecovered();
            this.pump();
        }
        this.notifyTransport();
    }

    /** Drop the pause without a pump, for the paths that are about to do their own. */
    private setPausedSilently(paused: boolean): void {
        if (this.paused === paused) return;
        this.paused = paused;
    }

    /**
     * On, paused or off has changed — or the reading moved to another session
     * (DROVE-233, DROVE-289).
     *
     * No payload: the listener reads `isEnabled`, `isPaused` and
     * `focusedSessionId`, which is what `useSyncExternalStore` wants and what
     * keeps the button and the lock screen reading the same fields rather
     * than a copy that can drift. A focus move fires it because the wrist's
     * reading names the session (DROVE-275) and its publish rides these
     * listeners; without it a switch would sit on the wire until the next
     * heartbeat.
     */
    private notifyTransport(): void {
        for (const listener of this.transportListeners) {
            try {
                listener();
            } catch {
                // A button that failed to redraw must not wedge the reader.
            }
        }
    }

    /** Told when on/paused/off changes, and on a focus move. Returns the unsubscribe. */
    addTransportListener(listener: () => void): () => void {
        this.transportListeners.add(listener);
        return () => { this.transportListeners.delete(listener); };
    }

    /**
     * Is there anything still to SAY? (DROVE-174.)
     *
     * Not the same question as `isSpeaking`. This is the sentence that has not
     * started yet, and it is what the cue mixer needs: a cue that starts in
     * the few milliseconds between two sentences is a cue over speech, and on
     * iOS it was a cue that tore the audio session down under the next one.
     * Nothing here is a promise to speak — the mic gate or a toggle can still
     * take it away — only that the reader has material it intends to say.
     */
    get speechPending(): boolean {
        // A PAUSE IS NOT PENDING SPEECH (DROVE-233). The mic gate and a toggle
        // can take a pending sentence away and this getter deliberately does
        // not care, because both are over in a second or two. A pause is not:
        // it lasts until he presses something, and a cue mixer that treated it
        // as "speech is coming" would hold every earcon until it went stale
        // and silence the heartbeat for as long as he was paused. Nothing is
        // about to be said, so nothing is pending.
        if (this.paused) return false;
        if (this.urgent.length > 0) return true;
        if (this.detour.length > 0) return true;
        return this.skipSpoken(this.cursor) < this.timeline.length;
    }

    /**
     * The app went to the background, or came back (DROVE-189).
     *
     * Reading does NOT stop either way. All this decides is whether a drained
     * queue releases the audio session: in the foreground it should, so ducked
     * music comes up; in the background it must not, because an app that has
     * released its session is an app iOS suspends, and a suspended app never
     * hears the next reply let alone reads it.
     */
    setBackgrounded(backgrounded: boolean): void {
        if (this.backgrounded === backgrounded) return;
        this.backgrounded = backgrounded;
        if (backgrounded) return;
        // Coming back to the foreground with nothing to say hands the session
        // over at the first opportunity rather than holding it all day. And
        // if a sentence is owed because the session refused it in his pocket,
        // this is the moment it will be taken (DROVE-189).
        this.audioSessionRecovered();
        if (!this.speaking) this.pump();
    }

    /**
     * Say this NOW, ahead of the transcript (DROVE-188).
     *
     * For a gate waiting on Clay, and for nothing else. It never cuts the
     * sentence in flight: `pump` runs only when the synthesiser is idle, so
     * the current sentence finishes and this is next. `key` is the gate's own
     * id, so `cancelUrgent` can take it back if he answers first.
     */
    sayUrgent(key: string, text: string): void {
        if (!this.enabled) return;
        if (text.length === 0) return;
        if (this.urgent.some((line) => line.key === key && line.text === text)) return;
        this.urgent.push({ key, text });
        this.pump();
    }

    /** Un-say a gate that was answered, dismissed or expired before its turn. */
    cancelUrgent(key: string): void {
        this.urgent = this.urgent.filter((line) => line.key !== key);
        // A gate answered while its session's reading is HELD must not be
        // read on his return (DROVE-289): the line is stale the moment the
        // gate stops being pending, wherever its session's reading lives.
        for (const held of this.heldReadings.values()) {
            held.urgent = held.urgent.filter((line) => line.key !== key);
        }
    }

    /** Lines still waiting to jump the queue. For the tests. */
    get urgentPending(): number {
        return this.urgent.length;
    }

    /**
     * Read a transcript this reader is NOT following, then come back
     * (DROVE-195).
     *
     * Clay: "if you go to a subagent and tap a sentence from it while I'm in
     * reading mode it will read it." The reader follows ONE session, and a
     * subagent's transcript is fetched by the agent screen over its own RPC
     * and never reaches `onMessages`. So the sentence he tapped is not in the
     * timeline, cannot be, and `seekToSentence` would miss it and fall back to
     * seeking the SESSION by createdAt, which moves the reading to whatever
     * unrelated reply shares that minute. Silently wrong is worse than inert,
     * and inert is what DROVE-164 already ruled out.
     *
     * THE DECISION, written down: the reader FOLLOWS HIM INTO THE SUBAGENT,
     * and it does so as a detour rather than as a move. The session keeps its
     * focus, its timeline, its cursor and every spoken mark; sentences still
     * arriving for it still queue, because focus never left. All that changes
     * is what is said next. When the borrowed sentences run out the session's
     * own reading resumes at exactly the sentence it was going to say anyway.
     *
     * A move was the alternative and it is wrong twice over: `focus` throws
     * the timeline away and nothing refills it (`onMessages` is fed deltas, so
     * coming back would be silence until the model wrote something new), and
     * while the focus was elsewhere the session's own arriving replies would
     * be dropped on the floor.
     *
     * Gates still outrank this (DROVE-188): a session blocked on him costs
     * more than a paragraph of an agent's transcript.
     *
     * IT SURVIVES HIM LEAVING THE AGENT SCREEN, because DROVE-179 settled that
     * a surface going away is not a request for silence and this is the same
     * rule: he asked for the agent's work to be read and swiping back is not
     * him taking that back. The reading mark goes with the screen; the voice
     * does not. What DOES end it is asking the session something new, which is
     * him moving on, and anything the gate calls a real stop.
     *
     * Unlike `sayUrgent` this CUTS the sentence in flight, because it is a
     * seek and seeks take effect under the finger (DROVE-163). It goes around
     * `interrupt` for the same reason a seek does: a tap is not a reason to
     * stop the microphone.
     */
    readDetour(sentences: readonly ReadAloudDetourSentence[]): boolean {
        if (!this.enabled) return false;
        if (sentences.length === 0) return false;
        this.detour = sentences.map((at) => ({
            text: at.text,
            words: countWords(at.text),
            turn: this.turn,
            messageId: at.messageId,
            createdAt: at.createdAt,
            spoken: false,
            aside: false,
            thinking: false,
        }));
        this.cutCurrentUtterance();
        this.pump();
        return true;
    }

    /** Borrowed sentences still to say. For the tests. */
    get detourPending(): number {
        return this.detour.length;
    }

    /**
     * The microphone has the audio session, or has given it back (DROVE-143).
     *
     * `interrupt('mic')` cuts the sentence in flight, but cutting once is not
     * enough: the reader is a QUEUE, and a reply still streaming in enqueues
     * another sentence a moment later, which pumps, which speaks, and every
     * `speak` sets the session to `.playback`. The recogniser then reads its
     * input format in the wrong category, gets 0 Hz / 0 channels, and the
     * native guard refuses the capture. From outside that is a mic press that
     * pops an alert and a button that does not stay open.
     *
     * So the reader is silent for the WHOLE capture, not merely at the start
     * of it. Nothing is thrown away: sentences that arrive meanwhile sit in
     * the timeline and reading carries on from the same position when the mic
     * lets go. The pause in the native module is the belt under this.
     */
    setMicHeld(held: boolean): void {
        if (this.micHeld === held) return;
        this.micHeld = held;
        if (held) {
            // Stop what is in flight AND hand the session back. A paused
            // utterance still owns the category, which is the fight itself.
            this.speaking = false;
            this.speakingTurn = null;
            this.rest();
            return;
        }
        // The route is free again, which is also the commonest reason an
        // utterance was refused in the first place (DROVE-189).
        this.audioSessionRecovered();
        this.pump();
    }

    /**
     * Which session is being READ. Only one, ever: four sessions finishing a
     * turn at once would have the phone narrating four replies over each other.
     *
     * A SWITCH HOLDS AND RESUMES, PER SESSION (DROVE-289). Leaving stashes the
     * outgoing session's whole reading exactly as a pause holds it — nothing
     * advances, nothing is dropped. Arriving restores the target's own held
     * reading, if it has one, and resumes FROM IT: never the tail, never the
     * previous session's place. A target with no held reading starts from
     * nothing, as before: silent until something arrives (DROVE-226). The
     * captures are told either way — the mic that was dictating into the old
     * session must not land words in the new one — and the transport listeners
     * fire so the button, the card and the wrist follow the switch.
     *
     * SINCE DROVE-297 THIS IS THE MECHANISM, NOT THE DECISION. Moving the
     * focus moves the voice, and the voice is only moved by the rule in
     * readingVoice.ts. The chat screen calls `visit`; the composer's control
     * and the CLI call `setSessionEnabled`; both ask the rule and only then
     * reach this. Calling `focus` directly is still how the voice is MOVED,
     * and it takes the target's own switch with it.
     */
    focus(sessionId: string | null, reason: ReadAloudInterruption = 'switched-session'): void {
        if (this.focused === sessionId) return;
        // Moving the focus moves the reading, so it may only ever be driven
        // by a reason the gate calls a real stop (DROVE-179). A caller that
        // means "this surface went away" wants `blur`.
        if (!stopsSpeech(reason)) {
            this.notifyInterrupted(reason);
            return;
        }
        this.holdFocused();
        this.focused = sessionId;
        // The voice arrives switched on or off according to the session it
        // arrived at (DROVE-297). `holdFocused` has already run, so it stashed
        // the OUTGOING session against the outgoing answer.
        this.enabled = this.enabledFor(sessionId);
        const restored = sessionId !== null ? this.heldReadings.get(sessionId) : undefined;
        if (restored !== undefined) {
            this.heldReadings.delete(sessionId as string);
            this.restoreHeld(restored);
        } else {
            this.freshFocus();
        }
        this.notifyInterrupted(reason);
        // The wire and the button follow the switch even when on/paused did
        // not change: the wrist's reading carries the sessionId (DROVE-275),
        // and its publish rides these listeners.
        this.notifyTransport();
        // AUTO-RESUME (DROVE-289): his words — "it starts reading from where
        // it left off". A restored PAUSE does not resume — `pump` defers to
        // it — because that pause is his and only his gesture lifts it.
        if (restored !== undefined) this.pump();
    }

    /**
     * Stash the focused session's reading before the focus moves
     * (DROVE-289).
     *
     * The switch-away half of "a switch is a pause": the utterance in flight
     * is cut (it keeps its spoken mark, DROVE-233's sentence granularity), the
     * held tails are flushed into the timeline — the reply as it stands is the
     * end of the reply for now, exactly as `onHistory` treats a tail — and the
     * whole position goes into `heldReadings` untouched. The transient
     * machinery (timers, the refusal stall) is reset either way: timers firing
     * into another session's timeline is cross-session corruption.
     */
    private holdFocused(): void {
        const leaving = this.focused;
        const stash = leaving !== null && this.enabled;
        if (stash) this.flushTails();
        this.cutCurrentUtterance();
        this.clearHold();
        this.clearRetry();
        this.stalled = false;
        this.refusals = 0;
        if (!stash) return;
        this.heldReadings.set(leaving as string, {
            timeline: this.timeline,
            cursor: this.cursor,
            queuedChunks: this.queuedChunks,
            pendingTails: this.pendingTails,
            latestCreatedAt: this.latestCreatedAt,
            turn: this.turn,
            turnOpenedAt: this.turnOpenedAt,
            markerDue: this.markerDue,
            paused: this.paused,
            lastPosition: this.lastPosition,
            urgent: this.urgent,
            detour: this.detour,
        });
        while (this.heldReadings.size > maxHeldReadings) {
            const oldest = this.heldReadings.keys().next().value;
            if (oldest === undefined) break;
            this.heldReadings.delete(oldest);
        }
    }

    /**
     * Take a held reading back as the live one (DROVE-289).
     *
     * The restore adopts the held objects outright — the map entry is deleted
     * by the caller, so nothing aliases. The arrival stamps start from
     * nothing on purpose: a restored reading is not "falling behind" whatever
     * the clock says, so it reads at the normal rate until its own live
     * stream re-establishes itself (DROVE-177).
     */
    private restoreHeld(s: HeldReading): void {
        this.timeline = s.timeline;
        this.cursor = s.cursor;
        this.queuedChunks = s.queuedChunks;
        this.pendingTails = s.pendingTails;
        this.latestCreatedAt = s.latestCreatedAt;
        this.turn = s.turn;
        this.turnOpenedAt = s.turnOpenedAt;
        this.markerDue = s.markerDue;
        this.lastPosition = s.lastPosition;
        this.urgent = s.urgent;
        this.detour = s.detour;
        this.setPausedSilently(s.paused);
        this.arrivalTurn = -1;
        this.previousArrivalAt = Number.NEGATIVE_INFINITY;
        this.previousSayableArrivalAt = Number.NEGATIVE_INFINITY;
        this.armHold();
    }

    /** A session the reader has never held: the playhead starts from nothing. */
    private freshFocus(): void {
        this.queuedChunks = new Map();
        this.pendingTails = new Map();
        this.latestCreatedAt = 0;
        this.turnOpenedAt = 0;
        // Another session's arrival stamps say nothing about this one's, and
        // neither does its transcript.
        this.arrivalTurn = -1;
        this.previousArrivalAt = Number.NEGATIVE_INFINITY;
        this.previousSayableArrivalAt = Number.NEGATIVE_INFINITY;
        this.timeline = [];
        this.cursor = 0;
        this.lastPosition = null;
        this.urgent = [];
        this.detour = [];
        this.markerDue = false;
        // A fresh session was never paused; the outgoing one's pause, if any,
        // went into its held reading and is still its own.
        this.setPausedSilently(false);
    }

    /** Is this switched-away session holding its place? For the tests. */
    hasHeldReading(sessionId: string): boolean {
        return this.heldReadings.has(sessionId);
    }

    /**
     * Give focus up, but only if this session still holds it.
     *
     * More than one chat can be mounted (the tablet side panel, an embedded
     * view, the screen being replaced) and they unmount on their own
     * schedule. A bare focus(null) from any of them took the voice away from
     * whichever session the user was actually looking at.
     */
    blur(sessionId: string, reason: ReadAloudInterruption = 'left-session'): void {
        if (this.focused !== sessionId) return;
        // DROVE-179. A surface going away is not the session going away. He
        // opened the agent screen, a sheet took the route, the transport
        // blipped, the tablet's side panel had its turn: in every one of them
        // the session being read is still the session he is in, so focus, the
        // timeline and the playhead all stay exactly where they are and the
        // sentence in flight keeps playing. Only a reason the gate calls a
        // real stop gives the session up.
        if (!stopsSpeech(reason)) {
            this.notifyInterrupted(reason);
            return;
        }
        this.focus(null, reason);
    }

    /**
     * Read from `createdAt` on (DROVE-114, rewritten by DROVE-146).
     *
     * The ONE way the position moves from outside, and it is a double tap on
     * a section, not a scroll. A createdAt rather than a message id because
     * the tap can land on a user message or a tool card, which have no
     * sentences of their own: it means "start from the first thing sayable at
     * or after here".
     *
     * Deliberate, so it outranks DROVE-126: the marks from the tap onwards are
     * cleared and the section is read again. That invariant exists to stop the
     * QUEUE repeating itself while nobody asked; being asked is the exception
     * it was always missing. Nothing here is reachable from a scroll frame any
     * more, so a repeated seek costs nothing and cannot stutter.
     */
    seekTo(createdAt: number): void {
        let next = this.timeline.length;
        for (let i = 0; i < this.timeline.length; i++) {
            if (this.timeline[i].createdAt >= createdAt) {
                next = i;
                break;
            }
        }
        // Nothing sayable at or after the tap. Leave reading where it is
        // rather than parking the cursor past the end.
        if (next === this.timeline.length) return;
        this.readFrom(next);
    }

    /**
     * Read from the SENTENCE that was tapped (DROVE-163).
     *
     * Clay, refining DROVE-146: "Whatever SENTENCE I tap is where you start
     * reading". `seekTo` resolves a tap to the first sayable thing at or after
     * a message's createdAt, which in the middle of a long reply is the top of
     * the block rather than the line under his finger. Every sentence in the
     * timeline already carries the message it came from, so given the rendered
     * text of the one he touched this is a lookup, not a measurement: no
     * coordinates, no layout, nothing that could fight the list.
     *
     * The search runs over the whole timeline rather than the message's own
     * range because one reply arrives as several messages and the same
     * sentence can occur twice; the FIRST match inside the tapped message is
     * the one under the finger, which is why messageId is matched first.
     *
     * Returns false when the sentence is not in the queue at all — read-aloud
     * was off when the reply landed, or the renderer shows something the
     * speaker dropped. The caller then falls back to `seekTo`, which is
     * DROVE-146's behaviour exactly.
     */
    seekToSentence(messageId: string, sentence: string): boolean {
        for (let i = 0; i < this.timeline.length; i++) {
            const at = this.timeline[i];
            if (at.messageId !== messageId) continue;
            if (!sameSentence(at.text, sentence)) continue;
            this.readFrom(i);
            return true;
        }
        return false;
    }

    /**
     * Move reading to `index` and carry on from there.
     *
     * Deliberate, so it outranks DROVE-126: the marks from here onwards are
     * cleared and the material is read again. That invariant exists to stop
     * the QUEUE repeating itself while nobody asked; being asked is the
     * exception it was always missing. Nothing here is reachable from a scroll
     * frame any more (DROVE-146), so a repeated seek costs nothing and cannot
     * stutter.
     */
    private readFrom(index: number): void {
        for (let i = index; i < this.timeline.length; i++) this.timeline[i].spoken = false;
        this.cursor = index;
        // Whatever is in the air belongs to the old position. Cut it without
        // going through interrupt(): a tap is not a reason to stop the mic.
        this.cutCurrentUtterance();
        this.markerDue = false;
        this.pump();
    }

    /**
     * The transcript this session ALREADY had, which is never spoken
     * (DROVE-226).
     *
     * Clay: "START READING ONLY NEW FUCKING MESSAGING unless I double tap a
     * specific place to start." Reading speaks what has arrived; it does not
     * walk back into the conversation on its own.
     *
     * The reader could not tell the difference on its own and it should not
     * have to guess. `applyMessages` in sync.ts carries two quite different
     * things down one pipe: the live stream, and the transcript being FETCHED:
     * the most recent page when a session opens, and then, in the background,
     * every older page in turn. Both looked identical here, so
     * opening a session read its last reply again and the prefetch then
     * narrated the whole conversation backwards, one page at a time, stamped
     * with the current turn so not even `abandonTurnsBefore` could catch it.
     * So the fetch says what it is and this is where it lands.
     *
     * These sentences are REMEMBERED, not dropped, and the difference is his
     * tap. A sentence that is not in the timeline is a sentence `seekToSentence`
     * cannot find, and DROVE-163 is the one way reading is allowed to start
     * anywhere but the newest thing. So they go in, in their place in time,
     * marked spoken: `skipSpoken` steps over every one of them, and a tap
     * clears the marks from where he pointed and reads on (`readFrom`).
     *
     * Not offered to `asideFor` or `thinkingFor` either. A title is a thing to
     * SAY as a tool call happens, and there is nothing live about a tool call
     * that finished before he opened the session.
     */
    onHistory(sessionId: string, messages: Message[]): void {
        if (!this.enabled) return;
        if (this.focused === null || sessionId !== this.focused) return;

        for (const message of [...messages].sort((a, b) => a.createdAt - b.createdAt)) {
            if (message.kind !== 'agent-text' || message.isThinking) continue;
            if (typeof message.text !== 'string' || message.text.length === 0) continue;
            const { complete, pending } = chunkStreamed(stripToSpeakableProse(message.text), false);
            // The tail counts as a sentence HERE, unlike in `onMessages`: the
            // last line of a reply that has been sitting there for an hour is
            // not waiting for more text, it is the end of the reply, and it is
            // on his screen to be tapped. It is deliberately not counted into
            // `queuedChunks`, so a message still being written when he opened
            // the session has its finished sentence read once it lands.
            const sentences = pending !== null ? [...complete, pending] : complete;
            const already = this.queuedChunks.get(message.id) ?? 0;
            if (sentences.length <= already) continue;
            this.remember(sentences.slice(already), message.id, message.createdAt);
            this.queuedChunks.set(message.id, complete.length);
        }
    }

    /**
     * Put sentences in the timeline that must never be said (DROVE-226).
     *
     * Two things make this different from `enqueue`, and both are about the
     * timeline being a TRANSCRIPT rather than a queue:
     *
     *   - `spoken` is true from the start. The queue's own invariant then does
     *     all the work: `skipSpoken` steps over them, `speechPending` does not
     *     count them, and only a tap (`readFrom`) can clear the marks.
     *   - They are INSERTED at their place in time rather than appended. The
     *     older pages arrive newest-first, so appending would leave the
     *     timeline out of order, and everything that reads it takes the order
     *     for granted: `seekTo`'s scan, and `readFrom` clearing the marks
     *     "from here on". A tap in the middle of a reply would otherwise
     *     un-mark a page of ancient history sitting behind it and read that.
     *
     * The cursor is a position in the array, so material inserted at or before
     * it moves with it. Nothing about the reading position changes.
     */
    private remember(sentences: string[], messageId: string, createdAt: number): void {
        if (sentences.length === 0) return;
        let at = this.timeline.length;
        for (let i = 0; i < this.timeline.length; i++) {
            if (this.timeline[i].createdAt > createdAt) {
                at = i;
                break;
            }
        }
        const remembered = sentences.map((text) => ({
            text,
            words: countWords(text),
            turn: this.turn,
            messageId,
            createdAt,
            spoken: true,
            aside: false,
            thinking: false,
        }));
        this.timeline.splice(at, 0, ...remembered);
        if (at <= this.cursor) this.cursor += remembered.length;
    }

    /**
     * Make sure the transcript at or after `createdAt` is in the timeline,
     * because a tap is about to seek there (DROVE-285).
     *
     * Clay: "when I scroll up and double tap because I wanted it to go read
     * something to me from the past, it doesn't read it." The timeline only
     * ever held what went past while the reader was ON and FOCUSED:
     * `onHistory` drops every page that arrives while it is off or elsewhere,
     * the transcript is fetched exactly once per session, and neither
     * `setEnabled` nor `focus` re-feeds anything (`freshFocus` starts empty
     * on purpose). So everything on his screen from before the toggle was
     * permanently absent, the sentence lookup missed, and the block fallback
     * seeked a timeline whose every entry was newer than the tap — the wrong
     * place, or nothing at all.
     *
     * Pointing at it IS the ask, which is what squares this with DROVE-226:
     * the absent messages are pulled from the store and go through the same
     * `onHistory` ingestion, in their place in time, MARKED SPOKEN — so the
     * ingest itself says nothing, ever, and only the seek that follows it
     * clears the marks from the sentence he touched. History still never
     * reads unasked; it just stops being unreachable when he asks.
     *
     * Everything from the tap FORWARD, not just the tapped message, so the
     * reading runs on through the rest of the history and into the live
     * replies instead of falling into a gap after one block. Messages the
     * reader has already seen are skipped by id — `queuedChunks` keys every
     * prose ingest, live or historic — which is also what makes a second tap
     * on the same sentence a plain re-read rather than a duplicate:
     * `onHistory` counts only COMPLETE sentences, so re-offering a message
     * whose tail had no full stop would remember that tail twice.
     *
     * Only the FOCUSED session's live timeline is touched. A held reading's
     * stash (DROVE-289) is by definition not the focused one, so an ingest
     * here can never corrupt it.
     */
    ensureHistoryFrom(createdAt: number): void {
        if (!this.enabled) return;
        if (this.focused === null) return;
        if (this.historyFor === null) return;
        const absent = this.historyFor(this.focused).filter(
            (message) => message.createdAt >= createdAt && !this.queuedChunks.has(message.id),
        );
        if (absent.length === 0) return;
        this.onHistory(this.focused, absent);
    }

    onMessages(sessionId: string, messages: Message[]): void {
        if (!this.enabled || this.focused === null || sessionId !== this.focused) {
            // A held session's timeline KEEPS FILLING, exactly as a paused
            // one's does (DROVE-233, taken per session by DROVE-289): what
            // arrives while he is elsewhere queues unspoken, so a resume
            // reads on through it instead of skipping it.
            //
            // Asked BEFORE the live gate since DROVE-297, not after. A yielded
            // session's fill has nothing to do with whether the session that
            // took the voice is still switched on, and gating it on that put a
            // hole in the yielded session's reply the moment he switched the
            // talking one off.
            const held = this.heldReadings.get(sessionId);
            if (held !== undefined) this.fillHeld(held, messages);
            return;
        }

        const ordered = [...messages].sort((a, b) => a.createdAt - b.createdAt);
        let added = false;
        // Only PROSE is an arrival. A title says the agent is working, not
        // writing, and is no reason to speed up or cut (DROVE-177).
        let proseAdded = false;
        for (const message of ordered) {
            // A message from the user opens the next turn (DROVE-108). It is
            // the one boundary that is visible from here: agent text arrives
            // in several blocks per turn, so a new message id says nothing.
            if (message.kind === 'user-text' && message.createdAt > this.turnOpenedAt) {
                this.turn += 1;
                this.turnOpenedAt = message.createdAt;
                // He has asked the session something new, so an agent's
                // transcript he was part way through is no longer what he
                // wants read (DROVE-195). The same rule the session's own
                // backlog gets in `abandonTurnsBefore`, one turn earlier.
                this.detour = [];
            }

            // The title of a tool call, a terminal call or an agent spawning
            // (DROVE-112). Every message is offered, prose included, because
            // the policy on the other side folds runs and has to see where one
            // ends; almost all of them are worth nothing and answer null.
            if (this.asideFor !== null) {
                const aside = this.asideFor(message, sessionId);
                // Offered every time but enqueued once. The policy is asked
                // again on a redelivery because it has its own reasons to look
                // (a tool call that has finished since), and the mark that
                // stops the title being said twice belongs here, in the queue,
                // beside the one that stops a reply being re-read: the spoken
                // flag cannot do it, because a second enqueue is a second
                // sentence and has never been spoken (DROVE-126).
                const asideKey = `aside:${message.id}`;
                if (aside !== null && aside.length > 0 && !this.queuedChunks.has(asideKey)) {
                    this.queuedChunks.set(asideKey, 1);
                    // A held tail is over the moment something else lands, and
                    // it has to be said BEFORE the title or the two cross.
                    if (this.flushTails((id) => id !== message.id)) added = true;
                    this.enqueue([aside], this.turn, message.id, message.createdAt, true);
                    added = true;
                }
            }

            // The model's reasoning, read in its place (DROVE-181). Same
            // shape as the aside above and for the same reasons: offered every
            // time, enqueued once, and NOT counted as an arrival — a thought
            // is the model thinking, not writing, and letting it hold the
            // arrival window open would bring the catch-up rate back on a
            // reply that has already landed whole (DROVE-177).
            if (this.thinkingFor !== null && message.kind === 'agent-text' && message.isThinking) {
                const thought = this.thinkingFor(message, sessionId);
                const thinkingKey = `thinking:${message.id}`;
                const already = this.queuedChunks.get(thinkingKey) ?? 0;
                if (thought !== null && thought.length > 0) {
                    const { complete, pending } = chunkStreamed(stripToSpeakableProse(thought), false);
                    // A thought STREAMS, so it is chunked and counted exactly
                    // the way prose is; the tail is held under its own key so
                    // a half-finished sentence is not read twice.
                    const sentences = pending !== null ? [...complete, pending] : complete;
                    if (sentences.length > already) {
                        if (this.flushTails((id) => id !== message.id)) added = true;
                        this.enqueue(sentences.slice(already), this.turn, message.id, message.createdAt, false, true);
                        this.queuedChunks.set(thinkingKey, sentences.length);
                        added = true;
                    }
                }
            }

            if (message.kind !== 'agent-text' || message.isThinking) continue;
            if (typeof message.text !== 'string' || message.text.length === 0) continue;

            // A newer message means every older one is over: their tails are
            // spoken as they stand, and before this message's sentences.
            if (message.createdAt > this.latestCreatedAt) {
                if (this.flushTails((id) => id !== message.id)) added = proseAdded = true;
                this.latestCreatedAt = message.createdAt;
            }

            const prose = stripToSpeakableProse(message.text);
            const { complete, pending } = chunkStreamed(prose, false);
            const already = this.queuedChunks.get(message.id) ?? 0;
            if (complete.length > already) {
                this.enqueue(complete.slice(already), this.turn, message.id, message.createdAt);
                this.queuedChunks.set(message.id, complete.length);
                added = proseAdded = true;
            }
            if (pending !== null) {
                this.pendingTails.set(message.id, { text: pending, turn: this.turn, createdAt: message.createdAt });
            } else {
                this.pendingTails.delete(message.id);
            }
        }
        // Prose moves both clocks; a thought or a title moves only the one
        // the CUT reads (DROVE-181, DROVE-177).
        if (added) this.noteArrival(proseAdded);
        this.armHold();
        if (added) this.pump();
    }

    /**
     * Arrivals for a session whose reading is HELD (DROVE-289).
     *
     * The paused half of `onMessages`, run against the held state instead of
     * the live fields: prose is chunked and queued unspoken with the same
     * dedupe, a user message opens the next turn, and DROVE-108's rule runs
     * here exactly as it runs while paused — a new turn steps the held cursor
     * past the older turn's unspoken tail and owes the marker once. Nothing
     * is spoken and no clock moves: there is no utterance to cut, the
     * arrival stamps belong to the live session, and a backlog gathered while
     * he was away is not a stream he is falling behind — it is read out at
     * the normal rate on resume, or cut by the live rules once its stream
     * picks back up.
     *
     * Not offered to `asideFor` or `thinkingFor`, for `onHistory`'s reason: a
     * title is a thing to SAY as a tool call happens, and nothing is live
     * about a session he is not in. Tails are held without a timer — the
     * next message flushes them, and `restoreHeld` arms the hold for
     * whatever is left.
     */
    private fillHeld(state: HeldReading, messages: Message[]): void {
        for (const message of [...messages].sort((a, b) => a.createdAt - b.createdAt)) {
            if (message.kind === 'user-text' && message.createdAt > state.turnOpenedAt) {
                state.turn += 1;
                state.turnOpenedAt = message.createdAt;
                // He asked the session something new; a borrowed transcript
                // he was part way through is no longer wanted (DROVE-195).
                state.detour = [];
                while (state.cursor < state.timeline.length && state.timeline[state.cursor].turn < state.turn) {
                    state.cursor += 1;
                }
                for (const [id, tail] of [...state.pendingTails]) {
                    if (tail.turn < state.turn) state.pendingTails.delete(id);
                }
                state.markerDue = true;
            }
            if (message.kind !== 'agent-text' || message.isThinking) continue;
            if (typeof message.text !== 'string' || message.text.length === 0) continue;

            // A newer message ends every older one's tail, exactly as live.
            if (message.createdAt > state.latestCreatedAt) {
                for (const [id, tail] of [...state.pendingTails]) {
                    if (id === message.id) continue;
                    state.pendingTails.delete(id);
                    this.pushHeld(state, [tail.text], tail.turn, id, tail.createdAt);
                    state.queuedChunks.set(id, (state.queuedChunks.get(id) ?? 0) + 1);
                }
                state.latestCreatedAt = message.createdAt;
            }

            const { complete, pending } = chunkStreamed(stripToSpeakableProse(message.text), false);
            const already = state.queuedChunks.get(message.id) ?? 0;
            if (complete.length > already) {
                this.pushHeld(state, complete.slice(already), state.turn, message.id, message.createdAt);
                state.queuedChunks.set(message.id, complete.length);
            }
            if (pending !== null) {
                state.pendingTails.set(message.id, { text: pending, turn: state.turn, createdAt: message.createdAt });
            } else {
                state.pendingTails.delete(message.id);
            }
        }
    }

    /** Append sentences, unspoken, to a held session's timeline (DROVE-289). */
    private pushHeld(
        state: HeldReading,
        sentences: string[],
        turn: number,
        messageId: string,
        createdAt: number,
    ): void {
        for (const text of sentences) {
            state.timeline.push({
                text,
                words: countWords(text),
                turn,
                messageId,
                createdAt,
                spoken: false,
                aside: false,
                thinking: false,
            });
        }
    }

    /**
     * Cut speech now, mid-word, not at the end of the sentence, and tell
     * every capture that it is over too. Listeners hear about EVERY call,
     * including one made while nothing was speaking: a latched mic with
     * read-aloud off is still a mic that has to stop when the user types.
     *
     * The timeline itself survives: the user can still scroll back over what
     * was already said and have it read again (DROVE-114). What ends is the
     * reading, so the position goes to the end and the marking clears.
     */
    interrupt(reason: ReadAloudInterruption): void {
        // THE gate (DROVE-179). Every path that wants the voice to stop comes
        // through here and names its reason, and one table decides. A reason
        // that does not stop the voice still tells the captures: a latched mic
        // really does have to stop when he types, and that half of this method
        // was never the half that was wrong.
        if (!stopsSpeech(reason)) {
            this.notifyInterrupted(reason);
            return;
        }
        this.generation += 1;
        this.cursor = this.timeline.length;
        // A pause holds a place in a queue, and this is the queue being thrown
        // away (DROVE-233). Keeping it would leave a reader that is on, silent,
        // and holding a position that no longer exists — and the next reply
        // would arrive to nothing. Released here so a new turn reads.
        //
        // ONLY the reasons that stop the voice reach this line, which is the
        // gate table's doing and is the behaviour that is wanted: `sent`,
        // `typed`, `backgrounded` and `left-session` do not throw the queue
        // away, so there is still a place to be holding and the pause is his
        // to release. He asked for silence; sending a message is not him
        // taking it back.
        const wasPaused = this.paused;
        this.setPausedSilently(false);
        this.pendingTails.clear();
        // A gate line belongs to a session and a queue the user threw away.
        this.urgent = [];
        // So does a transcript borrowed from one of its screens (DROVE-195).
        this.detour = [];
        this.clearHold();
        // Nothing is owed to a queue the user threw away, so the refusal
        // stall and its retry go with it (DROVE-189).
        this.clearRetry();
        this.stalled = false;
        this.refusals = 0;
        this.speaking = false;
        this.speakingTurn = null;
        this.setPlayhead(null);
        // Nothing is owed to a queue the user threw away.
        this.markerDue = false;
        if (this.started) {
            this.started = false;
            void this.engine.stop();
        }
        if (wasPaused) this.notifyTransport();
        this.notifyInterrupted(reason);
    }

    /**
     * The user sent a message (DROVE-122).
     *
     * Every capture stops, exactly as interrupt('sent') made it: the
     * dictation that produced the message is over. Reading does NOT stop.
     * At this instant the reply being asked for does not exist, so cutting
     * here buys a silence as long as the model takes to start writing. The
     * old reply keeps being read until the new turn's first speakable
     * sentence arrives, and `abandonTurnsBefore` cuts it there with the one
     * marker DROVE-108 established. If the old reply runs out first, the
     * reader rests, which is the right kind of silence.
     */
    userSent(): void {
        this.interrupt('sent');
    }

    /**
     * The user typed into the composer (DROVE-162).
     *
     * Every capture stops, exactly as `interrupt('typed')` made it: keystrokes
     * landing on top of a live transcription is the mess DROVE-30 wired the
     * interrupt listeners to prevent. Reading does NOT stop.
     *
     * Clay: "And don't stop talking when I'm typing". He is usually typing the
     * next thing WHILE listening to the current reply, which is the entire
     * point of read-aloud on a phone, so a keystroke cutting the voice made
     * the two features mutually exclusive. Nothing about typing says the
     * answer being read is no longer wanted, and nothing about it needs the
     * audio session either — which is what separates it from the mic
     * (DROVE-143), where the recogniser genuinely cannot share the route.
     *
     * Same shape as `userSent`, and for the same reason: `interrupt` had two
     * jobs welded together, telling the captures to stop and throwing the
     * reading away, and only the first of them was ever wanted here.
     */
    userTyped(): void {
        this.interrupt('typed');
    }

    private notifyInterrupted(reason: ReadAloudInterruption): void {
        for (const listener of this.interruptListeners) {
            try {
                listener(reason);
            } catch {
                // One controller failing to stop must not keep the next one
                // from hearing that it should.
            }
        }
    }

    /** Returns the unsubscribe. */
    addInterruptListener(listener: ReadAloudInterruptListener): () => void {
        this.interruptListeners.add(listener);
        return () => { this.interruptListeners.delete(listener); };
    }

    private enqueue(
        sentences: string[],
        turn: number,
        messageId: string,
        createdAt: number,
        aside = false,
        thinking = false,
    ): void {
        if (sentences.length === 0) return;
        this.abandonTurnsBefore(turn);
        for (const text of sentences) {
            this.timeline.push({
                text,
                words: countWords(text),
                turn,
                messageId,
                createdAt,
                spoken: false,
                aside,
                thinking,
            });
        }
    }

    /**
     * A newer turn has something to say, so whatever is left of the older one
     * is dropped and the marker is owed once (DROVE-108).
     *
     * This cuts the utterance in flight WITHOUT going through interrupt():
     * the mic and the other captures hang off that, and a reply arriving is
     * not a reason to stop the user talking.
     *
     * Since DROVE-114 the older sentences are stepped OVER rather than thrown
     * away: they are still in the transcript, so scrolling back to them still
     * reads them.
     */
    private abandonTurnsBefore(turn: number): void {
        const staleQueued = this.cursor < this.timeline.length && this.timeline[this.cursor].turn < turn;
        const staleSpeaking = this.speaking && this.speakingTurn !== null && this.speakingTurn < turn;
        if (!staleQueued && !staleSpeaking) return;

        while (this.cursor < this.timeline.length && this.timeline[this.cursor].turn < turn) {
            this.cursor += 1;
        }
        for (const [id, tail] of [...this.pendingTails]) {
            if (tail.turn < turn) this.pendingTails.delete(id);
        }
        this.markerDue = true;
        if (staleSpeaking) this.cutCurrentUtterance();
    }

    /**
     * The first position at or after `from` that has not been said.
     *
     * THE invariant, and it lives here alone rather than in each caller
     * (DROVE-126): A SENTENCE THAT HAS BEEN SPOKEN IS NEVER SPOKEN AGAIN.
     * Once said it is done, whatever the cursor does afterwards.
     *
     * The cursor cannot carry that on its own any more. Until DROVE-114 it
     * could, because sentences were shifted off as they were said, so
     * "behind the cursor" and "already said" were the same fact. Keeping the
     * whole timeline split them apart, and the seek moves the cursor
     * backwards over spoken material every time the reading position runs
     * off the top of the screen, which DROVE-122 made routine by letting the
     * voice carry on across a send. Hence a mark per sentence.
     *
     * Scrolling back is still not a replay: reading steps over what it has
     * said and then stops at the bottom of the screen, which is above the
     * unread edge, so the user gets silence until the view comes forward
     * again. Scrolling forward still skips unread material, and skipped is
     * not spoken, so it stays reachable rather than being burnt.
     */
    private skipSpoken(from: number): number {
        let at = from;
        while (at < this.timeline.length && this.timeline[at].spoken) at += 1;
        return at;
    }

    /** Stop the utterance in flight without telling the interrupt listeners. */
    private cutCurrentUtterance(): void {
        this.generation += 1;
        this.speaking = false;
        this.speakingTurn = null;
        this.setPlayhead(null);
        if (this.started) {
            this.started = false;
            void this.engine.stop();
        }
    }

    /** Speak the held tails whose message id passes `where`; true if any did. */
    private flushTails(where: (messageId: string) => boolean = () => true): boolean {
        let flushed = false;
        for (const [id, tail] of [...this.pendingTails]) {
            if (!where(id)) continue;
            this.pendingTails.delete(id);
            this.enqueue([tail.text], tail.turn, id, tail.createdAt);
            this.queuedChunks.set(id, (this.queuedChunks.get(id) ?? 0) + 1);
            flushed = true;
        }
        return flushed;
    }

    /**
     * New material landed; remember when, and when the batch before it did.
     *
     * `prose` says whether it is the model WRITING. Only prose moves the pair
     * the ramp reads; anything sayable moves the pair the cut reads. See the
     * fields for why the two are no longer one question.
     */
    private noteArrival(prose: boolean): void {
        const at = this.now();
        const newTurn = this.arrivalTurn !== this.turn;
        if (newTurn) {
            this.arrivalTurn = this.turn;
            this.previousArrivalAt = Number.NEGATIVE_INFINITY;
            this.previousSayableArrivalAt = Number.NEGATIVE_INFINITY;
        }
        if (prose) {
            if (!newTurn) this.previousArrivalAt = this.lastArrivalAt;
            this.lastArrivalAt = at;
        }
        if (!newTurn) this.previousSayableArrivalAt = this.lastSayableArrivalAt;
        this.lastSayableArrivalAt = at;
    }

    /**
     * Is this turn still being written? Only then may the backlog be cut.
     *
     * Measured from the batch BEFORE the most recent one, which rules out
     * the three ways a finished answer looks busy: a reply delivered whole
     * (there is no earlier batch), one big block landing after a pause (the
     * gap is too long to be a stream), and a stream that has since stopped
     * (the last batch is no longer recent). All three are read to the end.
     *
     * The session's own generating flag, when the caller passes one, vetoes
     * the whole thing: nothing is newer once the agent has finished.
     */
    private stillArriving(): boolean {
        if (this.turnFinished()) return false;
        return this.now() - this.previousArrivalAt <= this.arrivalWindowMs;
    }

    /** The cut's question: is there anything newer to skip TO? (DROVE-181.) */
    private somethingNewerToSay(): boolean {
        if (this.turnFinished()) return false;
        return this.now() - this.previousSayableArrivalAt <= this.arrivalWindowMs;
    }

    /** The agent has stopped. Nothing is newer once that is true. */
    private turnFinished(): boolean {
        return this.turnStillRunning !== null
            && this.focused !== null
            && !this.turnStillRunning(this.focused);
    }

    /**
     * Seconds of audio left to say, from word count and the speaking rate.
     *
     * A spoken title (DROVE-112) counts like any sentence: it takes the
     * speaker's time, which is what this measures. It is read a little
     * faster than prose, so the estimate is slightly high for it, by a
     * second at most per title, and the titles-per-run cap keeps the sum
     * small (DROVE-177).
     */
    private backlogSeconds(): number {
        let words = 0;
        for (let i = this.cursor; i < this.timeline.length; i++) {
            words += this.timeline[i].words;
        }
        return (words * 60) / this.wordsPerMinute;
    }

    /**
     * Read faster rather than cut (DROVE-108, corrected by DROVE-116). The
     * shape is `catchUpScale`; this only supplies the live ceiling.
     */
    private catchUpRate(backlogSeconds: number, speedUp: number, jump: number): number {
        return catchUpScale(backlogSeconds, speedUp, jump, this.maxRateScale());
    }

    private armHold(): void {
        this.clearHold();
        if (this.pendingTails.size === 0) return;
        this.holdTimer = setTimeout(() => {
            this.holdTimer = null;
            if (this.flushTails()) this.pump();
        }, this.holdMs);
    }

    private clearHold(): void {
        if (this.holdTimer === null) return;
        clearTimeout(this.holdTimer);
        this.holdTimer = null;
    }

    private setPlayhead(next: ReadAloudPlayhead | null): void {
        const same = next === null
            ? this.playheadValue === null
            : this.playheadValue !== null
                && this.playheadValue.messageId === next.messageId
                && this.playheadValue.sentence === next.sentence;
        if (same) return;
        this.playheadValue = next;
        if (next !== null) this.lastPosition = next.createdAt;
        for (const listener of this.playheadListeners) {
            try {
                listener(next);
            } catch {
                // A row failing to render must not stop the voice.
            }
        }
    }

    /** Drained: let the audio session go and mark nothing. */
    private rest(): void {
        this.setPlayhead(null);
        // In the BACKGROUND the session is kept (DROVE-189). Stopping here is
        // about releasing it so ducked music comes back up, and behind the
        // lock screen releasing it is how the app gets suspended and reading
        // ends for the rest of the session. Music stays ducked meanwhile,
        // which is the correct trade: he is listening to the session.
        if (this.backgrounded && this.enabled) return;
        if (this.started) {
            this.started = false;
            void this.engine.stop();
        }
    }

    private pump(): void {
        if (this.speaking) return;
        // The microphone has the audio session. Everything queued stays
        // queued; setMicHeld(false) pumps again (DROVE-143).
        if (this.micHeld) return;
        // He paused it (DROVE-233). Same rule, one line below the one it is
        // modelled on: everything queued stays queued, the cursor does not
        // move, and setPaused(false) pumps again from exactly here.
        if (this.paused) return;
        // The session refused the last utterance and the retry has not come
        // round yet (DROVE-189). Everything queued stays queued, including the
        // sentence that was refused; pumping here is what burned the reply.
        if (this.stalled) return;

        // A gate waiting on him outranks the transcript (DROVE-188). Checked
        // HERE, at the top of a pump that only ever runs with the synthesiser
        // idle, which is what makes "finish the sentence, then say the gate"
        // true without a single line about cutting anything.
        const urgent = this.urgent.shift();
        if (urgent !== undefined) {
            this.setPlayhead(null);
            // A refused gate line goes back to the FRONT: it is still the
            // thing he is being waited on for (DROVE-188, DROVE-189).
            this.speakNow(urgent.text, this.turn, 1, null, () => { this.urgent.unshift(urgent); });
            return;
        }

        // A transcript borrowed from another surface (DROVE-195). Ahead of the
        // session because he asked for it by tapping it, behind a gate because
        // a gate is him being waited on. It carries its own playhead, so the
        // mark lands on the subagent row he touched exactly as it does on a
        // reply, and at the normal rate: the catch-up ramp is about falling
        // behind a session that is still writing, which this is not.
        const detour = this.detour.shift();
        if (detour !== undefined) {
            this.speakNow(detour.text, this.turn, 1, detour, () => { this.detour.unshift(detour); });
            return;
        }

        // Nothing already said is ever a candidate, so every measure below
        // this line is about unread material only (DROVE-126).
        this.cursor = this.skipSpoken(this.cursor);

        const speedUp = this.maxBacklogSeconds();
        // Never below the speed-up threshold, whatever a caller hands over:
        // a jump at or under it would put the cut back where DROVE-116 found
        // it, firing before the ramp had any room to run.
        const jump = Math.max(speedUp, this.jumpBacklogSeconds());
        const backlog = this.backlogSeconds();
        // "Is the voice behind?", for the RAMP. Behind means newer PROSE is
        // still landing (DROVE-177); a reply that has finished is read at the
        // normal rate however long it is, and a thought landing beside it is
        // not prose (DROVE-181). The cut asks its own, wider question below.
        const arriving = this.stillArriving();

        // The cut (DROVE-108, moved out to its own threshold by DROVE-116).
        // Three things have to hold at once: there is something newer to skip
        // TO, more than the JUMP threshold of unspoken audio is waiting, and
        // the turn is still producing so that newer material actually exists.
        // A finished turn fails the third test however long it is, which is
        // the whole point. Between the two thresholds nothing is thrown away
        // and the voice simply reads faster.
        //
        // `somethingNewerToSay` rather than `arriving` since DROVE-181: a
        // minute of THINKING followed by the answer has to be skippable, and
        // thinking is not prose so it never moves the ramp.
        if (this.timeline.length - this.cursor > 1
            && backlog > jump
            && this.somethingNewerToSay()) {
            this.cursor = this.timeline.length - 1;
            this.markerDue = true;
        }

        if (this.markerDue && this.cursor < this.timeline.length) {
            this.markerDue = false;
            this.skips += 1;
            // The sound of a cut, before anything is said. An earcon replaces
            // the words entirely when the app wires one up (DROVE-112); with
            // no marker left to speak, reading falls through to the next
            // sentence rather than resting, or the jump would be silent.
            this.onSkip?.();
            if (this.skipMarker.length > 0) {
                this.setPlayhead(null);
                this.speakNow(
                    this.skipMarker,
                    this.timeline[this.cursor]?.turn ?? this.turn,
                    1,
                    null,
                    () => { this.markerDue = true; },
                );
                return;
            }
        }

        const next = this.timeline[this.cursor];
        if (next === undefined) {
            // Drained. Stopping here is not about cutting anything off, it is
            // about releasing the audio session so ducked music comes back up
            // instead of staying quiet until the next reply.
            this.rest();
            return;
        }
        const index = this.cursor;
        this.cursor += 1;
        // A refused sentence is still owed, so the cursor goes back to it and
        // `spoken` is taken off in `refused` (DROVE-189). `Math.min` because a
        // seek or a fresh turn may have moved the cursor BACK meanwhile, and
        // that position is his, not this one's.
        this.speakNow(
            next.text,
            next.turn,
            arriving ? this.catchUpRate(backlog, speedUp, jump) : 1,
            next,
            () => { this.cursor = Math.min(this.cursor, index); },
        );
    }

    /**
     * Hand one utterance to the engine.
     *
     * `putBack` is what to do if the engine REFUSES it (DROVE-189). A refusal
     * is not a short utterance, it is no utterance: on iOS `speak` rejects
     * when `activatePlayback` throws, which is what an unfinished audio-session
     * interruption looks like from JS. Before this ticket the rejection was
     * swallowed and the reader pumped straight on, so a session that was
     * refusing consumed the entire reply in a tight loop, marked every
     * sentence spoken, and left NOTHING to read when the session came back.
     * That is the "it went quiet in my pocket and stayed quiet" Clay has
     * reported three times; the earlier fixes kept the app ALIVE, which was
     * necessary and not sufficient, because a live app still burned the reply.
     *
     * So a refused utterance is put back exactly as it was and the queue
     * stalls until the session will take it. Marking `spoken` at the START is
     * kept, because DROVE-126 needs a sentence cut mid-word to stay spoken and
     * never repeat; the distinction that makes both true is REJECTED (never
     * made a sound, still owed) against RESOLVED (made a sound, however
     * little, and is finished with).
     */
    private speakNow(
        text: string,
        turn: number,
        rateScale: number,
        at: QueuedSentence | null,
        putBack: (() => void) | null = null,
    ): void {
        this.speaking = true;
        this.speakingTurn = turn;
        this.started = true;
        if (at !== null) {
            at.spoken = true;
            this.setPlayhead({
                sentence: at.text,
                messageId: at.messageId,
                createdAt: at.createdAt,
                turn: at.turn,
            });
        }
        const generation = this.generation;
        void Promise.resolve()
            .then(() => this.engine.speak(text, {
                rateScale,
                aside: at?.aside === true,
                thinking: at?.thinking === true,
            }))
            .then(() => true, () => false)
            .then((spoke) => {
                if (generation !== this.generation) return;
                this.speaking = false;
                this.speakingTurn = null;
                if (!spoke) {
                    this.refused(at, putBack);
                    return;
                }
                this.refusals = 0;
                this.pump();
            });
    }

    /**
     * The engine would not take that utterance (DROVE-189).
     *
     * Put the material back where it came from, then STOP handing sentences
     * over. Pumping straight on is what burned the reply: every later sentence
     * would be refused by the same session and marked spoken on the way.
     */
    private refused(at: QueuedSentence | null, putBack: (() => void) | null): void {
        this.refusals += 1;
        if (at !== null) at.spoken = false;
        this.setPlayhead(null);
        try {
            putBack?.();
        } catch {
            // Losing one line is better than wedging the reader.
        }
        this.stalled = true;
        this.armRetry();
    }

    /**
     * Offer the refused utterance again in a moment (DROVE-189).
     *
     * A poll rather than an event because the event does not exist on every
     * binary: `onSpeechInterruption` arrives only from a build that handles
     * interruptions, and the builds that do not are exactly the ones where a
     * refusal is permanent without this. One timer at a time, and none once
     * read-aloud is off.
     */
    private armRetry(): void {
        if (this.retryTimer !== null) return;
        if (!this.enabled) return;
        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            this.retryAfterRefusal();
        }, this.retryDelayMs);
    }

    private clearRetry(): void {
        if (this.retryTimer === null) return;
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
    }

    private retryAfterRefusal(): void {
        if (!this.stalled) return;
        if (!this.enabled) {
            this.stalled = false;
            return;
        }
        this.stalled = false;
        this.pump();
        // A pump that found nothing to say, or was refused again, has already
        // said so; only a still-stalled reader needs the next timer.
        if (this.stalled) this.armRetry();
    }

    /**
     * The audio session is probably back, so try the owed sentence NOW
     * (DROVE-189).
     *
     * Called when something says the refusal is over: he came back to the
     * foreground, the microphone let go, or a build that reports interruptions
     * said one ended. Safe to call when nothing is owed, which is why every
     * caller may call it blind.
     */
    audioSessionRecovered(): void {
        if (!this.stalled) return;
        this.clearRetry();
        this.stalled = false;
        this.pump();
        if (this.stalled) this.armRetry();
    }
}
