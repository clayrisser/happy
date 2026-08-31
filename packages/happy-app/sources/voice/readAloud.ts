import type { Message } from '@/sync/typesMessage';
import { chunkStreamed } from './sentenceStream';
import { stripToSpeakableProse } from './speakable';

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
 * backlog rules above already do it: past the threshold of unspoken audio the
 * voice reads faster, and past twice it the tail is dropped outright (the
 * numbers being too timid is DROVE-116, not a third rule). And the window is
 * only ever as long as the model takes to produce one sentence.
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
 * See `skipSpoken`. Nothing the queue does by itself repeats. A double tap
 * is not the queue doing something by itself: it is a request to read from
 * there, so it clears the marks from that point and reads on.
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
 */

/** Why speech stopped. Carried for logs and for the tests to assert on. */
export type ReadAloudInterruption =
    | 'typed'
    | 'sent'
    | 'mic'
    | 'left-session'
    | 'switched-session'
    | 'toggled-off'
    | 'call-started'
    | 'headphones-unplugged';

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
     * How many seconds of UNSPOKEN AUDIO may pile up before a still-arriving
     * turn is cut. Read at every pump rather than once, so a slider in
     * settings takes effect on the next sentence instead of the next launch.
     */
    maxBacklogSeconds?: () => number;
    /** What is said when the backlog is dropped. */
    skipMarker?: string;
    /**
     * How long an unfinished tail waits for more text before it is spoken as
     * it stands. Messages usually arrive whole, so this mostly covers a reply
     * whose last sentence has no full stop.
     */
    holdMs?: number;
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
    /** The most the catch-up may speed the voice up. */
    maxRateScale?: number;
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
 * Bounds on the catch-up: at worst the voice reads 15 percent faster, which
 * is still comfortably inside the speed slider's range and does not sound
 * like a different setting. It ramps in linearly and reaches the top when
 * the backlog is twice the threshold.
 */
export const defaultMaxRateScale = 1.15;
const defaultHoldMs = 1500;

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
     * what was said. A double tap clears it from that point (DROVE-146).
     */
    spoken: boolean;
    /**
     * A title rather than prose (DROVE-112). It rides the timeline like any
     * other sentence, and differs only in how the engine reads it.
     */
    aside: boolean;
}

interface HeldTail {
    text: string;
    turn: number;
    createdAt: number;
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
    private readonly skipMarker: string;
    private readonly holdMs: number;
    private readonly wordsPerMinute: number;
    private readonly arrivalWindowMs: number;
    private readonly maxRateScale: number;
    private readonly turnStillRunning: ((sessionId: string) => boolean) | null;
    private readonly asideFor: ((message: Message, sessionId: string) => string | null) | null;
    private readonly onSkip: (() => void) | null;
    private readonly interruptListeners = new Set<ReadAloudInterruptListener>();
    private readonly playheadListeners = new Set<ReadAloudPlayheadListener>();
    private enabled = false;
    /**
     * The microphone holds the audio session, so the reader says nothing
     * (DROVE-143). Not the same as disabled: the timeline keeps filling and
     * reading picks up from where it stood as soon as the mic lets go.
     */
    private micHeld = false;
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

    constructor(engine: SpeechEngine, options: ReadAloudOptions = {}) {
        this.engine = engine;
        this.now = options.now ?? Date.now;
        this.maxBacklogSeconds = options.maxBacklogSeconds ?? (() => defaultMaxBacklogSeconds);
        this.skipMarker = options.skipMarker ?? defaultSkipMarker;
        this.holdMs = options.holdMs ?? defaultHoldMs;
        this.wordsPerMinute = options.wordsPerMinute ?? defaultWordsPerMinute;
        this.arrivalWindowMs = options.arrivalWindowMs ?? defaultArrivalWindowMs;
        this.maxRateScale = options.maxRateScale ?? defaultMaxRateScale;
        this.turnStillRunning = options.turnStillRunning ?? null;
        this.asideFor = options.asideFor ?? null;
        this.onSkip = options.onSkip ?? null;
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

    setEnabled(enabled: boolean): void {
        if (this.enabled === enabled) return;
        this.enabled = enabled;
        if (!enabled) this.interrupt('toggled-off');
    }

    get isMicHeld(): boolean {
        return this.micHeld;
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
        this.pump();
    }

    /**
     * Which session is being READ. Only one, ever: four sessions finishing a
     * turn at once would have the phone narrating four replies over each other.
     */
    focus(sessionId: string | null, reason: ReadAloudInterruption = 'switched-session'): void {
        if (this.focused === sessionId) return;
        this.focused = sessionId;
        this.queuedChunks.clear();
        this.latestCreatedAt = 0;
        this.turnOpenedAt = 0;
        // Another session's arrival stamps say nothing about this one's, and
        // neither does its transcript: the playhead starts from nothing.
        this.arrivalTurn = -1;
        this.timeline = [];
        this.cursor = 0;
        this.lastPosition = null;
        this.interrupt(reason);
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
        for (let i = next; i < this.timeline.length; i++) this.timeline[i].spoken = false;
        this.cursor = next;
        // Whatever is in the air belongs to the old position. Cut it without
        // going through interrupt(): a tap is not a reason to stop the mic.
        this.cutCurrentUtterance();
        this.markerDue = false;
        this.pump();
    }

    onMessages(sessionId: string, messages: Message[]): void {
        if (!this.enabled) return;
        if (this.focused === null || sessionId !== this.focused) return;

        const ordered = [...messages].sort((a, b) => a.createdAt - b.createdAt);
        let added = false;
        for (const message of ordered) {
            // A message from the user opens the next turn (DROVE-108). It is
            // the one boundary that is visible from here: agent text arrives
            // in several blocks per turn, so a new message id says nothing.
            if (message.kind === 'user-text' && message.createdAt > this.turnOpenedAt) {
                this.turn += 1;
                this.turnOpenedAt = message.createdAt;
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

            if (message.kind !== 'agent-text' || message.isThinking) continue;
            if (typeof message.text !== 'string' || message.text.length === 0) continue;

            // A newer message means every older one is over: their tails are
            // spoken as they stand, and before this message's sentences.
            if (message.createdAt > this.latestCreatedAt) {
                if (this.flushTails((id) => id !== message.id)) added = true;
                this.latestCreatedAt = message.createdAt;
            }

            const prose = stripToSpeakableProse(message.text);
            const { complete, pending } = chunkStreamed(prose, false);
            const already = this.queuedChunks.get(message.id) ?? 0;
            if (complete.length > already) {
                this.enqueue(complete.slice(already), this.turn, message.id, message.createdAt);
                this.queuedChunks.set(message.id, complete.length);
                added = true;
            }
            if (pending !== null) {
                this.pendingTails.set(message.id, { text: pending, turn: this.turn, createdAt: message.createdAt });
            } else {
                this.pendingTails.delete(message.id);
            }
        }
        if (added) this.noteArrival();
        this.armHold();
        if (added) this.pump();
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
        this.generation += 1;
        this.cursor = this.timeline.length;
        this.pendingTails.clear();
        this.clearHold();
        this.speaking = false;
        this.speakingTurn = null;
        this.setPlayhead(null);
        // Nothing is owed to a queue the user threw away.
        this.markerDue = false;
        if (this.started) {
            this.started = false;
            void this.engine.stop();
        }
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
        this.notifyInterrupted('sent');
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

    private enqueue(sentences: string[], turn: number, messageId: string, createdAt: number, aside = false): void {
        if (sentences.length === 0) return;
        this.abandonTurnsBefore(turn);
        for (const text of sentences) {
            this.timeline.push({ text, words: countWords(text), turn, messageId, createdAt, spoken: false, aside });
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

    /** New text landed; remember when, and when the batch before it did. */
    private noteArrival(): void {
        const at = this.now();
        if (this.arrivalTurn !== this.turn) {
            this.arrivalTurn = this.turn;
            this.previousArrivalAt = Number.NEGATIVE_INFINITY;
        } else {
            this.previousArrivalAt = this.lastArrivalAt;
        }
        this.lastArrivalAt = at;
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
        if (this.turnStillRunning !== null && this.focused !== null && !this.turnStillRunning(this.focused)) {
            return false;
        }
        return this.now() - this.previousArrivalAt <= this.arrivalWindowMs;
    }

    /** Seconds of audio left to say, from word count and the speaking rate. */
    private backlogSeconds(): number {
        let words = 0;
        for (let i = this.cursor; i < this.timeline.length; i++) {
            words += this.timeline[i].words;
        }
        return (words * 60) / this.wordsPerMinute;
    }

    /**
     * Read faster rather than cut. Flat 1 until the backlog passes the
     * threshold, then linear to `maxRateScale` at twice the threshold.
     */
    private catchUpRate(backlogSeconds: number, threshold: number): number {
        if (threshold <= 0 || backlogSeconds <= threshold) return 1;
        const over = Math.min(1, (backlogSeconds - threshold) / threshold);
        return 1 + over * (this.maxRateScale - 1);
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

        // Nothing already said is ever a candidate, so every measure below
        // this line is about unread material only (DROVE-126).
        this.cursor = this.skipSpoken(this.cursor);

        const threshold = this.maxBacklogSeconds();
        const backlog = this.backlogSeconds();

        // The cut (DROVE-108). Three things have to hold at once: there is
        // something newer to skip TO, more than the threshold of unspoken
        // audio is waiting, and the turn is still being written so that
        // newer material actually exists. A finished turn fails the third
        // test however long it is, which is the whole point.
        if (this.timeline.length - this.cursor > 1
            && backlog > threshold
            && this.stillArriving()) {
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
                this.speakNow(this.skipMarker, this.timeline[this.cursor]?.turn ?? this.turn, 1, null);
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
        this.cursor += 1;
        this.speakNow(next.text, next.turn, this.catchUpRate(backlog, threshold), next);
    }

    private speakNow(text: string, turn: number, rateScale: number, at: QueuedSentence | null): void {
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
            .then(() => this.engine.speak(text, { rateScale, aside: at?.aside === true }))
            .catch(() => {
                // One utterance failing must not wedge every later one. The
                // reply keeps being read from the next sentence on.
            })
            .then(() => {
                if (generation !== this.generation) return;
                this.speaking = false;
                this.speakingTurn = null;
                this.pump();
            });
    }
}
