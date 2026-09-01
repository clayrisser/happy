/**
 * The chrome DROVE-153 did not reach, and what keeps it reached (DROVE-161).
 *
 * Clay, with the session header and the agent header side by side: "See how
 * some places are using Liquid Glass and others aren't". DROVE-153 converted
 * the session screen and built the primitives; everything else was still on
 * the flat path, so a back button was a grey disc and a title was bare text.
 *
 * TWO SEPARATE FAULTS, and the second is the one that made the first invisible
 * to anyone reading the code.
 *
 * 1. MATERIAL. `MobileGlassSurface material="static"` is expo-blur with a flat
 *    colour painted over it, not `UIGlassEffect`, and a blur of a black list is
 *    black. The shared navigation header had all four of its controls on it.
 *    The default `glassEffectStyle` is `clear`, the barely-there material Apple
 *    uses over photography, which over anything dark draws close to nothing;
 *    the artifacts FAB was on that.
 * 2. REACH. `(app)/_layout.tsx` gave iPhones UIKit's own navigation bar and
 *    only routed Android, Mac and web through the app's header. So the header
 *    component was not the thing being drawn on the screen Clay photographed,
 *    and converting it alone would have changed nothing. Every phone comes
 *    through it now; the iPad still gets UIKit, because the app's header hides
 *    its back button on a tablet.
 *
 * Everything here is data, so the test beside it can walk the app and fail on
 * a control that shrinks, a surface that quietly goes back to a flat material,
 * or a fallback that would leave a control invisible.
 *
 * This is the surface-by-surface walk. The RULES it applies live in
 * `nativeControls.ts` (DROVE-134), which is where a new control should start.
 */

import type { ChromeControlSize } from './glassChrome';
import { MOBILE_GLASS_CONTROL_SIZE } from './navigation/headerMetrics';

/**
 * The floating add button on the artifacts list. 56pt is Material's FAB and
 * comfortably past the 44pt floor; the radius is a squircle rather than a
 * circle, which is what it already drew.
 */
export const FAB_SIZE = 56;
export const FAB_RADIUS = 20;

/**
 * Every chrome control outside the session screen, with what it draws and what
 * it answers a touch on.
 *
 * Same shape as DROVE-153's table and checked against the same floor, so a
 * control on the settings screen cannot be smaller than the same control on
 * the session screen without the test saying so.
 */
export const screenChromeControls: readonly ChromeControlSize[] = [
    { name: 'navigation header back chevron', drawnWidth: MOBILE_GLASS_CONTROL_SIZE, drawnHeight: MOBILE_GLASS_CONTROL_SIZE, slop: 0 },
    { name: 'navigation header left slot', drawnWidth: MOBILE_GLASS_CONTROL_SIZE, drawnHeight: MOBILE_GLASS_CONTROL_SIZE, slop: 0 },
    { name: 'navigation header title pill', drawnWidth: MOBILE_GLASS_CONTROL_SIZE, drawnHeight: MOBILE_GLASS_CONTROL_SIZE, slop: 0 },
    { name: 'navigation header right slot', drawnWidth: MOBILE_GLASS_CONTROL_SIZE, drawnHeight: MOBILE_GLASS_CONTROL_SIZE, slop: 0 },
    { name: 'artifacts add button', drawnWidth: FAB_SIZE, drawnHeight: FAB_SIZE, slop: 0 },
    { name: 'voice call pill', drawnWidth: MOBILE_GLASS_CONTROL_SIZE, drawnHeight: MOBILE_GLASS_CONTROL_SIZE, slop: 0 },
];

/**
 * How a surface gets its material.
 *
 * `chrome` is `GlassChromeSurface` / `GlassChromeButton`: one object, one
 * material, one fallback, the 44pt floor. `material` is a `MobileGlassSurface`
 * already asking for `liquid` + `regular`, which reaches the same
 * `UIGlassEffect` by a longer road and is left alone. `writing` and `content`
 * are deliberately not chrome.
 */
export type ScreenChromeMaterial = 'chrome' | 'material' | 'writing' | 'content';

export interface ScreenChromeSurface {
    /** What a person would call it. */
    name: string;
    /** Path under `sources/`. */
    source: string;
    /** Does it float over content, or sit in the flow of a page? */
    floating: boolean;
    material: ScreenChromeMaterial;
    /** Required on anything not on the chrome primitive. */
    reason?: string;
}

/**
 * The walk. Every screen with a header or a floating control, and what it got.
 *
 * The header is one row because it is one component: `createHeader` /
 * `createPlainHeader` draw the bar for settings, the sessions list, session
 * info, files, the file view, the text-selection reader, artifacts, machines,
 * gates, the changelog, friends, the terminal pages, restore, the new-session
 * screen, the dev pages, and the agent screen Clay photographed. Converting it
 * once converts all of them, which is the whole reason the reach fix matters
 * more than the material fix.
 */
export const screenChromeSurfaces: readonly ScreenChromeSurface[] = [
    {
        name: 'navigation header, every screen that is not the session',
        source: 'components/navigation/Header.tsx',
        floating: true,
        material: 'chrome',
    },
    {
        name: 'artifacts add button',
        source: 'components/FAB.tsx',
        floating: true,
        material: 'chrome',
    },
    {
        name: 'voice call pill',
        source: 'components/VoiceAssistantStatusBar.tsx',
        floating: true,
        material: 'chrome',
    },
    {
        name: 'session header',
        source: 'components/ChatHeaderView.tsx',
        floating: true,
        material: 'chrome',
        reason: 'Converted by DROVE-153. This ticket is the rest of the app catching up to it.',
    },
    {
        name: 'session action popover',
        source: 'components/SessionActionsPopover.tsx',
        floating: true,
        material: 'material',
        reason: 'Already asks for liquid + regular, so it already reaches UIGlassEffect.',
    },
    {
        name: 'floating overlay, the base of the quota and picker popups',
        source: 'components/FloatingOverlay.tsx',
        floating: true,
        material: 'material',
        reason: 'Already asks for liquid + regular.',
    },
    {
        name: 'composer sheet',
        source: 'components/ComposerSheet.tsx',
        floating: true,
        material: 'material',
        reason: 'Already asks for liquid + regular. DROVE-147 built it that way.',
    },
    {
        name: 'worktree sheet',
        source: 'components/WorktreeSheet.tsx',
        floating: true,
        material: 'material',
        reason: 'Already asks for liquid + regular.',
    },
    {
        name: 'duplicate sheet',
        source: 'components/DuplicateSheet.tsx',
        floating: true,
        material: 'material',
        reason: 'Already asks for liquid + regular.',
    },
    {
        name: 'composer autocomplete',
        source: 'components/AgentInputAutocomplete.tsx',
        floating: true,
        material: 'material',
        reason: 'Already asks for liquid + regular.',
    },
    {
        name: 'files sidebar',
        source: 'components/FilesSidebar.tsx',
        floating: true,
        material: 'material',
        reason: 'Already asks for liquid + regular.',
    },
    {
        name: 'home dock picker sheet',
        source: 'components/HomeDock.tsx',
        floating: true,
        material: 'material',
        reason: 'Already asks for liquid + regular.',
    },
    {
        name: 'tab bar',
        source: 'components/TabBar.tsx',
        floating: true,
        material: 'material',
        reason: 'Left on `clear` on purpose: the bar is a clear base with a regular lens sliding over it, and the lens is only visible because the two differ. Making both regular erases the control it was built around.',
    },
    {
        name: 'home dock composer',
        source: 'components/HomeDock.tsx',
        floating: true,
        material: 'material',
        reason: 'It is the session composer now (DROVE-345): the same ComposerBubble, spreading the same COMPOSER_BUBBLE_SURFACE. The frosted exemption said content must not compete with text being typed, and DROVE-153 had already answered that for the chat — frosted paints rgba(20,20,22,0.82) over a blur, and a blur of a black screen is black, so what it bought was a flat slab rather than legibility. Legibility comes from the backdrop being masked before it reaches the card (DROVE-168).',
    },
    {
        name: 'session composer',
        source: 'components/AgentInput.tsx',
        floating: true,
        material: 'writing',
        reason: 'DROVE-153 converted its controls and DROVE-168/169/171 are on its motion and its contrast. Not this lane.',
    },
    {
        name: 'new-session composer and its send button',
        source: 'app/(app)/new/index.tsx',
        floating: true,
        material: 'writing',
        reason: 'Same writing surface as the home dock, and the send button is nested inside the input capsule the way DROVE-153\'s exempted 36pt one is. Left with the composers.',
    },
    {
        name: 'file view path bar and diff toggle',
        source: 'app/(app)/session/[id]/file.tsx',
        floating: false,
        material: 'content',
        reason: 'In the flow of the page under the header, not floating over it. Opaque by design: Liquid Glass is chrome, not a card background.',
    },
    {
        name: 'text-selection reader',
        source: 'app/(app)/text-selection.tsx',
        floating: false,
        material: 'content',
        reason: 'The reader is the page. Its header is the navigation header, which is converted.',
    },
    {
        name: 'session info card, session list cards, artifact rows, appearance preview',
        source: 'app/(app)/session/[id]/info.tsx',
        floating: false,
        material: 'content',
        reason: 'Opaque content surfaces. They render as plain views on native already, because MobileGlassSurface only reaches a material with `nativeEffect`.',
    },
    {
        name: 'files and language search fields',
        source: 'app/(app)/session/[id]/files.tsx',
        floating: false,
        material: 'writing',
        reason: 'Text fields in the flow of a list, not floating chrome.',
    },
];

/**
 * The strings that mean a surface asked for a material and did not get one.
 *
 * `material="static"` and `material="frosted"` are expo-blur with a flat colour
 * painted over, and `glassEffectStyle="clear"` is the barely-there material.
 * Scanned rather than reviewed, because the failure this ticket is fixing is
 * exactly a surface that looks converted in a diff and is not. Comment lines
 * do not count: several of these files explain the materials, and naming one
 * is not using it.
 */
export const flatChromeMarkers = [
    'material="static"',
    'material="frosted"',
    'glassEffectStyle="clear"',
] as const;

/** A component allowed to draw a flat material, and why. */
export interface FlatChromeExemption {
    /** Path under `sources/`. */
    source: string;
    reason: string;
}

/**
 * Exactly the components that still draw one. The test fails on a file missing
 * from this list AND on a line in this list that no longer draws one, so the
 * reasons cannot outlive the code they excuse.
 */
export const flatChromeExemptions: readonly FlatChromeExemption[] = [
    {
        source: 'components/ChatHeaderView.tsx',
        reason: 'Only on the branch taken when glass is off, where MobileGlassSurface returns a plain view and the material name is inert. DROVE-153 converted the branch that draws.',
    },
    {
        source: 'components/TabBar.tsx',
        reason: 'A clear base under a regular lens. The lens only reads because the two differ, so making both regular erases the control the bar was built around.',
    },
];
