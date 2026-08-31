import * as React from 'react';
import { StyleSheet as RNStyleSheet, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import Svg, { Circle, Line, Path } from 'react-native-svg';
import { Typography } from '@/constants/Typography';
import { BubblePressable } from './BubblePressable';
import { GlassChromeSurface } from './GlassChromeControl';
import { NativeSettingsMenu, type NativeSettingsMenuGroup } from './NativeSettingsMenu';
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
    effortColour,
    permissionModeColour,
} from './composerControlColour';
import {
    COMPOSER_MODEL_SEGMENT,
    COMPOSER_SESSION_CONTROL_SIZE,
    type SessionPillLabel,
} from './sessionPillLabel';

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
 * COLOUR CARRIES THE STATE TOO (DROVE-176). The padlock is the warning amber
 * when open, the shield and the eye have their own hues, and the dial's needle
 * warms from the floor to the ceiling. The model's name stays neutral, because
 * a name is not a state and a coloured word beside coloured glyphs would
 * compete with the state they carry. composerControlColour.ts decides and
 * measures every one of those; nothing here picks a colour.
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
    /** Opens a picker directly. Absent means that one is not settable here. */
    onPress?: (picker: ComposerSessionPicker) => void;
    /**
     * iOS anchors its pickers as native menus on the control itself rather
     * than opening an overlay, so a group here replaces the press.
     */
    nativeMenus?: boolean;
    modeGroups?: NativeSettingsMenuGroup[];
    effortGroup?: NativeSettingsMenuGroup | null;
    modelGroup?: NativeSettingsMenuGroup | null;
    /** Which picker is open, so the pressed control reads as open. */
    openPicker?: ComposerSessionPicker | null;
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
 * The needle's colour is that same position read as heat (DROVE-176): cool at
 * the floor, the warning amber at the ceiling. The track stays dim, so the
 * angle is still the primary reading.
 */
export function EffortGauge(props: { index: number; count: number; color: string; dim: string }) {
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
                stroke={props.dim}
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

function Control(props: {
    picker: ComposerSessionPicker;
    accessibilityLabel: string;
    accessibilityValue?: string;
    group?: NativeSettingsMenuGroup | null;
    groups?: NativeSettingsMenuGroup[];
    nativeMenus?: boolean;
    open: boolean;
    onPress?: (picker: ComposerSessionPicker) => void;
    /** The 44pt square by default; the model segment sizes to its name. */
    wide?: boolean;
    children: React.ReactNode;
}) {
    const groups = props.groups ?? (props.group ? [props.group] : []);
    const segmentStyle = props.wide ? styles.modelSegment : styles.control;
    if (props.nativeMenus && groups.length > 0) {
        return (
            <NativeSettingsMenu
                // The native host takes one string, so the state rides in the
                // label there rather than being dropped (DROVE-141).
                accessibilityLabel={props.accessibilityValue
                    ? `${props.accessibilityLabel}, ${props.accessibilityValue}`
                    : props.accessibilityLabel}
                groups={groups}
                style={props.wide
                    ? { height: COMPOSER_SESSION_CONTROL_SIZE, flexShrink: 1, minWidth: 0 }
                    : { width: COMPOSER_SESSION_CONTROL_SIZE, height: COMPOSER_SESSION_CONTROL_SIZE }}
            >
                <View style={[segmentStyle, props.open && styles.controlOpen]}>{props.children}</View>
            </NativeSettingsMenu>
        );
    }
    return (
        <BubblePressable
            onPress={props.onPress ? () => props.onPress?.(props.picker) : undefined}
            disabled={!props.onPress}
            style={(p) => [
                segmentStyle,
                props.open && styles.controlOpen,
                { opacity: p.pressed && props.onPress ? 0.7 : 1 },
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
        nativeMenus,
        modeGroups,
        effortGroup,
        modelGroup,
        openPicker,
    } = props;
    const palette = composerControlPalette(theme.dark);
    const showMode = !!label.mode;
    const showEffort = !!label.effort && effortCount > 0 && effortIndex != null && effortIndex >= 0;
    const showModel = !!label.model;
    const canOpenMode = (modeGroups?.length ?? 0) > 0;
    const canOpenEffort = !!effortGroup;
    const canOpenModel = !!modelGroup;
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
                    accessibilityValue={mode.value}
                    groups={modeGroups}
                    nativeMenus={nativeMenus}
                    open={openPicker === 'permission'}
                    onPress={canOpenMode ? onPress : undefined}
                >
                    <Ionicons
                        name={permissionModeGlyph(modeKind, modeKey)}
                        size={20}
                        color={permissionModeColour(palette, modeKind, modeKey)}
                    />
                </Control>
            ) : null}
            {effortNeedsDivider ? <View style={styles.segmentDivider} /> : null}
            {showEffort ? (
                <Control
                    picker="effort"
                    accessibilityLabel={effort.label}
                    accessibilityValue={effort.value}
                    group={effortGroup}
                    nativeMenus={nativeMenus}
                    open={openPicker === 'effort'}
                    onPress={canOpenEffort ? onPress : undefined}
                >
                    <EffortGauge
                        index={effortIndex!}
                        count={effortCount}
                        color={effortColour(palette, effortIndex!, effortCount)}
                        dim={theme.colors.divider}
                    />
                </Control>
            ) : null}
            {modelNeedsDivider ? <View style={styles.segmentDivider} /> : null}
            {showModel ? (
                <Control
                    picker="model"
                    accessibilityLabel="Model"
                    accessibilityValue={label.model!}
                    group={modelGroup}
                    nativeMenus={nativeMenus}
                    open={openPicker === 'model'}
                    onPress={canOpenModel ? onPress : undefined}
                    wide
                >
                    <Text
                        style={styles.model}
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
