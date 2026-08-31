/**
 * The quota sheet (DROVE-117).
 *
 * Clay: "and actually have it show on a sheet that slides up, right?" It also
 * settles a compromise DROVE-107 was stuck with. The quota used to be a native
 * menu, and a NativeSettingsMenuOption is a plain label string rendered by a
 * SwiftUI Button, so a menu row can hold a sentence but never a bar. That lane
 * fell back to unfolding the bars inline under the status row, which squeezed
 * a list of accounts into the composer's furniture and capped it at whatever
 * fitted. A sheet is the container this content wanted: it draws anything, it
 * scrolls on its own, and its width is known, which is what lets the columns
 * be fixed instead of fighting the composer for space.
 *
 * Built from the pieces the composer's own sheets already use - DROVE-83's
 * session sheet and DROVE-72's channel sheet are an AnimatedClickAwayBackdrop
 * plus a FloatingOverlay anchored above the composer - rather than a second
 * sheet mechanism. Dismiss by tapping outside, like those, and by dragging the
 * grabber down, the same gesture and the same thresholds as the gate overlay.
 */
import * as React from 'react';
import { View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
    runOnJS,
    useAnimatedStyle,
    useSharedValue,
    withSpring,
    withTiming,
} from 'react-native-reanimated';
import { useUnistyles } from 'react-native-unistyles';
import { AnimatedClickAwayBackdrop } from './AnimatedOverlay';
import { FloatingOverlay } from './FloatingOverlay';
import { UsageAccountBars } from './UsageAccountBars';
import { swipeDismisses } from './sessionGateDeck';
import type { UsageBarGroup } from './agentInputUsage';

/**
 * Tall enough for the current account's three windows plus five accounts at
 * 20pt a row, short enough that the transcript is still there behind it. Past
 * that the list scrolls, which is the point: a sixth account is reachable
 * instead of pushing the sheet off the top of the screen.
 */
const sheetMaxHeight = 320;

/** How far the sheet slides on its way out when the drag wins. */
const dismissTravel = 260;

export function UsageAccountBarsSheet(props: {
    groups: UsageBarGroup[];
    open: boolean;
    onClose: () => void;
    /** Side inset, matching the composer's other sheets. */
    horizontalInset?: number;
}) {
    const { theme } = useUnistyles();
    const dragY = useSharedValue(0);
    const onClose = props.onClose;

    React.useEffect(() => {
        // A reopened sheet starts at rest, whatever the last drag left behind.
        if (props.open) dragY.value = 0;
    }, [dragY, props.open]);

    // Only the grabber drags. The body is a scroll view holding the account
    // list, and a pan over the whole sheet would eat its vertical touches.
    const drag = React.useMemo(() => Gesture.Pan()
        .activeOffsetY([-12, 12])
        .failOffsetX([-16, 16])
        .onUpdate((event) => {
            dragY.value = Math.max(0, event.translationY);
        })
        .onEnd((event) => {
            if (swipeDismisses(event.translationY, event.velocityY)) {
                dragY.value = withTiming(dismissTravel, { duration: 160 }, (finished) => {
                    if (finished) runOnJS(onClose)();
                });
            } else {
                dragY.value = withSpring(0, { damping: 22, stiffness: 240 });
            }
        }), [dragY, onClose]);

    const sheetStyle = useAnimatedStyle(() => ({
        transform: [{ translateY: dragY.value }],
        opacity: 1 - Math.min(1, dragY.value / dismissTravel) * 0.6,
    }));

    if (!props.open) return null;

    const inset = props.horizontalInset ?? 16;
    return (
        <>
            <AnimatedClickAwayBackdrop
                onPress={onClose}
                style={{
                    position: 'absolute',
                    top: -1000,
                    left: -1000,
                    right: -1000,
                    bottom: -1000,
                    zIndex: 999,
                }}
            />
            <View
                style={{
                    position: 'absolute',
                    bottom: '100%',
                    left: 0,
                    right: 0,
                    marginBottom: 8,
                    paddingHorizontal: inset,
                    zIndex: 1000,
                }}
            >
                <Animated.View style={sheetStyle}>
                    <FloatingOverlay
                        maxHeight={sheetMaxHeight}
                        showScrollIndicator
                        header={(
                            <GestureDetector gesture={drag}>
                                {/* Unlabelled, like the gate overlay's: the
                                    sheet is dismissed by tapping outside for
                                    anyone not dragging it. */}
                                <View style={{ paddingTop: 8, paddingBottom: 2 }}>
                                    <View style={{
                                        alignSelf: 'center',
                                        width: 36,
                                        height: 4,
                                        borderRadius: 2,
                                        backgroundColor: theme.colors.divider,
                                    }} />
                                </View>
                            </GestureDetector>
                        )}
                    >
                        <UsageAccountBars groups={props.groups} />
                        <View style={{ height: 6 }} />
                    </FloatingOverlay>
                </Animated.View>
            </View>
        </>
    );
}
