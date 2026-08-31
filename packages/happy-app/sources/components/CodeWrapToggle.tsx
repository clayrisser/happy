import * as React from 'react';
import { Platform, StyleProp, StyleSheet, View, ViewStyle } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { Ionicons } from '@expo/vector-icons';
import { type DoubleTapState, doubleTapWindowMs, pressDoubleTap } from './doubleTapPress';

/**
 * Two presses on anything that only has a single-press callback: the web's
 * onClick here, and a sentence run's `Text.onPress` in MarkdownView
 * (DROVE-235). One pending tap per element, so two taps on two different
 * sentences are two first taps and neither fires.
 */
export function useDoubleTapPress(onDoubleTap: () => void): () => void {
    const pendingSince = React.useRef<DoubleTapState>(null);
    return React.useCallback(() => {
        const next = pressDoubleTap(pendingSince.current, Date.now());
        pendingSince.current = next.pendingSince;
        if (next.fired) onDoubleTap();
    }, [onDoubleTap]);
}

/**
 * Double-tap to toggle soft wrap on a monospace card (DROVE-95, wrapping by
 * default since DROVE-149).
 *
 * A gesture-handler Tap with two taps on native, so it recognises inside the
 * chat list and inside a horizontal ScrollView without stealing either pan: a
 * tap that moves is not a tap. On web the same View counts clicks by hand,
 * because react-native-web drops onDoubleClick and MarkdownView already keeps
 * gesture-handler off the web path for text selection's sake.
 */
interface DoubleTapProps {
    onDoubleTap: () => void;
    style?: StyleProp<ViewStyle>;
    children: React.ReactNode;
}

export function DoubleTap(props: DoubleTapProps) {
    const { onDoubleTap } = props;
    const onClick = useDoubleTapPress(onDoubleTap);
    const gesture = React.useMemo(() => Gesture.Tap()
        .numberOfTaps(2)
        .maxDelay(doubleTapWindowMs)
        .onStart(() => {
            onDoubleTap();
        })
        .runOnJS(true), [onDoubleTap]);

    if (Platform.OS === 'web') {
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

/**
 * The small corner glyph that says how the card lays its text out. Wrapping is
 * the default, so it is the quiet one: a faint return arrow. Horizontal
 * scrolling is the state you chose, so it is bright and gets its own arrows
 * (DROVE-149).
 */
export function WrapGlyph(props: WrapGlyphProps) {
    return (
        <View
            pointerEvents="none"
            style={[styles.glyph, props.style]}
            accessibilityLabel={props.on ? 'Line wrap on' : 'Horizontal scrolling on'}
        >
            <Ionicons
                name={props.on ? 'return-down-back-outline' : 'swap-horizontal'}
                size={14}
                color={props.color}
                style={{ opacity: props.on ? 0.35 : 1 }}
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
