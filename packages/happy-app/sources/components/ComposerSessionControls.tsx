import * as React from 'react';
import { Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { Typography } from '@/constants/Typography';
import { BubblePressable } from './BubblePressable';
import { NativeSettingsMenu, type NativeSettingsMenuGroup } from './NativeSettingsMenu';
import {
    COMPOSER_MODEL_FONT_SIZE,
    COMPOSER_MODEL_TRUNCATION,
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
 * the menu. The mode is an icon, the effort is an icon, the model keeps its
 * name as text, and each one opens its own picker on the first tap. Losing
 * the two words is what buys the model room to stay readable; losing the row
 * is what buys the chat its height back.
 *
 * GEOMETRY. 393pt of phone leaves the action row 357. The plus and the three
 * on the right are 42 each and are not negotiable (DROVE-118 wants them
 * reading as buttons), which with 6pt gaps and the primary's 8pt margin is
 * 252 before these controls exist at all. At 38pt each the mode and the
 * effort leave the model 63pt, which holds `Opus 5 1M` at 12pt with a little
 * to spare and tail-truncates anything longer. 38 plus 3pt of slop a side is
 * exactly the 44pt target, and exactly the 6pt gap, so no two of these
 * controls' hit boxes overlap: pressing effort cannot open the model list.
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
    modelGroup?: NativeSettingsMenuGroup | null;
    effortGroup?: NativeSettingsMenuGroup | null;
    /** Which picker is open, so the pressed control reads as open. */
    openPicker?: ComposerSessionPicker | null;
}

/**
 * The permission mode as a glyph.
 *
 * Every mode we ship is one of a handful of ideas: review it yourself (auto),
 * edits only, plan first, read but never write, keep to the workspace, or do
 * not ask at all. The glyphs are the ones the permission list already draws
 * beside those rows, so a mode looks the same wherever it appears.
 */
export function permissionModeGlyph(
    kind: string | null | undefined,
    key: string | null | undefined,
): React.ComponentProps<typeof Ionicons>['name'] {
    const value = (kind ?? key ?? '').toLowerCase();
    if (value === 'read-only' || value === 'read') return 'lock-closed-outline';
    if (value === 'safe-yolo' || value === 'workspace') return 'shield-checkmark-outline';
    if (value === 'yolo' || value === 'bypasspermissions' || value === 'full') return 'warning-outline';
    if (value === 'plan') return 'map-outline';
    if (value === 'acceptedits' || value === 'edits') return 'create-outline';
    if (value === 'auto') return 'sparkles-outline';
    return 'shield-outline';
}

/**
 * The effort as a meter, filled to the level.
 *
 * One glyph cannot say which of six (low, medium, high, xhigh, max,
 * ultracode) is on, because there is no family of six glyphs anyone reads as
 * ordered. A meter can: the reader counts rather than recognises, and it is
 * the idiom every phone already uses for signal. Bars are drawn only for the
 * levels the current model offers, so a four-level model shows four, and the
 * exact word is one tap away in the picker either way.
 */
export function EffortMeter(props: { index: number; count: number; color: string; dim: string }) {
    const count = Math.max(1, Math.min(6, props.count));
    const index = Math.max(0, Math.min(count - 1, props.index));
    return (
        <View style={styles.meter}>
            {Array.from({ length: count }, (_unused, bar) => (
                <View
                    key={bar}
                    style={[
                        styles.meterBar,
                        {
                            height: 4 + (9 * bar) / Math.max(1, count - 1),
                            backgroundColor: bar <= index ? props.color : props.dim,
                        },
                    ]}
                />
            ))}
        </View>
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
    // The model's full name, not DROVE-83's middle-ellipsised remains of it.
    modelPressable: {
        flexShrink: 1,
        minWidth: 0,
        height: COMPOSER_SESSION_CONTROL_SIZE,
        justifyContent: 'center',
        paddingHorizontal: 2,
    },
    model: {
        fontSize: COMPOSER_MODEL_FONT_SIZE,
        color: theme.colors.text,
        ...Typography.default(),
    },
    meter: {
        flexDirection: 'row',
        alignItems: 'flex-end',
        gap: 1.5,
        height: 13,
    },
    meterBar: {
        width: 2.5,
        borderRadius: 1.5,
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
                accessibilityLabel={props.accessibilityLabel}
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
        modelGroup,
        effortGroup,
        openPicker,
    } = props;
    const showMode = !!label.mode;
    const showEffort = !!label.effort && effortCount > 0 && effortIndex != null && effortIndex >= 0;
    const canOpenMode = (modeGroups?.length ?? 0) > 0;
    const canOpenModel = !!modelGroup;
    const canOpenEffort = !!effortGroup;
    if (!showMode && !showEffort && !label.model) {
        return null;
    }
    return (
        <>
            {showMode ? (
                <Control
                    picker="permission"
                    accessibilityLabel={label.mode!}
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
                    accessibilityLabel={label.effort!}
                    group={effortGroup}
                    nativeMenus={nativeMenus}
                    open={openPicker === 'effort'}
                    onPress={canOpenEffort ? onPress : undefined}
                >
                    <EffortMeter
                        index={effortIndex!}
                        count={effortCount}
                        color={theme.colors.text}
                        dim={theme.colors.divider}
                    />
                </Control>
            ) : null}
            {label.model ? (
                nativeMenus && modelGroup ? (
                    <NativeSettingsMenu
                        accessibilityLabel={label.model}
                        groups={[modelGroup]}
                        style={styles.modelPressable}
                    >
                        <Text
                            style={styles.model}
                            numberOfLines={1}
                            ellipsizeMode={COMPOSER_MODEL_TRUNCATION.ellipsizeMode}
                        >
                            {label.model}
                        </Text>
                    </NativeSettingsMenu>
                ) : (
                    <BubblePressable
                        onPress={canOpenModel && onPress ? () => onPress('model') : undefined}
                        disabled={!canOpenModel || !onPress}
                        hitSlop={controlHitSlop}
                        style={(p) => [
                            styles.modelPressable,
                            { opacity: p.pressed && canOpenModel && onPress ? 0.7 : 1 },
                        ]}
                        accessibilityRole="button"
                        accessibilityLabel={label.model}
                        accessibilityState={{ expanded: openPicker === 'model', disabled: !canOpenModel }}
                    >
                        <Text
                            style={styles.model}
                            numberOfLines={1}
                            ellipsizeMode={COMPOSER_MODEL_TRUNCATION.ellipsizeMode}
                        >
                            {label.model}
                        </Text>
                    </BubblePressable>
                )
            ) : null}
        </>
    );
});
