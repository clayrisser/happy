# iPhone and watch widgets for Cattle Drover (DROVE-260)

The argument for one iPhone widget, and the widget. Nothing is built beyond
that one size, on purpose: a widget's whole discipline is what it leaves out,
and four sizes shipped together is four decisions nobody made.

The first half of this document was the proposal. It stands as written and the
build agreed with it, including the two calls most worth arguing with — no
Lock Screen until someone designs a monochrome vocabulary, and no account
headroom until there is a row wide enough to date it. The second half, from
"How it is wired" down, is what the wiring turned out to need, and it is one
decision the proposal did not have to make: **the reload budget**. A widget's
freshness is not only what it says, it is how often anyone is allowed to tell
it anything, and WidgetKit rations that at about 40 to 70 times a day.

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

What did not exist was anything on the phone. `com.bitspur.drover` had no
app-group entitlement at all — `app.config.js` granted
`group.com.bitspur.drover` to `DroverWatch` and `DroverWatchWidget` and to
nothing else — so there was no shared container an iOS extension could read.
That is the first thing "How it is wired" below changes, and it is the change
that fails most quietly if it is got wrong.

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
running, so the widget costs no new wake. Apple documents roughly two or three
background pushes an hour and promises none of them, which is why the staleness
policy below is load-bearing rather than decorative.

It does not, as this section originally claimed, cost no new refresh budget.
That was true of the gate push alone; the build also writes the face on every
foreground publish, which is what makes it fresh — and the reload that reaches
the widget is exactly the thing WidgetKit rations. See "The reload budget"
below, which is the one decision the proposal did not have to make.

## What each supported size would show, and what it costs

| size | shows | refresh cost | verdict |
|---|---|---|---|
| iOS `.systemSmall` | gate count, or the worst dot + workers when zero | rides the gate push and every foreground publish; the reload is rationed | **built** |
| iOS `.systemMedium` | the above plus one account bar, with an "as of" stamp | free for the count, but headroom moves every turn | later, if he asks |
| iOS `.systemLarge` | a session list | a list is what the app is for | no |
| iOS `.accessoryRectangular` (Lock Screen) | count + oldest gate title, monochrome | free | blocked on a monochrome vocabulary |
| iOS `.accessoryCircular` / `.accessoryInline` | count alone | free | same block, less value |
| watchOS `.accessoryCircular` / `.accessoryCorner` / `.accessoryRectangular` | gate count | already shipped (BASED-98) | leave it |
| watchOS `.accessoryInline` | the same count, one line beside the time | rides the watch app's existing reload | **built** (second pass) |

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

Headroom moves on every turn, and the widget's copy does not. It is refreshed
while the app is open and when the gate set changes, and the phone is closed
for most of the hours a home screen is glanced at — so the number on it is
routinely an hour old and can be a night old, over a window that moved the
whole time. A percentage on a home screen with nothing beside it saying how old
it is reads as live. That is DROVE-255 exactly: the fresh-looking session row
over a spent week.

The build did not change this. It is the one place where writing the face more
often would have been an argument for putting headroom on the small size, and
it is not enough: an hour is long enough to burn a session window, so an
hour-old percentage with no stamp is still a lie, just a fresher one.

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


## How it is wired

Five pieces, all on rails that already existed.

1. **The app group, on the phone target.** `app.config.js` declares
   `ios.entitlements` with `com.apple.security.application-groups`, which is
   what EAS reads to put App Groups on the profile it mints — without it,
   signing is refused with "doesn't support the group.com.bitspur.drover App
   Group", which is the same wall the two watch targets hit before their
   `appExtensions` entries carried it. `add-watch-targets.rb` also **merges**
   the group into `ios/<Host>/<Host>.entitlements` itself, because that file is
   written by the graft on a fresh `ios/` and by expo's entitlements base mod
   afterwards, and merging rather than assigning means the order cannot matter.
   Checked: `expo config --type introspect` resolves the phone's entitlements
   to the group *and* `aps-environment`, so the two writers really do compose.

2. **A widget extension target, `DroverPhoneWidget`.** Grafted by the same
   script as the watch targets, for the same reason — `ios/` is gitignored, so
   a target that is not in the graft does not exist. It is `:ios`, not
   `:watchos`, so almost none of the watch targets' shared settings hash
   applies and it is spelled out instead; the one setting they must NOT share
   is `TARGETED_DEVICE_FAMILY`, which is `4` there and `1,2` here. The graft
   asserts its own `SDKROOT`, and `verify-watch-targets.rb` asserts it again
   afterwards, because a watchOS setting copied onto a phone extension builds,
   embeds, signs, and then fails on the device saying nothing useful.

3. **`DroverSnapshot.swift`, and only that file out of `Shared/`.** It carries
   the app-group suite name and the ISO-8601 coders the face rides on. The rest
   of `Shared/` is the wrist's — cues, reach, drafts, the demo — and an iOS
   extension compiling them would be carrying watch behaviour it can never run.

4. **Writing the face.** `sources/sync/droverWidgetPublish.ts` builds it and
   `DroverWatchModule.publishWidgetFace` writes the raw JSON into the group.
   Two callers: the foreground feed, on every publish it makes, and
   `republishWatchSnapshot`, on the silent gate push. In the background task it
   is **awaited, and above the watch publish** — the execution budget ends when
   that function returns, and a widget that only got written when a WATCH
   publish also succeeded would go dark for anyone without a watch, silently.

5. **The deep link.** `widgetURL` is `happy://gates`, and `/gates` is a route
   that already exists (`sources/app/(app)/gates.tsx`, which
   `PendingGatesBanner` and `HomeHeader` already push). Nothing to add.

## The reload budget, which is the decision the proposal did not have to make

WidgetKit hands out roughly 40 to 70 timeline reloads a day and promises none
of them. `WidgetCenter.reloadAllTimelines()` spends one. The face, meanwhile,
is now written on every publish the feed makes — a heartbeat a minute plus
every store change while the app is open — because that is what makes it fresh.
Reload on each of those and the day's budget is gone inside the hour, and the
widget is then frozen for the rest of it. Over a gate raised at four o'clock.
That is the one failure this surface cannot have, so the write and the telling
are split.

**The blob is written every time.** It costs nothing and it is what WidgetKit
reads on its next reload from any cause, including its own `.after(900)`
policy. Keeping it current can only help.

**The reload is spent on two things.** The COUNT moved — something is now
waiting on him, or he is now clear — or a FAULT appeared or cleared. Those are
the two facts the widget exists to carry, and both want the home screen to
change now rather than within the quarter hour.

**Everything else waits for the floor**, `WIDGET_RELOAD_FLOOR_MS`, 30 minutes.
`working` and `connected` swap on every turn a session takes and the worker
count moves with every subagent; a widget chasing those would spend the whole
budget on a glyph nobody is looking at.

30 minutes is picked against `WIDGET_CLEAR_TRUSTED_MS` rather than by feel: it
is half the window a clear face is trusted for, so a phone being used at all
restamps the widget twice inside every trusted hour and cannot fall out of
trust while it is awake — a widget saying "Not heard from" over a phone in his
hand is DROVE-22's failure moved to a new surface. `droverWidgetFace.spec.ts`
asserts that relationship rather than the number, so changing one forces the
other to be thought about.

**The honest part.** WidgetKit's own timeline policy already asks for a reload
every 15 minutes, and the two draw on the same budget, so the floor is belt and
braces: insurance for the case where the system throttles the policy to
nothing, bought at up to 48 reloads a day. Whether that trade is right can only
be found out by living with it, exactly like the six-hour count budget above.
The floor being measured from the last RELOAD rather than the last write is not
in that category, though — a write nobody reloaded for did not reach the
widget, so counting writes would let an hour of churn look like an hour of
keeping it current.

## The watch, per family (second pass, 2026-09-01)

BASED-98's complication answers the question this ticket says a wrist should:
how many gates are waiting. It schedules a second timeline entry at the moment
its snapshot goes stale, so it stops saying "clear" the instant it stops
knowing. And it draws in SF Symbols and semantic colours rather than
`statusDotColors` on purpose: complications desaturate, so the glyph's shape
carries the state and the hue never has to. Rewriting it onto the phone's hue
table would import the exact problem this document declines to solve on the
Lock Screen.

One rule for every slot on the face: the count, and the same glyph. Per family:

| family | shows | tap | leaves out | state |
|---|---|---|---|---|
| `.accessoryCorner` | the count | the wall | names, reading, headroom | shipped (BASED-98) |
| `.accessoryCircular` | the count | the wall | the same | shipped (BASED-98) |
| `.accessoryRectangular` | the count; proposed: the oldest gate's title on the second line | the wall | headroom, tasks | count shipped; the title waits on Clay |
| `.accessoryInline` | the count and glyph as one line beside the time | the wall | everything else | **built here** |

Inline was the one slot the face offered that Drover did not fill, and it is
the settled signal on one more family with no new words and no new data, so it
needed no answer from anyone. It reads the same `label` and `symbol` the
circular reads; the watch pin in `droverWidgetFace.spec.ts` holds it to that.

Waiting on Clay, as posted on DROVE-260: whether rectangular names the oldest
gate (the ticket says "not a miniature of the phone widget"); whether the
session actually READING (DROVE-297, already on the snapshot) takes the second
rung on rectangular and inline while nothing waits; whether a tap should open
the gate rather than the wall when one is waiting, since the notification tap's
route already exists; and how the corner draws on his Ultra, because it puts
the caption inside the small circle rather than on the curve.

## What was verified, and what cannot be without a native build

Verified on this branch, on this machine:

- the derivation, the trust ladder, the wire adapter and the reload policy —
  31 tests in `sources/sync/droverWidgetFace.spec.ts` and 9 in
  `sources/sync/droverWidgetPublish.spec.ts`.
- `tsc --noEmit` clean, and the full app suite green at **4146 tests across 266
  files**, including the 148 `composerControlColour` tests (DROVE-254's capsule
  `colorAlpha === 1` among them) and the 90 `droverWatchFeed` tests.
- the three widget Swift files **type-check against the real iOS SDK**:
  `swiftc -typecheck -sdk iphonesimulator -target arm64-apple-ios17.0-simulator`
  over `DroverPhoneWidget.swift`, `DroverWidgetFace.swift` and
  `DroverSnapshot.swift`. Confirmed meaningful by dropping `DroverSnapshot.swift`
  and watching it fail on `cannot find 'DroverSnapshot' in scope`. This is a
  stronger check than the macOS typecheck the proposal ran: it proves platform
  availability of every symbol on iOS 17, not just the shapes.
- the body of `publishWidgetFace` type-checks against the same SDK, lifted out
  of the Expo module DSL so it can be compiled without ExpoModulesCore.
- **the graft actually runs.** A synthetic `ios/` — one application target and
  a host Info.plist, built with the xcodeproj gem where a real prebuild would
  put it — then the real `add-watch-targets.rb` twice and the real
  `verify-watch-targets.rb`. It produced `DroverPhoneWidget` as
  `com.apple.product-type.app-extension`, `SDKROOT=iphoneos`, family `1,2`,
  `SKIP_INSTALL=YES`, id `com.bitspur.drover.widget`, version 22 off the host
  plist, the three expected sources, an `Embed Foundation Extensions` phase on
  the HOST with `dst=:plug_ins` and `CodeSignOnCopy`, and the app group merged
  into the host's entitlements. Idempotent: the second run left exactly one of
  each phase and dependency.
- the verifier's two new checks go red and exit 1, checked by breaking each in
  turn — `SDKROOT` flipped to watchos, and the group removed from the host
  entitlements.
- `expo config --type introspect` resolves all three `appExtensions` with the
  right bundle ids and the phone's own entitlements with the group.

Unverified until a prebuild and a real device build — and the honest list is
longer than the verified one, because none of this has been through a compiler
that links:

- that the widget **compiles and links** as a real iOS app extension inside the
  host, and that CocoaPods' `post_integrate` re-graft leaves it intact. The
  synthetic project proves the pbxproj surgery, not the build.
- that EAS mints a profile carrying App Groups for `com.bitspur.drover.widget`,
  and that the phone app's own profile carries it too — the phone has never
  needed it before, so this is a NEW capability on the main app's profile and
  the first archive is where that shows.
- that the phone's write is actually readable from the extension's process.
- that `reloadAllTimelines()` from the background push lands inside the push's
  seconds-long budget.
- that the 44pt count and a two-line title fit `.systemSmall` at the largest
  Dynamic Type setting.
- the real hit rate of the gate push, and whether the 30-minute floor is right.
  Both need a week of living with it.
- that `.systemSmall` on iOS 18's tinted Home Screen keeps enough hue to tell
  amber from green. Still the risk most likely to change the design: if tinted
  mode flattens the palette the way the Lock Screen does, the
  monochrome-vocabulary problem arrives here too.

Nothing above can ship as an OTA. `publishWidgetFace` is a new native function
and the widget is a new target, so this needs a prebuild, an archive and a
TestFlight build — and the runtime version must be bumped past 22 on that
build, by the same rule the voice lane's pod followed, or an OTA carrying
`droverWidgetPublish.ts` reaches a binary that has no such function. It
degrades rather than crashes there (`writeDroverWidgetFace` returns false on a
module without the function), but the bump is the rule.
