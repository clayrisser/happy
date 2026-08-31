import { Ionicons } from '@expo/vector-icons';
import * as React from 'react';
import { Platform, View, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { FAB_RADIUS, FAB_SIZE } from './glassChromeScreens';
import { GlassChromeSurface } from './GlassChromeControl';

const stylesheet = StyleSheet.create((theme, runtime) => ({
    container: {
        position: 'absolute',
        right: 16,
    },
    button: {
        borderRadius: FAB_RADIUS,
        width: FAB_SIZE,
        height: FAB_SIZE,
        padding: Platform.select({ web: 16, default: 0 }),
        overflow: 'visible',
        shadowColor: Platform.select({ web: theme.colors.shadow.color, default: 'transparent' }),
        shadowOffset: { width: 0, height: 2 },
        shadowRadius: Platform.select({ web: 3.84, default: 0 }),
        shadowOpacity: Platform.select({ web: theme.colors.shadow.opacity, default: 0 }),
        elevation: Platform.select({ web: 5, default: 0 }),
    },
    buttonDefault: {
        backgroundColor: Platform.select({ web: theme.colors.fab.background, default: 'transparent' }),
    },
    buttonPressed: {
        backgroundColor: Platform.select({ web: theme.colors.fab.backgroundPressed, default: 'transparent' }),
        opacity: Platform.select({ web: 1, default: 0.72 }),
        transform: Platform.select({ web: [], default: [{ scale: 0.97 }] }),
    },
    glass: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: FAB_RADIUS,
        overflow: 'hidden',
        shadowColor: theme.colors.glass.shadow,
        shadowOffset: { width: 0, height: 8 },
        shadowOpacity: Platform.select({ web: 0, default: 1 }),
        shadowRadius: 18,
        elevation: Platform.select({ android: 8, default: 0 }),
    },
}));

export const FAB = React.memo(({ onPress }: { onPress: () => void }) => {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const safeArea = useSafeAreaInsets();
    return (
        <View
            style={[
                styles.container,
                { bottom: safeArea.bottom + 16 }
            ]}
        >
            <Pressable
                style={({ pressed }) => [
                    styles.button,
                    pressed ? styles.buttonPressed : styles.buttonDefault
                ]}
                onPress={onPress}
            >
                {Platform.OS === 'web' ? (
                    <Ionicons name="add" size={24} color={theme.colors.fab.icon} />
                ) : (
                    /* The one control on the artifacts list that floats over
                       it, so it gets the same material as everything else that
                       floats (DROVE-161). It was on MobileGlassSurface's
                       default `clear` style, the barely-there material Apple
                       uses over photography, with no tint of its own.

                       THE TINT IS THE FIX, not decoration. `fab.icon` is white
                       on the light theme, because the web FAB is a black
                       circle; on a barely-there surface over a white list that
                       is a white glyph on white. The tint carries the colour
                       the button already had on to the material, which is how
                       the system draws a prominent glass button, and it is
                       what the fallback paints where there is no material. */
                    <GlassChromeSurface
                        radius={FAB_RADIUS}
                        tintColor={theme.colors.fab.background}
                        style={styles.glass}
                    >
                        <Ionicons name="add" size={24} color={theme.colors.fab.icon} />
                    </GlassChromeSurface>
                )}
            </Pressable>
        </View>
    )
});
