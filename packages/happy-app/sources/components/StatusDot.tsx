import * as React from 'react';
import { ViewStyle } from 'react-native';
import Animated, {
    ReduceMotion,
    useAnimatedStyle,
    useReducedMotion,
    useSharedValue,
    withRepeat,
    withTiming,
} from 'react-native-reanimated';
import {
    STATUS_DOT_BLINK_HALF_MS,
    STATUS_DOT_BLINK_MIN_OPACITY,
} from './statusDotState';

export interface StatusDotProps {
    color: string;
    isPulsing?: boolean;
    size?: number;
    style?: ViewStyle;
    /**
     * What a screen reader hears (DROVE-243). A dot has no text of its own, and
     * on a list row there is no Pressable around it to carry the label the way
     * the strip's has, so it says the state itself. Absent leaves the dot
     * invisible to the reader, which is right when the words are already beside
     * it.
     */
    accessibilityLabel?: string;
}

/**
 * The blinking dot.
 *
 * ONE PERIOD, from statusDotState.ts (DROVE-231). Two states blink now,
 * working and compacting, so the blink cannot be what tells them apart; the
 * hue is. That only holds if both blink identically, which is why the period
 * is a shared constant rather than a literal here.
 *
 * REDUCED MOTION STOPS IT DEAD, at full opacity. A dot that pulses is saying
 * "busy" with movement, and the hue says the same thing on its own, since blue
 * and purple are not colours this strip uses for anything else, so a still dot
 * loses nothing but the animation. `ReduceMotion.System` is belt and braces
 * for a setting that changes while the dot is on screen.
 */
export const StatusDot = React.memo(({ color, isPulsing, size = 6, style, accessibilityLabel }: StatusDotProps) => {
    const opacity = useSharedValue(1);
    const reduceMotion = useReducedMotion();

    React.useEffect(() => {
        if (isPulsing && !reduceMotion) {
            opacity.value = withRepeat(
                withTiming(STATUS_DOT_BLINK_MIN_OPACITY, {
                    duration: STATUS_DOT_BLINK_HALF_MS,
                    reduceMotion: ReduceMotion.System,
                }),
                -1, // infinite
                true, // reverse, so the full period is twice the half
                undefined,
                ReduceMotion.System,
            );
        } else {
            opacity.value = withTiming(1, { duration: 200, reduceMotion: ReduceMotion.System });
        }
    }, [isPulsing, reduceMotion]);

    const animatedStyle = useAnimatedStyle(() => {
        return {
            opacity: opacity.value,
        };
    });

    const baseStyle: ViewStyle = {
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: color,
    };

    return (
        <Animated.View
            accessible={accessibilityLabel !== undefined}
            accessibilityRole={accessibilityLabel !== undefined ? 'image' : undefined}
            accessibilityLabel={accessibilityLabel}
            style={[
                baseStyle,
                animatedStyle,
                style
            ]}
        />
    );
});
