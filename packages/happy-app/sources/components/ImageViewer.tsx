/**
 * The full screen an inline picture opens into (DROVE-151). Pinch to zoom,
 * drag to pan, double tap to snap between fit and 2.5x, and any of close,
 * back, or a tap on the backdrop dismisses.
 *
 * A Modal rather than a route on purpose: the transcript underneath is never
 * unmounted, so dismissing lands on the same scroll position instead of
 * rebuilding the list at the top.
 *
 * The stage is sized from the window in POINTS (DROVE-366). It used to be two
 * nested views sharing one `flex: 1, alignItems: 'center'` style with the
 * picture at `width: '100%'`, and that percentage measured against a parent
 * whose own width `alignItems: 'center'` had left auto. Yoga answers zero to
 * that circle, so the picture was laid out zero wide and the screen was the
 * backdrop, the close control, and nothing else. Clay: "Why are images not
 * showing when I click on this?"
 *
 * A viewer with no source says so rather than opening onto the same black.
 */
import * as React from 'react';
import { Modal, Platform, Pressable, Text, View, useWindowDimensions } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet } from 'react-native-unistyles';

import { imageViewerContent, imageViewerStage } from '@/utils/imageViewer';

interface ImageViewerProps {
    /** Missing when nothing on this phone can supply the bytes. */
    uri: string | undefined;
    visible: boolean;
    onClose: () => void;
}

const minScale = 1;
const maxScale = 8;
const doubleTapScale = 2.5;

export const ImageViewer = React.memo<ImageViewerProps>(({ uri, visible, onClose }) => {
    const insets = useSafeAreaInsets();
    const window = useWindowDimensions();
    const stage = imageViewerStage(window);
    const content = imageViewerContent(uri);
    const scale = useSharedValue(1);
    const savedScale = useSharedValue(1);
    const offsetX = useSharedValue(0);
    const offsetY = useSharedValue(0);
    const savedX = useSharedValue(0);
    const savedY = useSharedValue(0);

    React.useEffect(() => {
        // A reopened viewer starts fit to the screen, whatever the last pinch left.
        if (visible) {
            scale.value = 1;
            savedScale.value = 1;
            offsetX.value = 0;
            offsetY.value = 0;
            savedX.value = 0;
            savedY.value = 0;
        }
    }, [visible, scale, savedScale, offsetX, offsetY, savedX, savedY]);

    const pinch = React.useMemo(() => Gesture.Pinch()
        .onUpdate((event) => {
            scale.value = Math.min(maxScale, Math.max(minScale, savedScale.value * event.scale));
        })
        .onEnd(() => {
            savedScale.value = scale.value;
            if (scale.value <= minScale) {
                offsetX.value = withTiming(0, { duration: 140 });
                offsetY.value = withTiming(0, { duration: 140 });
                savedX.value = 0;
                savedY.value = 0;
            }
        }), [scale, savedScale, offsetX, offsetY, savedX, savedY]);

    // Panning only means anything once zoomed in; at fit the picture has
    // nowhere to go, and eating the drag there would fight the dismiss tap.
    const pan = React.useMemo(() => Gesture.Pan()
        .averageTouches(true)
        .onUpdate((event) => {
            if (scale.value <= minScale) {
                return;
            }
            offsetX.value = savedX.value + event.translationX;
            offsetY.value = savedY.value + event.translationY;
        })
        .onEnd(() => {
            savedX.value = offsetX.value;
            savedY.value = offsetY.value;
        }), [scale, offsetX, offsetY, savedX, savedY]);

    const doubleTap = React.useMemo(() => Gesture.Tap()
        .numberOfTaps(2)
        .onEnd(() => {
            const next = scale.value > minScale ? minScale : doubleTapScale;
            scale.value = withTiming(next, { duration: 160 });
            savedScale.value = next;
            if (next === minScale) {
                offsetX.value = withTiming(0, { duration: 160 });
                offsetY.value = withTiming(0, { duration: 160 });
                savedX.value = 0;
                savedY.value = 0;
            }
        }), [scale, savedScale, offsetX, offsetY, savedX, savedY]);

    const gesture = React.useMemo(
        () => Gesture.Simultaneous(pinch, pan, doubleTap),
        [pinch, pan, doubleTap],
    );

    const imageStyle = useAnimatedStyle(() => ({
        transform: [
            { translateX: offsetX.value },
            { translateY: offsetY.value },
            { scale: scale.value },
        ],
    }));

    return (
        <Modal
            visible={visible}
            transparent
            animationType="fade"
            statusBarTranslucent
            onRequestClose={onClose}
        >
            {/* Gesture handlers do not inherit the app's root inside a Modal. */}
            <GestureHandlerRootView style={styles.root}>
                <View style={styles.backdrop}>
                    {content.kind === 'image' ? (
                        // Nothing is drawn until the window has been measured,
                        // because the only other size available is zero.
                        stage ? (
                            <GestureDetector gesture={gesture}>
                                <Animated.View style={styles.stage}>
                                    <Animated.View style={[stage, imageStyle]}>
                                        <Image
                                            source={{ uri: content.uri }}
                                            style={stage}
                                            contentFit="contain"
                                            accessibilityIgnoresInvertColors
                                        />
                                    </Animated.View>
                                </Animated.View>
                            </GestureDetector>
                        ) : null
                    ) : (
                        <View style={styles.stage}>
                            <Text style={styles.empty}>{content.message}</Text>
                        </View>
                    )}
                    <Pressable
                        style={[styles.close, { top: insets.top + 12 }]}
                        onPress={onClose}
                        accessibilityRole="button"
                        hitSlop={12}
                    >
                        <Ionicons name="close" size={24} color="#fff" />
                    </Pressable>
                </View>
            </GestureHandlerRootView>
        </Modal>
    );
});

const styles = StyleSheet.create(() => ({
    root: {
        flex: 1,
    },
    backdrop: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.96)',
    },
    stage: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
    },
    empty: {
        color: 'rgba(255,255,255,0.75)',
        fontSize: 15,
    },
    close: {
        position: 'absolute',
        right: 12,
        width: 40,
        height: 40,
        borderRadius: 20,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(0,0,0,0.45)',
        cursor: Platform.OS === 'web' ? 'pointer' : undefined,
    },
}));
