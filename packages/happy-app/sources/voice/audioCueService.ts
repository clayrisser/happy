import { storage } from '@/sync/storage';
import { resolveAudioCues } from '@/sync/settings';
import { gatesForSession } from '@/sync/droverGates';
import { isLiveStatusFresh } from '@/utils/liveStatus';
import type { Message } from '@/sync/typesMessage';
import { AudioCueMixer } from './audioCueMixer';
import { playCue, releaseCuePlayers, warmCuePlayers } from './cuePlayer';
import { SpokenTitleTracker } from './spokenTitles';
import { audioCues as cueTable, cueSpec, type AudioCueId } from './audioCues';

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
}

function settings() {
    return resolveAudioCues(storage.getState().settings);
}

class AudioCueService {
    private readonly mixer = new AudioCueMixer({
        now: () => Date.now(),
        play: (id, volume) => playCue(id, volume),
        settings,
    });
    private readonly titles = new SpokenTitleTracker();
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
                    this.mixer.setState({ reading: false, working: false, pendingKinds: [] });
                    this.mixer.reset();
                }
                if (this.armedAt !== idleTickMs) this.arm(idleTickMs);
                return;
            }
            if (!this.wasReading) {
                this.wasReading = true;
                // Build the sounds now rather than when the first one is due.
                warmCuePlayers(cueTable.map((cue) => cue.id), settings().volume);
            }
            if (this.armedAt !== tickMs) this.arm(tickMs);
            const at = Date.now();
            if (at - this.stateAt >= stateEveryMs) {
                this.stateAt = at;
                this.mixer.setState(this.readState(focused as string, at));
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
        const working = session?.thinking === true
            || isLiveStatusFresh(session?.metadata?.liveStatus as never, at);
        const pendingKinds = gatesForSession(sessions as never, sessionId).map((entry) => entry.gate.kind);
        return { reading: true, working, pendingKinds };
    }
}

export const audioCues = new AudioCueService();
