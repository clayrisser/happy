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
 * `LongPressCopyable.ios.tsx.native` beside this file and goes back the moment
 * the host reports the body's real height, which is DROVE-154's open work.
 *
 * The anchored menu lives in the .android file; this is the same component,
 * not an iOS-specific one, so it is re-exported rather than copied.
 */
export { LongPressCopyable } from './LongPressCopyable.android';
