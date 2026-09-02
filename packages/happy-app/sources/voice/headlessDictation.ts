import type { ReadAloudInterruption } from './readAloud';
import {
    DictationCapture,
    type DictationCaptureState,
    type DictationEngine,
} from './dictationCapture';
import { dictationComposerEvents } from './dictationComposer';

/**
 * Dictation with NO SCREEN TO DICTATE INTO (DROVE-302).
 *
 * Clay's requirement, stated while DROVE-300 was being specified: "the
 * headphone mappings should work the same if the app is in the foreground or
 * if the app is background and we are in streaming mode." Single press and
 * double press already met it, because both are subscribed at module scope
 * (backgroundAudio.ts and readAloudService.ts) and neither can tell foreground
 * from background. The triple press did not: the microphone lived in
 * `useVoiceComposer`, which only `SessionView` mounts, so the press landed on
 * a subscription that existed only while a session screen happened to be up.
 *
 * React native does not unmount the tree when the app leaves the screen, which
 * is exactly why this looked fine every time it was tested: open a session,
 * pocket the phone, triple press, it works. Background the app from the
 * session LIST and the same press reached nothing at all — no capture, no cue,
 * no log line. That is the failure, and it is invisible from the inside.
 *
 * ## What this file is, and what it deliberately is not
 *
 * It is the composer's HALF that a composer was providing: somewhere for the
 * words to go. Everything else is the same code the screen runs.
 * `DictationCapture` is the same state machine, over the same recogniser, with
 * the same `dictationComposerEvents` in front of it — so DROVE-140's pause
 * handling, DROVE-120's "a capture ending never costs words" and DROVE-105's
 * "only a lift sends" are inherited rather than restated. A second
 * implementation of any of those is a second thing to keep in step, and the
 * whole DROVE-263 fiasco was two halves of one contract disagreeing.
 *
 * WHERE THE WORDS GO IS THE SESSION DRAFT, which the app already has: the
 * store keeps one per session, persists it, and `ChatComposer` hydrates from
 * it the moment he opens the session. So a sentence dictated into a pocket is
 * simply waiting in the composer when he next looks, which is the only place
 * he would think to look for it.
 *
 * A HEADPHONE PRESS NEVER SENDS (DROVE-105), and this is the path where that
 * matters most: there is no lift, no screen, and no way to check what was
 * heard before it goes. `send` below is wired to nothing on purpose rather
 * than left off the port, so a future reason that sets `shouldSend` cannot
 * quietly reach an agent from his pocket.
 *
 * ## The idle clock runs here, and it is not optional
 *
 * A headphone press can only latch — the hardware has no press-and-hold, see
 * the measurement in headphonePress.ts — and a latch holds the audio session
 * in `.playAndRecord` until something closes it. On screen the composer drives
 * `capture.tick` every half second so the latch stops itself after
 * DICTATION_LATCH_IDLE_MS (DROVE-259). With no screen there is no such
 * component, so this owns the clock. Without it, a mis-press in a pocket
 * leaves the microphone open and the reader locked out of the audio session
 * indefinitely, which is a worse bug than the one being fixed.
 */

/**
 * How often the idle deadline is checked. Half a second, the same as the
 * composer's clock, so the stop lands within a breath of the deadline.
 */
export const MIC_IDLE_TICK_MS = 500;

export interface HeadlessDictationDeps {
    /** The recogniser: `startDictation` / `stopDictation` / `cancelDictation`. */
    engine: DictationEngine;
    /** What this session's composer already holds. `sessions[id].draft`. */
    draft(session: string): string;
    /** Put the words where the composer will find them. `updateSessionDraft`. */
    setDraft(session: string, text: string): void;
    /**
     * Keep the reader off the audio session for the WHOLE capture, not merely
     * cut it: a reply still streaming in would queue another sentence a moment
     * later and take the category back under the recogniser (DROVE-143).
     */
    micHeld(held: boolean): void;
    /** Cut whatever is being said now. `readAloud.interrupt('mic')`. */
    cutReading(): void;
    /**
     * The mic could not open, or died. Nobody can read an alert from a pocket,
     * so the wiring answers this with a sound.
     */
    onError(message: string): void;
    /** Everything that stops speech stops capture too (DROVE-30). */
    onInterrupt(listener: (reason: ReadAloudInterruption) => void): () => void;
    /** A partial transcript landed. Everything heard since the mic opened. */
    onPartial(listener: (text: string) => void): () => void;
    /** The recogniser's task ended and nobody asked it to. */
    onEnded(listener: (text: string, reason?: string) => void): () => void;
    /** `setInterval`, injected so the idle clock has a spec and needs none. */
    interval(run: () => void, ms: number): () => void;
    now(): number;
}

/** What micPress.ts needs of a capture with no screen behind it. */
export interface HeadlessDictationPort {
    capturing(): boolean;
    settling(): boolean;
    open(session: string): void;
    close(): void;
}

export class HeadlessDictation implements HeadlessDictationPort {
    private readonly deps: HeadlessDictationDeps;
    private readonly capture: DictationCapture;
    private readonly unsubscribe: Array<() => void> = [];
    /** Which session this capture is writing into. */
    private into: string | null = null;
    /**
     * What that session's draft held when the microphone opened. SNAPSHOT, not
     * a live read: every partial is re-joined onto the base, so a base that
     * read the draft back would join the transcript onto itself once per
     * partial. That is DROVE-140's duplication bug reached from a new
     * direction, and it is the one mistake this file is most likely to make.
     */
    private base = '';
    private stopClock: (() => void) | null = null;

    constructor(deps: HeadlessDictationDeps) {
        this.deps = deps;
        this.capture = new DictationCapture(
            deps.engine,
            // The SAME composer wiring the screen uses, so DROVE-120's
            // invariant is exercised by the same code rather than by a copy of
            // it that can drift.
            dictationComposerEvents({
                base: () => this.base,
                // The draft IS this capture's composer, so it is what gets
                // asked whether dictation still owns what it wrote
                // (DROVE-360). Nothing is on screen to type into here, but a
                // draft the user edited on another screen is the same claim.
                current: () => (this.into === null ? '' : this.deps.draft(this.into)),
                setComposerText: (text) => {
                    if (this.into !== null) this.deps.setDraft(this.into, text);
                },
                // A HEADPHONE PRESS NEVER SENDS (DROVE-105). Only a lift sends
                // and there is no lift; the words wait in the draft where he
                // can read them before they go anywhere.
                send: () => { },
                onError: (message) => this.deps.onError(message),
                onChange: (state) => this.onChange(state),
            }),
            deps.now,
        );
        // Subscribed for the life of the app, like the press itself. A partial
        // arriving while nothing is capturing is dropped by the capture, so an
        // idle listener costs nothing and a listener wired per capture would
        // be one more thing to get wrong.
        this.unsubscribe.push(deps.onPartial((text) => this.capture.partial(text)));
        this.unsubscribe.push(deps.onEnded((text, reason) => this.capture.recogniserEnded(text, reason)));
        this.unsubscribe.push(deps.onInterrupt((reason) => this.capture.interrupt(reason)));
    }

    /** For the tests and the wiring: the capture as it stands. */
    get state(): DictationCaptureState {
        return this.capture.current;
    }

    /** The session being dictated into, or null when nothing is open. */
    get session(): string | null {
        return this.into;
    }

    capturing(): boolean {
        return this.capture.current.active;
    }

    settling(): boolean {
        return this.capture.current.settling;
    }

    /**
     * Open the microphone into this session's draft.
     *
     * `latch`, and it could not be anything else: a headphone press is one
     * discrete event with no duration, so press-to-open and press-to-close is
     * the only shape the hardware can carry (headphonePress.ts measures why).
     */
    open(session: string): void {
        if (this.capture.current.active || this.capture.current.settling) return;
        this.into = session;
        this.base = this.deps.draft(session);
        // Gate first, then cut. Nothing is recording yet, so the interrupt the
        // cut fires has nothing of ours to take: same order as the composer's
        // `open` effect, and for the same reason.
        this.deps.micHeld(true);
        this.deps.cutReading();
        this.capture.begin('latch');
    }

    /** The second press. The words stay in the draft; nothing is sent. */
    close(): void {
        this.capture.stop();
    }

    /** Tests only. The app's instance lives as long as the app does. */
    dispose(): void {
        this.capture.discard('left-session');
        this.clearClock();
        for (const off of this.unsubscribe.splice(0)) off();
    }

    private onChange(state: DictationCaptureState): void {
        // The idle clock runs only while a latch is live, and starts with it.
        if (state.active && state.idleAt !== null) {
            if (this.stopClock === null) {
                this.stopClock = this.deps.interval(
                    () => this.capture.tick(this.deps.now()),
                    MIC_IDLE_TICK_MS,
                );
            }
            return;
        }
        if (state.active) return;
        this.clearClock();
        // The reader gets the audio session back only once the native side has
        // finished with it. `settling` is part of that window: the recogniser
        // is still resolving the last stop and has not released the category
        // (DROVE-143).
        if (!state.settling) this.deps.micHeld(false);
    }

    private clearClock(): void {
        const cancel = this.stopClock;
        this.stopClock = null;
        if (cancel !== null) cancel();
    }
}
