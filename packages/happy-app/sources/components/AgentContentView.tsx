import { useHeaderHeight } from '@/utils/responsive';
import * as React from 'react';
import { LayoutChangeEvent, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import {
    DOCK_SCRIM_FADE_HEIGHT,
    resolveDockBottomOffset,
    resolveDockInset,
    resolveMeasuredDockHeight,
    resolveRestingDockHeight,
    resolveDockScrimHeight,
    transparentOf,
} from './agentDockLayout';
import { ScrollView } from 'react-native-gesture-handler';
import { useKeyboardState } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUnistyles } from 'react-native-unistyles';

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
    const { theme } = useUnistyles();
    const safeArea = useSafeAreaInsets();
    const headerHeight = useHeaderHeight();
    const state = useKeyboardState();
    const keyboardInset = state.isVisible ? Math.max(0, state.height - safeArea.bottom) : 0;
    // Starts at the composer's RESTING height, not at 0 (DROVE-373). This
    // number reaches the list as the band it reserves at its visual bottom,
    // and it gets there through onLayout -> setState -> an effect -> another
    // setState, so a 0 here is a first paint with the newest message drawn
    // under the composer. The composer's height is resolved from the value
    // (DROVE-350), so the resting number is known before anything measures.
    const [dockHeight, setDockHeight] = React.useState(resolveRestingDockHeight);

    const handleDockLayout = React.useCallback((event: LayoutChangeEvent) => {
        // Floored here rather than at each reader, so the inset, the mask, the
        // scrim and the placeholder's bottom edge cannot disagree.
        const nextHeight = resolveMeasuredDockHeight(Math.ceil(event.nativeEvent.layout.height));
        setDockHeight((currentHeight) => (
            Math.abs(currentHeight - nextHeight) < 1 ? currentHeight : nextHeight
        ));
    }, []);

    // See agentDockLayout: AgentInput's own bottom padding is spent inside the
    // safe-area gap rather than stacked on top of it (DROVE-113).
    const dockBottomOffset = resolveDockBottomOffset(safeArea.bottom, floatingDock);
    const dockScrimHeight = resolveDockScrimHeight(dockHeight, safeArea.bottom);
    // The chat's own background, painted solid so nothing reads through.
    const dockSurface = theme.colors.groupped.background;

    React.useEffect(() => {
        onDockInsetChange?.(resolveDockInset({
            dockHeight,
            safeAreaBottom: safeArea.bottom,
            floatingDock,
            keyboardInset,
        }));
    }, [dockHeight, floatingDock, keyboardInset, onDockInsetChange, safeArea.bottom]);

    if (floatingDock) {
        return (
            <View style={{ flexBasis: 0, flexGrow: 1 }}>
                {content && (
                    <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}>
                        {content}
                    </View>
                )}
                {placeholder && (
                    <ScrollView
                        style={{
                            position: 'absolute',
                            top: safeArea.top + headerHeight,
                            left: 0,
                            right: 0,
                            bottom: dockHeight + keyboardInset + dockBottomOffset,
                        }}
                        contentContainerStyle={{ alignItems: 'center', justifyContent: 'center', flex: 1 }}
                        keyboardShouldPersistTaps="handled"
                        alwaysBounceVertical={false}
                    >
                        {placeholder}
                    </ScrollView>
                )}
                {/* Android and web keep the painted backdrop (DROVE-113):
                    fades in over the top DOCK_SCRIM_FADE_HEIGHT and is the
                    chat's own surface from there down. These are the platforms
                    with NO Liquid Glass, so there is nothing for the chat to
                    be seen through and the backdrop is the only thing keeping
                    live text out from under a flat dock. iOS lets the
                    transcript run behind the material at full alpha instead
                    (DROVE-180) and masks only the status strip. The two paths
                    diverge on purpose now, and DROVE-168's 32pt derivation
                    stayed on this one, where it still holds. Sits below the
                    dock's zIndex
                    so the DROVE-88 gate overlay, a child of the dock at
                    bottom: '100%', still paints over it and is not clipped. */}
                {dockScrimHeight > 0 && (
                    <View
                        pointerEvents="none"
                        style={{
                            position: 'absolute',
                            left: 0,
                            right: 0,
                            bottom: keyboardInset,
                            height: dockScrimHeight,
                            zIndex: 1,
                        }}
                    >
                        <LinearGradient
                            colors={[transparentOf(dockSurface), dockSurface]}
                            locations={[0, 1]}
                            start={{ x: 0.5, y: 0 }}
                            end={{ x: 0.5, y: 1 }}
                            style={{ height: DOCK_SCRIM_FADE_HEIGHT }}
                        />
                        <View style={{ flex: 1, backgroundColor: dockSurface }} />
                    </View>
                )}
                <View
                    onLayout={handleDockLayout}
                    pointerEvents="box-none"
                    style={{
                        position: 'absolute',
                        left: 0,
                        right: 0,
                        bottom: keyboardInset + dockBottomOffset,
                        zIndex: 2,
                    }}
                >
                    {input}
                </View>
            </View>
        );
    }

    return (
        <View style={{ flexBasis:0, flexGrow:1, paddingBottom: keyboardInset }}>
            <View style={{ flexBasis:0, flexGrow:1 }}>
                {content && (
                    <View style={[{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }]}>
                        {content}
                    </View>
                )}
                {placeholder && (
                    <ScrollView
                        style={[{ position: 'absolute', top: safeArea.top + headerHeight, left: 0, right: 0, bottom: 0 }]}
                        contentContainerStyle={{ alignItems: 'center', justifyContent: 'center', flex: 1 }}
                        keyboardShouldPersistTaps="handled"
                        alwaysBounceVertical={false}
                    >
                        {placeholder}
                    </ScrollView>
                )}
            </View>
            <View>
                {input}
            </View>
        </View>
    );
});

// const FallbackKeyboardAvoidingView: React.FC<AgentContentViewProps> = React.memo(({
//     children,
// }) => {
    
// });
