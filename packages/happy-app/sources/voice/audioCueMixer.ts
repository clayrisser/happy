import { cueDurationMs, cueSpec, isWorkingCue, type AudioCueId } from './audioCues';
import { ambientCue, isWaitingCue, type CueSessionState } from './audioCueState';
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
 * Driven by `tick`, not by timers of its own. The owner calls it a few times a
 * second and every decision is a synchronous function of the clock, which is
 * what lets the whole state machine be tested without waiting for anything.
 */

/** How long a queued event cue may wait for speech to end before it is dropped. */
export const cueStaleMs = 4_000;
/** Ambient stays out of the way for this long after an event cue. */
export const quietAfterEventMs = 700;
/** The window the per-minute caps are measured over. */
export const rateWindowMs = 60_000;

export interface AudioCueMixerOptions {
    now: () => number;
    /** Start playing a cue. Fire and forget; the mixer times it from the table. */
    play: (id: AudioCueId, volume: number) => void;
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
    private readonly playCue: (id: AudioCueId, volume: number) => void;
    private readonly settings: () => Required<AudioCues>;

    private readonly speechPending: () => boolean;

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
    /** When the last event cue finished, so ambient can stay out of its way. */
    private eventEndedAt = Number.NEGATIVE_INFINITY;
    /** When each ambient pulse last played, so a state change fires promptly. */
    private ambientAt = Number.NEGATIVE_INFINITY;
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
            return;
        }
        // Staleness is decided FIRST, whatever is blocking. A cue that has
        // waited four seconds has stopped being true, and it makes no
        // difference whether it was speech or another cue that held it up: if
        // it were dropped only once the way was clear, a long reply would end
        // with the whole of a tool burst rattling out after the fact.
        this.dropStale(at);

        // Speech in flight, speech about to start, or a cue still sounding.
        // Nothing else may start. The middle one is DROVE-174's whole fix: a
        // gap between two sentences is not silence, it is the space a cue used
        // to steal (see the header). The cue waits and may go stale; the
        // sentence is never the thing that gives way.
        if (this.state.speaking || at < this.playingUntil) return;
        if (this.queue.length > 0 && this.speechPending()) return;

        // Events first. Anything that stopped being true while it waited has
        // already gone, above.
        const next = this.queue.shift();
        if (next !== undefined) {
            this.start(next.id, at);
            this.eventEndedAt = this.playingUntil;
            return;
        }

        if (!settings.heartbeat) return;
        const pulse = ambientCue(this.state);
        if (pulse === null) {
            this.ambientId = null;
            return;
        }
        // Every working variant is one settings row (DROVE-182), so a mute on
        // 'working' silences the whole family however many agents are out.
        if (settings.muted.includes(pulse)) return;
        if (isWorkingCue(pulse) && settings.muted.includes('working')) return;
        // A change of state pulses at once rather than waiting out the old
        // clock: going from working to waiting-on-Clay is exactly the moment
        // the sound is supposed to tell him something. An agent starting or
        // finishing changes the working variant, so the NEXT beat carries the
        // new count without waiting out the cadence (DROVE-182).
        if (pulse !== this.ambientId) {
            this.ambientId = pulse;
            this.ambientAt = Number.NEGATIVE_INFINITY;
        }
        if (at - this.eventEndedAt < quietAfterEventMs) return;
        const intervalMs = 1000 * (isWaitingCue(pulse)
            ? settings.waitingIntervalSeconds
            : settings.workingIntervalSeconds);
        if (at - this.ambientAt < intervalMs) return;
        this.ambientAt = at;
        this.start(pulse, at);
    }

    /** Everything queued is abandoned and the clocks reset. */
    reset(): void {
        this.queue = [];
        this.playingUntil = 0;
        this.ambientAt = Number.NEGATIVE_INFINITY;
        this.ambientId = null;
        this.eventEndedAt = Number.NEGATIVE_INFINITY;
    }

    private start(id: AudioCueId, at: number): void {
        const spec = cueSpec(id);
        this.playingUntil = at + cueDurationMs(spec);
        this.playCue(id, Math.max(0, Math.min(1, this.settings().volume * spec.gain)));
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
