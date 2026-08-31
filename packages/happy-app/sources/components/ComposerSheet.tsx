/**
 * The one sheet everything on the composer strip and the status row slides up
 * into (DROVE-147, after DROVE-117, DROVE-111, DROVE-123, DROVE-128).
 *
 * Clay, for the third time: "again the sheets are supposed to be full width
 * and should actually slide up". The shell this replaces was called
 * ComposerAnchoredSheet and the name was the bug. It sat at `bottom: '100%'`
 * of the composer, so it was a rounded card floating ABOVE the dock, inset
 * 16pt from both screen edges, overlapping the last message, and it appeared
 * in place with FloatingOverlay's scale-and-fade. A grabber on a card that
 * never moved.
 *
 * This is a sheet. It renders in a screen-level modal, which is the only way
 * to escape the composer's subtree and reach the bottom edge, so it is:
 *
 *   - full width, no side inset, square at the bottom and rounded on top;
 *   - pinned to the bottom of the SCREEN, over the dock rather than above it;
 *   - slid up from its own measured height, and slid back down on the way
 *     out, including when the caller flips `open` off;
 *   - dragged by a real grabber, dismissed by a drag down on the gate
 *     overlay's thresholds or by a tap outside;
 *   - scrolled inside itself once the content passes the cap.
 *
 * It rides the keyboard rather than hiding behind it, which the anchored
 * version got for free by living inside the dock.
 *
 * Anything that expands out of the composer strip or the status row goes
 * through here. A caller that draws its own backdrop, its own card or its own
 * grabber is a bug, not a variant.
 */
import * as React from 'react';
import { Modal, Platform, Pressable, StyleSheet as RNStyleSheet, useWindowDimensions, View } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import Animated, {
    runOnJS,
    useAnimatedStyle,
    useSharedValue,
    withSpring,
    withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUnistyles } from 'react-native-unistyles';
import { MobileGlassSurface } from './MobileGlass';
import { swipeDismisses } from './sessionGateDeck';

/**
 * Tall enough for the current account's three windows plus five accounts at
 * 20pt a row, or for a dozen agents, and short enough that the transcript is
 * still there behind it. Past that the content scrolls, which is the point: a
 * sixth account or a thirteenth agent is reachable instead of pushing the
 * sheet off the top of the screen.
 */
export const COMPOSER_SHEET_MAX_HEIGHT = 320;

/**
 * Where the sheet parks before anything has measured it. Taller than any
 * sheet we draw, so the first frame is offscreen instead of a flash at rest.
 */
const parked = 900;

/** A phone gets the whole width; a desktop window gets a sheet, not a wall. */
const maxSheetWidth = 640;

/** The sheet never eats the transcript entirely, however long the content is. */
const maxHeightFraction = 0.7;

export function ComposerSheet(props: {
    open: boolean;
    onClose: () => void;
    children: React.ReactNode;
    maxHeight?: number;
    /** A sheet with switches in it must not lose the first tap to the keyboard. */
    keyboardShouldPersistTaps?: 'always' | 'never' | 'handled';
}) {
    const { theme } = useUnistyles();
    const safeArea = useSafeAreaInsets();
    const window = useWindowDimensions();
    const keyboard = useReanimatedKeyboardAnimation();
    const onClose = props.onClose;

    // `open` is the caller's; `mounted` is ours, and it outlives `open` by the
    // length of the slide down. Unmounting on the flag would snap the sheet
    // away, which is the half of "slides up" nobody notices until it is gone.
    const [mounted, setMounted] = React.useState(false);
    const translateY = useSharedValue(parked);
    const sheetHeight = useSharedValue(parked);
    const entered = React.useRef(false);
    const unmount = React.useCallback(() => setMounted(false), []);

    React.useEffect(() => {
        if (props.open) {
            entered.current = false;
            translateY.value = parked;
            setMounted(true);
            return;
        }
        translateY.value = withTiming(sheetHeight.value, { duration: 180 }, (finished) => {
            if (finished) runOnJS(unmount)();
        });
    }, [props.open, sheetHeight, translateY, unmount]);

    // The slide starts from the height the sheet turned out to be, so a
    // three-row sheet travels three rows and not a screenful.
    const handleLayout = React.useCallback((event: { nativeEvent: { layout: { height: number } } }) => {
        const height = event.nativeEvent.layout.height;
        if (height <= 0) return;
        sheetHeight.value = height;
        if (entered.current) return;
        entered.current = true;
        translateY.value = height;
        translateY.value = withSpring(0, { damping: 26, stiffness: 300, mass: 0.7 });
    }, [sheetHeight, translateY]);

    // Only the grabber drags. The body is a scroll view holding a list, and a
    // pan over the whole sheet would eat its vertical touches.
    const drag = React.useMemo(() => Gesture.Pan()
        .activeOffsetY([-12, 12])
        .failOffsetX([-16, 16])
        .onUpdate((event) => {
            translateY.value = Math.max(0, event.translationY);
        })
        .onEnd((event) => {
            if (swipeDismisses(event.translationY, event.velocityY)) {
                translateY.value = withTiming(sheetHeight.value, { duration: 180 }, (finished) => {
                    if (finished) runOnJS(onClose)();
                });
            } else {
                translateY.value = withSpring(0, { damping: 24, stiffness: 260 });
            }
        }), [onClose, sheetHeight, translateY]);

    const sheetStyle = useAnimatedStyle(() => ({
        // The keyboard's height is negative while it is up, so this lifts.
        transform: [{ translateY: translateY.value + keyboard.height.value }],
    }));

    const backdropStyle = useAnimatedStyle(() => ({
        opacity: 1 - Math.min(1, translateY.value / Math.max(1, sheetHeight.value)),
    }));

    if (!mounted) return null;

    const scrollMaxHeight = Math.min(
        props.maxHeight ?? COMPOSER_SHEET_MAX_HEIGHT,
        Math.round(window.height * maxHeightFraction),
    );

    return (
        <Modal
            visible
            transparent
            animationType="none"
            statusBarTranslucent
            onRequestClose={onClose}
        >
            {/* Gestures inside an RN modal need their own root on Android. */}
            <GestureHandlerRootView style={{ flex: 1 }}>
                <Animated.View style={[RNStyleSheet.absoluteFill, backdropStyle]}>
                    <Pressable
                        onPress={onClose}
                        accessibilityRole="button"
                        accessibilityLabel="Close"
                        style={{
                            flex: 1,
                            // Light enough that the transcript is still there
                            // behind the sheet, dark enough to read as modal.
                            backgroundColor: theme.dark ? 'rgba(0, 0, 0, 0.5)' : 'rgba(0, 0, 0, 0.25)',
                        }}
                    />
                </Animated.View>
                <Animated.View
                    onLayout={handleLayout}
                    style={[{ position: 'absolute', left: 0, right: 0, bottom: 0 }, sheetStyle]}
                >
                    <View style={{ width: '100%', maxWidth: maxSheetWidth, alignSelf: 'center' }}>
                        <MobileGlassSurface
                            enabled
                            nativeEffect
                            intensity={88}
                            glassEffectStyle="regular"
                            tintColor={theme.colors.glass.overlayTint}
                            style={{
                                borderTopLeftRadius: 24,
                                borderTopRightRadius: 24,
                                overflow: 'hidden',
                                backgroundColor: Platform.select({
                                    web: theme.colors.surface,
                                    ios: theme.colors.glass.overlay,
                                    android: theme.colors.glass.backgroundStrong,
                                    default: theme.colors.surface,
                                }),
                                borderTopWidth: RNStyleSheet.hairlineWidth,
                                borderColor: Platform.select({
                                    web: theme.colors.modal.border,
                                    default: theme.colors.glass.border,
                                }),
                            }}
                        >
                            <GestureDetector gesture={drag}>
                                {/* Unlabelled, like the gate overlay's: anyone
                                    not dragging dismisses by tapping outside. */}
                                <View style={{ paddingTop: 10, paddingBottom: 4 }}>
                                    <View style={{
                                        alignSelf: 'center',
                                        width: 36,
                                        height: 4,
                                        borderRadius: 2,
                                        backgroundColor: theme.colors.divider,
                                    }} />
                                </View>
                            </GestureDetector>
                            <Animated.ScrollView
                                style={{ maxHeight: scrollMaxHeight }}
                                keyboardShouldPersistTaps={props.keyboardShouldPersistTaps ?? 'handled'}
                                showsVerticalScrollIndicator
                            >
                                {props.children}
                            </Animated.ScrollView>
                            {/* The home indicator, not padding for its own sake. */}
                            <View style={{ height: safeArea.bottom + 8 }} />
                        </MobileGlassSurface>
                    </View>
                </Animated.View>
            </GestureHandlerRootView>
        </Modal>
    );
}
