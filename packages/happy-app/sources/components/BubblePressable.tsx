import * as React from 'react';
import {
    GestureResponderEvent,
    Platform,
    Pressable,
    PressableProps,
    PressableStateCallbackType,
    StyleProp,
    ViewStyle,
} from 'react-native';
import Animated, {
    cancelAnimation,
    Easing,
    useAnimatedStyle,
    useSharedValue,
    withSpring,
    withTiming,
} from 'react-native-reanimated';
import { resolveBubblePressableFeedback } from './bubblePressableFeedback';
import { useNativeGlassPress } from './glassPress';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

type BubblePressableProps = Omit<PressableProps, 'style'> & {
    style?: StyleProp<ViewStyle> | ((state: PressableStateCallbackType) => StyleProp<ViewStyle>);
    pressedStyle?: StyleProp<ViewStyle>;
    bubbleScale?: number;
    scaleFeedback?: boolean;
    /**
     * Override the surrounding surface's answer about whether the PLATFORM is
     * drawing this press (DROVE-266).
     *
     * The context is a property of the SURFACE, and it is right for a control
     * that stands on the material. It is wrong for one whose own opaque fill
     * COVERS it: the composer's `+`, its session capsule, its audio disc and
     * its mic once open all replace the glass rather than sit on it, so
     * `UIGlassEffect.isInteractive` lenses under a view you cannot see through
     * and the spring standing down would leave them with no response at all.
     * Those pass `false` here. `resolveComposerPressResponse` in
     * glassInteractionPolicy.ts decides which is which and carries the
     * argument; this prop is only how the answer reaches the Pressable.
     */
    nativeGlassPress?: boolean;
};

/**
 * Pressable with the small inflate-and-settle feedback used by mobile glass
 * controls. Large rows can opt into a subtler scale via bubbleScale.
 */
export const BubblePressable = React.memo(({
    style,
    pressedStyle,
    bubbleScale = Platform.OS === 'web' ? 1.01 : 1.025,
    scaleFeedback = true,
    disabled,
    onPressIn,
    onPressOut,
    nativeGlassPress: nativeGlassPressOverride,
    ...props
}: BubblePressableProps) => {
    const scale = useSharedValue(1);
    const [pressed, setPressed] = React.useState(false);
    const surfaceGlassPress = useNativeGlassPress();
    const nativeGlassPress = nativeGlassPressOverride ?? surfaceGlassPress;
    const { animateScale } = resolveBubblePressableFeedback({
        platform: Platform.OS === 'web' ? 'web' : 'native',
        scaleFeedback,
        nativeGlassPress,
    });
    React.useEffect(() => {
        if (animateScale) {
            return;
        }
        cancelAnimation(scale);
        scale.value = 1;
    }, [animateScale, scale]);
    const animatedStyle = useAnimatedStyle(() => ({
        ...(animateScale ? { transform: [{ scale: scale.value }] } : {}),
    }));

    const handlePressIn = React.useCallback((event: GestureResponderEvent) => {
        if (!disabled) {
            setPressed(true);
            if (animateScale) {
                scale.value = withTiming(bubbleScale, {
                    duration: 65,
                    easing: Easing.out(Easing.quad),
                });
            }
        }
        onPressIn?.(event);
    }, [animateScale, bubbleScale, disabled, onPressIn, scale]);

    const handlePressOut = React.useCallback((event: GestureResponderEvent) => {
        setPressed(false);
        if (animateScale) {
            scale.value = withSpring(1, {
                damping: 14,
                stiffness: 520,
                mass: 0.4,
                overshootClamping: false,
            });
        }
        onPressOut?.(event);
    }, [animateScale, onPressOut, scale]);

    // Bubble feedback belongs to the mobile glass controls. Keep desktop
    // interaction identical to the previous plain Pressable behavior.
    if (Platform.OS === 'web') {
        return (
            <Pressable
                {...props}
                disabled={disabled}
                onPressIn={onPressIn}
                onPressOut={onPressOut}
                style={(state) => [
                    typeof style === 'function' ? style(state) : style,
                    state.pressed && pressedStyle,
                ]}
            />
        );
    }

    return (
        <AnimatedPressable
            {...props}
            disabled={disabled}
            onPressIn={handlePressIn}
            onPressOut={handlePressOut}
            style={[
                typeof style === 'function' ? style({ pressed } as PressableStateCallbackType) : style,
                pressed && pressedStyle,
                animateScale && animatedStyle,
            ]}
        />
    );
});
