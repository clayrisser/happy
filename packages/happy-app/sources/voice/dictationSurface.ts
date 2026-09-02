/**
 * Which composer, if any, is on screen and able to take dictation (DROVE-302).
 *
 * A REGISTRY RATHER THAN A LOOKUP, and the direction is the point. Before this
 * ticket the headphone microphone was subscribed inside `useVoiceComposer`, so
 * the press could only ever reach a session screen that happened to be
 * mounted: background the app from the session LIST and a triple press landed
 * on no subscription at all, did nothing, and said nothing. Clay's requirement
 * is that "the headphone mappings should work the same if the app is in the
 * foreground or if the app is background and we are in streaming mode", and a
 * subscription owned by a screen cannot meet it.
 *
 * So the owner moved out to module scope (micPress.ts) and the screen became
 * the OPTIONAL half: it announces itself here while it is mounted, and the
 * module-scope owner asks. When nothing has announced itself the press still
 * lands — it goes to the draft instead — which is the whole of the fix.
 *
 * LATEST WINS, AND A STALE UNREGISTER IS IGNORED. React mounts the next screen
 * before it unmounts the last one, so a naive "clear on unregister" would have
 * the outgoing screen wipe the incoming one's registration a tick after it
 * arrived. Unregistering only clears the slot when the slot still holds the
 * surface being removed.
 *
 * No react in here, and no reader either: it holds one object and tells anyone
 * who asked when it changes.
 */

export interface DictationSurface {
    /** The session this composer writes into. */
    readonly session: string;
    /** A capture is running on this composer right now. */
    capturing(): boolean;
    /**
     * The one capture, tapped. `useVoiceComposer.onTalkTap`, which is the same
     * call DROVE-210 gave the composer's primary button: one discrete event,
     * no duration, so it can only latch, and on a latched mic it can only stop.
     */
    tap(): void;
    /**
     * The one capture, ENDED AND SENT (DROVE-370).
     *
     * `tap` is the screen's verb and it never sends: DROVE-105 says a second
     * on-screen tap stops and leaves the words in the composer, where he can
     * read them and press send himself. That is right, because he is looking
     * at them.
     *
     * The headphone triple press is the other case, and it needs its own verb
     * rather than a changed `tap`. There is no screen, no lift and no send
     * button in a pocket, so a close that only stops leaves a sentence he has
     * to go and find later. Clay: "triple tap should also end it, and when it
     * ends it should auto-submit."
     *
     * It goes through the SAME commit a lift-send does — `onCommit(text, true,
     * 'send')`, DROVE-350 — so DROVE-360's replaceable-range rules and
     * DROVE-120's "a capture ending never costs words" are inherited rather
     * than restated. An empty transcript sends nothing: `DictationCapture`
     * discards rather than commits on an empty final, so the press just closes.
     */
    commit(): void;
}

let mounted: DictationSurface | null = null;
const listeners = new Set<() => void>();

function announce(): void {
    for (const listener of [...listeners]) {
        try {
            listener();
        } catch {
            // One deaf listener must not stop the others being told.
        }
    }
}

/**
 * This composer is on screen and will take dictation. Returns the unregister,
 * to be called when the screen goes away or stops offering the mic.
 */
export function registerDictationSurface(surface: DictationSurface): () => void {
    mounted = surface;
    announce();
    return () => {
        // Only the CURRENT surface may clear the slot. An outgoing screen
        // unmounting after the incoming one mounted is the ordinary case, not
        // an exception, and it must not take the new registration with it.
        if (mounted !== surface) return;
        mounted = null;
        announce();
    };
}

/** The composer on screen, or null when the press has no screen to land on. */
export function mountedDictationSurface(): DictationSurface | null {
    return mounted;
}

/**
 * Tell me when that changes.
 *
 * micPress.ts uses this for one thing: a screen ARRIVING mid-capture takes the
 * dictation over, so the headless capture is closed rather than left running
 * underneath a composer that is about to offer its own microphone. Two
 * captures on one recogniser is a rejected `startDictation` and a mic that
 * looks live over nothing.
 */
export function onDictationSurfaceChange(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

/** Tests only: forget everything, so one spec cannot leak into the next. */
export function resetDictationSurfaces(): void {
    mounted = null;
    listeners.clear();
}
