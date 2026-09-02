/**
 * The persisted read-aloud setting reaches the reader with NO SCREEN MOUNTED
 * (DROVE-301).
 *
 * ## The bug, which is one gate in the wrong file
 *
 * `readAloud.setEnabled` was, when this was written, the MASTER SWITCH: what a
 * session nobody had said anything about read (DROVE-297; DROVE-386 has since
 * made it the capability instead, see below). Until this ticket its only caller was an
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
 * ## What this file is now: a CAPABILITY, not a default (DROVE-386)
 *
 * The wiring above is unchanged and still the fix DROVE-301 shipped. What the
 * setting MEANS on the far side of it changed once, and this paragraph is the
 * whole of it.
 *
 * It used to be what a session nobody had touched inherited, and that turned
 * out to be the bug. Clay leaves the switch on because he wants read-aloud to
 * EXIST, so every session the reader had not been told about came up armed: a
 * session he had just created started talking the moment he opened it, and
 * after a relaunch — where the per-session map is empty by construction —
 * every session he owned was armed at once. His words: "By default when I
 * create a new session and go to it, why does it have reading enabled? Even if
 * I close the app and reopen the app, by default reading should not be
 * enabled."
 *
 * So `readAloud.setEnabled` no longer arms anything. It says the phone MAY
 * read, it is what `drover read` reports as "off on the phone", and turning it
 * off is still the kill that drops every per-session switch and every held
 * position. Arming is `setSessionEnabled`, one session at a time, by his thumb
 * or by `drover read <session>`.
 *
 * ## What this deliberately does NOT change
 *
 * DROVE-297's model, whole: the take-the-voice rule, the composer's control
 * writing the session's own switch, a visit to an unarmed session moving
 * nothing.
 *
 * DROVE-301's own acceptance criterion, which is this file's reason to exist:
 * the setting still reaches the reader with NO SCREEN MOUNTED, at module
 * scope, ahead of `startBackgroundAudio`. What it publishes at launch is now
 * 'off', and that is correct rather than the teardown DROVE-301 refused —
 * after a relaunch nothing IS reading, so there is no card to tear down. Arm a
 * session and the card comes up, still with no SessionView anywhere. Both
 * halves are pinned in readingDefault.spec.ts.
 *
 * DROVE-226's "a transcript loads silent" is untouched: the switch decides
 * whether the reader MAY speak, and what it speaks comes from the timeline,
 * which at launch is empty and is only ever filled forward by sync.
 *
 * DROVE-179's "the reader follows him" keeps its real claim — a surface going
 * away is not the session going away, which is `blur` — and loses only its
 * corollary that with nothing to distinguish the sessions by every session is
 * enabled. There is always something to distinguish them by now: his thumb.
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
