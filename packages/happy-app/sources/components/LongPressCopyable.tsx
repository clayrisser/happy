import * as React from 'react';
import { Platform, type StyleProp, type ViewStyle } from 'react-native';

export interface LongPressCopyableProps {
    children: React.ReactNode;
    /**
     * The caller's own layout, and on iOS the only place the fill-versus-hug
     * decision is made. It rides INSIDE the SwiftUI host, which stretches
     * unconditionally: a `measured` host has a real width from RN style and
     * the content hugs its own width within it (Rule 3, `nativeControls.ts`).
     *
     * There was a `fill` prop here for the opposite arrangement — a host that
     * sized itself to its content and so could not resolve a percentage width.
     * `RNHostView` removed the reason for it (DROVE-154).
     */
    style?: StyleProp<ViewStyle>;
    text: string;
}

// iOS raises the real UIKit context menu at the finger. Android has no
// context-menu primitive in @expo/ui, so it keeps the anchored menu; web keeps
// plain mouse selection.
const LongPressCopyableImpl = Platform.select<React.ComponentType<LongPressCopyableProps>>({
    ios: require('./LongPressCopyable.ios').LongPressCopyable,
    android: require('./LongPressCopyable.android').LongPressCopyable,
    default: require('./LongPressCopyable.web').LongPressCopyable,
}) ?? require('./LongPressCopyable.web').LongPressCopyable;

/**
 * Hold a block of content to raise its actions. Copy is the item it has today;
 * "Select text" opens the same reader the markdown long press used to.
 */
export function LongPressCopyable(props: LongPressCopyableProps) {
    return <LongPressCopyableImpl {...props} />;
}
