/**
 * The sheet everything on the status row slides up into (DROVE-117, DROVE-111).
 *
 * Clay, having asked for the quota popup to become a sheet: "just like agents
 * should show in a sheet, right?" So the quota and the agent tree are the same
 * sheet, not two that merely look alike. This is DROVE-117's chrome with the
 * content lifted out of it: an AnimatedClickAwayBackdrop plus a FloatingOverlay
 * anchored above the composer, which is what DROVE-72's channel sheet and
 * DROVE-83's session sheet are built from, rather than a second mechanism.
 * Dismiss by tapping outside, or by dragging the grabber down with the same
 * gesture and thresholds as the gate overlay.
 *
 * Anchored at `bottom: '100%'` of whatever mounts it, so it adds no measured
 * height to the dock. Anything that expands off the status row goes through
 * here; a caller that draws its own backdrop is a bug, not a variant.
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
import { swipeDismisses } from './sessionGateDeck';

/**
 * Tall enough for the current account's three windows plus five accounts at
 * 20pt a row, or for a dozen agents, and short enough that the transcript is
 * still there behind it. Past that the content scrolls, which is the point: a
 * sixth account or a thirteenth agent is reachable instead of pushing the
 * sheet off the top of the screen.
 */
export const COMPOSER_SHEET_MAX_HEIGHT = 320;

/** How far the sheet slides on its way out when the drag wins. */
const dismissTravel = 260;

export function ComposerAnchoredSheet(props: {
    open: boolean;
    onClose: () => void;
    children: React.ReactNode;
    maxHeight?: number;
    /** Side inset, matching the composer's other sheets. */
    horizontalInset?: number;
    /** A sheet with switches in it must not lose the first tap to the keyboard. */
    keyboardShouldPersistTaps?: 'always' | 'never' | 'handled';
}) {
    const { theme } = useUnistyles();
    const dragY = useSharedValue(0);
    const onClose = props.onClose;

    React.useEffect(() => {
        // A reopened sheet starts at rest, whatever the last drag left behind.
        if (props.open) dragY.value = 0;
    }, [dragY, props.open]);

    // Only the grabber drags. The body is a scroll view holding a list, and a
    // pan over the whole sheet would eat its vertical touches.
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
                        maxHeight={props.maxHeight ?? COMPOSER_SHEET_MAX_HEIGHT}
                        showScrollIndicator
                        keyboardShouldPersistTaps={props.keyboardShouldPersistTaps}
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
                        {props.children}
                        <View style={{ height: 6 }} />
                    </FloatingOverlay>
                </Animated.View>
            </View>
        </>
    );
}
