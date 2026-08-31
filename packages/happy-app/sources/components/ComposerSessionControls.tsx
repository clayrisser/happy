import * as React from 'react';
import { StyleSheet as RNStyleSheet, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import Svg, { Circle, Line, Path } from 'react-native-svg';
import { Typography } from '@/constants/Typography';
import { BubblePressable } from './BubblePressable';
import { GlassChromeSurface } from './GlassChromeControl';
import { shouldDrawPressedFallback } from './glassInteractionPolicy';
import { useNativeGlassPress } from './glassPress';
import {
    effortAccessibility,
    effortGaugeAngle,
    effortGaugePoint,
    effortGaugeTrackPath,
    permissionModeAccessibility,
    permissionModeGlyph,
} from './sessionControlGlyphs';
import {
    composerControlPalette,
    composerGaugeTrack,
    composerGlyphColour,
    pendingOrSettled,
} from './composerControlColour';
import {
    COMPOSER_MODEL_SEGMENT,
    COMPOSER_SESSION_CONTROL_SIZE,
    type SessionPillLabel,
} from './sessionPillLabel';
import type { EffortSliderHandle } from './EffortSliderPopover';

/**
 * Permission mode, effort and model, folded into the composer's button row
 * (DROVE-111).
 *
 * DROVE-83 gave the three a row of their own, one pill reading
 * `Yolo · Opus 5 1M · High` that opened a sheet listing them again. Clay drew
 * an arrow from that row down into the button row, then said of the sheet:
 * "I don't like this extra menu, then I have to click twice." So the row is
 * the menu: each control opens its own picker on the first tap, and there is
 * no intermediate menu anywhere in the path.
 *
 * ONE CAPSULE (DROVE-153). Clay sent the Screenshot markup toolbar as a
 * reference and the thing to take from it is not the pixel size, it is that
 * related actions share ONE capsule rather than sitting in separate circles.
 * Mode and effort are the same idea twice over: how this session is being run.
 * So they are one glass capsule with a hairline between them, not two discs
 * with air between them. Each segment is its own 44pt-tall, 44pt-wide press
 * target with its own picker, so pressing effort cannot open the mode list.
 *
 * AND THE MODEL IS THE THIRD SEGMENT (DROVE-178). It was here, DROVE-138 took
 * it to the status row because six 63pt buttons were cutting `Opus 5 1M` to
 * `Opus 5...`, and DROVE-153 then collapsed the row to three objects and freed
 * the gap Clay drew his arrow into. The history is written out in
 * sessionPillLabel.ts so nobody flips it a fourth time. Here it is one more
 * segment inside the same capsule and the same interactive surface: mode,
 * effort, model, in that order, each its own picker on the first tap. The name
 * is drawn smaller before it is ever cut.
 *
 * AND EFFORT IS A SLIDER (DROVE-200). Its segment is the only one that does
 * not open a list on a DRAG: pressing it raises a horizontal line above the
 * row and the same touch drags along it, one stop per level, committing on
 * release. The dial in the segment is untouched — it is still DROVE-141's
 * resting glyph with DROVE-176's ramp on its needle — but while a drag is
 * running the needle follows the thumb, so the two never disagree. The whole
 * rule set is in effortSlider.ts; this file only hands it the touch.
 *
 * AND ALL THREE ARE SHEETS (DROVE-242). Mode and model were iOS native menus
 * here until Clay, with one of them open: "Shouldn't these show in sheets like
 * the effort does". They were left as menus deliberately, on the grounds that
 * they were system-owned, and that is exactly what was wrong with them: a
 * menu UIKit places and UIKit dismisses is outside composerPicker.ts's
 * placement rule and outside its dismissal state machine, so a second tap on
 * the control could not close it because the control never saw the tap. This
 * file no longer knows what platform it is on. Every segment is a press that
 * reports its picker, and the sheet is what draws it.
 *
 * A TAP ON IT IS STILL THE PICKER, LIKE THE OTHER TWO (DROVE-229). A press
 * that never moved reports a tap and the hook calls `onTap`, which the control
 * row turns into `handlePickerPress('effort')` — the same full-width sheet the
 * mode and the model open, with the same second tap, tap outside and back
 * gesture. It used to LATCH the readout open instead, which is the one surface
 * on the composer a second tap could not put away.
 *
 * THE READOUT IS NOT DRAWN HERE. It spans the composer's whole width, which is
 * wider than this capsule, so the control row places it (DROVE-229). This file
 * hands the hook the touch and reads its live index for the needle.
 *
 * COLOUR CARRIES THE STATE TOO (DROVE-176). The padlock is the warning amber
 * when open, the shield and the eye have their own hues, and the dial's needle
 * warms from the floor to the ceiling. The model's name stays neutral, because
 * a name is not a state and a coloured word beside coloured glyphs would
 * compete with the state they carry. composerControlColour.ts decides and
 * measures every one of those; nothing here picks a colour.
 *
 * AND A PICK THAT HAS NOT LANDED IS DRAWN AS ONE (DROVE-217). The value moves
 * the instant it is tapped, and the control takes the `pending` colour until
 * the terminal confirms it. Clay: "It seems that the effort is actually
 * updating now but there's like a huge delay so it feels weird." It is a median
 * of about two seconds and a tail past a minute, measured off his own logs, and
 * a two-second change and a sixty-second change used to look identical. All
 * three segments, one rule — model and permission mode lag exactly as effort
 * does. The rule for WHEN a pick is pending is in sync/agentModeRequests.ts;
 * this file only draws it.
 */

export type ComposerSessionPicker = 'permission' | 'model' | 'effort';

export interface ComposerSessionControlsProps {
    label: SessionPillLabel;
    /** Which permission mode, for the glyph. Falls back to the mode's key. */
    modeKind?: string | null;
    modeKey?: string | null;
    /** Where the effort sits on the scale this model offers, and how long that scale is. */
    effortIndex?: number | null;
    effortCount?: number;
    /** Opens a picker directly. Absent means none of the three is settable here. */
    onPress?: (picker: ComposerSessionPicker) => void;
    /**
     * Which of the three the session will actually take a pick for
     * (DROVE-242).
     *
     * It used to be read off the native menu groups that were handed in, which
     * carried availability by accident of also carrying the rows. The rows are
     * the sheet's now, so this says the one thing the capsule needs: a segment
     * with no handler behind it is drawn and does not press. Absent, or absent
     * for one field, means that field opens.
     */
    canOpen?: { permission?: boolean; effort?: boolean; model?: boolean };
    /** Which picker is open, so the pressed control reads as open. */
    openPicker?: ComposerSessionPicker | null;
    /**
     * The effort slider (DROVE-200). Present on the phone, where effort is
     * dragged as well as picked; absent on a surface that only lists it, and
     * then the effort segment is an ordinary picker segment.
     */
    effortSlider?: EffortSliderHandle | null;
    /**
     * Which segments hold a pick the terminal has not confirmed yet
     * (DROVE-217). Absent means everything shown is what the session is
     * actually running, which is the ordinary state.
     */
    pending?: { permission?: boolean; effort?: boolean; model?: boolean } | null;
}

/** What VoiceOver adds while a pick is in flight, since colour reaches nobody there. */
export function unconfirmedAccessibilityValue(value: string | undefined, pending: boolean): string | undefined {
    if (!pending) return value;
    return value ? `${value}, not confirmed by the terminal yet` : 'not confirmed by the terminal yet';
}

/**
 * The effort as a dial, the needle at the level (DROVE-141).
 *
 * It was a bar meter, and the lane that built it already named the flaw: four
 * filled bars against five is a COUNT, and nobody counts at a glance, so the
 * two levels Clay moves between most were the two hardest to tell apart. A
 * needle is a POSITION. Hard left is the floor, hard right the ceiling, and
 * the angle between them is read rather than counted.
 *
 * The angle is interpolated across whatever scale the current model offers, so
 * a four-level Codex and a six-level Claude both use the whole dial and the
 * ends always mean the ends (DROVE-101). The exact word is one tap away in the
 * picker, and in the accessibility value without one.
 *
 * BOTH MARKS ARE THE FOREGROUND, at two strengths (DROVE-215, DROVE-227). The
 * needle is the foreground itself, because a level is a value and the angle
 * was always the reading the dial was chosen for. The track is the foreground
 * at a reduced opacity, which is a two-sided measurement rather than a taste:
 * it has to separate from the capsule it is drawn on AND stay under the needle
 * it is read against. `composerGaugeTrack` owns the number and
 * composerControlColour.spec.ts asserts both floors on both themes.
 *
 * It shipped once with the track at `theme.colors.divider`, which measures
 * 1.05:1 on the dark glass. Clay: "This icon isn't contrasting." That is the
 * whole of DROVE-227: a gauge with an invisible dial is a floating diagonal.
 */
export function EffortGauge(props: { index: number; count: number; color: string; track: string }) {
    const size = 20;
    const strokeWidth = 2;
    const centre = size / 2;
    const angle = effortGaugeAngle(props.index, props.count);
    // Stops short of the track so the needle reads as pointing AT a position
    // rather than as another piece of the ring.
    const tip = effortGaugePoint(centre, (size - strokeWidth) / 2 - 3, angle);
    return (
        <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
            <Path
                d={effortGaugeTrackPath(size, strokeWidth)}
                stroke={props.track}
                strokeWidth={strokeWidth}
                strokeLinecap="round"
                fill="none"
            />
            <Line
                x1={centre}
                y1={centre}
                x2={tip.x}
                y2={tip.y}
                stroke={props.color}
                strokeWidth={2.25}
                strokeLinecap="round"
            />
            <Circle cx={centre} cy={centre} r={1.8} fill={props.color} />
        </Svg>
    );
}

const styles = StyleSheet.create((theme) => ({
    // The capsule the segments share. The material is the surface's, so this
    // carries only shape and flex. It shrinks only through the model segment,
    // which is the one part of it with a width of its own (DROVE-178); the
    // glyph segments stay 44pt whatever happens.
    capsule: {
        flexDirection: 'row',
        alignItems: 'center',
        flexShrink: 1,
        minWidth: 0,
        height: COMPOSER_SESSION_CONTROL_SIZE,
    },
    control: {
        width: COMPOSER_SESSION_CONTROL_SIZE,
        height: COMPOSER_SESSION_CONTROL_SIZE,
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
    },
    /**
     * The model's name: as wide as the name, and the only thing in the capsule
     * that can give way, after the spacer beside it has (DROVE-178).
     * `flexShrink: 1` with `minWidth: 0` is what lets the text inside scale
     * rather than push the audio capsule off the row.
     */
    modelSegment: {
        height: COMPOSER_SESSION_CONTROL_SIZE,
        paddingHorizontal: COMPOSER_MODEL_SEGMENT.paddingHorizontal,
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 1,
        minWidth: 0,
    },
    model: {
        fontSize: COMPOSER_MODEL_SEGMENT.fontSize,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    // Pressed and open read as a wash on the glass rather than as a different
    // fill, so the material underneath is still doing the drawing.
    controlOpen: {
        backgroundColor: theme.colors.glass.backgroundSubtle,
    },
    /**
     * The hairline between segments. Apple's grouped capsules separate their
     * halves with a divider rather than a gap, which is what keeps the capsule
     * reading as one object while the halves stay obviously separate.
     */
    segmentDivider: {
        width: RNStyleSheet.hairlineWidth,
        height: 20,
        backgroundColor: theme.colors.glass.divider,
    },
}));

/** VoiceOver's two actions on an adjustable, since there is no drag there. */
const ADJUSTABLE_ACTIONS = [
    { name: 'increment' as const },
    { name: 'decrement' as const },
];

function Control(props: {
    picker: ComposerSessionPicker;
    accessibilityLabel: string;
    accessibilityValue?: string;
    open: boolean;
    onPress?: (picker: ComposerSessionPicker) => void;
    /** The 44pt square by default; the model segment sizes to its name. */
    wide?: boolean;
    children: React.ReactNode;
}) {
    const segmentStyle = props.wide ? styles.modelSegment : styles.control;
    // Inside the capsule's own material, so the press is drawn by
    // UIGlassEffect and this segment must not fade on top of it (DROVE-202).
    // A dimming glyph in a frame that does not move is the "scaling up inside"
    // Clay was looking at, one segment at a time.
    const nativePress = useNativeGlassPress();
    return (
        <BubblePressable
            onPress={props.onPress ? () => props.onPress?.(props.picker) : undefined}
            disabled={!props.onPress}
            style={(p) => [
                segmentStyle,
                props.open && styles.controlOpen,
                { opacity: shouldDrawPressedFallback(nativePress, p.pressed, !props.onPress) ? 0.7 : 1 },
            ]}
            accessibilityRole="button"
            accessibilityLabel={props.accessibilityLabel}
            accessibilityValue={props.accessibilityValue ? { text: props.accessibilityValue } : undefined}
            accessibilityState={{ expanded: props.open, disabled: !props.onPress }}
        >
            {props.children}
        </BubblePressable>
    );
}

export const ComposerSessionControls = React.memo(function ComposerSessionControls(
    props: ComposerSessionControlsProps,
) {
    const { theme } = useUnistyles();
    const {
        label,
        modeKind,
        modeKey,
        effortIndex,
        effortCount = 0,
        onPress,
        canOpen,
        openPicker,
        effortSlider,
        pending,
    } = props;
    const palette = composerControlPalette(theme.dark);
    const permissionPending = !!pending?.permission;
    const modelPending = !!pending?.model;
    // A drag in progress outranks a wait: while the finger is on the slider the
    // needle is following the thumb, and that is a value nobody has asked for
    // yet, so there is nothing outstanding to draw.
    const effortPending = !!pending?.effort && !effortSlider?.active;
    const showMode = !!label.mode;
    const showEffort = !!label.effort && effortCount > 0 && effortIndex != null && effortIndex >= 0;
    const showModel = !!label.model;
    const canOpenMode = canOpen?.permission !== false;
    const canOpenEffort = canOpen?.effort !== false;
    const canOpenModel = canOpen?.model !== false;
    if (!showMode && !showEffort && !showModel) {
        return null;
    }
    const mode = permissionModeAccessibility(label.mode);
    const effort = effortAccessibility(label.effort, effortIndex ?? 0, effortCount);
    // A divider goes between two drawn segments, never at either end, so a
    // session with no effort scale does not leave a hairline floating in the
    // capsule.
    const effortNeedsDivider = showEffort && showMode;
    const modelNeedsDivider = showModel && (showMode || showEffort);
    // One interactive surface for the capsule, not one per segment
    // (DROVE-169). UIGlassEffect follows the touch inside the effect view it
    // is on, so the segment under the finger brightens and its neighbours
    // answer with it, which is how the system draws a grouped control. The
    // model segment is inside the same surface, so it takes part rather than
    // needing a press animation of its own (DROVE-178).
    return (
        <GlassChromeSurface
            radius={COMPOSER_SESSION_CONTROL_SIZE / 2}
            interactive
            style={styles.capsule}
        >
            {showMode ? (
                <Control
                    picker="permission"
                    accessibilityLabel={mode.label}
                    accessibilityValue={unconfirmedAccessibilityValue(mode.value, permissionPending)}
                    open={openPicker === 'permission'}
                    onPress={canOpenMode ? onPress : undefined}
                >
                    {/* The foreground in every mode (DROVE-215). The mode is
                        a value the session holds, not a thing it is doing, so
                        under the rule it earns no colour, and the padlock,
                        shield, eye and map already separate the modes on
                        their own (DROVE-141). */}
                    <Ionicons
                        name={permissionModeGlyph(modeKind, modeKey)}
                        size={20}
                        color={pendingOrSettled(palette, permissionPending, composerGlyphColour(palette))}
                    />
                </Control>
            ) : null}
            {effortNeedsDivider ? <View style={styles.segmentDivider} /> : null}
            {showEffort ? (
                effortSlider ? (
                    /* The drag (DROVE-200). The responder is a plain View
                       rather than a Pressable because it has to keep the touch
                       for the whole gesture: `onResponderTerminationRequest`
                       returning false is what stops the chat's scroll view
                       taking it back the moment the finger moves. Page
                       coordinates, because the drag is a DELTA between two of
                       them and never an absolute position (effortSlider.ts). */
                    <View
                        style={[styles.control, effortSlider.active && styles.controlOpen]}
                        accessible
                        accessibilityRole="adjustable"
                        accessibilityLabel={effort.label}
                        accessibilityValue={(() => {
                            const text = unconfirmedAccessibilityValue(effort.value, effortPending);
                            return text ? { text } : undefined;
                        })()}
                        accessibilityActions={ADJUSTABLE_ACTIONS}
                        onAccessibilityAction={(event) => {
                            if (event.nativeEvent.actionName === 'increment') effortSlider.step(1);
                            if (event.nativeEvent.actionName === 'decrement') effortSlider.step(-1);
                        }}
                        onStartShouldSetResponder={() => true}
                        onMoveShouldSetResponder={() => true}
                        onResponderTerminationRequest={() => false}
                        onResponderGrant={(event) => effortSlider.onPressIn(event.nativeEvent.pageX)}
                        onResponderMove={(event) => effortSlider.onMove(event.nativeEvent.pageX)}
                        onResponderRelease={() => effortSlider.onRelease()}
                        onResponderTerminate={() => effortSlider.dismiss()}
                    >
                        {/* The needle follows the thumb while a drag runs, so
                            the glyph and the line never say different things.
                            The ANGLE follows it; the colour is the foreground
                            at every level (DROVE-215), because a level is a
                            value and the angle was always the reading the dial
                            was chosen for (DROVE-101). The track under it is
                            that same foreground at a reduced opacity, held off
                            the capsule and under the needle (DROVE-227). */}
                        <EffortGauge
                            index={effortSlider.active ? effortSlider.index : effortIndex!}
                            count={effortCount}
                            color={pendingOrSettled(palette, effortPending, composerGlyphColour(palette))}
                            track={composerGaugeTrack(theme.dark)}
                        />
                    </View>
                ) : (
                    <Control
                        picker="effort"
                        accessibilityLabel={effort.label}
                        accessibilityValue={unconfirmedAccessibilityValue(effort.value, effortPending)}
                        open={openPicker === 'effort'}
                        onPress={canOpenEffort ? onPress : undefined}
                    >
                        <EffortGauge
                            index={effortIndex!}
                            count={effortCount}
                            color={pendingOrSettled(palette, effortPending, composerGlyphColour(palette))}
                            track={composerGaugeTrack(theme.dark)}
                        />
                    </Control>
                )
            ) : null}
            {modelNeedsDivider ? <View style={styles.segmentDivider} /> : null}
            {showModel ? (
                <Control
                    picker="model"
                    accessibilityLabel="Model"
                    accessibilityValue={unconfirmedAccessibilityValue(label.model!, modelPending)}
                    open={openPicker === 'model'}
                    onPress={canOpenModel ? onPress : undefined}
                    wide
                >
                    <Text
                        style={[styles.model, modelPending && { color: palette.pending }]}
                        numberOfLines={1}
                        // Smaller before shorter: the name scales rather than
                        // gaining an ellipsis, because `Opus 5...` is the
                        // failure DROVE-138 was filed about (DROVE-178).
                        adjustsFontSizeToFit
                        minimumFontScale={COMPOSER_MODEL_SEGMENT.minimumFontScale}
                    >
                        {label.model}
                    </Text>
                </Control>
            ) : null}
        </GlassChromeSurface>
    );
});
