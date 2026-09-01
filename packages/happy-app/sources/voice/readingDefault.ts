/**
 * The persisted read-aloud setting reaches the reader with NO SCREEN MOUNTED
 * (DROVE-301).
 *
 * ## The bug, which is one gate in the wrong file
 *
 * `readAloud.setEnabled` is the MASTER SWITCH: what a session nobody has said
 * anything about reads (DROVE-297). Until this ticket its only caller was an
 * effect in `useVoiceComposer` gated on `active`, which is `!embedded` and is
 * set from `SessionView`. So the persisted `localSettings.readAloudEnabled`
 * reached the reader only while a non-embedded session screen was mounted, and
 * two things followed that nobody asked for:
 *
 *   TURNING IT ON FROM SETTINGS PUBLISHED NOTHING. Settings -> Voice, the
 *   channels screen and `DroverChannelsSheet` all write the local setting and
 *   nothing else. With no session screen up, the reader never heard, so
 *   `startBackgroundAudio` had nothing to react to: no hold, no
 *   `setReadingState`, no card. The switch said on and the app was off.
 *
 *   A COLD LAUNCH WITH IT PERSISTED ON CAME UP OFF. `defaultEnabled` starts
 *   false, so the reader was off until a session screen mounted, and
 *   `startBackgroundAudio`'s first `apply()` published `'off'` — which is not
 *   a missed publish, it is an ACTIVE teardown: native's `setReadingState(off)`
 *   tears down the remote commands and clears the now-playing card. The app
 *   dismantled the lock screen at launch because a screen was not up yet.
 *
 * ## The fix, which is the shape DROVE-300 and DROVE-302 already chose
 *
 * The setting is app-wide, so it is read app-wide: subscribed at module scope
 * in readAloudService.ts, beside `startBackgroundAudio`, the double press and
 * the triple press. That module has no react in it and runs once at import, so
 * the setting lands whether a SessionView is mounted, unmounted, or was never
 * opened this launch — which is the same sentence those two tickets wrote about
 * the headphone gestures, for the same reason.
 *
 * `useVoiceComposer` no longer calls `setEnabled` at all. That removes the
 * hazard its own comment named — two chat surfaces mounted at once, the
 * embedded one writing `false` over what the user is looking at — by having no
 * surface write it, rather than by picking the right surface.
 *
 * ## What this deliberately does NOT change
 *
 * DROVE-297's model, whole. This is the DEFAULT a session inherits, not a
 * command: `setEnabled(true)` leaves a session he explicitly switched off still
 * off, and the composer's control still writes the session's own switch. The
 * only thing that moved is WHO tells the reader the default, not what the
 * default means.
 *
 * DROVE-179's "the reader follows him" is untouched, and is pinned in
 * readAloudNeverSilent.spec.ts: with the default on and no session individually
 * switched off, every session is enabled, so navigating takes the voice exactly
 * as before.
 *
 * DROVE-226's "a transcript loads silent" is untouched too, and this is the
 * question worth being explicit about, because arming the reader at launch
 * sounds like it should read history. It does not: `defaultEnabled` decides
 * whether the reader MAY speak, and what it speaks comes from the timeline,
 * which at launch is empty and is only ever filled forward by sync. A cold
 * launch therefore comes up armed and silent, which is the state the card
 * describes.
 */

export interface ReadingDefaultDeps {
    /** The persisted setting, read fresh each time. */
    read(): boolean;
    /** Told when the store changes. Returns the unsubscribe. */
    subscribe(listener: () => void): () => void;
    /** `readAloud.setEnabled` — the master switch (DROVE-297). */
    setEnabled(enabled: boolean): void;
}

/**
 * Point the reader's default at the persisted setting, now and on every change.
 *
 * NO CACHE OF THE LAST VALUE HERE, on purpose. `setEnabled` already returns
 * early when the default has not moved, and it has to: turning it off clears
 * every per-session switch and every held position, so a redundant call that
 * got through would wipe them. Keeping a second copy of that guard in this file
 * would only be a second place for it to be wrong.
 *
 * The first push happens BEFORE the subscription so a caller can order this
 * ahead of `startBackgroundAudio` and have its first `apply()` see the truth.
 * That ordering is what stops the launch-time `'off'` publish.
 */
export function startReadingDefault(deps: ReadingDefaultDeps): () => void {
    const push = () => {
        try {
            deps.setEnabled(deps.read());
        } catch {
            // A setting that could not be read is not worth taking the reader
            // down for; it stays wherever it was.
        }
    };
    push();
    return deps.subscribe(push);
}
