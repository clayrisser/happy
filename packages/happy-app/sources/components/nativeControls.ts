/**
 * WHERE THIS APP USES A PLATFORM CONTROL AND WHERE IT DRAWS ITS OWN (DROVE-134).
 *
 * Clay: "why are those buttons not using native iOS buttons while other places
 * are? We should be using native iOS buttons and inputs and stuff where
 * possible." And, setting the ceiling: "you can still use React Native
 * components I assume, this doesn't need to support web, it just needs to be
 * native."
 *
 * Read the rules. `nativeControls.test.ts` beside this file enforces the ones
 * that can be enforced, so an entry here that stops matching the code fails
 * the suite rather than quietly becoming a lie.
 *
 * ---------------------------------------------------------------------------
 * RULE 0. React Native's own primitives ARE platform controls. Reach for them
 * first.
 *
 * This is the correction that shrinks the whole question. `Switch` is
 * `UISwitch`. `TextInput` is `UITextField`. `Alert.alert` is
 * `UIAlertController`. `@react-native-community/slider` is `UISlider`.
 * `RefreshControl` is `UIRefreshControl`. All of those are already in the app
 * and all of them are already native. "Native" does not mean "@expo/ui" and it
 * does not mean SwiftUI.
 *
 * So the gap Clay was pointing at was never the controls. It was two things:
 * MENUS, which RN has no primitive for, and CHROME, the surfaces we draw
 * around controls. Rules 1 and 2.
 *
 * ---------------------------------------------------------------------------
 * RULE 1. A list of labelled choices is a native menu. Anything that is not a
 * list of labels is not.
 *
 * `NativeSettingsMenu` and `NativeOptionsPicker` are SwiftUI `Menu` on iOS and
 * Compose `DropdownMenu` on Android. Use them for a picker, an action list, an
 * overflow menu.
 *
 * The limit is hard and it is the oldest finding here: `NativeSettingsMenuOption`
 * is `{ key, label, disabled?, systemImage? }`. `label` is a `string`. A native
 * menu row holds a sentence and an SF Symbol and nothing else: no bar, no
 * per-row colour, no layout. DROVE-107 tried to put the account quota bars in
 * one and had to leave for a custom sheet. Do not widen this type to take a
 * `ReactNode`; the platform will not render it. If the row needs to be drawn,
 * the whole surface is a sheet, not a menu.
 *
 * ---------------------------------------------------------------------------
 * RULE 2. For the material, reach for `GlassView`. Keep the gesture in React
 * Native. Never reach for a SwiftUI button to get a material.
 *
 * DROVE-133 converted two icon-only header controls to a SwiftUI `Button` with
 * `.glass` and stopped there, because a SwiftUI `Button` renders SwiftUI
 * children only, so the title pill and the avatar could not follow. That
 * reading conflated the BUTTON with the MATERIAL and it was wrong.
 *
 * `GlassView` from `expo-glass-effect` is an `ExpoView` whose
 * `mountChildComponentView` inserts each child into a
 * `UIVisualEffectView.contentView` carrying a `UIGlassEffect`. Ordinary RN
 * views mount inside the real material. DROVE-153 put a two-line pill, a
 * generated avatar with a badge, an SVG effort meter and several `Pressable`s
 * inside it without touching SwiftUI.
 *
 * The practical form of the rule: `GlassChromeSurface` / `GlassChromeButton`
 * in `GlassChromeControl.tsx`, one implementation for the whole app. A second
 * glass implementation in the same header drew a visibly different surface
 * from its neighbours, which was half of what Clay was complaining about.
 *
 * `NativeGlassIconButton` was the SwiftUI-button attempt. It is deleted rather
 * than kept as a monument, because dead code with a long comment is what gets
 * reused. This paragraph is the record.
 *
 * ---------------------------------------------------------------------------
 * RULE 3. A `Host` cannot see React Native children. Give it an explicit
 * frame, lay it over RN content, or wrap the children in `RNHostView`.
 *
 * A bare RN view inside a `Host` is wrapped in `ExpoSwiftUI.UIViewHost`, a
 * `UIViewRepresentable` with no `sizeThatFits` and no bounds observer, and
 * `UIViewRepresentable` stamps a resizing mask on it. So SwiftUI sizes the
 * child from its own proposal and the child's Yoga height never travels back
 * up. `matchContents` reports what `onGeometryChange` saw, which is the
 * SwiftUI tree's size, which the RN child contributed nothing to. It is not
 * measuring the body short. It is not measuring the body.
 *
 * The same wrapper also gets no `RCTSurfaceTouchHandler`, so touches inside a
 * bare RN child of a `Host` are dead. Two failures, one cause, and only the
 * first one is visible in a screenshot.
 *
 * Four modes, and the first three are what is in this tree:
 *
 *   overlay   `<Host style={StyleSheet.absoluteFillObject}>` as a sibling of
 *             the RN content inside an RN parent that sizes itself. RN owns
 *             the frame, SwiftUI owns the gesture and the menu, and there is
 *             nothing to measure. Shipping in `NativeSettingsMenu.ios.tsx` and
 *             `NativeOptionsPicker.ios.tsx`.
 *
 *   fixed     `<Host style={{ width, height }}>` around SwiftUI-only content.
 *             Correct by construction.
 *
 *   bare      `<Host matchContents>` straight around RN children. THE TRAP,
 *             and the reason DROVE-154 clipped long messages mid-sentence.
 *             Never ship this. Both sites in the tree are casualties: one
 *             parked, one never wired up.
 *
 *   measured  `<Host matchContents={{ vertical: true }}>` with the RN children
 *             inside `<RNHostView matchContents>`. `RNHostView` is the one
 *             component in the package that KVOs the RN child's `bounds` and
 *             applies it as a SwiftUI `.frame`, which is what closes the loop
 *             back to `setStyleSize` and Yoga. It also attaches the touch
 *             handler. Untried in this app; it is the fix for the parked file
 *             below.
 *
 * Two constraints on `measured`, both load-bearing. Match only the VERTICAL
 * axis: horizontal `matchContents` pins the host's style width from its
 * content while the child's width comes down from that same node, which is a
 * feedback loop that collapses to zero. And give the `Host` a real width from
 * RN style, `flex: 1` or explicit, or the child has nothing to lay out
 * against.
 *
 * `overlay` remains the first choice, because it has no measurement in it at
 * all. Its cost is the lift: what iOS lifts is the SwiftUI trigger, and in
 * `overlay` the trigger is transparent.
 *
 * ---------------------------------------------------------------------------
 * RULE 4. When a native menu morphs its trigger, the trigger has to be SwiftUI.
 *
 * The counterweight to Rule 2, and the reason it says "for the material"
 * rather than "always". iOS morphs a `Menu`'s trigger into the open menu and
 * lenses whatever sits beneath it, so an RN chip under an invisible trigger is
 * visibly distorted on every open and close. `NativeSettingsMenu`'s
 * `triggerLabel` / `triggerSystemImage` draw the chip in SwiftUI for exactly
 * this, and the RN child is kept for layout and hidden.
 *
 * The distinction: mounting RN content inside a material is fine, because the
 * material does not transform its contents. Mounting RN content under a
 * control the system ANIMATES is not.
 *
 * ---------------------------------------------------------------------------
 * RULE 5. Do not hand-write the platform's press response.
 *
 * `getNativeGlassInteractivity()` hard-returned `false` for months, so
 * `UIGlassEffect.isInteractive` was never set and the material was drawn
 * static. Three imitations grew in its place: a `withSpring` scale in
 * `MobileGlassSurface`, another in `BubblePressable`, and an `opacity: 0.6`
 * pressed style on `GlassChromeButton`. All three are worse than the real
 * thing, and the scale is worst: a `GlassView` under a transform renders as a
 * refractive blob rather than a control reacting.
 *
 * Ask for `isInteractive` on the surface. `isInteractive` is a property of the
 * EFFECT, not a responder claim, so the RN `Pressable` still dispatches the
 * tap and only the drawing changes hands. Keep a pressed style ONLY on the
 * fallback branch, where there is no platform response to suppress:
 * `useNativeGlassPress()` is how a control asks which branch it is on.
 *
 * ---------------------------------------------------------------------------
 * RULE 6. The material settings are settled. Do not re-derive them.
 *
 *   - `MobileGlassSurface material="liquid"` is the only variant that reaches
 *     `UIGlassEffect`. `static` and `frosted` are `expo-blur` with a flat
 *     colour painted over, and a blur of a black chat is black.
 *   - `glassEffectStyle` is `regular`, never `clear`. `clear` is the
 *     barely-there material Apple uses over photography; over black it draws
 *     close to nothing, which reads as the same flat complaint.
 *   - Force `colorScheme` to the app theme. Left on `auto` a light diff
 *     scrolling behind a dark composer flips the fill out from under a white
 *     glyph.
 *   - Every material has a fallback, gated on `isGlassEffectAPIAvailable()`,
 *     and the fallback is a VISIBLE flat surface. A control that degrades to
 *     nothing over a chat is worse than one that never looked like glass.
 *     Reduce Transparency takes the fallback too, because Apple's own controls
 *     do.
 *
 * The arithmetic behind all four is in `glassChrome.ts`, and which surface got
 * which is in `glassChromeScreens.ts`.
 *
 * ---------------------------------------------------------------------------
 * RULE 7. Every platform file has a sibling `Foo.tsx`, and the non-iOS path is
 * a real implementation rather than a stub.
 *
 * Metro resolves `Foo.ios.tsx` over `Foo.tsx` on its own. What it does not do
 * is help `tsc` or vitest, which see only `Foo.tsx`, so an orphan platform
 * file is code nothing type-checks and nothing tests.
 *
 * Two shapes, both correct, and which one you want depends on how different
 * the platforms are:
 *
 *   dispatcher  `Foo.tsx` is a `Platform.select` over `Foo.ios`, `Foo.android`
 *               and `Foo.web`, each a real file. Use it when there are three
 *               genuinely different implementations and when tests need to
 *               import one directly and mock `@expo/ui/swift-ui` under it.
 *               `NativeSettingsMenu`, `NativeOptionsPicker`, `LongPressCopyable`.
 *
 *   override    `Foo.tsx` IS the implementation for everything else, and
 *               `Foo.ios.tsx` overrides it. Use it when one platform needs a
 *               variation rather than a different component.
 *               `AgentContentView`.
 *
 * Web is not a constraint on the design ("this doesn't need to support web"),
 * but under either shape it still has to render something.
 *
 * ---------------------------------------------------------------------------
 * RULE 8. Android has no context-menu primitive. Say so instead of faking one.
 *
 * `@expo/ui/jetpack-compose` exports `DropdownMenu`, which opens on a tap of
 * its trigger, so it cannot stand in for a hold menu over content that is
 * itself tappable. Android keeps the hand-drawn anchored menu, and any lane
 * that makes an iOS interaction native has to say what Android gets.
 *
 * ---------------------------------------------------------------------------
 * WHAT `@expo/ui` HAS THAT THIS APP DOES NOT USE YET.
 *
 * Not a backlog, a list of the swaps that would be honest ones under the rules
 * above: `ConfirmationDialog`, `ShareLink`, `ContentUnavailableView` for empty
 * states, `BottomSheet` alongside the DROVE-147 sheets. All four are
 * label-and-symbol surfaces, so Rule 1 does not stop them. `List` and `Form`
 * are not: our rows draw. `Picker` is both: in its menu and wheel styles it
 * would draw rows, and stays out; in its SEGMENTED style it is a row of
 * labels, which is `UISegmentedControl`, and DROVE-330 uses exactly that for
 * the tabs inside a sheet (`SheetTabs.ios.tsx`).
 *
 * One cost is unmeasured and should be measured before anything hosts SwiftUI
 * per row: a `Host` on every message in the transcript is the first place
 * hosting overhead would show up as scroll jank.
 */

/** How a `Host` from `@expo/ui/swift-ui` is mounted. See Rule 3. */
export type SwiftUiHostMode = 'overlay' | 'fixed' | 'bare' | 'measured';

export interface SwiftUiHostSite {
    /** Path under `sources/`. */
    source: string;
    mode: SwiftUiHostMode;
    /** Required on `bare`, the mode that measures nothing. */
    reason?: string;
}

/**
 * Every `<Host>` in the tree. The test fails on a file that mounts one and is
 * not here, and on an entry whose file no longer mounts one.
 *
 * The one `bare` entry is unimported, which is the cheapest statement of Rule
 * 3 available: the mode has never once shipped.
 */
export const swiftUiHostSites: readonly SwiftUiHostSite[] = [
    {
        source: 'components/NativeSettingsMenu.ios.tsx',
        mode: 'overlay',
    },
    {
        source: 'components/NativeOptionsPicker.ios.tsx',
        mode: 'overlay',
    },
    {
        // A segmented Picker at an explicit height from worktreeSheetLayout,
        // SwiftUI children only. The first `fixed` site in the tree (DROVE-330).
        source: 'components/SheetTabs.ios.tsx',
        mode: 'fixed',
    },
    {
        source: 'components/SessionActionsNativeMenu.ios.tsx',
        mode: 'bare',
        reason: 'Written by an earlier lane and never imported by anything. The DROVE-154 failure is waiting in it twice over: a session row taller than the host measures would clip, and every tap target inside the row is inert for want of a touch handler. Give it `RNHostView` or make it an overlay before importing it.',
    },
];

/**
 * `bare` is the mode that must never reach a screen. A file may mount one only
 * while nothing imports it, which is what makes the exemption self-clearing:
 * wiring it up fails the suite.
 */
export const bannedHostMode: SwiftUiHostMode = 'bare';

/**
 * The one component allowed to construct `GlassView` outside the primitives,
 * and why. Everything else goes through `GlassChromeSurface` /
 * `GlassChromeButton` or `MobileGlassSurface`, which is what keeps Rule 6 in
 * one place.
 */
export interface RawGlassViewExemption {
    source: string;
    reason: string;
}

export const glassViewPrimitives = [
    'components/GlassChromeControl.tsx',
    'components/MobileGlass.tsx',
] as const;

export const rawGlassViewExemptions: readonly RawGlassViewExemption[] = [
    {
        source: 'app/(app)/new/index.tsx',
        reason: 'The new-session path picker\'s Done button, written before the primitives existed and left alone by DROVE-153, which scoped itself to the session chrome. It breaks Rule 6 twice: no `colorScheme`, so it flips with the system rather than the theme, and a hardcoded `rgba(255,255,255,0.10)` tint, which is the dark-theme value painted on both. Converting it to GlassChromeButton is a small change that wants a device to check.',
    },
];

/**
 * Files that may import from `@expo/ui/swift-ui`, and what they build with it.
 *
 * `menu` was the only justified use until DROVE-330 added `segmented`: SwiftUI
 * `Button` exists in this app as a MENU ITEM, never as a standalone control,
 * because a standalone SwiftUI button cannot hold our content (Rule 2) and
 * draws a second, different glass surface next to the primitives. A segmented
 * `Picker` is a row of labels, which is the one shape Rule 1 lets SwiftUI own.
 */
export type SwiftUiUse = 'menu' | 'context-menu' | 'segmented';

export interface SwiftUiImporter {
    source: string;
    use: SwiftUiUse;
}

export const swiftUiImporters: readonly SwiftUiImporter[] = [
    { source: 'components/NativeSettingsMenu.ios.tsx', use: 'menu' },
    { source: 'components/NativeOptionsPicker.ios.tsx', use: 'menu' },
    { source: 'components/SessionActionsNativeMenu.ios.tsx', use: 'context-menu' },
    { source: 'components/SheetTabs.ios.tsx', use: 'segmented' },
];

/**
 * What each class of interactive control in the app is drawn by, and what it
 * would gain or lose by moving.
 *
 * Classes rather than instances, on purpose. An inventory of every button in
 * the app is stale the day after it is written; an inventory of the KINDS is
 * the thing a rule can be applied to, and it fails usefully when a new kind
 * appears without anyone deciding where it belongs.
 */
export type ControlDrawnBy =
    /** A React Native primitive that is already the platform's control. */
    | 'rn-platform'
    /** `@expo/ui` SwiftUI or Compose. */
    | 'expo-ui'
    /** React Native gesture and content inside a real `UIGlassEffect`. */
    | 'rn-in-material'
    /** Drawn by us, no platform control underneath. */
    | 'custom';

export interface ControlClass {
    name: string;
    drawnBy: ControlDrawnBy;
    /** Where the pattern lives. */
    source: string;
    /** Required on `custom`: what it would gain or lose by converting. */
    verdict?: string;
}

export const controlClasses: readonly ControlClass[] = [
    {
        name: 'switches',
        drawnBy: 'rn-platform',
        source: 'components/Switch.tsx',
        verdict: 'React Native\'s Switch IS UISwitch. Already native, only themed.',
    },
    {
        name: 'text fields',
        drawnBy: 'rn-platform',
        source: 'components/MultiTextInput.tsx',
        verdict: 'TextInput is UITextField. Dictation, selection and the keyboard bar come free.',
    },
    {
        name: 'alerts and confirmations',
        drawnBy: 'rn-platform',
        source: 'modal/ModalManager.ts',
        verdict: 'Alert.alert is UIAlertController on native; the drawn one is the web branch only. @expo/ui ConfirmationDialog would add a tinted destructive style and nothing else.',
    },
    {
        name: 'sliders',
        drawnBy: 'rn-platform',
        source: 'components/AudioCueSettings.tsx',
        verdict: '@react-native-community/slider is UISlider.',
    },
    {
        name: 'pickers and settings menus',
        drawnBy: 'expo-ui',
        source: 'components/NativeSettingsMenu.tsx',
        verdict: 'SwiftUI Menu / Compose DropdownMenu. Rule 1 is its ceiling: rows are labels.',
    },
    {
        name: 'tabs inside a sheet',
        drawnBy: 'expo-ui',
        source: 'components/SheetTabs.tsx',
        verdict: 'SwiftUI Picker in the segmented style is UISegmentedControl with the iOS 26 glass, in a fixed-height Host (Rule 3). Labels only, so Rule 1 holds. Android and web get an RN-drawn sibling at the same height.',
    },
    {
        name: 'session row actions',
        drawnBy: 'expo-ui',
        source: 'components/SessionActionsNativeMenu.tsx',
        verdict: 'Built, never imported, and mounted in the `bare` mode Rule 3 bans. Not shipping as it stands.',
    },
    {
        name: 'chrome icon buttons: header back, avatar, title pill, jump-to-bottom, FAB, voice pill',
        drawnBy: 'rn-in-material',
        source: 'components/GlassChromeControl.tsx',
        verdict: 'The right shape under Rule 2. A SwiftUI button would be native and could not hold the pill or the avatar.',
    },
    {
        name: 'composer icon buttons',
        drawnBy: 'rn-in-material',
        source: 'components/AgentInput.tsx',
        verdict: 'Same as the chrome. The two tinted ones carry meaning and keep their tint on the material as UIGlassEffect.tintColor.',
    },
    {
        name: 'message long press',
        drawnBy: 'custom',
        source: 'components/LongPressCopyable.tsx',
        verdict: 'Would gain the anchored menu, the lift, the haptic and system dismissal. Parked on the `bare` host clipping long bodies; `RNHostView` is the fix and it is three lines. See the verdict below.',
    },
    {
        name: 'sheets',
        drawnBy: 'custom',
        source: 'components/ComposerSheet.tsx',
        verdict: 'RN Modal on a liquid MobileGlassSurface. @expo/ui BottomSheet would bring the system detents and drag; it would also take the content into a host, so Rule 3 applies and the content is ours to draw.',
    },
    {
        name: 'empty states',
        drawnBy: 'custom',
        source: 'components/EmptyMainScreen.tsx',
        verdict: 'ContentUnavailableView is a label, a symbol and a description, which is exactly what these are. The cheapest honest swap left.',
    },
    {
        name: 'list rows and cards',
        drawnBy: 'custom',
        source: 'components/Item.tsx',
        verdict: 'Stays custom. Rows draw: bars, badges, per-row colour, two-line layouts. SwiftUI List would take all of that away for a separator style.',
    },
];

/**
 * VERDICT ON `LongPressCopyable.ios.tsx.native` (DROVE-154, asked on DROVE-134).
 *
 * KEEP IT. The height problem is solvable, the fix is three lines, and the
 * mechanism is already compiled into the build on Clay's phone.
 *
 * DROVE-154 parked the file believing it was blocked on the host reporting the
 * body's real height. It is not blocked; it is missing a component. Bare RN
 * children in a `Host` contribute nothing to `matchContents` (Rule 3), but
 * `RNHostView` from `@expo/ui/swift-ui` exists for exactly this: it KVOs the
 * RN child's `bounds`, which is what RN's `updateLayoutMetrics` writes, and
 * applies it as a SwiftUI `.frame`. That closes the loop the parked file is
 * missing, all the way back to `setStyleSize` and a dirtied Yoga node. Every
 * hop is reactive, so an async markdown reflow propagates rather than
 * freezing a stale height.
 *
 * The change, against the file as parked:
 *
 *   -  <Host matchContents={props.fill ? { vertical: true } : true} ...>
 *   +  <Host matchContents={{ vertical: true }} style={styles.fill}>
 *        <ContextMenu>
 *          <ContextMenu.Items>...</ContextMenu.Items>
 *   -      <ContextMenu.Trigger>{props.children}</ContextMenu.Trigger>
 *   +      <ContextMenu.Trigger>
 *   +        <RNHostView matchContents>{props.children}</RNHostView>
 *   +      </ContextMenu.Trigger>
 *
 * `matchContents` goes to vertical-only on BOTH branches, not just the filling
 * one. `true` matches horizontally as well, which pins the host's style width
 * from content whose width comes down from that same node, and that loop
 * collapses to zero. The user-bubble branch wants `alignSelf: 'stretch'` and a
 * bubble that hugs its own content inside the host, not a host that hugs the
 * bubble.
 *
 * `RNHostView` also fixes a second defect nobody reported, because a clipped
 * message is louder than a dead one: a bare RN child of a `Host` gets no
 * `RCTSurfaceTouchHandler`, so every tap target inside a message under the
 * parked file was inert. `RNHostView` attaches one. Anyone re-testing the
 * parked file must check that a link and a tool card inside a message still
 * respond, not only that the body is not clipped.
 *
 * OTA. `RNHostView.swift` is registered in `ExpoUIModule.swift` in the
 * installed `@expo/ui` 55.0.5, which is the version compiled into TestFlight
 * build 12, so this needs no new build.
 *
 * TWO THINGS TO VERIFY ON DEVICE BEFORE SHIPPING IT, both unmeasured:
 *
 *   1. Scroll cost. A `Host` plus an `RNHostView` per transcript row is two
 *      hosting layers on every message, and the transcript is the one screen
 *      where that would show as jank. Nothing here has ever been profiled.
 *   2. The height under reflow, not at rest. The clip DROVE-154 saw was on a
 *      long markdown body; test with code blocks and images, which lay out
 *      late, and not only with a long paragraph.
 *
 * If either fails, the fallback is `overlay` (Rule 3): the menu at the finger
 * with no measurement anywhere, at the cost of the lift preview. That is a
 * product call for Clay rather than an engineering one. Deleting the file is
 * the wrong move either way now that the fix is known and written down.
 */
export const parkedContextMenuVerdict = 'keep' as const;
