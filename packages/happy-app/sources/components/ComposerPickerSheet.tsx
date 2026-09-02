import * as React from 'react';
import { Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { Typography } from '@/constants/Typography';
import { BubblePressable } from './BubblePressable';
import { ComposerSheet } from './ComposerSheet';
import { sheetSectionRhythm, sheetSectionTitleInset } from './sheetHeaderLayout';

/**
 * THE ONE PICKER SHEET, for the session composer and for Home (DROVE-394).
 *
 * Clay, on the new-session sheet's harness menu: "for the millionth time this
 * input box needs to match all the other input boxes; that should actually be
 * a sheet that comes up."
 *
 * The session capsule opened a `ComposerSheet` of radio rows drawn inline in
 * `AgentInput`; Home opened an iOS context menu for the harness and its own
 * glass card for the rest. Three pickers for one job. This is the list the
 * capsule always drew, as a component both screens mount: a title, an optional
 * header, radio rows with a glyph, a name and a reason, and a disabled row
 * that is drawn with its reason and cannot be picked.
 *
 * THE LAST PART IS THE HARNESS BUG. Home marked an uninstalled harness
 * `disabled` with "Not installed on this machine", then handed the native menu
 * a list of bare labels, so the menu offered it anyway; the pick was written to
 * the draft and the availability effect wrote it straight back. Clay tapped
 * Claude Code and Codex stayed ticked. A row here carries its own `disabled`,
 * so the reason is on screen and the press never happens.
 *
 * `composerPickerParity.test.ts` holds that both screens mount this and that
 * neither draws a picker of its own.
 */
export interface ComposerPickerOption {
    key: string;
    name: string;
    description?: string | null;
    disabled?: boolean;
    /**
     * A glyph before the name. An Ionicons name follows the row's colour;
     * a function draws its own (the model's provider mark).
     */
    icon?: React.ComponentProps<typeof Ionicons>['name'] | ((selected: boolean) => React.ReactNode);
}

export interface ComposerPickerSheetProps {
    open: boolean;
    onClose: () => void;
    /** After the slide down, once the Modal is off the screen. See `ComposerSheet`. */
    onClosed?: () => void;
    title: string;
    options: ComposerPickerOption[];
    selectedKey: string | null | undefined;
    /** The pick. The sheet closes itself after it. */
    onSelect: (key: string) => void;
    /** Above the rows: the permission sheet's auto-accept switch. */
    header?: React.ReactNode;
    /** Drawn instead of rows when there are none. */
    empty?: string;
}

const styles = StyleSheet.create((theme) => ({
    section: {
        paddingTop: sheetSectionRhythm.top,
        paddingBottom: sheetSectionRhythm.bottom,
    },
    title: {
        fontSize: sheetSectionRhythm.titleSize,
        lineHeight: sheetSectionRhythm.titleLine,
        color: theme.colors.textSecondary,
        paddingHorizontal: sheetSectionTitleInset,
        paddingBottom: sheetSectionRhythm.gap,
        ...Typography.default('semiBold'),
    },
    row: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        paddingHorizontal: 16,
        paddingVertical: 8,
        marginHorizontal: 8,
        borderRadius: 14,
    },
    rowDisabled: {
        opacity: 0.55,
    },
    radio: {
        width: 16,
        height: 16,
        borderRadius: 8,
        borderWidth: 2,
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: 12,
        marginTop: 2,
    },
    dot: {
        width: 6,
        height: 6,
        borderRadius: 3,
        backgroundColor: theme.colors.radio.dot,
    },
    copy: {
        flex: 1,
    },
    nameRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
    },
    name: {
        fontSize: 14,
        color: theme.colors.text,
        ...Typography.default(),
    },
    description: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    empty: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        paddingHorizontal: 16,
        paddingVertical: 8,
        ...Typography.default(),
    },
}));

export function ComposerPickerRow(props: {
    option: ComposerPickerOption;
    selected: boolean;
    onPress: () => void;
}) {
    const { theme } = useUnistyles();
    const { option, selected } = props;
    const disabled = option.disabled === true;
    const tint = selected ? theme.colors.radio.active : theme.colors.text;
    const icon = typeof option.icon === 'function'
        ? option.icon(selected)
        : option.icon
            ? (
                <Ionicons
                    name={option.icon}
                    size={13}
                    color={selected ? theme.colors.radio.active : theme.colors.textSecondary}
                />
            )
            : null;
    return (
        <BubblePressable
            disabled={disabled}
            onPress={props.onPress}
            accessibilityRole="radio"
            accessibilityLabel={option.name}
            accessibilityHint={option.description ?? undefined}
            accessibilityState={{ checked: selected, disabled }}
            style={({ pressed }) => [
                styles.row,
                disabled && styles.rowDisabled,
                {
                    backgroundColor: pressed && !disabled
                        ? theme.colors.surfacePressedOverlay
                        : selected
                            ? theme.colors.glass.backgroundSubtle
                            : 'transparent',
                },
            ]}
        >
            <View style={[
                styles.radio,
                { borderColor: selected ? theme.colors.radio.active : theme.colors.radio.inactive },
            ]}>
                {selected && <View style={styles.dot} />}
            </View>
            <View style={styles.copy}>
                <View style={styles.nameRow}>
                    {icon}
                    <Text style={[styles.name, { color: tint }]}>{option.name}</Text>
                </View>
                {!!option.description && (
                    <Text style={styles.description}>{option.description}</Text>
                )}
            </View>
        </BubblePressable>
    );
}

export function ComposerPickerSheet(props: ComposerPickerSheetProps) {
    const { onClose, onSelect } = props;
    const pick = React.useCallback((key: string) => {
        onSelect(key);
        onClose();
    }, [onClose, onSelect]);
    return (
        <ComposerSheet
            open={props.open}
            onClose={onClose}
            onClosed={props.onClosed}
            keyboardShouldPersistTaps="always"
        >
            {props.open && (
                <View style={styles.section}>
                    <Text style={styles.title}>{props.title}</Text>
                    {props.header}
                    {props.options.length > 0 ? props.options.map((option) => (
                        <ComposerPickerRow
                            key={option.key}
                            option={option}
                            selected={option.key === props.selectedKey}
                            onPress={() => pick(option.key)}
                        />
                    )) : props.empty ? (
                        <Text style={styles.empty}>{props.empty}</Text>
                    ) : null}
                </View>
            )}
        </ComposerSheet>
    );
}
