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
 *   - exactly as tall as its content, and scrolled inside itself ONLY once
 *     that content passes the cap (DROVE-158).
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
import { composerSheetBody, composerSheetMaxHeight } from './composerSheetLayout';
import { swipeDismisses } from './sessionGateDeck';

/** @see composerSheetMaxHeight, which is where the number and its reasons live. */
export const COMPOSER_SHEET_MAX_HEIGHT = composerSheetMaxHeight;

/**
 * Where the sheet parks before anything has measured it. Taller than any
 * sheet we draw, so the first frame is offscreen instead of a flash at rest.
 */
const parked = 900;

/** A phone gets the whole width; a desktop window gets a sheet, not a wall. */
const maxSheetWidth = 640;

export function ComposerSheet(props: {
    open: boolean;
    onClose: () => void;
    children: React.ReactNode;
    maxHeight?: number;
    /** A sheet with switches in it must not lose the first tap to the keyboard. */
    keyboardShouldPersistTaps?: 'always' | 'never' | 'handled';
    /**
     * After the slide down has finished AND the Modal has come off the screen.
     *
     * This exists because `onClose` is far too early for anything that presents
     * a SYSTEM modal of its own. The sheet is a react-native `Modal`, so it
     * still owns the presentation context for the 180ms it spends animating
     * out, and a picker launched inside that window either comes up behind it
     * or never comes up at all. Anything opening the camera, the photo library
     * or the document browser has to wait for this, not for `onClose`.
     */
    onClosed?: () => void;
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
    /**
     * How far down the sheet is as a FRACTION of its own height: 1 is exactly
     * offscreen, 0 is at rest.
     *
     * It used to be a pixel offset taken from the first layout, latched, and
     * never revisited. That is the DROVE-158 measurement bug: a sheet whose
     * content settles a frame later parked at the old number and then jumped.
     * A fraction multiplied by the LIVE height cannot park short, because rest
     * is 0 whatever the height turns out to be, and a late layout only changes
     * how far the sheet still has to travel.
     */
    const progress = useSharedValue(1);
    const sheetHeight = useSharedValue(parked);
    const [contentHeight, setContentHeight] = React.useState<number | null>(null);
    /**
     * Measuring stops for the length of the slide down.
     *
     * Several callers render their children behind the same flag they pass as
     * `open` (AgentInput's two pickers do), so the body empties the instant
     * the sheet starts leaving. Letting that re-measure would shrink the card
     * to a stub halfway out. Whatever it was when the exit began is what it
     * leaves as.
     */
    const frozen = React.useRef(false);
    const entered = React.useRef(false);
    const onClosed = props.onClosed;
    const unmount = React.useCallback(() => {
        setMounted(false);
        onClosed?.();
    }, [onClosed]);

    React.useEffect(() => {
        if (props.open) {
            entered.current = false;
            frozen.current = false;
            progress.value = 1;
            setMounted(true);
            return;
        }
        frozen.current = true;
        progress.value = withTiming(1, { duration: 180 }, (finished) => {
            if (finished) runOnJS(unmount)();
        });
    }, [props.open, progress, unmount]);

    // The sheet's own height, kept current. Nothing latches it: a list that
    // grows, a keyboard that changes the safe area, or children that measure a
    // frame late all just move the number the fraction is multiplied by.
    const handleLayout = React.useCallback((event: { nativeEvent: { layout: { height: number } } }) => {
        const height = event.nativeEvent.layout.height;
        if (height > 0 && !frozen.current) sheetHeight.value = height;
    }, [sheetHeight]);

    // What the children actually came to, which is what decides whether this
    // sheet scrolls at all. A zero is kept rather than dropped: it is what a
    // sheet whose caller drew nothing measures, and the slide up is waiting on
    // this number, not on a truthy one. It is NOT cleared when the sheet
    // reopens, because a reopen inside the slide down re-renders the same
    // children at the same size and would never fire a second layout.
    const handleContentLayout = React.useCallback((event: { nativeEvent: { layout: { height: number } } }) => {
        const height = event.nativeEvent.layout.height;
        if (height < 0 || frozen.current) return;
        setContentHeight((current) => (current === height ? current : height));
    }, []);

    // The slide up waits for the content to have measured, so it starts from
    // the height the sheet is going to be rather than from a guess.
    React.useEffect(() => {
        if (!mounted || contentHeight === null || entered.current) return;
        entered.current = true;
        progress.value = withSpring(0, { damping: 26, stiffness: 300, mass: 0.7 });
    }, [mounted, contentHeight, progress]);

    const freeze = React.useCallback(() => {
        frozen.current = true;
    }, []);

    // Only the grabber drags. The body is a scroll view holding a list, and a
    // pan over the whole sheet would eat its vertical touches.
    const drag = React.useMemo(() => Gesture.Pan()
        .activeOffsetY([-12, 12])
        .failOffsetX([-16, 16])
        .onUpdate((event) => {
            const travel = Math.max(0, event.translationY);
            progress.value = Math.min(1, travel / Math.max(1, sheetHeight.value));
        })
        .onEnd((event) => {
            if (swipeDismisses(event.translationY, event.velocityY)) {
                runOnJS(freeze)();
                progress.value = withTiming(1, { duration: 180 }, (finished) => {
                    if (finished) runOnJS(onClose)();
                });
            } else {
                progress.value = withSpring(0, { damping: 24, stiffness: 260 });
            }
        }), [freeze, onClose, progress, sheetHeight]);

    const sheetStyle = useAnimatedStyle(() => ({
        // The keyboard's height is negative while it is up, so this lifts.
        transform: [{ translateY: progress.value * sheetHeight.value + keyboard.height.value }],
    }));

    const backdropStyle = useAnimatedStyle(() => ({
        opacity: 1 - progress.value,
    }));

    if (!mounted) return null;

    const body = composerSheetBody({
        contentHeight,
        maxHeight: props.maxHeight,
        windowHeight: window.height,
    });

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
                            {/* An EXPLICIT height, not a maxHeight. A scroll
                                view inside an auto-height card sizes itself,
                                and what it sized itself to was short enough to
                                slice the Add context tiles through their
                                labels (DROVE-158). Below the cap this is the
                                content's own height, so there is nothing to
                                scroll and nothing left over. */}
                            <Animated.ScrollView
                                style={{ height: body.height, maxHeight: body.cap }}
                                scrollEnabled={body.scrolls}
                                bounces={body.scrolls}
                                keyboardShouldPersistTaps={props.keyboardShouldPersistTaps ?? 'handled'}
                                showsVerticalScrollIndicator={body.scrolls}
                            >
                                <View onLayout={handleContentLayout}>
                                    {props.children}
                                </View>
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
