/**
 * The two kinds of phone haptic, and the one switch that answers for both
 * (DROVE-190).
 *
 * Clay: "No haptics on phone app or at least keep it disabled by default,"
 * and immediately after, "I want haptics on watch." The split he is drawing
 * is PHONE versus WRIST, not one kind of buzz versus another. The wrist is
 * the surface meant to tap him; the phone is the one he looks at and hears,
 * and it is in his pocket while a reply is read aloud.
 *
 * NOTIFICATION vs INTERACTION is still worth naming, because they fail
 * differently:
 *
 *   notification  something happened in a session. A gate arrived, an agent
 *                 finished. Fires while the phone sits in a pocket. This is
 *                 the buzzing he complained about, and it is duplicate noise
 *                 besides: the wrist already buzzed for the same event.
 *   interaction   feedback for something his own finger just did. The mic
 *                 latching, a picker notching, a long press registering. It
 *                 can only fire while he is holding the phone.
 *
 * ONE SWITCH, and why. A second switch would be a setting he never asked
 * for, and it would let the app buzz in his pocket while reading "Phone
 * haptics: off" on the screen, which is the one outcome that must be
 * impossible. So `phoneHaptics` gates both kinds: off, the default, means
 * this handset is still. On means it behaves as it did before this ticket.
 *
 * Interaction haptics are the smaller loss in that trade. They fire only
 * when he is already looking at the control he touched, which is exactly
 * when a haptic tells him least, and they come straight back with the same
 * switch. The kinds are still tagged at every call site so that if he ever
 * wants the two-switch version, it is a change to `hapticAllowed` and a
 * second key, not another sweep of the app.
 *
 * The WRIST is untouched by all of this. The watch buzzes off
 * `droverAnnounceHaptic`, the synced drover channel switch that is mirrored
 * to every connected Mac and that gates the background wake in
 * droverWatchFeed (DROVE-124). `phoneHaptics` is device-local and no watch
 * code reads it.
 *
 * Pure, no React and no native module, so a node test can prove the policy.
 */

export const HAPTIC_KINDS = ['notification', 'interaction'] as const;
export type HapticKind = typeof HAPTIC_KINDS[number];

/**
 * Whether a haptic of this kind may fire on this phone right now.
 *
 * `preview` is the one bypass: the channel demo screen (DROVE-75) exists so
 * Clay can press a row and feel what a pattern is. A demo that plays nothing
 * is a broken screen, not a quiet one, and nothing there fires unless a
 * finger asks for it by name.
 */
export function hapticAllowed(
    kind: HapticKind,
    phoneHaptics: boolean,
    preview: boolean = false,
): boolean {
    if (preview) return true;
    // Both kinds ride the same switch. See the header for why.
    void kind;
    return phoneHaptics;
}

/**
 * Every haptic call site in the phone app, with its kind. The spec walks
 * this against the source, so a new call site that is not listed here fails
 * the build rather than quietly shipping a buzz nobody classified.
 */
export interface HapticCallSite {
    file: string;
    kind: HapticKind;
    what: string;
}

export const HAPTIC_CALL_SITES: readonly HapticCallSite[] = Object.freeze([
    { file: 'sources/sync/droverAnnounce.ts', kind: 'notification', what: 'A Cattle Drover gate arrived and wants a human: the warning double-tap.' },
    { file: 'sources/components/AgentInput.tsx', kind: 'interaction', what: 'Composer taps: machine and path chips, autocomplete pick, picker open, permission mode, model and effort rows, send, mic press, stream-talk toggle, abort, blocked send.' },
    { file: 'sources/voice/useVoiceComposer.ts', kind: 'interaction', what: 'The mic gesture: one tap when the hold opens the recogniser, and a tick on every boundary the finger crosses (DROVE-140).' },
    { file: 'sources/components/HomeDock.tsx', kind: 'interaction', what: 'A refused composer action: the error pattern paired with the flash.' },
    { file: 'sources/components/TabBar.tsx', kind: 'interaction', what: 'The swipe-across-tabs preview, one tap per tab crossed.' },
    { file: 'sources/components/PermissionModeSelector.tsx', kind: 'interaction', what: 'Tapping the permission-mode chip to cycle it.' },
    { file: 'sources/components/LongPressCopyable.android.tsx', kind: 'interaction', what: 'A long press registering, before the copy menu opens.' },
    { file: 'sources/components/useCodeWrap.ts', kind: 'interaction', what: 'The double-tap that flips a code block between wrap and scroll (DROVE-95).' },
    { file: 'sources/components/DroverChannelsSheet.tsx', kind: 'interaction', what: 'The composer sheet: picking a mode, flipping a channel switch.' },
    { file: 'sources/app/(app)/settings/demo.tsx', kind: 'interaction', what: 'The channel demo, the one preview surface: pressing a row plays the taptic or the wrist pattern on purpose.' },
]);
