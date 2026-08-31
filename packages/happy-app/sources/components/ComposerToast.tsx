import * as React from 'react';
import { Text } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';

/**
 * One line over the composer that says what a toggle just did (DROVE-98):
 * "Stream-talk on". It takes no touches and goes away on its own; the
 * composer owns the timer, this only draws.
 */
export const ComposerToast = React.memo(({ text }: { text: string | null }) => {
    if (!text) return null;
    return (
        <Animated.View
            entering={FadeIn.duration(120)}
            exiting={FadeOut.duration(220)}
            pointerEvents="none"
            style={styles.toast}
            accessibilityLiveRegion="polite"
        >
            <Text style={styles.text} numberOfLines={1}>{text}</Text>
        </Animated.View>
    );
});

const styles = StyleSheet.create((theme) => ({
    toast: {
        position: 'absolute',
        bottom: '100%',
        alignSelf: 'center',
        marginBottom: 8,
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: 14,
        backgroundColor: theme.colors.surfaceHighest,
        zIndex: 1001,
    },
    text: {
        fontSize: 13,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
}));
