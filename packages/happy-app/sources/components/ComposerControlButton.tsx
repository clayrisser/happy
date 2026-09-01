import * as React from 'react';
import { StyleSheet as RNStyleSheet, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';
import { BubblePressable } from './BubblePressable';
import { GlassChromeButton } from './GlassChromeControl';
import { MOBILE_COMPOSER_BUBBLE_CONTROL_SIZE, MOBILE_COMPOSER_METRICS } from './agentInputLayout';
import { composerGlassTint } from './composerControlColour';

/**
 * A COMPOSER CONTROL, WHICH IS THE HEADER'S LIQUID GLASS BUTTON AT A SMALLER
 * SIZE (DROVE-266).
 *
 * Clay, for the second time and sharper: "you can make the buttons in the
 * speech bubble a little bigger and also make them behave like liquid glass
 * buttons I already told you that stop doing your custom buttons shouldn't they
 * just be smaller liquid glass buttons".
 *
 * The middle clause is the correction and it is taken literally. The previous
 * answer turned `UIGlassEffect.isInteractive` on for the BUBBLE and then
 * reasoned that the controls wearing an opaque fill could not benefit, because
 * a fill covers the material there is nothing left to lens. That reasoning is
 * sound about the fill and it answers the wrong question: the controls were
 * still plain `View`s with a `backgroundColor` and a hand-rolled `withSpring`
 * scale, so what they lacked was not lensing, it was BEING A BUTTON. A glass
 * button is a `UIVisualEffectView` that UIKit deforms, brightens, shadows and
 * springs on its own schedule. None of that arrives by turning a flag on two
 * levels up.
 *
 * The last clause is the design, handed over rather than invented here: they
 * are the SAME control at a smaller size. So this is `GlassChromeButton` with
 * the composer's size and the composer's fill, not a second implementation of
 * it. `nativeControls.ts` Rule 2 already said one glass implementation, and
 * DROVE-134 dropped the SwiftUI-button escape hatch for exactly the reason this
 * would have hit: two glass paths draw visibly different surfaces side by side.
 *
 * TWO FACES, AND THE SPLIT IS THE FILL RATHER THAN THE CONTROL.
 *
 *   `fill` set     The `+`, the audio-out disc, the mic once it is open, the
 *                  pause disc. A `GlassChromeButton` tinted with that fill.
 *                  The fill is spent as `UIGlassEffect.tintColor`, which is how
 *                  the system draws a prominent glass button, and
 *                  `composerGlassTint` refuses anything translucent so
 *                  DROVE-254's measurement survives the control becoming a real
 *                  material.
 *   `fill` unset   Send, and the mic at rest. DROVE-264 and DROVE-254 took
 *                  their circles off and that is Clay's standing instruction,
 *                  so there is no surface of their own to draw. They are bare
 *                  glyphs standing ON the bubble's glass, and the bubble is
 *                  interactive, so the press they get is still the platform's.
 *                  A second glass shape here would be the circle he removed.
 *
 * WHAT THIS DELETES. `resolveComposerPressResponse` and BubblePressable's
 * `nativeGlassPress` override, both from the first half of this ticket. They
 * existed to decide which controls kept a hand-rolled 0.7 fade because their
 * opaque fill hid the material. Nothing keeps that fade now: a filled control
 * is a glass button and `GlassChromeButtonContent` already stands the fade down
 * on the material and keeps it off it, which is DROVE-169's rule reaching the
 * composer at last instead of being reasoned around.
 */
export interface ComposerControlButtonProps extends Omit<PressableProps, 'style' | 'children'> {
    /**
     * The control's OPAQUE fill, or nothing for a bare glyph on the bubble.
     *
     * Opaque is enforced rather than documented: `composerGlassTint` throws on
     * anything else. DROVE-254's bug was a translucent tint reaching this prop
     * with nothing in the way.
     */
    fill?: string | null;
    /** Drawn size. The composer's own, never the header's 44. */
    size?: number;
    /** Capsules override this; a disc leaves it alone. */
    width?: number;
    style?: StyleProp<ViewStyle>;
    children?: React.ReactNode;
}

export function ComposerControlButton({
    fill,
    size = MOBILE_COMPOSER_BUBBLE_CONTROL_SIZE,
    width,
    style,
    children,
    ...pressable
}: ComposerControlButtonProps) {
    if (fill) {
        return (
            <GlassChromeButton
                size={size}
                width={width}
                tintColor={composerGlassTint(fill)}
                // One separation mechanism, measured (DROVE-254). The chrome
                // fallback draws a hairline round its flat surface and these
                // discs do not: the fill is what makes them read, and an edge
                // covering for it would be a second answer to one question.
                rim={false}
                hitSlop={MOBILE_COMPOSER_METRICS.primaryActionSlop}
                // `flexShrink: 0`, which every disc on this row carried in
                // `resolveMobileComposerActionGeometry` and which
                // `GlassChromeButton` does not assume. Without it a row that
                // overflows squashes the buttons instead of overflowing, which
                // would hide the very failure `composerBubbleLayout.spec.ts`
                // measures at 320.
                style={[styles.disc, style]}
                {...pressable}
            >
                {children}
            </GlassChromeButton>
        );
    }
    return (
        <BubblePressable
            hitSlop={MOBILE_COMPOSER_METRICS.primaryActionSlop}
            {...pressable}
            style={[
                styles.bare,
                styles.disc,
                { width: width ?? size, height: size, borderRadius: (width ?? size) / 2 },
                style,
            ]}
        >
            {children}
        </BubblePressable>
    );
}

const styles = RNStyleSheet.create({
    disc: {
        flexShrink: 0,
    },
    bare: {
        alignItems: 'center',
        justifyContent: 'center',
    },
});
