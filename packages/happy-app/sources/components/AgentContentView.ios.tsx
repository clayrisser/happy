import { useHeaderHeight } from '@/utils/responsive';
import * as React from 'react';
import { LayoutChangeEvent, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import MaskedView from '@react-native-masked-view/masked-view';
import {
    CHAT_BOTTOM_SCRIM_OVERLAY_OPACITY,
    resolveDockBottomOffset,
    resolveDockInset,
    resolveTranscriptBottomScrim,
    resolveTranscriptMask,
} from './agentDockLayout';
import { MobileHeaderScrim } from './navigation/MobileHeaderScrim';
import { useKeyboardHandler, useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface AgentContentViewProps {
    input?: React.ReactNode | null;
    content?: React.ReactNode | null;
    placeholder?: React.ReactNode | null;
    /** Keep the composer as an overlay while the chat scrolls beneath it. */
    floatingDock?: boolean;
    /** Measured visual inset that the inverted chat list reserves at its bottom. */
    onDockInsetChange?: (inset: number) => void;
}

export const AgentContentView: React.FC<AgentContentViewProps> = React.memo(({
    input,
    content,
    placeholder,
    floatingDock = false,
    onDockInsetChange,
}) => {
    const safeArea = useSafeAreaInsets();
    const height = useReanimatedKeyboardAnimation();
    const headerHeight = useHeaderHeight();
    const animatedPadding = useSharedValue(0);
    const [dockHeight, setDockHeight] = React.useState(0);

    const handleDockLayout = React.useCallback((event: LayoutChangeEvent) => {
        const nextHeight = Math.ceil(event.nativeEvent.layout.height);
        setDockHeight((currentHeight) => (
            Math.abs(currentHeight - nextHeight) < 1 ? currentHeight : nextHeight
        ));
    }, []);

    // The dock's frame sits this far above the screen edge. In floating mode
    // AgentInput's own 8pt container padding under the status row counts
    // toward the home indicator clearance instead of stacking on top of it,
    // which is the empty band in DROVE-113. Everything that animates with the
    // keyboard uses this same number, so a dock at `bottom: B` translated by
    // `-keyboardHeight + B * progress` lands exactly on the keyboard.
    const dockBottomOffset = resolveDockBottomOffset(safeArea.bottom, floatingDock);
    // The transcript runs behind the composer and is SEEN THROUGH it
    // (DROVE-180). It arrives at the capsule over a short ramp and then holds
    // TRANSCRIPT_GLASS_ALPHA for the whole height of the card, so the material
    // has real content to blur and refract the way a Liquid Glass tab bar
    // does. DROVE-168 masked that same band to nothing; the alpha is the
    // measured ceiling that keeps every composer glyph at 3:1 over both a
    // white and a black scroll, which is the one thing that stopped it being
    // 1. Only the status strip under the card is cleared, because that strip
    // is bare 11pt text with no material of its own.
    //
    // A mask rather than a painted scrim, still: it takes the chat's OWN alpha
    // down, so a white code block and body prose behave identically on either
    // theme, and the glass keeps the real screen behind it.
    const transcriptMask = resolveTranscriptMask(dockHeight, safeArea.bottom);
    // And the other half of the same edge (DROVE-219). The mask above only
    // takes the transcript's ALPHA down, which leaves every glyph as crisp as
    // it was; the header softens because it is a live blur under a ramped
    // gradient. So the bottom mounts that same scrim, mirrored, hung off the
    // dock's MEASURED box rather than a height anyone typed: the composer is a
    // bubble, a control row and a status strip, and it changes height as the
    // field grows. See `CHAT_BOTTOM_SCRIM_OVERLAY_OPACITY` for why the tint
    // half of it is held at zero here.
    const bottomScrim = resolveTranscriptBottomScrim(dockHeight, safeArea.bottom);

    React.useEffect(() => {
        onDockInsetChange?.(resolveDockInset({ dockHeight, safeAreaBottom: safeArea.bottom, floatingDock }));
    }, [dockHeight, floatingDock, onDockInsetChange, safeArea.bottom]);

    useKeyboardHandler({
        onEnd(e) {
            'worklet';
            animatedPadding.value = e.progress === 1 ? (-height.height.value - dockBottomOffset) : 0;
        },
        onStart(e) {
            'worklet';
            animatedPadding.value = 0;
        },
    },[dockBottomOffset]);
    const animatedStyle = useAnimatedStyle(() => ({
        paddingTop: animatedPadding.value,
        transform: [{ translateY: height.height.value + dockBottomOffset * height.progress.value }]
    }), [dockBottomOffset]);
    const animatedInputStyle = useAnimatedStyle(() => ({
        transform: [{ translateY: height.height.value + dockBottomOffset * height.progress.value }]
    }), [dockBottomOffset]);
    const animatePlaceholderdStyle = useAnimatedStyle(() => ({
        paddingTop: height.progress.value === 1 ? height.height.value : 0,
        transform: [{ translateY: (height.height.value  + dockBottomOffset * height.progress.value) / 2 }]
    }), [dockBottomOffset]);

    if (floatingDock) {
        return (
            <View style={{ flexBasis: 0, flexGrow: 1 }}>
                {content && (
                    <Animated.View style={[{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }, animatedStyle]}>
                        {/* The mask lives INSIDE the content's animated
                            wrapper on purpose. That wrapper and the dock carry
                            the same keyboard translation, and this box's
                            bottom edge is the screen edge, so a mask measured
                            up from it lands on the glass at every keyboard
                            position without animating the mask element
                            itself, which would mean driving a layer UIKit has
                            taken out of the view hierarchy to use as a mask. */}
                        {transcriptMask.clearHeight > 0 ? (
                            <MaskedView
                                style={{ flex: 1 }}
                                maskElement={(
                                    <View pointerEvents="none" style={{ flex: 1 }}>
                                        <View style={{ flex: 1, backgroundColor: '#000000' }} />
                                        <LinearGradient
                                            colors={transcriptMask.colors as [string, string, ...string[]]}
                                            locations={transcriptMask.locations as [number, number, ...number[]]}
                                            start={{ x: 0.5, y: 0 }}
                                            end={{ x: 0.5, y: 1 }}
                                            style={{ height: transcriptMask.gradientHeight }}
                                        />
                                        <View style={{ height: transcriptMask.clearHeight }} />
                                    </View>
                                )}
                            >
                                {content}
                            </MaskedView>
                        ) : content}
                    </Animated.View>
                )}
                {placeholder && (
                    <Animated.ScrollView
                        style={[
                            {
                                position: 'absolute',
                                top: safeArea.top + headerHeight,
                                left: 0,
                                right: 0,
                                bottom: dockHeight + dockBottomOffset,
                            },
                            animatePlaceholderdStyle,
                        ]}
                        contentContainerStyle={{ alignItems: 'center', justifyContent: 'center', flex: 1 }}
                        keyboardShouldPersistTaps="handled"
                        alwaysBounceVertical={false}
                    >
                        {placeholder}
                    </Animated.ScrollView>
                )}
                {/* No backdrop behind the dock (DROVE-168), and now nothing
                    masked behind the card either (DROVE-180). DROVE-113
                    painted `groupped.background` solid from the fade down,
                    past the dock and through the home indicator gap; DROVE-168
                    replaced the slab with a mask that took the transcript to
                    nothing before it reached the glass. Both left the material
                    with a uniform ground and no content to refract, which is
                    what a grey slab looks like and is what DROVE-171 was
                    reacting to. The glass has the real chat behind it now. */}
                <Animated.View
                    onLayout={handleDockLayout}
                    pointerEvents="box-none"
                    style={[
                        {
                            position: 'absolute',
                            left: 0,
                            right: 0,
                            bottom: dockBottomOffset,
                            zIndex: 2,
                        },
                        animatedInputStyle,
                    ]}
                >
                    {/* Behind the composer, never over it: painted before
                        `input` in the same box, so the bubble, the control row
                        and the status text are untouched by it. It reaches
                        `overhang` points below the dock's frame so the gap over
                        the home indicator fades too, and it carries the dock's
                        keyboard translation for free by living inside it. */}
                    {bottomScrim.visible && (
                        <View
                            pointerEvents="none"
                            style={{
                                position: 'absolute',
                                left: 0,
                                right: 0,
                                bottom: -bottomScrim.overhang,
                                height: bottomScrim.height,
                            }}
                        >
                            <MobileHeaderScrim
                                variant="strong"
                                edge="bottom"
                                overlayOpacity={CHAT_BOTTOM_SCRIM_OVERLAY_OPACITY}
                            />
                        </View>
                    )}
                    {input}
                </Animated.View>
            </View>
        );
    }

    return (
        <View style={{ flexBasis:0, flexGrow:1 }}>
            <View style={{ flexBasis:0, flexGrow:1 }}>
                {content && (
                    <Animated.View style={[{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }, animatedStyle]}>
                        {content}
                    </Animated.View>
                )}
                {placeholder && (
                    <Animated.ScrollView 
                        style={[{ position: 'absolute', top: safeArea.top + headerHeight, left: 0, right: 0, bottom: 0 }, animatePlaceholderdStyle]}
                        contentContainerStyle={{ alignItems: 'center', justifyContent: 'center', flex: 1 }}
                        keyboardShouldPersistTaps="handled"
                        alwaysBounceVertical={false}
                    >
                        {placeholder}
                    </Animated.ScrollView>
                )}
            </View>
            <Animated.View style={[animatedInputStyle]}>
                {input}
            </Animated.View>
        </View>
    );
});

// const FallbackKeyboardAvoidingView: React.FC<AgentContentViewProps> = React.memo(({
//     children,
// }) => {
    
// });
