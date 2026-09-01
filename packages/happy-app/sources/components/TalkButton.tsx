import * as React from 'react';
import {
    StyleProp,
    StyleSheet,
    View,
    ViewStyle,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { BubblePressable } from './BubblePressable';
import { type MicButtonState } from '@/voice/micButton';
import { useTalkTouchStream } from './talkTouchStream';
import { t } from '@/text';

/**
 * The composer's talk button (DROVE-74, DROVE-105, DROVE-140).
 *
 * Press-in opens the mic; the lift decides. Released before the hold is
 * recognised it latches, after that the words are sent, and if the finger
 * slid OFF the button before lifting the recording is thrown away.
 *
 * THE GESTURE ITSELF IS NOT HERE ANY MORE (DROVE-269). The measuring, the OS
 * touch clock and the slide test moved to `talkTouchStream.ts` the moment a
 * second button wanted the same contract -- the composer's standalone mic,
 * which got push-to-talk back. What is left in this file is where the button
 * sits and what it is drawn in. Two buttons, one stream, so they cannot drift.
 *
 * The haptics all come from the gesture reducer, one per transition, so none
 * is added here.
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
    const stream = useTalkTouchStream(React.useMemo(
        () => ({ onPressIn, onPressOut, onSlide }),
        [onPressIn, onPressOut, onSlide],
    ));

    return (
        <View {...stream.view} style={styles.wrapper}>
            <BubblePressable
                {...stream.press}
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
