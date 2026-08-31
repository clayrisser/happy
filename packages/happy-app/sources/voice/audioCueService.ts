import { storage } from '@/sync/storage';
import { resolveAudioCues } from '@/sync/settings';
import { gatesForSession } from '@/sync/droverGates';
import { isLiveStatusFresh, summarizeLiveStatus } from '@/utils/liveStatus';
import type { LiveStatus } from '@/utils/liveStatus';
import type { Message } from '@/sync/typesMessage';
import { AudioCueMixer } from './audioCueMixer';
import { playCue, releaseCuePlayers, warmCuePlayers } from './cuePlayer';
import { SpokenTitleTracker } from './spokenTitles';
import { GateSpeechTracker } from './gateSpeech';
import { audioCues as cueTable, cueSpec, workingCueFor, type AudioCueId } from './audioCues';

/**
 * The one audio cue system the app owns (DROVE-112).
 *
 * A singleton for the same reason the reader is one: there is exactly one
 * speaker on the device, and the things that drive this live far apart. The
 * reader hands it messages and tells it when a cut happened; the engine
 * wrapper tells it when speech is in the air; storage tells it what the
 * session is doing.
 *
 * NOTHING HERE IS ALLOWED TO MAKE THE READER GO SILENT. The reader calls into
 * this on the message path, so every entry point swallows its own failures.
 * DROVE-146 is the live proof of how quietly a reader stops speaking.
 *
 * The ambient state is READ, not pushed. Every tick it asks storage the same
 * two questions the screen asks — is this session working (the status row's
 * own `liveStatus` freshness, plus `thinking` for the window before the CLI
 * has published anything) and what is pending on it (`gatesForSession`, the
 * list the gate cards and the wrist already draw) — so the sound and the
 * screen cannot disagree. There is no second notion of busy anywhere.
 */

/** How often the mixer is asked to decide while reading. Under the shortest cue. */
const tickMs = 250;
/**
 * How often it is asked while cues are QUEUED (DROVE-174).
 *
 * A burst of twenty tool calls is twenty ticks, and at 250ms a tick they would
 * take five seconds to drain — most of them dropped as stale, and the ones
 * that survived arriving long after the burst was over. At 50ms the same
 * twenty rattle out in about a second, which is the sound Clay described and
 * which is itself the information: a lot is happening. The tick is 28ms, so
 * this is close to back-to-back without ever asking the device to overlap one
 * file with itself.
 */
const burstTickMs = 50;
/**
 * How often it is asked while read-aloud is off. Almost nothing happens on
 * such a tick, and a four-a-second timer running all day for a feature nobody
 * has switched on is not a thing to leave in an app that lives in a pocket.
 */
const idleTickMs = 2_000;
/** How often storage is re-read for the ambient state. Cheaper than the tick. */
const stateEveryMs = 1000;

/** What the cue system needs to know about the reader, and nothing more. */
interface ReaderView {
    isEnabled: boolean;
    focusedSessionId: string | null;
    isMicHeld: boolean;
    /** Anything still to be said, in flight or queued (DROVE-174). */
    speechPending: boolean;
    /** Say this ahead of the transcript (DROVE-188). */
    sayUrgent: (key: string, text: string) => void;
    cancelUrgent: (key: string) => void;
}

function settings() {
    return resolveAudioCues(storage.getState().settings);
}

class AudioCueService {
    private readonly mixer = new AudioCueMixer({
        now: () => Date.now(),
        play: (id, volume) => playCue(id, volume),
        settings,
        // THE rule (DROVE-174): a cue may only sound in a genuine gap, and a
        // gap between two sentences is not one. The reader is the only thing
        // that knows a sentence is queued but not yet started.
        speechPending: () => this.reader?.speechPending === true,
    });
    private readonly titles = new SpokenTitleTracker();
    private readonly gates = new GateSpeechTracker();
    private timer: ReturnType<typeof setInterval> | null = null;
    /** The interval the timer is currently armed at. */
    private armedAt = 0;
    private stateAt = 0;
    /** Which session the tracker's fold belongs to. */
    private trackedSession: string | null = null;
    /** Whether the reader was on last tick, so switching off can reset once. */
    private wasReading = false;
    private reader: ReaderView | null = null;

    /** The mixer, for the settings screen's preview and for the tests. */
    get cues(): AudioCueMixer {
        return this.mixer;
    }

    /**
     * The reader, handed over after it is built.
     *
     * Passed in rather than imported because the dependency really does run
     * both ways: the reader asks this for titles and this asks the reader
     * whether it is on and what it is reading. An import cycle between two
     * module-level singletons is decided by load order, which is not a thing
     * to bet a silent voice on.
     */
    attach(reader: ReaderView): void {
        this.reader = reader;
        this.start();
    }

    /**
     * Start ticking. Idempotent, and safe to call before anything is enabled:
     * a tick with read-aloud off does almost nothing and stops the timer being
     * one more thing that has to be started at the right moment.
     */
    start(): void {
        if (this.timer !== null) return;
        this.arm(idleTickMs);
    }

    private arm(everyMs: number): void {
        if (this.timer !== null) clearInterval(this.timer);
        this.armedAt = everyMs;
        this.timer = setInterval(() => this.tick(), everyMs);
    }

    stop(): void {
        if (this.timer !== null) clearInterval(this.timer);
        this.timer = null;
        this.armedAt = 0;
        this.mixer.reset();
        releaseCuePlayers();
    }

    /** A sentence is at the synthesiser, or is not. Speech always wins. */
    setSpeaking(speaking: boolean): void {
        this.mixer.setSpeaking(speaking);
    }

    /**
     * Play one cue now, straight past the mixer.
     *
     * The settings preview, and the one thing that is allowed to skip the
     * rules: a row asking to be heard is not an event, it is Clay learning the
     * vocabulary, so a muted cue still demonstrates itself and the tenth press
     * in a minute is not silently dropped by a cap meant for a fan-out.
     */
    preview(id: AudioCueId): void {
        const resolved = settings();
        try {
            playCue(id, Math.max(0, Math.min(1, resolved.volume * cueSpec(id).gain)));
        } catch {
            // A device that cannot make the sound simply does not.
        }
    }

    /**
     * Answer a press, now, whatever else is going on (DROVE-225).
     *
     * The mixer's job is to decide when the app may INTERRUPT him: a gap
     * between sentences is not a gap, a burst of tool calls is rate-capped,
     * a stale cue is dropped. Every one of those rules is right for news
     * about the agent and wrong for a reply to something he just did. He
     * pressed the button; the sound is the answer, and an answer that arrives
     * late or not at all is the whole failure the ticket names: a press with
     * no sound is indistinguishable from a press that did nothing.
     *
     * So this goes straight to the device, past the queue, the gap rule and
     * the rate caps. It still respects the two settings that are Clay saying
     * what he wants to hear: the master switch and the volume, and the mute
     * list, so a row on the settings screen means what it says.
     */
    ack(id: AudioCueId): void {
        try {
            const resolved = settings();
            if (!resolved.on) return;
            if (resolved.muted.includes(id)) return;
            playCue(id, Math.max(0, Math.min(1, resolved.volume * cueSpec(id).gain)));
        } catch {
            // A device that cannot make the sound simply does not, and the
            // mic press goes ahead regardless: a missing beep is bad, a
            // missing microphone is worse.
        }
    }

    /** The gate tracker, for the settings preview and the tests. */
    get gateSpeech(): GateSpeechTracker {
        return this.gates;
    }

    /** The reader cut its backlog. The earcon that replaced "Skipping ahead." */
    skipped(): void {
        try {
            this.mixer.event('skipAhead');
        } catch {
            // Never let a sound take the reader down.
        }
    }

    /**
     * One message, on its way through the reader.
     *
     * Returns the line to speak in its place, or null. The earcons it also
     * decides are fired here and now, because an event cue is a claim about
     * NOW: binding it to the spoken title would delay it by however far behind
     * the voice happens to be, and would fall silent entirely whenever titles
     * are switched off.
     */
    titleFor(message: Message, sessionId: string): string | null {
        try {
            if (this.trackedSession !== sessionId) {
                this.trackedSession = sessionId;
                this.titles.reset();
            }
            const resolved = settings();
            const decision = this.titles.observe(message, resolved);
            for (const event of decision.events) this.mixer.event(event);
            if (decision.events.length > 0) this.mixer.tick();
            return resolved.on ? decision.title : null;
        } catch {
            // A message shape nobody expected must not stop the reply being
            // read. No title, no sound, and the reader carries on.
            return null;
        }
    }

    private tick(): void {
        try {
            const reader = this.reader;
            const focused = reader?.focusedSessionId ?? null;
            // The microphone holding the audio session is silence too, not
            // just for the voice (DROVE-143): a beep played into an open
            // recogniser is a beep in the transcript, and every play touches
            // the same route the capture is using.
            const reading = reader?.isEnabled === true && focused !== null && reader.isMicHeld !== true;
            if (!reading) {
                if (this.wasReading) {
                    this.wasReading = false;
                    this.mixer.setState({ reading: false, working: false, pendingKinds: [], agents: 0 });
                    this.mixer.reset();
                    this.gates.reset();
                }
                if (this.armedAt !== idleTickMs) this.arm(idleTickMs);
                return;
            }
            if (!this.wasReading) {
                this.wasReading = true;
                // Build the sounds now rather than when the first one is due.
                // The table, plus the working counts a session actually
                // reaches (DROVE-182). A count is unbounded so it cannot all
                // be warmed; zero to twelve covers every fan-out Clay runs,
                // and a count past that is a shade late on its first beat
                // only. Zero is in it because it is the commonest state of
                // all: no subagents, the thump on its own (DROVE-209).
                warmCuePlayers(
                    [
                        ...cueTable.map((cue) => cue.id),
                        ...Array.from({ length: 13 }, (_, i) => workingCueFor(i)),
                    ],
                    settings().volume,
                );
            }
            // A queued burst drains on the fast clock and the ambient state
            // on the slow one (DROVE-174).
            const want = this.mixer.pending > 0 ? burstTickMs : tickMs;
            if (this.armedAt !== want) this.arm(want);
            const at = Date.now();
            if (at - this.stateAt >= stateEveryMs) {
                this.stateAt = at;
                this.mixer.setState(this.readState(focused as string, at));
                this.speakGates(focused as string, at);
            }
            this.mixer.tick();
        } catch {
            // A tick that throws must not stop the next one, and must never
            // reach the reader.
        }
    }

    /**
     * What the session is doing, from the same state the screen reads.
     *
     * `speaking` is deliberately not read here: it is pushed by the engine
     * wrapper, which knows the instant an utterance starts and ends, and
     * re-deriving it a second way is exactly the kind of disagreement this
     * whole design is trying to avoid.
     */
    private readState(sessionId: string, at: number) {
        const sessions = storage.getState().sessions ?? {};
        const session = sessions[sessionId] as
            | { thinking?: boolean; metadata?: { liveStatus?: unknown } | null }
            | undefined;
        const live = session?.metadata?.liveStatus as LiveStatus | null | undefined;
        const fresh = isLiveStatusFresh(live as never, at);
        const working = session?.thinking === true || fresh;
        const pendingKinds = gatesForSession(sessions as never, sessionId).map((entry) => entry.gate.kind);
        return { reading: true, working, pendingKinds, agents: this.agentCount(live, fresh, at) };
    }

    /**
     * How many subagents are running, for the heartbeat's rhythm (DROVE-182).
     *
     * The SAME derivation the status row draws from — `summarizeLiveStatus`'s
     * agent rows (DROVE-155) — rather than a second count off the raw status,
     * because a heartbeat that says four while the screen says three is worse
     * than a heartbeat that says nothing. Stale live status counts as zero:
     * the thump alone then means "working, and I cannot see the fan-out",
     * which is honest, where ticks from a minute-old snapshot would not be.
     */
    private agentCount(live: LiveStatus | null | undefined, fresh: boolean, at: number): number {
        if (!fresh || !live) return 0;
        try {
            return summarizeLiveStatus(live, at).rows.filter((row) => row.kind === 'agent').length;
        } catch {
            return 0;
        }
    }

    /**
     * A gate waiting on Clay is READ ALOUD (DROVE-188).
     *
     * The lines are decided by GateSpeechTracker, which is pure; all this does
     * is hand them to the reader's urgent lane and take back the ones for
     * gates that have stopped being pending. Answering, dismissing or an
     * expiry all show up here the same way: the gate leaves the list, and
     * `cancelUrgent` un-says a line that had not been reached yet.
     *
     * The mic gate needs no code here. `reading` is already false while the
     * mic holds the route (see `tick`), so nothing is even looked at, and the
     * gate is spoken the moment he stops talking — which is the right answer,
     * because a gate does not stop waiting while he dictates.
     */
    private speakGates(sessionId: string, at: number): void {
        const reader = this.reader;
        if (reader === null) return;
        if (!settings().speakGates) return;
        const sessions = storage.getState().sessions ?? {};
        const entries = gatesForSession(sessions as never, sessionId);
        const { say, gone } = this.gates.observe(entries, at);
        for (const key of gone) reader.cancelUrgent(key);
        for (const line of say) reader.sayUrgent(line.key, line.text);
    }
}

export const audioCues = new AudioCueService();
