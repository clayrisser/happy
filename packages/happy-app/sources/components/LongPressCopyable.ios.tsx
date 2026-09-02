/**
 * iOS is back on the anchored menu, and this time the device check is in.
 *
 * DROVE-154 parked the SwiftUI ContextMenu, then un-parked it on `RNHostView`
 * (4c80ad77, 02:49) on the theory that a bare RN child of a `Host` was the
 * whole of the problem: it contributes nothing to `matchContents`, gets no
 * touch handler, and `RNHostView` closes both by KVOing the child's `bounds`
 * into a SwiftUI `.frame`. The theory is right about the mechanism. It is
 * wrong that the mechanism is enough, and the ticket said so itself — device
 * check 1, "the height under reflow, not at rest", was written down as owed.
 *
 * IT FAILED, at 10:24 the same morning (DROVE-373). Clay: "What's up with the
 * alignment of the speech things? You can see how they're overlapping, it's
 * all funky." Two screenshots on the ticket: a drover reply cut across the
 * middle of a line with the next message drawn inside the same band, and a
 * user bubble sitting on top of "wave 4 is porting those now". The failure the
 * file was parked for the first time, plus the half nobody had photographed
 * yet — the NEXT row, which starts wherever the short measurement said this
 * one ended.
 *
 * WHY THE OVERLAP IS THE SAME BUG AS THE CLIP. `matchContents={{vertical}}`
 * makes the row's Yoga height a value written back from a native measurement
 * rather than a value Yoga computed. When the measurement is short the row's
 * FRAME ends before its CONTENT does, so two things happen at once and only
 * one of them was in the original screenshot: the content is cut at the frame,
 * and the sibling below starts at the frame. A markdown body that reflows
 * after the first pass — a code fence, an image, a table — is exactly the case
 * that leaves the frame behind, and it is the case the transcript is made of.
 *
 * So the height of a message goes back to Yoga, which is the one thing in this
 * app that knows it. Reading the transcript beats the menu being native; that
 * was the ruling when this was parked the first time and nothing about it has
 * changed. The SwiftUI file is kept verbatim at `LongPressCopyable.ios.tsx.native`.
 *
 * WHAT WOULD ACTUALLY FIX IT is written in `nativeControls.ts` under the
 * verdict, and it is not a third go at `measured`: it is Rule 3's `overlay`,
 * a `Host` at `absoluteFillObject` over RN content that sizes itself, because
 * that mode has no measurement in it anywhere. Its cost is a transparent
 * SwiftUI trigger sitting over the row, which is a live question for the links
 * and tool cards inside a message and therefore a product call rather than a
 * mechanical one.
 *
 * The anchored menu lives in the .android file; this is the same component,
 * not an iOS-specific one, so it is re-exported rather than copied. It puts no
 * host in the tree, so a message row is laid out by Yoga and touches inside it
 * are ordinary RN touches.
 */
export { LongPressCopyable } from './LongPressCopyable.android';
