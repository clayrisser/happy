import * as React from 'react';
import { Platform, type StyleProp, type ViewStyle } from 'react-native';

export interface LongPressCopyableProps {
    children: React.ReactNode;
    /**
     * The content fills its row (an agent turn) rather than hugging its own
     * width (a user bubble). SwiftUI has to be told which: a hosted view that
     * sizes itself to its content cannot also resolve a percentage width.
     */
    fill?: boolean;
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
