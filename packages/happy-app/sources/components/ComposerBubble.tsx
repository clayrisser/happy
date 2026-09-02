import * as React from 'react';
import { Pressable, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated from 'react-native-reanimated';
import { StyleSheet } from 'react-native-unistyles';
import { MobileGlassSurface } from './MobileGlass';
import { useGlassChromeMaterial } from './GlassChromeControl';
import {
    COMPOSER_BUBBLE_ACTION_ROW_GEOMETRY,
    COMPOSER_BUBBLE_GAP_GEOMETRY,
    COMPOSER_BUBBLE_GEOMETRY,
    COMPOSER_BUBBLE_SPACER_GEOMETRY,
    COMPOSER_BUBBLE_SURFACE,
    COMPOSER_BUBBLE_TEXT_ROW_GEOMETRY,
    resolveComposerBubbleSurfaceStyle,
    resolveComposerShellInteractive,
} from './composerBubbleLayout';

/**
 * THE COMPOSER, AS ONE COMPONENT BOTH SCREENS MOUNT (DROVE-345).
 *
 * Clay, on the new-session sheet: "on the homepage it's not properly using
 * liquid glass and this input is not using our liquid glass input that we have
 * everywhere else."
 *
 * It was two implementations of one thing. `AgentInput` drew the chat's
 * composer — a `liquid` `MobileGlassSurface`, the text row inside it, the
 * button row under the text — and `HomeDock` drew its own: a `frosted` surface
 * with a hairline border, a raw `TextInput`, a `BubblePressable` `+`, three
 * words for permission / model / effort, and a filled send disc. They shared
 * `agentInputLayout.ts`'s NUMBERS and nothing else, which is exactly why five
 * consecutive Liquid Glass tickets (DROVE-153, DROVE-266, DROVE-328,
 * DROVE-331, DROVE-343) each landed on the chat and left Home behind. A shared
 * constant does not carry a material.
 *
 * So the SHAPE lives here — the shell, the field's surface, the button row —
 * and each screen passes what it puts in the slots. That is the split that
 * makes a glass change land on both screens at once, and it is what
 * `composerParity.test.ts` holds: neither screen may mount the shell, the text
 * row's surface or the action row's geometry itself.
 *
 * THE TREE IS `composerBubbleLayout.ts`'S, resolved by the layout engine
 * rather than restated here (DROVE-214):
 *
 *   shell         column, padding `bubbleInset`, gap `controlGap`, glass that
 *                 asks UIKit for the press only while the text row is held
 *     textRow     a plain view — the bubble's press target, drawing nothing
 *     actionRow   leading ‖ gap ‖ controls ‖ gap ‖ trailing…, where `controls`
 *                 is the flexible child and a spacer stands in for it when
 *                 there are none (DROVE-353)
 *
 * WHY THE GAPS ARE CHILDREN rather than the row's `gap` property is on
 * `resolveComposerBubbleGapGeometry`: the row wants a fixed 6 in three places
 * and slack in exactly one, and `gap` cannot say that.
 *
 * THE ROWS ARE `Animated.View`s, and that is not decoration. Home reveals the
 * field and the button row on their own timings as the dock opens into the
 * sheet, so the styles it hands down are reanimated styles and have to land on
 * a view that can read one. The chat passes plain objects to the same props.
 */
export interface ComposerBubbleProps {
    /**
     * Whether the bubble is DRAWN.
     *
     * Off — desktop web, Mac Catalyst, a tablet-width canvas — the shell falls
     * back to the caller's own flat card, which is what `MobileGlassSurface`
     * does with `enabled={false}`. The chat's desktop composer is a different
     * arrangement entirely and keeps its own row.
     */
    enabled?: boolean;
    /** The caller's card styles: the desktop panel, a shadow, an animated height. */
    style?: StyleProp<ViewStyle>;
    /** Above the field, inside the shell: the attachment strip. */
    above?: React.ReactNode;
    /** The field itself. */
    children?: React.ReactNode;
    /** The field row's own style, over the geometry. */
    fieldStyle?: StyleProp<ViewStyle>;
    /** Painted over the whole bubble: a press blocker while a session starts. */
    overlay?: React.ReactNode;
    /** The leading control: the `+`. */
    leading?: React.ReactNode;
    /**
     * The session capsule, between the `+` and the mic. IT IS THE ROW'S SLACK
     * since DROVE-353, rather than something sitting beside it.
     */
    controls?: React.ReactNode;
    /**
     * Everything at the trailing end, in order, one `controlGap` between each:
     * the mic and send in the chat, send alone on Home. One `controlGap` from
     * the capsule too, with nothing in between — the empty band that used to
     * sit here is DROVE-353.
     */
    trailing?: React.ReactNode[];
    /** The action row's own style, over the geometry. */
    actionRowStyle?: StyleProp<ViewStyle>;
    /** Zen mode draws no button row at all. */
    showActionRow?: boolean;
    /**
     * THE WHOLE BUBBLE AS ONE BUTTON (DROVE-394).
     *
     * The sessions-list entry: the new-session sheet's composer, drawn at
     * rest, where a tap anywhere opens the sheet. With this set the rows take
     * no touches, the text row cannot lens the shell, and one `Pressable`
     * wraps the surface. Nothing inside changes shape for it, which is what
     * lets the entry and the sheet mount the same slots.
     */
    onPress?: () => void;
    /** What the one button is called, when `onPress` is set. */
    accessibilityLabel?: string;
}

const styles = StyleSheet.create(() => ({
    /**
     * THE BUBBLE'S OWN LAYOUT, from `composerBubbleLayout` rather than written
     * here (DROVE-214). A column of two rows with one padding all round, and
     * that padding is the only air anywhere inside it: the discs' margin, the
     * text's, the lot.
     *
     * Four padding LONGHANDS, because a caller's card style may set
     * `paddingVertical` / `paddingBottom` / `paddingHorizontal` and a shorthand
     * here loses to them however it is ordered. That leak shipped for two
     * tickets as a comment claiming zero padding over a style that never wrote
     * one.
     */
    shell: COMPOSER_BUBBLE_GEOMETRY,
    /**
     * The padding, applied AFTER the caller's style, as four longhands.
     *
     * Both callers hand down a card style, and a card style that sets
     * `paddingHorizontal` or `paddingVertical` beats a shorthand here however
     * it is ordered. That leak shipped for two tickets as a comment claiming
     * zero padding over a style that never wrote one, and it is exactly the
     * kind of thing a spec that resolves the GEOMETRY cannot see, because it
     * lives in the stylesheet. So the bubble's own padding goes on last and
     * the four sides are named, and `composerParity.test.ts` mounts it under a
     * hostile caller style to prove it.
     */
    shellPadding: {
        paddingTop: COMPOSER_BUBBLE_GEOMETRY.padding,
        paddingBottom: COMPOSER_BUBBLE_GEOMETRY.paddingBottom,
        paddingLeft: COMPOSER_BUBBLE_GEOMETRY.padding,
        paddingRight: COMPOSER_BUBBLE_GEOMETRY.padding,
    },
    textRow: COMPOSER_BUBBLE_TEXT_ROW_GEOMETRY,
    actionRow: COMPOSER_BUBBLE_ACTION_ROW_GEOMETRY,
    spacer: COMPOSER_BUBBLE_SPACER_GEOMETRY,
    gap: COMPOSER_BUBBLE_GAP_GEOMETRY,
}));

export function ComposerBubble({
    enabled = true,
    style,
    above,
    children,
    fieldStyle,
    overlay,
    leading,
    controls,
    trailing,
    actionRowStyle,
    showActionRow = true,
    onPress,
    accessibilityLabel,
}: ComposerBubbleProps) {
    /**
     * WHICH MATERIAL THE COMPOSER IS ACTUALLY ON (DROVE-343).
     *
     * The shell's `overflow` depends on it: on Liquid Glass nothing in the
     * composer may be clipped, because three surfaces inside it swell past
     * their resting frames; off it the flat card is the only thing rounding
     * what it holds. `getGlassSurfaceOverflow` is the rule and this is its
     * argument. The hook watches Reduce Transparency too, so a reader who has
     * turned the material off gets the clipped card rather than one pretending
     * to hold a swell that is not drawn.
     */
    const material = useGlassChromeMaterial();
    /**
     * WHETHER A FINGER IS ON THE TEXT ROW RIGHT NOW (DROVE-343, second pass).
     *
     * The shell's `isInteractive` follows it, so the bubble lenses and swells
     * under a press on the field and stays still under a press on the `+` or
     * the capsule. The handlers are on the text row's own view and nowhere
     * else, which is what makes a control press unable to set it.
     *
     * `onTouchStart` rather than a `Pressable`: the field is a `TextInput` and
     * takes the responder for itself, so a wrapping pressable would never see
     * the press. Touch events are dispatched along the path regardless of who
     * owns the responder, which is the one hook a text field leaves open.
     *
     * NOTHING MOUNTS OR UNMOUNTS FOR THIS. It is a prop on a view that is
     * already there, which is DROVE-286's rule: the press stream must never
     * ride a view the state can unmount, and the alternative — swapping a
     * glass host in on press — would do exactly that under the finger.
     */
    const [pressedTarget, setPressedTarget] = React.useState<'textRow' | null>(null);
    const releaseTextRow = React.useCallback(() => setPressedTarget(null), []);
    const holdTextRow = React.useCallback(() => setPressedTarget('textRow'), []);
    const gapped: React.ReactNode[] = [];
    (trailing ?? []).forEach((node, index) => {
        if (!node) return;
        if (gapped.length > 0) {
            gapped.push(<View key={`gap-${index}`} style={styles.gap} />);
        }
        gapped.push(<React.Fragment key={`trailing-${index}`}>{node}</React.Fragment>);
    });
    const surface = (
        <MobileGlassSurface
            enabled={enabled}
            // THE MATERIAL, AND THE PRESS, from one object (DROVE-328,
            // DROVE-343). `interactive` is deliberately NOT in there: the
            // effect view answers every touch delivered inside it, so while the
            // shell carried it a press on the `+` or on the capsule swelled the
            // whole bubble. The press is the text row's below.
            {...COMPOSER_BUBBLE_SURFACE}
            // THE PRESS, AND ONLY FOR THE FIELD (DROVE-343). `isInteractive`
            // is a property of the effect VIEW and answers every touch inside
            // it, so it cannot be scoped to a region — but it can be scoped in
            // TIME. It goes on when the text row is held and off when it is
            // released, and a touch that starts on a control never turns it on.
            // As one button (DROVE-394) it never goes on: the press is the
            // wrapper's, and the shell holds still under it.
            interactive={onPress ? false : resolveComposerShellInteractive(pressedTarget)}
            // One button takes every touch itself; nothing inside may answer.
            pointerEvents={onPress ? 'none' : undefined}
            style={[
                styles.shell,
                style,
                // The bubble's own padding, after the caller's card style and
                // as four longhands, so no card can shrink the air round the
                // field. See `shellPadding`.
                styles.shellPadding,
                // NEVER CLIPPED ON THE MATERIAL (DROVE-202, DROVE-328). The
                // shell holds three surfaces that swell — the text row, the
                // `+`, the capsule — so a clip would cut all three at the
                // bubble's edge. Off the material it still clips, because
                // there the flat card is the only thing rounding what it
                // holds. The answer goes on LAST so no caller can put the clip
                // back.
                enabled && resolveComposerBubbleSurfaceStyle(material === 'liquid'),
            ]}
        >
            {above}
            {/* THE TEXT ROW, AND THE BUBBLE'S PRESS TARGET (DROVE-343). Clay:
                "The input box should only get the touch effect when I'm
                touching where the text is."

                IT DRAWS NOTHING. The first pass gave it a nested
                `MobileGlassSurface` on the reasoning that glass inside glass
                has nothing left to refract (DROVE-254). The EFFECT does not,
                but the surface also paints `chromeGlassTint` — DROVE-171's
                tint, chosen so the composer separates from the chat behind it
                — and a white gradient over that, and a view mounted at rest
                draws at rest. Clay, on OTA 01a05f69: "What the hell happened
                here?" over a lighter panel filling the field. So this is a
                plain view again, and the press it owns is spent on the shell
                above for the length of the touch. */}
            <View
                style={[styles.textRow, fieldStyle]}
                onTouchStart={holdTextRow}
                onTouchEnd={releaseTextRow}
                onTouchCancel={releaseTextRow}
            >
                {children}
            </View>
            {overlay}
            {showActionRow ? (
                <Animated.View style={[styles.actionRow, actionRowStyle]}>
                    {leading}
                    {leading && controls ? <View style={styles.gap} /> : null}
                    {controls}
                    {controls ? <View style={styles.gap} /> : null}
                    {/* THE SPACER ONLY WHEN THERE IS NO CAPSULE TO BE IT
                        (DROVE-353). The capsule takes `flex: 1` now, so it is
                        the row's flexible child and the gap above really is
                        the gap to the mic. Mounting a second `flex: 1` child
                        beside it would SPLIT the slack, which is the band Clay
                        photographed at half width. With no controls — zen
                        mode, Home before the dock opens — this is what still
                        holds send at the trailing end rather than sliding it
                        to the leading one. */}
                    {controls ? null : <View style={styles.spacer} />}
                    {gapped}
                </Animated.View>
            ) : null}
        </MobileGlassSurface>
    );
    if (!onPress) return surface;
    return (
        <Pressable
            onPress={onPress}
            accessibilityRole="button"
            accessibilityLabel={accessibilityLabel}
        >
            {surface}
        </Pressable>
    );
}
