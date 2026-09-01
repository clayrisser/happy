# iPhone and watch widgets for Cattle Drover (DROVE-260)

A proposal, plus a thin proof of concept for the one size it argues for. Nothing
here is built beyond that one size, on purpose: a widget's whole discipline is
what it leaves out, and four sizes shipped together is four decisions nobody
made.

## The recommendation, first

Ship **one iPhone widget, `.systemSmall`, on the Home Screen.** It answers one
question — is anything waiting on me — and when the answer is no it says whether
the work is still alive, in the hue vocabulary DROVE-231 already defined.

Leave the Lock Screen alone until someone designs a monochrome vocabulary for
it. Leave the watch complication exactly as BASED-98 shipped it.

## What already exists

The watch half of this ticket is mostly done. `watch/DroverWatchWidget/` is a
Smart Stack complication that shows the gate count, went in with BASED-98, and
already gets the two hard parts right: it renders from an app-group snapshot,
and it schedules a second timeline entry at the exact moment that snapshot goes
stale so it stops saying "clear" the instant it stops knowing.

What does not exist is anything on the phone. `com.bitspur.drover` has no
app-group entitlement at all — `app.config.js` grants
`group.com.bitspur.drover` to `DroverWatch` and `DroverWatchWidget` and to
nothing else — so today there is no shared container an iOS extension could
read.

## The two constraints this is designed against

**A widget does not run the app.** WidgetKit renders it in a separate process
with no store, no socket and no bus. Everything shown has to have been written
into the app group beforehand, and it goes stale between writes. So the design
question is not "what would be nice to see", it is "what is still true an hour
after it was written, and what does the widget say when it isn't".

**The refresh budget is not yours.** WidgetKit gives a widget roughly 40 to 70
timeline reloads a day on its own schedule. That is about one every twenty
minutes at best, and it is not a promise.

The second constraint has a good answer here, and it is the reason this is worth
building at all: **the app already gets woken on exactly the right event.**
`sources/sync/droverBackgroundNotification.ts` claims a silent
content-available push that the CLI sends whenever the set of gates *changes* —
on a raise and on a dismiss. That handler already rebuilds the whole snapshot
and hands it to the wrist. Writing the same thing into the app group and calling
`WidgetCenter.reloadAllTimelines()` is one more line in a path that is already
running, so the widget costs no new refresh budget and no new wake. Apple
documents roughly two or three background pushes an hour and promises none of
them, which is why the staleness policy below is load-bearing rather than
decorative.

## What each supported size would show, and what it costs

| size | shows | refresh cost | verdict |
|---|---|---|---|
| iOS `.systemSmall` | gate count, or the worst dot + workers when zero | free — rides the existing gate push | **build** |
| iOS `.systemMedium` | the above plus one account bar, with an "as of" stamp | free for the count, but headroom moves every turn | later, if he asks |
| iOS `.systemLarge` | a session list | a list is what the app is for | no |
| iOS `.accessoryRectangular` (Lock Screen) | count + oldest gate title, monochrome | free | blocked on a monochrome vocabulary |
| iOS `.accessoryCircular` / `.accessoryInline` | count alone | free | same block, less value |
| watchOS `.accessoryCircular` / `.accessoryCorner` / `.accessoryRectangular` | gate count | already shipped (BASED-98) | leave it |

### Why `.systemSmall` and not the Lock Screen

The Lock Screen is the better *surface* and the worse *canvas*. It is genuinely
the thing you see without opening anything, which is the whole argument for a
widget. But Lock Screen accessory families render in `WidgetRenderingMode`
`.vibrant`: content is desaturated to a monochrome material. Every state this
widget can be in is carried by hue — green connected, blue working, purple
compacting, amber waiting, yellow then red disconnected. Desaturated, all six
collapse into one grey.

So a Lock Screen widget cannot reuse `statusDotColors`. It needs a second
vocabulary in glyphs and words, and inventing one is precisely the drift
DROVE-257 caught: the wrist had grown its own colour table where `disconnected`
was grey on the watch and red on the phone, and nobody noticed because nobody
holds a watch and a session list side by side. A monochrome dot vocabulary is a
real piece of design work and it should be its own ticket, not a family added to
a `supportedFamilies` array.

`droverWidgetFace.spec.ts` pins that: it asserts the widget declares exactly
`.systemSmall`, and that no accessory family appears in the file. The decision
fails a test rather than eroding.

### Why not `.systemMedium`, and the account headroom question

`usageFill` is the shared derivation and a widget should be its fourth consumer.
But headroom is the wrong fact for a small widget, and the reason is timing, not
space.

Headroom moves on every turn. The widget's copy is written when the *gate set*
changes, which is uncorrelated with token spend — a session can burn a whole
week's window without raising a single gate, and the widget would sit on the
number from before. A percentage on a home screen with nothing next to it saying
how old it is reads as live. That is DROVE-255 exactly: the fresh-looking
session row over a spent week.

`.systemSmall` has no room for an "as of 14:20" stamp beside a bar without
crowding out the count. `.systemMedium` does. So the rule is: **headroom needs a
timestamp, a timestamp needs a row, and a row needs the medium size.** Not
before.

## What `.systemSmall` shows

Two shapes, and no third.

**Something is waiting.** The count at 44pt in `statusDotColors.waiting`
(`#FF9500`, the phone's own amber), and under it the title of the **oldest**
gate. Oldest rather than newest because when one gate is waiting the title *is*
the decision, and when five are, the one ignored longest is the one worth
naming — the newest is the one he was just buzzed about.

**Nothing is waiting.** No number at all. A zero rendered as a zero is a figure
competing with the figure that matters. Instead: the worst dot across all
sessions, in its own hue, with its own `statusDotLabels` word, and a line saying
how many workers are out. When nothing needs him the only remaining question is
whether his work is alive, and the dot answers it in one glyph.

Empty store is `disconnected`, never `connected`. A phone that has never synced
and a machine with everything shut down look identical from here, and neither is
an all-clear worth a green tick.

## What a stale widget shows

This is the part worth arguing about, and the answer is **not** the watch's.

The wrist uses one number, `DroverSnapshot.staleAfter = 180`, three phone
heartbeats. That works there because the phone heartbeats every 60s while
foregrounded *and* the wrist can ask for a fresh snapshot — a WatchConnectivity
`sendMessage` wakes the phone in the background. A widget can do neither. It has
no channel and the phone app is suspended nearly always, so a widget holding a
180-second budget would read "stale" essentially every time it was looked at.
That is DROVE-22's failure repeated on a new surface: the only message he ever
sees is the accusation.

The fix is to notice that **the lie is asymmetric.**

The push that writes this fires when the gate set *changes*. So an old snapshot
carrying a count is old for an innocent reason — nothing has been raised or
resolved, and the count is probably still true. Clay asleep on an unanswered
gate looks exactly like this. An old snapshot carrying **zero** is the dangerous
one, because the event that would have corrected it is precisely the push that
went missing.

So two budgets, not one:

- `WIDGET_CLEAR_TRUSTED_MS` = **1 hour**. One push-budget window. Past it, a
  dropped raise is as good an explanation for the silence as a quiet machine,
  and "clear" is no longer something the widget is in a position to claim.
- `WIDGET_COUNT_TRUSTED_MS` = **6 hours**. A count survives silence; a zero does
  not. Not unbounded, because a machine off since morning leaves a "2 waiting"
  that will never be answered and never corrected.

Past its budget the face becomes `dated`. The count keeps its shape — hiding it
would be its own lie — but it drops out of the 44pt live weight, the tint gives
up its authority, and the relative age goes in the corner as a fact about the
*widget* rather than a warning about the machine. A dated zero does not survive
at all: it becomes "Not heard from".

Six hours is the one number here picked by judgement rather than derived from
something. Longer than a sitting, shorter than a night. It wants a week of
watching before anyone calls it right.

## Reuse, not re-derivation

The rule from DROVE-129 and DROVE-257 is that the phone resolves and the
extension renders. The widget's face is therefore computed in
`sources/sync/droverWidgetFace.ts` and written whole; the Swift draws it and
decides only one thing the phone could not know, which is whether that face is
still current at the moment WidgetKit is rendering for.

Concretely:

- the tint is `statusDotColors[dot]`, assigned, never chosen. A test asserts
  every hex the face can produce is already a value in that table.
- the word is `statusDotLabels[dot]`.
- the dot itself is whatever `sessionDotState` already resolved for
  `collectSessions`, ranked by a precedence over the *existing* six states. No
  seventh state, no rename.
- headroom, when a medium widget eventually carries it, is `usageFill` and
  nothing else.

The face carries its own `updatedAt` rather than reading the snapshot's. Two
blobs are written by two paths — the wrist publish writes the snapshot, a push
that only needs to move the widget writes just the face — so a face aged by the
other's timestamp would be aged by an unrelated write, or freshened by one,
which is the direction that lies.

`droverWidgetFace.spec.ts` extends the pin-test pattern from
`sessionStateWire.spec.ts`: it reads the Swift files and checks the two
timeouts, the fallback hex, and the family list against the TypeScript. Both
pins were verified to fail when the Swift is edited out of step.

## What it takes to actually ship this

Small, and mostly on rails that already exist.

1. **App group on the phone target.** `watch/scripts/add-watch-targets.rb`
   already creates the host app's entitlements file (empty) and pins
   `CODE_SIGN_ENTITLEMENTS` to it, for an unrelated reason — see its comment
   about build 8. Adding `com.apple.security.application-groups` there is a
   two-line edit to an existing block, plus the matching declaration in
   `app.config.js` so EAS mints a profile with the capability.
2. **A widget extension target.** Same graft as `DroverWatchWidget`, `:ios`
   instead of `:watchos`, bundle id `com.bitspur.drover.widget`, plus its entry
   in `app.config.js` `appExtensions`.
3. **Sharing `DroverSnapshot.swift`.** It lives under `watch/DroverWatch/Shared/`
   and is already app-group aware. The iOS widget target needs the same file
   references.
4. **Writing the face.** One call in the existing publish paths
   (`droverWatchFeed.ts` and `republishWatchSnapshot`) plus a native function
   beside `publish` in `modules/drover-watch/ios/DroverWatchModule.swift` that
   writes the JSON to the app group and calls
   `WidgetCenter.shared.reloadAllTimelines()`.
5. **A deep link.** `widgetURL` points at `happy://gates`; the route needs to
   exist and resolve.

## What was verified, and what cannot be without a native build

Verified on this branch:

- the derivation and the trust ladder, 15 tests in
  `sources/sync/droverWidgetFace.spec.ts`.
- both cross-language pins genuinely fail on drift — checked by editing the
  Swift out of step and watching the test go red, then restoring it.
- `tsc --noEmit` clean, and the full app suite green at 4117 tests across 265
  files, including the 148 `composerControlColour` tests and the 71
  `agentInputUsage` tests.
- both new Swift files **type-check** against WidgetKit and SwiftUI:
  `swiftc -typecheck` against the macOS SDK, together with
  `DroverSnapshot.swift`. Confirmed meaningful by dropping a file and watching
  it produce real errors. That is a macOS target, not iOS, so it proves the
  types and the API use, not the platform availability of every symbol.

Unverified until a prebuild and a device build:

- that the Xcode target graft works — the widget compiled as a real iOS app
  extension, embedded in the host, signed.
- that the app group is readable from an iOS extension once the entitlement is
  added, and that EAS mints a profile carrying it.
- that `WidgetCenter.reloadAllTimelines()` from a background push actually
  refreshes the widget within the push's seconds-long execution budget.
- that the 44pt count and a two-line title fit `.systemSmall` at the largest
  Dynamic Type setting.
- the real-world hit rate of the gate push, which is the whole freshness
  argument, and which can only be measured by living with it.
- that `.systemSmall` on iOS 18's tinted Home Screen keeps enough of the hue to
  tell amber from green. This is the risk most likely to change the design: if
  tinted mode flattens the palette the way the Lock Screen does, the
  monochrome-vocabulary problem arrives on the Home Screen too and this widget
  needs the same work the Lock Screen was deferred for.
