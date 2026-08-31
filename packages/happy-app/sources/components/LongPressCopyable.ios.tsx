/**
 * iOS is back on the anchored menu, deliberately and temporarily.
 *
 * DROVE-154 put the real UIKit context menu on a message by hosting a SwiftUI
 * ContextMenu around it (`@expo/ui`'s `Host`). Anchoring, the lift, the haptic
 * and dismissal all worked. What did not is that a hosted SwiftUI view does
 * not take its height from React Native children: `matchContents` measured a
 * long markdown body short, so the message was CLIPPED mid-sentence with dead
 * space under it, and Clay could not read his own transcript.
 *
 * Reading the transcript beats the menu being native, so the SwiftUI path is
 * parked rather than shipped broken. It is kept verbatim at
 * `LongPressCopyable.ios.tsx.native` beside this file.
 *
 * THE FIX IS KNOWN NOW (DROVE-134). The host was never going to report the
 * body's height, because a bare React Native child of a `Host` contributes
 * nothing to `matchContents` and gets no touch handler either. `RNHostView`
 * from `@expo/ui/swift-ui` is the missing piece: it observes the child's
 * `bounds` and applies it as a SwiftUI frame. Three lines, already compiled
 * into build 12. The diff and the two device checks it still needs are written
 * out in `nativeControls.ts` under "VERDICT ON LongPressCopyable".
 *
 * The anchored menu lives in the .android file; this is the same component,
 * not an iOS-specific one, so it is re-exported rather than copied.
 */
export { LongPressCopyable } from './LongPressCopyable.android';
