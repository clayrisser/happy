import type * as React from 'react';
import type { StyleProp, ViewStyle } from 'react-native';

/**
 * A round, icon-only button drawn by SwiftUI rather than by hand (DROVE-133,
 * DROVE-139).
 *
 * Clay's complaint is that some controls are native and some are not, and the
 * hand-drawn ones read as artefacts: a translucent disc with chat text showing
 * through it, or two rounded shapes touching. SwiftUI's `.glass` button style
 * gives the real material, the real press response and a hit area that matches
 * what is drawn, none of which the React Native imitation gets right.
 *
 * Deliberately narrow. It replaces a control whose entire content is one SF
 * Symbol. Anything carrying React Native content — the session header's
 * generated avatar, the two-line title pill — cannot use this, because
 * `@expo/ui`'s Button only accepts SwiftUI children. That wall is the same one
 * DROVE-107 hit, and deciding the app-wide rule is DROVE-134, not this.
 *
 * SUPERSEDED, AND NOTHING USES IT (DROVE-153). Kept as the record of a wrong
 * turn worth not taking twice. The SwiftUI button really does render SwiftUI
 * children only, and the mistake was reading that as "the material cannot hold
 * React Native content". It can: `GlassView` from `expo-glass-effect` is an
 * `ExpoView` whose `mountChildComponentView` inserts children into a
 * `UIVisualEffectView.contentView`, so a two-line pill, a generated avatar and
 * a `Pressable` all mount inside the real `UIGlassEffect`. Use
 * `GlassChromeButton` / `GlassChromeSurface` in `GlassChromeControl.tsx`
 * instead; a second glass implementation in the same header drew a visibly
 * different surface from its neighbours, which was the other half of what Clay
 * was looking at.
 */
export type NativeGlassIconButtonProps = {
    /** SF Symbol name, e.g. `chevron.backward`. */
    systemImage: string;
    accessibilityLabel: string;
    onPress?: () => void;
    /** Outer size of the button; also its hit area. Defaults to 44. */
    size?: number;
    /** Point size of the symbol inside it. */
    iconSize?: number;
    tintColor?: string;
    style?: StyleProp<ViewStyle>;
};

/**
 * Whether the native button is actually better than the control it replaces.
 *
 * Below iOS 26 SwiftUI's `.glass` style silently degrades to `.automatic`,
 * which draws no surface at all, so a floating control would lose its
 * background entirely. The glass API check is the same one the rest of the
 * chrome uses to decide whether Liquid Glass exists.
 */
export function supportsNativeGlassIconButton(): boolean {
    return false;
}

export function NativeGlassIconButton(_props: NativeGlassIconButtonProps): React.ReactElement | null {
    return null;
}
