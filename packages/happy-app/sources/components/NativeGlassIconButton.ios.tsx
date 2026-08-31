import * as React from 'react';
import { isGlassEffectAPIAvailable } from 'expo-glass-effect';
import { Button, Host, Image } from '@expo/ui/swift-ui';
import {
    accessibilityLabel as accessibilityLabelModifier,
    buttonStyle,
    frame,
} from '@expo/ui/swift-ui/modifiers';
import { isRunningOnMac } from '@/utils/platform';
import type { NativeGlassIconButtonProps } from './NativeGlassIconButton';

const systemName = (name: string) => (
    name as NonNullable<React.ComponentProps<typeof Image>['systemName']>
);

// Resolved once: it asks the platform for its iOS version and cannot change
// while the app is running.
const nativeGlassAvailable = !isRunningOnMac() && isGlassEffectAPIAvailable();

/** See the shared module for why this is gated rather than always on. */
export function supportsNativeGlassIconButton(): boolean {
    return nativeGlassAvailable;
}

export function NativeGlassIconButton({
    systemImage,
    accessibilityLabel,
    onPress,
    size = 44,
    iconSize = 17,
    tintColor,
    style,
}: NativeGlassIconButtonProps): React.ReactElement | null {
    return (
        <Host style={[{ width: size, height: size }, style]}>
            <Button
                onPress={onPress}
                modifiers={[
                    // Size the button before styling it, so the glass surface
                    // fills the whole target instead of hugging the symbol and
                    // leaving a disc smaller than what can be tapped.
                    frame({ width: size, height: size }),
                    buttonStyle('glass'),
                    accessibilityLabelModifier(accessibilityLabel),
                ]}
            >
                <Image systemName={systemName(systemImage)} size={iconSize} color={tintColor} />
            </Button>
        </Host>
    );
}
