import * as React from 'react';
import { Platform, StyleProp, StyleSheet as RNStyleSheet, View, ViewProps, ViewStyle } from 'react-native';
import { BlurView } from 'expo-blur';
import { GlassView, isGlassEffectAPIAvailable, type GlassStyle } from 'expo-glass-effect';
import { LinearGradient } from 'expo-linear-gradient';
import { useUnistyles } from 'react-native-unistyles';
import { isRunningOnMac } from '@/utils/platform';
import { chromeGlassTint } from './glassChrome';
import { getGlassSurfaceOverflow, getNativeGlassInteractivity } from './glassInteractionPolicy';
import { GlassPressProvider } from './glassPress';

type MobileGlassMaterial = 'liquid' | 'static' | 'frosted';

type MobileGlassSurfaceProps = ViewProps & {
    enabled?: boolean;
    intensity?: number;
    /**
     * Ask `UIGlassEffect` for its own press response. An interactive surface
     * is never clipped, whatever it holds (DROVE-202, DROVE-328): the effect
     * answers a touch anywhere inside it by swelling past its resting frame,
     * and `overflow: 'hidden'` on the host turns that swell into a hard edge.
     * There was a `pressTarget` prop here for one ticket (DROVE-266) that let
     * the composer card keep its clip on the theory that nobody presses the
     * card; Clay photographed the card clipped mid-swell, and the prop is
     * gone. `getGlassSurfaceOverflow` has the argument.
     */
    interactive?: boolean;
    nativeEffect?: boolean;
    material?: MobileGlassMaterial;
    glassEffectStyle?: GlassStyle;
    tintColor?: string;
    style?: StyleProp<ViewStyle>;
};

// Header chrome is the only consumer of the static material. Letting more blur
// through, and painting less flat tint over it, is what makes these controls
// read as glass rather than as filled circles.
const STATIC_MATERIAL_BLUR_CAP = 44;

/**
 * Performance-aware material surface. `nativeControls.ts` Rule 6 is the short
 * version of which material to ask for and why; this is the implementation.
 *
 * Interactive controls and explicit
 * `nativeEffect` surfaces use Liquid Glass/material blur; `material="static"`
 * opts into a calm, non-refractive blur without the Liquid Glass highlight.
 * `material="frosted"` adds a denser tint and blur for writing surfaces where
 * background content must not compete with the foreground text.
 * Content surfaces remain opaque so glass stays a distinct functional layer.
 *
 * `interactive` used to mean "wrap this in a reanimated scale" (DROVE-169). It
 * now means what it says: ask `UIGlassEffect` for its own press response. The
 * spring it replaced was the imitation Clay was looking at, and scaling a
 * `GlassView` is also what produced the refractive blob the old comment
 * described. There is no animated variant of this component any more, because
 * nothing here animates.
 */
export function MobileGlassSurface({
    enabled = Platform.OS !== 'web' && !isRunningOnMac(),
    intensity = 72,
    interactive = false,
    nativeEffect = interactive,
    material = 'liquid',
    glassEffectStyle = 'clear',
    tintColor,
    style,
    children,
    ...props
}: MobileGlassSurfaceProps) {
    const { theme } = useUnistyles();
    const usesStaticMaterial = nativeEffect && material === 'static';
    const usesFrostedMaterial = nativeEffect && material === 'frosted';
    // An interactive surface stops clipping its children (DROVE-202), so the
    // full-bleed overlay has to round its own corners instead of borrowing the
    // parent's clip. Read off the caller's style rather than taken as a prop,
    // because every caller already says it there.
    const surfaceRadius = RNStyleSheet.flatten(style)?.borderRadius;

    if (!enabled || Platform.OS === 'web' || isRunningOnMac()) {
        return <View {...props} style={style}>{children}</View>;
    }

    // Liquid Glass is navigation chrome, not a general card background. Keeping
    // content opaque also avoids compositing dozens of translucent layers.
    if (!nativeEffect) {
        return (
            <View {...props} style={[{ backgroundColor: theme.colors.surface }, style]}>
                {children}
            </View>
        );
    }

    const surfaceOverlay = usesStaticMaterial || usesFrostedMaterial ? (
        <View
            pointerEvents="none"
            style={[
                RNStyleSheet.absoluteFill,
                {
                    backgroundColor: theme.dark
                        ? usesFrostedMaterial ? 'rgba(20, 20, 22, 0.82)' : 'rgba(44, 44, 47, 0.40)'
                        : usesFrostedMaterial ? 'rgba(255, 255, 255, 0.82)' : 'rgba(0, 0, 0, 0.024)',
                    borderRadius: usesStaticMaterial ? 999 : surfaceRadius,
                },
            ]}
        />
    ) : (
        <LinearGradient
            pointerEvents="none"
            colors={theme.dark
                ? ['rgba(255,255,255,0.12)', 'rgba(255,255,255,0.018)', 'rgba(255,255,255,0.055)']
                : ['rgba(255,255,255,0.76)', 'rgba(255,255,255,0.10)', 'rgba(255,255,255,0.42)']}
            locations={[0, 0.48, 1]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={[RNStyleSheet.absoluteFill, { borderRadius: surfaceRadius }]}
        />
    );

    // Header controls need two separate layers: an unclipped shell for the
    // material shadow, and a clipped glass view for the live backdrop. Putting
    // both jobs on one `overflow: hidden` view is why the old controls looked
    // flat even though they technically contained a blur.
    if (Platform.OS === 'ios' && usesStaticMaterial) {
        const staticMaterial = (
            <BlurView
                pointerEvents="none"
                intensity={Math.min(intensity, STATIC_MATERIAL_BLUR_CAP)}
                tint={theme.dark ? 'systemUltraThinMaterialDark' : 'systemUltraThinMaterialLight'}
                style={styles.staticMaterialClip}
            >
                {surfaceOverlay}
            </BlurView>
        );

        return (
            <View {...props} style={[style, styles.staticMaterialShell]}>
                {staticMaterial}
                {children}
            </View>
        );
    }

    // The tint is the chrome tint, not `theme.colors.glass.tint` (DROVE-171).
    // That token is `rgba(16, 16, 16, 0.08)` on the dark theme, a near-black
    // wash over a black chat: composited it lands on rgb(1, 1, 1), 1.008:1
    // from its own ground, which is why the composer read as a smudge.
    if (Platform.OS === 'ios' && isGlassEffectAPIAvailable() && material === 'liquid') {
        return (
            <GlassView
                {...props}
                glassEffectStyle={glassEffectStyle}
                colorScheme={theme.dark ? 'dark' : 'light'}
                tintColor={tintColor ?? chromeGlassTint(theme.dark)}
                isInteractive={getNativeGlassInteractivity(interactive, isGlassEffectAPIAvailable())}
                // An interactive surface has to be free to swell past its
                // resting frame on press, and a caller that clipped it turned
                // that swell into an inner zoom (DROVE-202). The answer goes
                // on LAST so the caller's style cannot put the clip back,
                // which is what the composer card's desktop style tries to do
                // (DROVE-328). A surface nothing lands on keeps whatever
                // clipping it asked for.
                style={[style, interactive && { overflow: getGlassSurfaceOverflow(true) }]}
            >
                {surfaceOverlay}
                <GlassPressProvider value={interactive}>
                    {children}
                </GlassPressProvider>
            </GlassView>
        );
    }

    if (Platform.OS === 'ios') {
        return (
            <BlurView
                {...props}
                intensity={Math.min(intensity, usesFrostedMaterial ? 42 : usesStaticMaterial ? STATIC_MATERIAL_BLUR_CAP : 36)}
                tint={theme.dark ? 'systemUltraThinMaterialDark' : 'systemUltraThinMaterialLight'}
                style={style}
            >
                {surfaceOverlay}
                {children}
            </BlurView>
        );
    }

    return (
        <View
            {...props}
            style={[{ backgroundColor: theme.colors.glass.background }, style]}
        >
            {surfaceOverlay}
            {children}
        </View>
    );
}

export function MobileGlassBackdrop({ enabled = Platform.OS !== 'web' && !isRunningOnMac() }: { enabled?: boolean }) {
    const { theme } = useUnistyles();

    if (!enabled || isRunningOnMac()) {
        return null;
    }

    return (
        <View pointerEvents="none" style={RNStyleSheet.absoluteFill}>
            <LinearGradient
                colors={theme.colors.glass.backdrop}
                locations={[0, 0.52, 1]}
                start={{ x: 0.05, y: 0 }}
                end={{ x: 0.95, y: 1 }}
                style={RNStyleSheet.absoluteFill}
            />
            <View
                style={[
                    styles.glow,
                    styles.primaryGlow,
                    { backgroundColor: theme.colors.glass.glowPrimary },
                ]}
            />
            <View
                style={[
                    styles.glow,
                    styles.secondaryGlow,
                    { backgroundColor: theme.colors.glass.glowSecondary },
                ]}
            />
        </View>
    );
}

const styles = RNStyleSheet.create({
    staticMaterialShell: {
        overflow: 'visible',
    },
    staticMaterialClip: {
        ...RNStyleSheet.absoluteFillObject,
        borderRadius: 999,
        overflow: 'hidden',
    },
    glow: {
        position: 'absolute',
        borderRadius: 999,
    },
    primaryGlow: {
        width: 280,
        height: 280,
        top: -96,
        right: -116,
    },
    secondaryGlow: {
        width: 320,
        height: 320,
        bottom: -148,
        left: -156,
    },
});
