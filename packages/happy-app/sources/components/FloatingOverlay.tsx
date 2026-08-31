import * as React from 'react';
import { Platform } from 'react-native';
import Animated from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { MobileGlassSurface } from './MobileGlass';
import { AnimatedPopup, LocalBlurHalo } from './AnimatedOverlay';

const stylesheet = StyleSheet.create((theme, runtime) => ({
    container: {
        borderRadius: Platform.select({ web: 12, default: 24 }),
        overflow: 'hidden',
        backgroundColor: Platform.select({
            web: theme.colors.surface,
            ios: theme.colors.glass.overlay,
            android: theme.colors.glass.backgroundStrong,
            default: theme.colors.surface,
        }),
        borderWidth: Platform.OS === 'web' ? 0 : StyleSheet.hairlineWidth,
        borderColor: Platform.select({ web: theme.colors.modal.border, default: theme.colors.glass.border }),
        shadowColor: Platform.select({ web: theme.colors.shadow.color, default: theme.colors.glass.shadow }),
        shadowOffset: { width: 0, height: Platform.select({ web: 2, default: 16 }) },
        shadowRadius: Platform.select({ web: 3.84, default: 36 }),
        shadowOpacity: Platform.select({ web: theme.colors.shadow.opacity, default: 1 }),
        elevation: 14,
    },
}));

interface FloatingOverlayProps {
    children: React.ReactNode;
    maxHeight?: number;
    showScrollIndicator?: boolean;
    keyboardShouldPersistTaps?: boolean | 'always' | 'never' | 'handled';
    /**
     * Pinned above the scroll rather than scrolling with it (DROVE-117): the
     * quota sheet's grabber has to stay under the finger that is dragging it.
     */
    header?: React.ReactNode;
}

export const FloatingOverlay = React.memo((props: FloatingOverlayProps) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const {
        children,
        header,
        maxHeight = 240,
        showScrollIndicator = false,
        keyboardShouldPersistTaps = 'handled'
    } = props;
    // A pinned header shares the box with the scroll, so the scroll gives way
    // instead of holding its own maxHeight and pushing the header out.
    const scrollStyle = header ? { flexShrink: 1 } : { maxHeight };

    // Keep the desktop popup exactly as it was before the native glass work.
    // In particular, web does not get the local blur halo or its entry motion.
    if (Platform.OS === 'web') {
        return (
            <Animated.View style={[styles.container, { maxHeight }]}>
                {header}
                <Animated.ScrollView
                    style={scrollStyle}
                    keyboardShouldPersistTaps={keyboardShouldPersistTaps}
                    showsVerticalScrollIndicator={showScrollIndicator}
                >
                    {children}
                </Animated.ScrollView>
            </Animated.View>
        );
    }

    return (
        <AnimatedPopup style={{ maxHeight }}>
            <LocalBlurHalo borderRadius={24} />
            <MobileGlassSurface
                enabled
                nativeEffect
                intensity={88}
                glassEffectStyle="regular"
                tintColor={theme.colors.glass.overlayTint}
                style={[styles.container, { maxHeight }]}
            >
                {header}
                <Animated.ScrollView
                    style={scrollStyle}
                    keyboardShouldPersistTaps={keyboardShouldPersistTaps}
                    showsVerticalScrollIndicator={showScrollIndicator}
                >
                    {children}
                </Animated.ScrollView>
            </MobileGlassSurface>
        </AnimatedPopup>
    );
});
