import * as React from 'react';
import { Platform, StyleProp, StyleSheet, View, ViewStyle } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { Ionicons } from '@expo/vector-icons';

/**
 * Double-tap to toggle soft wrap on a monospace card (DROVE-95).
 *
 * A gesture-handler Tap with two taps on native, so it recognises inside the
 * chat list and inside a horizontal ScrollView without stealing either pan: a
 * tap that moves is not a tap. On web the same View counts clicks by hand,
 * because react-native-web drops onDoubleClick and MarkdownView already keeps
 * gesture-handler off the web path for text selection's sake.
 */
const doubleClickWindowMs = 350;

interface DoubleTapProps {
    onDoubleTap: () => void;
    style?: StyleProp<ViewStyle>;
    children: React.ReactNode;
}

export function DoubleTap(props: DoubleTapProps) {
    const { onDoubleTap } = props;
    const lastClickAt = React.useRef(0);
    const gesture = React.useMemo(() => Gesture.Tap()
        .numberOfTaps(2)
        .maxDelay(doubleClickWindowMs)
        .onStart(() => {
            onDoubleTap();
        })
        .runOnJS(true), [onDoubleTap]);

    if (Platform.OS === 'web') {
        const onClick = () => {
            const now = Date.now();
            if (now - lastClickAt.current < doubleClickWindowMs) {
                lastClickAt.current = 0;
                onDoubleTap();
            } else {
                lastClickAt.current = now;
            }
        };
        return (
            <View style={props.style} {...({ onClick } as any)}>
                {props.children}
            </View>
        );
    }

    return (
        <GestureDetector gesture={gesture}>
            <View collapsable={false} style={props.style}>
                {props.children}
            </View>
        </GestureDetector>
    );
}

interface WrapGlyphProps {
    on: boolean;
    color: string;
    style?: StyleProp<ViewStyle>;
}

/** The small corner glyph that says whether the card wraps. Bright when on, faint when off. */
export function WrapGlyph(props: WrapGlyphProps) {
    return (
        <View
            pointerEvents="none"
            style={[styles.glyph, props.style]}
            accessibilityLabel={props.on ? 'Line wrap on' : 'Line wrap off'}
        >
            <Ionicons
                name="return-down-back-outline"
                size={14}
                color={props.color}
                style={{ opacity: props.on ? 1 : 0.35 }}
            />
        </View>
    );
}

const styles = StyleSheet.create({
    glyph: {
        position: 'absolute',
        top: 6,
        right: 8,
    },
});
