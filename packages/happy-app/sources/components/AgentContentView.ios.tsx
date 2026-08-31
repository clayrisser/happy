import { useHeaderHeight } from '@/utils/responsive';
import * as React from 'react';
import { LayoutChangeEvent, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import {
    DOCK_SCRIM_FADE_HEIGHT,
    resolveDockBottomOffset,
    resolveDockInset,
    resolveDockScrimHeight,
    transparentOf,
} from './agentDockLayout';
import { useKeyboardHandler, useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUnistyles } from 'react-native-unistyles';

interface AgentContentViewProps {
    input?: React.ReactNode | null;
    content?: React.ReactNode | null;
    placeholder?: React.ReactNode | null;
    /** Keep the composer as an overlay while the chat scrolls beneath it. */
    floatingDock?: boolean;
    /** Measured visual inset that the inverted chat list reserves at its bottom. */
    onDockInsetChange?: (inset: number) => void;
}

export const AgentContentView: React.FC<AgentContentViewProps> = React.memo(({
    input,
    content,
    placeholder,
    floatingDock = false,
    onDockInsetChange,
}) => {
    const { theme } = useUnistyles();
    const safeArea = useSafeAreaInsets();
    const height = useReanimatedKeyboardAnimation();
    const headerHeight = useHeaderHeight();
    const animatedPadding = useSharedValue(0);
    const [dockHeight, setDockHeight] = React.useState(0);

    const handleDockLayout = React.useCallback((event: LayoutChangeEvent) => {
        const nextHeight = Math.ceil(event.nativeEvent.layout.height);
        setDockHeight((currentHeight) => (
            Math.abs(currentHeight - nextHeight) < 1 ? currentHeight : nextHeight
        ));
    }, []);

    // The dock's frame sits this far above the screen edge. In floating mode
    // AgentInput's own 8pt container padding under the status row counts
    // toward the home indicator clearance instead of stacking on top of it,
    // which is the empty band in DROVE-113. Everything that animates with the
    // keyboard uses this same number, so a dock at `bottom: B` translated by
    // `-keyboardHeight + B * progress` lands exactly on the keyboard.
    const dockBottomOffset = resolveDockBottomOffset(safeArea.bottom, floatingDock);
    const dockScrimHeight = resolveDockScrimHeight(dockHeight, safeArea.bottom);
    // The chat's own background. Opaque, so scrolled messages stop being
    // legible through the dock instead of showing through a 66% scrim.
    const dockSurface = theme.colors.groupped.background;

    React.useEffect(() => {
        onDockInsetChange?.(resolveDockInset({ dockHeight, safeAreaBottom: safeArea.bottom, floatingDock }));
    }, [dockHeight, floatingDock, onDockInsetChange, safeArea.bottom]);

    useKeyboardHandler({
        onEnd(e) {
            'worklet';
            animatedPadding.value = e.progress === 1 ? (-height.height.value - dockBottomOffset) : 0;
        },
        onStart(e) {
            'worklet';
            animatedPadding.value = 0;
        },
    },[dockBottomOffset]);
    const animatedStyle = useAnimatedStyle(() => ({
        paddingTop: animatedPadding.value,
        transform: [{ translateY: height.height.value + dockBottomOffset * height.progress.value }]
    }), [dockBottomOffset]);
    const animatedInputStyle = useAnimatedStyle(() => ({
        transform: [{ translateY: height.height.value + dockBottomOffset * height.progress.value }]
    }), [dockBottomOffset]);
    const animatePlaceholderdStyle = useAnimatedStyle(() => ({
        paddingTop: height.progress.value === 1 ? height.height.value : 0,
        transform: [{ translateY: (height.height.value  + dockBottomOffset * height.progress.value) / 2 }]
    }), [dockBottomOffset]);

    if (floatingDock) {
        return (
            <View style={{ flexBasis: 0, flexGrow: 1 }}>
                {content && (
                    <Animated.View style={[{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }, animatedStyle]}>
                        {content}
                    </Animated.View>
                )}
                {placeholder && (
                    <Animated.ScrollView
                        style={[
                            {
                                position: 'absolute',
                                top: safeArea.top + headerHeight,
                                left: 0,
                                right: 0,
                                bottom: dockHeight + dockBottomOffset,
                            },
                            animatePlaceholderdStyle,
                        ]}
                        contentContainerStyle={{ alignItems: 'center', justifyContent: 'center', flex: 1 }}
                        keyboardShouldPersistTaps="handled"
                        alwaysBounceVertical={false}
                    >
                        {placeholder}
                    </Animated.ScrollView>
                )}
                {/* Opaque, not a scrim (DROVE-113). The old gradient topped
                    out at 66% so chat text stayed legible under the status
                    row and the strip below it. This fades in over the top
                    28pt and is the chat's own surface from there down, past
                    the dock and through the home indicator gap. It is a
                    sibling BELOW the dock's zIndex, so the DROVE-88 gate
                    overlay, which is a child of the dock at bottom: '100%',
                    still paints above it and is not clipped. */}
                {dockScrimHeight > 0 && (
                    <Animated.View
                        pointerEvents="none"
                        style={[
                            {
                                position: 'absolute',
                                left: 0,
                                right: 0,
                                bottom: 0,
                                height: dockScrimHeight,
                                zIndex: 1,
                            },
                            animatedInputStyle,
                        ]}
                    >
                        <LinearGradient
                            colors={[transparentOf(dockSurface), dockSurface]}
                            locations={[0, 1]}
                            start={{ x: 0.5, y: 0 }}
                            end={{ x: 0.5, y: 1 }}
                            style={{ height: DOCK_SCRIM_FADE_HEIGHT }}
                        />
                        <View style={{ flex: 1, backgroundColor: dockSurface }} />
                    </Animated.View>
                )}
                <Animated.View
                    onLayout={handleDockLayout}
                    pointerEvents="box-none"
                    style={[
                        {
                            position: 'absolute',
                            left: 0,
                            right: 0,
                            bottom: dockBottomOffset,
                            zIndex: 2,
                        },
                        animatedInputStyle,
                    ]}
                >
                    {input}
                </Animated.View>
            </View>
        );
    }

    return (
        <View style={{ flexBasis:0, flexGrow:1 }}>
            <View style={{ flexBasis:0, flexGrow:1 }}>
                {content && (
                    <Animated.View style={[{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }, animatedStyle]}>
                        {content}
                    </Animated.View>
                )}
                {placeholder && (
                    <Animated.ScrollView 
                        style={[{ position: 'absolute', top: safeArea.top + headerHeight, left: 0, right: 0, bottom: 0 }, animatePlaceholderdStyle]}
                        contentContainerStyle={{ alignItems: 'center', justifyContent: 'center', flex: 1 }}
                        keyboardShouldPersistTaps="handled"
                        alwaysBounceVertical={false}
                    >
                        {placeholder}
                    </Animated.ScrollView>
                )}
            </View>
            <Animated.View style={[animatedInputStyle]}>
                {input}
            </Animated.View>
        </View>
    );
});

// const FallbackKeyboardAvoidingView: React.FC<AgentContentViewProps> = React.memo(({
//     children,
// }) => {
    
// });
