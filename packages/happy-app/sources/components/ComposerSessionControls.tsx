import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import Svg, { Circle, Line, Path } from 'react-native-svg';
import { BubblePressable } from './BubblePressable';
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
    COMPOSER_SESSION_CONTROL_SIZE,
    type SessionPillLabel,
} from './sessionPillLabel';

/**
 * Permission mode and effort, as two glyphs on the composer's button row
 * (DROVE-111, DROVE-138, DROVE-141).
 *
 * DROVE-83 gave mode, model and effort a row of their own, one pill reading
 * `Yolo · Opus 5 1M · High` that opened a sheet listing them again. Clay drew
 * an arrow from that row down into the button row, then said of the sheet:
 * "I don't like this extra menu, then I have to click twice." So the row is
 * the menu: each control opens its own picker on the first tap, and there is
 * no intermediate menu anywhere in the path.
 *
 * THE MODEL IS NOT HERE ANY MORE (DROVE-138). Clay: "keep the full model name
 * and slide it down there, that way it's more compact and fits." A name
 * squeezed between six 38-to-42pt buttons had 63pt to live in, which is
 * `Opus 5 1M` and nothing longer, so `Opus 5 1M` was showing as `Opus 5...`.
 * The status line under the composer is text all the way across and has room
 * for the whole name, so that is where it went. Tapping it there opens the
 * same model picker on the same first tap.
 *
 * GEOMETRY. Two 38pt controls with 3pt of slop a side is exactly the 44pt
 * target and exactly the 6pt gap between them, so no two hit boxes overlap:
 * pressing effort cannot open the mode list. What the model used to occupy is
 * now slack on the row, which is DROVE-153's to spend on the glass capsule.
 */

/** 38 + 3 + 3. Sized so neighbouring slop meets but never overlaps. */
const controlHitSlop = { top: 8, bottom: 8, left: 3, right: 3 } as const;

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
 */
export function EffortGauge(props: { index: number; count: number; color: string; dim: string }) {
    const size = 17;
    const strokeWidth = 1.75;
    const centre = size / 2;
    const angle = effortGaugeAngle(props.index, props.count);
    // Stops short of the track so the needle reads as pointing AT a position
    // rather than as another piece of the ring.
    const tip = effortGaugePoint(centre, (size - strokeWidth) / 2 - 2.5, angle);
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
                strokeWidth={2}
                strokeLinecap="round"
            />
            <Circle cx={centre} cy={centre} r={1.6} fill={props.color} />
        </Svg>
    );
}

const styles = StyleSheet.create((theme) => ({
    control: {
        width: COMPOSER_SESSION_CONTROL_SIZE,
        height: COMPOSER_SESSION_CONTROL_SIZE,
        borderRadius: COMPOSER_SESSION_CONTROL_SIZE / 2,
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        // The same surface the speaker and the mic gained in DROVE-118, so
        // the row is buttons all the way across.
        backgroundColor: theme.colors.surfaceHigh,
    },
    controlOpen: {
        backgroundColor: theme.colors.surfaceHighest,
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
    children: React.ReactNode;
}) {
    const groups = props.groups ?? (props.group ? [props.group] : []);
    if (props.nativeMenus && groups.length > 0) {
        return (
            <NativeSettingsMenu
                // The native host takes one string, so the state rides in the
                // label there rather than being dropped (DROVE-141).
                accessibilityLabel={props.accessibilityValue
                    ? `${props.accessibilityLabel}, ${props.accessibilityValue}`
                    : props.accessibilityLabel}
                groups={groups}
                style={{ width: COMPOSER_SESSION_CONTROL_SIZE, height: COMPOSER_SESSION_CONTROL_SIZE }}
            >
                <View style={styles.control}>{props.children}</View>
            </NativeSettingsMenu>
        );
    }
    return (
        <BubblePressable
            onPress={props.onPress ? () => props.onPress?.(props.picker) : undefined}
            disabled={!props.onPress}
            hitSlop={controlHitSlop}
            style={(p) => [
                styles.control,
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
        openPicker,
    } = props;
    const showMode = !!label.mode;
    const showEffort = !!label.effort && effortCount > 0 && effortIndex != null && effortIndex >= 0;
    const canOpenMode = (modeGroups?.length ?? 0) > 0;
    const canOpenEffort = !!effortGroup;
    if (!showMode && !showEffort) {
        return null;
    }
    const mode = permissionModeAccessibility(label.mode);
    const effort = effortAccessibility(label.effort, effortIndex ?? 0, effortCount);
    return (
        <>
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
                        size={17}
                        color={theme.colors.text}
                    />
                </Control>
            ) : null}
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
                        color={theme.colors.text}
                        dim={theme.colors.divider}
                    />
                </Control>
            ) : null}
        </>
    );
});
