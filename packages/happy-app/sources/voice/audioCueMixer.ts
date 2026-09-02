import { cueDurationMs, cueSpec, isWorkingCue, type AudioCueId } from './audioCues';
import { ambientCue, ambientCueFor, isWaitingCue, type CueSessionState } from './audioCueState';
import type { AudioCues } from '@/sync/settings';

/**
 * The one mixer (DROVE-112).
 *
 * Two features each free to make noise would talk over each other and over
 * speech, which is why the heartbeat and the earcons are one ticket and one
 * object. Everything that wants to be heard asks here, and here is where the
 * rules that make it bearable live:
 *
 *   SPEECH ALWAYS WINS, AND IT WINS BEFORE IT STARTS (DROVE-174). Clay:
 *     "Damn don't let the sound effects stop talking". DROVE-112's rule was
 *     "nothing plays over speech", checked at the instant a cue STARTED, and
 *     that is not the same rule: the reader is free to begin the next sentence
 *     ten milliseconds later, so a 500ms cue landed on top of it anyway.
 *
 *     A cue may now only start in a GENUINE GAP — nothing at the synthesiser
 *     AND nothing queued to be said. `speechPending` is the second half, and
 *     the reader is the only thing that knows it. If no such gap opens before
 *     the cue goes stale, THE CUE IS DROPPED. Never the speech, never a pause
 *     in the speech, never a duck. That is the whole ordering: if the audio
 *     path cannot mix a cue with the synthesiser, the cue loses.
 *
 *     The other half of the same bug was not in this file at all; see the note
 *     on `keepAudioSessionActive` in cuePlayer.ts.
 *   STALE CUES ARE DROPPED, NOT PLAYED LATE. A cue is a claim about NOW; one
 *     that has been queued longer than `staleMs` is no longer true and playing
 *     it says something false rather than something late.
 *   RATE IS A SETTING, NOT A SECRET (DROVE-174). This session runs dozens of
 *     tools a minute and Clay wants to hear every one of them. The per-minute
 *     caps are still here and are still enforced on ACCEPTANCE, but they are
 *     settings now and they default to OFF, because a cap that silently drops
 *     what he asked to hear is the behaviour this ticket exists to undo.
 *   AMBIENT YIELDS TO EVENTS. A heartbeat under an earcon is mush.
 *
 * TWO KINDS OF SOUND, TWO POLICIES (DROVE-197). Clay, minutes after the rules
 * above shipped: "Why did heartbeat stop." Every rule in this header was
 * written for an EVENT and then applied to the heartbeat as well, and on a
 * session busy enough to keep an earcon queued that silenced the beat for
 * good. The two are not the same kind of sound and they no longer share a
 * policy:
 *
 *   An EVENT CUE is tied to a MOMENT. A tool tick means "a tool ran just
 *     now", so it is worthless late: it waits in the queue for a genuine gap
 *     and is DROPPED if none opens before `cueStaleMs`. It never delays
 *     speech to get one.
 *   The HEARTBEAT is AMBIENT and PERIODIC. It has no content to be late
 *     about — the cadence itself is the information, and its whole purpose is
 *     the case Clay asked for: "a heartbeat that pulses when the reading isn't
 *     talking yet we still have things working". It is never queued, so it can
 *     never go stale; it SOUNDS in its slot when the route is clear and is
 *     SKIPPED when it is not, and the next slot comes round on time either
 *     way. Nothing cancels it but the state it describes going away.
 *
 * The one rule they still share is the ordering that DROVE-174 exists for:
 * neither starts over a sentence at the synthesiser, over a sentence about to
 * start, or over a sound already in the air. Past that they part company, and
 * `tick` is written so the parting is visible.
 *
 * A PAUSE OVERRULES BOTH OF THEM (DROVE-354). Clay, pausing from the lock
 * screen: "it does pause the reading, but it doesn't pause all the beeping. It
 * should pause everything, because the whole point of pausing is to have it be
 * silent." Every rule above is about who may have the audio route while the
 * reader is USING it; a pause is him taking the route away from the app
 * altogether, so it is not another claimant to arbitrate between. It is the
 * end of the arbitration. See `paused` on the options and the gate at the top
 * of `tick`.
 *
 * Driven by `tick`, not by timers of its own. The owner calls it a few times a
 * second and every decision is a synchronous function of the clock, which is
 * what lets the whole state machine be tested without waiting for anything.
 */

/**
 * How long a queued EVENT cue may wait for speech to end before it is dropped.
 *
 * Events only. A heartbeat is never queued and so can never be stale: it is a
 * beat, not a claim, and the thing it describes is still true (DROVE-197).
 */
export const cueStaleMs = 4_000;
/** The window the per-minute caps are measured over. */
export const rateWindowMs = 60_000;

export interface AudioCueMixerOptions {
    now: () => number;
    /**
     * Start playing a cue. Fire and forget; the mixer times it from the table.
     *
     * TWO NUMBERS, TWO JOBS (DROVE-385). `volume` is the master slider and is
     * the player's own volume; `offsetDb` is Clay's trim against the voice and
     * belongs to the rendered samples, because the table's ceiling IS the voice
     * and a boost past it is a number a player's volume cannot hold. They are
     * passed together and applied in different places, once each.
     */
    play: (id: AudioCueId, volume: number, offsetDb: number) => void;
    /** The live settings, read at every decision so a slider applies at once. */
    settings: () => Required<AudioCues>;
    /**
     * Is there anything the reader still has to SAY? (DROVE-174.)
     *
     * Speech in flight is `state.speaking`; this is the sentence that has not
     * started yet. Without it a cue slips into the few milliseconds between
     * two sentences, and on iOS a cue starting there did not merely overlap —
     * expo-audio tore the audio session down behind it and the utterance
     * stopped. Left out, the mixer behaves as DROVE-112 did.
     */
    speechPending?: () => boolean;
    /**
     * Is HE holding it? (DROVE-354.)
     *
     * `readAloud.isPaused`, asked at PLAY TIME rather than checked when a cue
     * is enqueued, and that is the whole of why it is a function and lives
     * here rather than a flag the callers set. Cues arrive from several places
     * — a message walking through the reader, a gate raised on the poller, a
     * turn ending — and a gate at each of those doors is a gate somebody adds
     * a fifth door beside. There is one door out of this object, and this is
     * the check in front of it.
     *
     * NOT `speechPending`, which answers false while paused on purpose
     * (DROVE-233): a pause lasts until he presses something, and a mixer that
     * read it as "speech is coming" would hold every earcon until it went
     * stale and silence the heartbeat for the duration. That was the right
     * answer to "is a sentence about to start" and it is what left the cues
     * playing into the pause, because false there reads as a genuine gap.
     */
    paused?: () => boolean;
}

interface QueuedEvent {
    id: AudioCueId;
    at: number;
}

/**
 * Which cap an event cue counts against.
 *
 * The tool lane is the high-rate one; everything else is rare enough to share
 * a lane. `reply` sits in the agent lane because a reply arriving is the same
 * order of frequency as an agent spawning.
 */
function laneFor(id: AudioCueId): 'tool' | 'agent' {
    return id === 'toolCall' ? 'tool' : 'agent';
}

/** A cap of zero means NO cap. The default, since DROVE-174. */
function capped(cap: number, used: number): boolean {
    return cap > 0 && used >= cap;
}

export class AudioCueMixer {
    private readonly now: () => number;
    private readonly playCue: (id: AudioCueId, volume: number, offsetDb: number) => void;
    private readonly settings: () => Required<AudioCues>;

    private readonly speechPending: () => boolean;
    private readonly paused: () => boolean;

    private state: CueSessionState = {
        reading: false,
        working: false,
        pendingKinds: [],
        agents: 0,
        speaking: false,
    };
    private queue: QueuedEvent[] = [];
    /** When the sound currently in the air will be over. */
    private playingUntil = 0;
    /** When the next beat is DUE. Null until a pulse is called for at all. */
    private beatAt: number | null = null;
    private ambientId: AudioCueId | null = null;
    /** Play stamps per lane, trimmed to the window; the per-minute cap. */
    private stamps: Record<'tool' | 'agent', number[]> = { tool: [], agent: [] };
    /** Cues dropped for the cap or for staleness, for the tests and the logs. */
    private droppedCount = 0;

    constructor(options: AudioCueMixerOptions) {
        this.now = options.now;
        this.playCue = options.play;
        this.settings = options.settings;
        this.speechPending = options.speechPending ?? (() => false);
        this.paused = options.paused ?? (() => false);
    }

    get dropped(): number {
        return this.droppedCount;
    }

    /** What is queued and has not been played or dropped yet. */
    get pending(): number {
        return this.queue.length;
    }

    /** The pulse the current state calls for, or null. Exposed for the tests. */
    get ambient(): AudioCueId | null {
        return ambientCue(this.state);
    }

    /**
     * The session's state, minus whether speech is running.
     *
     * `speaking` is pushed by the engine wrapper, which knows the instant an
     * utterance starts and ends, so it is deliberately not part of what the
     * poller can overwrite: re-deriving it a second way is exactly the sort of
     * disagreement that ends with a pulse under a spoken sentence.
     */
    setState(state: Omit<CueSessionState, 'speaking'>): void {
        this.state = { ...state, speaking: this.state.speaking };
    }

    /** A sentence is at the synthesiser, or is not. Speech always wins. */
    setSpeaking(speaking: boolean): void {
        this.state = { ...this.state, speaking };
    }

    /**
     * Something happened worth a sound.
     *
     * Refused here rather than at the call site so that every caller gets the
     * same rules: the master switch, the per-cue mute, and the per-minute cap.
     * A refusal is silent on purpose — a cue about a dropped cue is absurd.
     */
    event(id: AudioCueId): void {
        const settings = this.settings();
        if (!settings.on) return;
        if (settings.muted.includes(id)) return;
        const lane = laneFor(id);
        const cap = lane === 'tool' ? settings.toolCuesPerMinute : settings.agentCuesPerMinute;
        const at = this.now();
        this.trimStamps(lane, at);
        if (capped(cap, this.stamps[lane].length)) {
            this.droppedCount += 1;
            return;
        }
        // Counted on ACCEPTANCE, not on playback: a burst that queues twenty
        // cues in a second must be capped at the moment it arrives, or the cap
        // only ever throttles how fast the backlog drains.
        this.stamps[lane].push(at);
        this.queue.push({ id, at });
    }

    /**
     * Decide what, if anything, should be heard now. Called a few times a
     * second by the owner; every rule above is enforced from here.
     */
    tick(): void {
        const at = this.now();
        const settings = this.settings();
        if (!settings.on) {
            this.queue = [];
            this.beatAt = null;
            return;
        }
        // PAUSE IS SILENCE, AND SILENCE MEANS THE WHOLE CHANNEL (DROVE-354).
        // Before the staleness sweep, before the gap rule, before the beat:
        // nothing below this line can make a sound while he is holding it.
        //
        // DROPPED, NOT HELD, and that is the half worth defending. Every other
        // refusal in this file leaves the queue alone because the block is
        // measured in milliseconds and the cue may still be true when it
        // lifts. A pause is not: it lasts until he presses something, so a
        // queue kept across one is a burst of stale news rattling out the
        // instant he asks for the voice back — which is the sound he pressed
        // pause to stop, arriving late and all at once. The cue was a claim
        // about a moment that has gone.
        //
        // The BEAT's clock is cleared rather than left running, so the first
        // pulse after a resume lands at once and says what the session is
        // doing now, instead of the cadence resuming mid-stride from a beat
        // nobody heard.
        if (this.paused()) {
            this.dropQueue();
            this.beatAt = null;
            return;
        }

        // EVENT staleness, decided FIRST and about events alone. A cue that
        // has waited four seconds has stopped being true, and it makes no
        // difference whether it was speech or another cue that held it up: if
        // it were dropped only once the way was clear, a long reply would end
        // with the whole of a tool burst rattling out after the fact.
        this.dropStale(at);

        // The one rule both kinds obey. Speech in flight, speech about to
        // start, or a sound still in the air: nothing new begins over any of
        // the three. The middle one is DROVE-174's whole fix — a gap between
        // two sentences is not silence, it is the space a cue used to steal.
        //
        // This is where the two kinds part. The EVENT sits in the queue and is
        // dropped if its four seconds run out; the BEAT is simply not heard
        // while the route is busy, and sounds on the first tick it is clear.
        // Nothing about a beat being blocked is written down anywhere, which
        // is precisely what makes it impossible to lose.
        if (this.state.speaking || at < this.playingUntil) return;
        if (this.speechPending()) return;

        // Events first: AMBIENT YIELDS TO EVENTS, and an earcon that has been
        // waiting is minutes closer to going stale than a beat ever is.
        // Yielding is all this is, though. It costs the beat this tick, not
        // its cadence — DROVE-197 was the version where an earcon a second
        // yielded the beat out of existence.
        const next = this.queue.shift();
        if (next !== undefined) {
            this.start(next.id, at);
            return;
        }

        const beat = this.dueBeat(at, settings);
        if (beat === null) return;
        // The cadence is measured from the beat that was HEARD, so a busy
        // stretch costs the beats inside it and nothing after them, and the
        // clock can never fall into step with whatever was blocking it and be
        // silenced by the coincidence.
        this.beatAt = at + this.intervalMs(beat, settings);
        this.start(beat, at);
    }

    /**
     * The beat that is due, or null.
     *
     * Returning a cue here is a claim about the CLOCK, not about the speaker:
     * `tick` decides whether it is actually heard, and only a beat that was
     * heard moves the cadence on. Everything that would make the beat give way
     * to another sound belongs there and not here, because a beat that queues
     * behind other sounds is a beat that can be starved, which is the bug
     * (DROVE-197).
     */
    private dueBeat(at: number, settings: Required<AudioCues>): AudioCueId | null {
        if (!settings.heartbeat) {
            this.ambientId = null;
            this.beatAt = null;
            return null;
        }
        // Which pulse the session DESERVES. Deliberately not `ambientCue`,
        // which also answers "can it be heard right now": that was settled by
        // the shared rule in `tick` before we got here, and a second copy of
        // the same decision is how these two sounds got one policy in the
        // first place.
        const pulse = ambientCueFor(this.state);
        if (pulse === null) {
            this.ambientId = null;
            this.beatAt = null;
            return null;
        }
        // A change of state beats AT ONCE rather than waiting out the old
        // clock: going from working to waiting-on-Clay is exactly the moment
        // the sound is supposed to tell him something. An agent starting or
        // finishing changes the working variant, so the next beat carries the
        // new count without waiting out the cadence (DROVE-182).
        if (pulse !== this.ambientId) {
            this.ambientId = pulse;
            this.beatAt = at;
        }
        if (this.beatAt === null) this.beatAt = at;
        if (at < this.beatAt) return null;
        // Every working variant is one settings row (DROVE-182), so a mute on
        // 'working' silences the whole family however many agents are out.
        if (settings.muted.includes(pulse)) return null;
        if (isWorkingCue(pulse) && settings.muted.includes('working')) return null;
        return pulse;
    }

    /** How often this pulse comes round. Waiting on Clay runs the fast clock. */
    private intervalMs(pulse: AudioCueId, settings: Required<AudioCues>): number {
        return 1000 * (isWaitingCue(pulse)
            ? settings.waitingIntervalSeconds
            : settings.workingIntervalSeconds);
    }

    /** Everything queued is abandoned and the clocks reset. */
    reset(): void {
        this.queue = [];
        this.playingUntil = 0;
        this.beatAt = null;
        this.ambientId = null;
    }

    private start(id: AudioCueId, at: number): void {
        const spec = cueSpec(id);
        this.playingUntil = at + cueDurationMs(spec);
        // The SETTINGS and nothing else (DROVE-341, DROVE-385). The cue's own
        // level is baked into the file cuePlayer renders, with the trim on it;
        // multiplying either of them in here as well is what squared the gain
        // and put the heartbeat under the voice.
        const settings = this.settings();
        this.playCue(id, settings.volume, settings.volumeVsVoiceDb);
    }

    /** Everything queued, gone. Counted, because a drop is a fact worth having. */
    private dropQueue(): void {
        this.droppedCount += this.queue.length;
        this.queue = [];
    }

    /** Everything that waited too long, gone rather than played late. */
    private dropStale(at: number): void {
        while (this.queue.length > 0 && at - this.queue[0].at > cueStaleMs) {
            this.queue.shift();
            this.droppedCount += 1;
        }
    }

    private trimStamps(lane: 'tool' | 'agent', at: number): void {
        this.stamps[lane] = this.stamps[lane].filter((stamp) => at - stamp < rateWindowMs);
    }
}
