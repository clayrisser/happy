import * as React from 'react';
import {
    LayoutChangeEvent,
    GestureResponderEvent,
    StyleProp,
    StyleSheet,
    View,
    ViewStyle,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { BubblePressable } from './BubblePressable';
import { isInsideTalkButton, type MicButtonState } from '@/voice/micButton';
import { t } from '@/text';

/**
 * The composer's talk button (DROVE-74, DROVE-105, DROVE-140).
 *
 * Press-in opens the mic; the lift decides. Released before the hold is
 * recognised it latches, after that the words are sent, and if the finger
 * slid OFF the button before lifting the recording is thrown away. The slide
 * is tracked here rather than in the voice hook, because it is a fact about
 * this rectangle and nothing above it needs to know where a finger is:
 * onPressOut alone says the finger went up, never where.
 *
 * Both press callbacks carry the OS's own event timestamp up to the reducer
 * (DROVE-140). `Date.now()` read inside a handler is the time the JS thread
 * reached it, and press-in is the busiest moment this screen has, so that
 * clock inflated every tap by however long the mic took to open and turned
 * short presses into holds. `nativeEvent.timestamp` is stamped when the
 * finger moved.
 *
 * Touch events bubble to this wrapper from the pressable inside it, and
 * their coordinates are relative to the view the touch started in, so the
 * inside test is the button's own measured box with slop and no window
 * measuring. The haptics all come from the gesture reducer, one per
 * transition, so none is added here.
 */
interface TalkButtonProps {
    state: MicButtonState;
    /** `touchAt` is the OS touch clock, absent on a platform that has none. */
    onPressIn: (touchAt?: number) => void;
    onPressOut: (touchAt?: number) => void;
    /** The finger crossed the button's edge while still down. */
    onSlide: (inside: boolean) => void;
    style?: StyleProp<ViewStyle>;
    heldStyle?: StyleProp<ViewStyle>;
    latchedStyle?: StyleProp<ViewStyle>;
    idleColor: string;
    activeColor: string;
}

/**
 * The touch's own timestamp, or undefined when the platform did not give
 * one. Guarded rather than assumed: web synthesises these events, and a
 * missing or zero stamp must fall back to the wall clock rather than read as
 * an instantaneous press.
 */
function touchTime(event: GestureResponderEvent): number | undefined {
    const stamp = event?.nativeEvent?.timestamp;
    return typeof stamp === 'number' && stamp > 0 ? stamp : undefined;
}

export const TalkButton = React.memo(({
    state,
    onPressIn,
    onPressOut,
    onSlide,
    style,
    heldStyle,
    latchedStyle,
    idleColor,
    activeColor,
}: TalkButtonProps) => {
    const size = React.useRef({ width: 0, height: 0 });
    const inside = React.useRef(true);

    const handleLayout = React.useCallback((event: LayoutChangeEvent) => {
        const { width, height } = event.nativeEvent.layout;
        size.current = { width, height };
    }, []);

    const handlePressIn = React.useCallback((event: GestureResponderEvent) => {
        inside.current = true;
        onPressIn(touchTime(event));
    }, [onPressIn]);

    const handlePressOut = React.useCallback((event: GestureResponderEvent) => {
        onPressOut(touchTime(event));
    }, [onPressOut]);

    const handleTouchMove = React.useCallback((event: GestureResponderEvent) => {
        const { locationX, locationY } = event.nativeEvent;
        const next = isInsideTalkButton({ x: locationX, y: locationY }, size.current);
        if (next === inside.current) return;
        inside.current = next;
        onSlide(next);
    }, [onSlide]);

    return (
        <View onLayout={handleLayout} onTouchMove={handleTouchMove} style={styles.wrapper}>
            <BubblePressable
                onPressIn={handlePressIn}
                onPressOut={handlePressOut}
                onLongPress={() => { }}
                delayLongPress={100000}
                hitSlop={10}
                scaleFeedback={state === 'idle'}
                style={[
                    style,
                    state === 'held' && heldStyle,
                    state === 'latched' && latchedStyle,
                ]}
                accessibilityRole="button"
                accessibilityState={{
                    busy: state === 'held',
                    selected: state === 'latched',
                }}
                accessibilityLabel={state === 'latched'
                    ? t('agentInput.dictate.tapToStop')
                    : t('agentInput.dictate.label')}
            >
                <Ionicons
                    name={state === 'idle' ? 'mic-outline' : 'mic'}
                    size={state === 'idle' ? 16 : 17}
                    color={state === 'held' ? '#FFFFFF' : state === 'latched' ? activeColor : idleColor}
                />
            </BubblePressable>
        </View>
    );
});

const styles = StyleSheet.create({
    // The wrapper exists only to own the layout and the touch stream; it must
    // not change the row's geometry.
    wrapper: {
        flexDirection: 'row',
        alignItems: 'center',
    },
});
