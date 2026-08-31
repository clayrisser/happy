import * as React from 'react';
import {
    AccessibilityInfo,
    Platform,
    Pressable,
    StyleSheet as RNStyleSheet,
    View,
    type PressableProps,
    type StyleProp,
    type ViewProps,
    type ViewStyle,
} from 'react-native';
import { GlassView, isGlassEffectAPIAvailable } from 'expo-glass-effect';
import { useUnistyles } from 'react-native-unistyles';
import { isRunningOnMac } from '@/utils/platform';
import {
    CHROME_GLASS_STYLE,
    CHROME_TARGET_MIN,
    chromeGlassTint,
    resolveGlassChromeMaterial,
    type GlassChromeMaterial,
} from './glassChrome';
import { getNativeGlassInteractivity } from './glassInteractionPolicy';
import { GlassPressProvider, useNativeGlassPress } from './glassPress';

/**
 * The session chrome's material, and the answer to the wall DROVE-133 hit
 * (DROVE-153).
 *
 * THE POLICY THIS IS AN INSTANCE OF is `nativeControls.ts`: when to reach for a
 * platform control, what can and cannot host React Native content, and the
 * material rules restated in one place. Read that before adding a control.
 *
 * THE WALL, AND WHY IT WAS THE WRONG DOOR. DROVE-133 made the back chevron and
 * the jump-to-bottom arrow native with a since-deleted `NativeGlassIconButton`,
 * which was `@expo/ui`'s SwiftUI `Button` with `.glass`. It then stopped, because the
 * title pill and the avatar carry React Native content and a SwiftUI Button
 * renders SwiftUI children only. That is true, and it is not the wall it looks
 * like: the SwiftUI button was never the only way to get the material.
 *
 * `GlassView` from `expo-glass-effect` is an `ExpoView` whose
 * `mountChildComponentView` inserts each child into a
 * `UIVisualEffectView.contentView` carrying a `UIGlassEffect`. Children are
 * ordinary React Native views, so a two-line pill, a generated avatar, an SVG
 * meter and a `Pressable` all mount inside the real material without going
 * anywhere near SwiftUI. The rule to remember: reach for `GlassView` for the
 * MATERIAL and keep the gesture in React Native. DROVE-134 went one step
 * further and dropped the SwiftUI-button escape hatch entirely: a second glass
 * implementation drew a visibly different surface next to its neighbours, and
 * the case for it never arrived. `nativeControls.ts` Rule 2.
 *
 * FALLBACK. Anything that is not iOS 26 with the glass API present, plus
 * anyone who has turned Reduce Transparency on, gets the flat surface the app
 * drew before this ticket. That is the one requirement with no room in it: a
 * control that degrades to an invisible surface over a chat is worse than a
 * control that never looked like glass.
 */

/** Reduce Transparency, watched rather than sampled once. */
function useReduceTransparency(): boolean {
    const [reduced, setReduced] = React.useState(false);
    React.useEffect(() => {
        let live = true;
        AccessibilityInfo.isReduceTransparencyEnabled()
            .then((value) => {
                if (live) {
                    setReduced(value);
                }
            })
            .catch(() => {});
        const subscription = AccessibilityInfo.addEventListener(
            'reduceTransparencyChanged',
            setReduced,
        );
        return () => {
            live = false;
            subscription.remove();
        };
    }, []);
    return reduced;
}

export function useGlassChromeMaterial(): GlassChromeMaterial {
    const reduceTransparency = useReduceTransparency();
    // The API check asks the platform for its version and cannot change while
    // the app runs, so it is safe outside the memo's dependency list.
    return React.useMemo(
        () => resolveGlassChromeMaterial({
            platform: Platform.OS,
            glassApiAvailable: isGlassEffectAPIAvailable(),
            runningOnMac: isRunningOnMac(),
            reduceTransparency,
        }),
        [reduceTransparency],
    );
}

export interface GlassChromeSurfaceProps {
    /**
     * The blue that carries meaning stays blue. On the material it is
     * `UIGlassEffect.tintColor`, which is how the system draws a prominent
     * glass button; on the fallback it is the fill. Either way the control is
     * still the colour it was, because the colour is the message.
     *
     * Left out, the surface takes the measured chrome tint for its theme
     * (DROVE-171) rather than no tint at all, which over a black chat drew a
     * surface 1.008:1 from its own ground.
     */
    tintColor?: string;
    /**
     * Ask `UIGlassEffect` for its own press response (DROVE-169). Set it on
     * anything a finger lands on, including a capsule holding several
     * segments: the effect follows the touch inside itself, so one interactive
     * capsule is how the system draws a grouped control, not one per segment.
     */
    interactive?: boolean;
    /** Corner radius, on the effect view as well as the frame. */
    radius: number;
    style?: StyleProp<ViewStyle>;
    children?: React.ReactNode;
    pointerEvents?: ViewStyle['pointerEvents'];
    onLayout?: ViewProps['onLayout'];
}

/**
 * One control's worth of material.
 *
 * `glassEffectStyle` is `regular`, never `clear`. `clear` is the barely-there
 * material Apple uses over photography; over a black chat it draws close to
 * nothing, which is the same complaint in a different guise. `colorScheme` is
 * forced to the app's theme rather than left on `auto`, so a light chat behind
 * a dark-theme composer cannot flip the control's fill out from under a white
 * glyph.
 */
export function GlassChromeSurface({
    tintColor,
    interactive = false,
    radius,
    style,
    children,
    pointerEvents,
    onLayout,
}: GlassChromeSurfaceProps) {
    const { theme } = useUnistyles();
    const material = useGlassChromeMaterial();

    if (material === 'liquid') {
        return (
            <GlassView
                pointerEvents={pointerEvents}
                onLayout={onLayout}
                glassEffectStyle={CHROME_GLASS_STYLE}
                colorScheme={theme.dark ? 'dark' : 'light'}
                tintColor={tintColor ?? chromeGlassTint(theme.dark)}
                isInteractive={getNativeGlassInteractivity(interactive, isGlassEffectAPIAvailable())}
                style={[{ borderRadius: radius, overflow: 'visible' }, style]}
            >
                <GlassPressProvider value={interactive}>
                    {children}
                </GlassPressProvider>
            </GlassView>
        );
    }

    return (
        <View
            pointerEvents={pointerEvents}
            onLayout={onLayout}
            style={[
                {
                    borderRadius: radius,
                    backgroundColor: tintColor ?? theme.colors.surfaceHigh,
                    borderWidth: RNStyleSheet.hairlineWidth,
                    borderColor: theme.colors.glass.border,
                    overflow: 'hidden',
                },
                style,
            ]}
        >
            {children}
        </View>
    );
}

export interface GlassChromeButtonProps extends Omit<PressableProps, 'style' | 'children'> {
    /**
     * Drawn size. Defaults to the 44pt floor rather than to whatever fits,
     * because Clay's complaint was about the DRAWN size: a 42pt disc with 6pt
     * of invisible slop passes the HIG and still reads small beside a system
     * app.
     */
    size?: number;
    /** Capsules override this; a circle leaves it alone. */
    width?: number;
    radius?: number;
    tintColor?: string;
    style?: StyleProp<ViewStyle>;
    children?: React.ReactNode;
}

/**
 * A round or capsule chrome button in the material, with React Native content.
 *
 * The `Pressable` is INSIDE the surface and fills it, so what is drawn and what
 * answers a touch are the same rectangle. That was the other half of DROVE-133:
 * the avatar was a 28pt target sitting in the middle of a 44pt capsule.
 */
export function GlassChromeButton({
    size = CHROME_TARGET_MIN,
    width,
    radius,
    tintColor,
    style,
    children,
    ...pressable
}: GlassChromeButtonProps) {
    const frameWidth = width ?? size;
    const cornerRadius = radius ?? Math.min(frameWidth, size) / 2;
    return (
        <GlassChromeSurface
            radius={cornerRadius}
            tintColor={tintColor}
            interactive={!pressable.disabled}
            style={[{ width: frameWidth, height: size }, style]}
        >
            <GlassChromeButtonContent cornerRadius={cornerRadius} pressable={pressable}>
                {children}
            </GlassChromeButtonContent>
        </GlassChromeSurface>
    );
}

/**
 * Split out only so it sits INSIDE the surface and can read whether the
 * material is drawing the press (DROVE-169).
 *
 * On the material the `Pressable` still dispatches the tap and draws nothing:
 * `UIGlassEffect.isInteractive` brightens and deforms the surface under the
 * finger, and an `opacity: 0.6` layered on top of that is the custom fade the
 * ticket is about. Off the material there is no platform response to suppress,
 * so the fade stays and a device without Liquid Glass still shows a pressed
 * state rather than nothing.
 */
function GlassChromeButtonContent({
    cornerRadius,
    pressable,
    children,
}: {
    cornerRadius: number;
    pressable: Omit<PressableProps, 'style' | 'children'>;
    children?: React.ReactNode;
}) {
    const nativePress = useNativeGlassPress();
    return (
        <Pressable
            {...pressable}
            style={({ pressed }) => ({
                width: '100%',
                height: '100%',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: cornerRadius,
                opacity: !nativePress && pressed && !pressable.disabled ? 0.6 : 1,
            })}
        >
            {children}
        </Pressable>
    );
}
