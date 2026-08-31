import { cueDurationMs, cueSpec, type AudioCueId } from './audioCues';
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
 *   SPEECH ALWAYS WINS. A cue never plays over a spoken sentence. It waits.
 *   STALE CUES ARE DROPPED, NOT PLAYED LATE. A cue is a claim about NOW; one
 *     that has been queued longer than `staleMs` is no longer true and playing
 *     it says something false rather than something late.
 *   RATE, NOT SOUND, IS THE HARD PART. This session runs dozens of tools a
 *     minute. Tool cues are folded to one per RUN by the caller and capped
 *     again here per minute, with the excess dropped in silence.
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
}

interface QueuedEvent {
    id: AudioCueId;
    at: number;
}

/** Which cap an event cue counts against. */
function laneFor(id: AudioCueId): 'tool' | 'agent' {
    return id === 'toolRun' ? 'tool' : 'agent';
}

export class AudioCueMixer {
    private readonly now: () => number;
    private readonly playCue: (id: AudioCueId, volume: number) => void;
    private readonly settings: () => Required<AudioCues>;

    private state: CueSessionState = { reading: false, working: false, pendingKinds: [], speaking: false };
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
        if (this.stamps[lane].length >= cap) {
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
        // Speech in flight, or a cue still sounding. Nothing else may start.
        if (this.state.speaking || at < this.playingUntil) return;

        // Events first, and drop whatever has stopped being true while it
        // waited rather than playing it late.
        while (this.queue.length > 0) {
            const next = this.queue[0];
            this.queue.shift();
            if (at - next.at > cueStaleMs) {
                this.droppedCount += 1;
                continue;
            }
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
        if (settings.muted.includes(pulse)) return;
        // A change of state pulses at once rather than waiting out the old
        // clock: going from working to waiting-on-Clay is exactly the moment
        // the sound is supposed to tell him something.
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

    private trimStamps(lane: 'tool' | 'agent', at: number): void {
        this.stamps[lane] = this.stamps[lane].filter((stamp) => at - stamp < rateWindowMs);
    }
}
