import * as React from 'react';
import { Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { Typography } from '@/constants/Typography';
import { BubblePressable } from './BubblePressable';
import {
    SESSION_PILL_FONT_SIZE,
    SESSION_PILL_GEOMETRY,
    SESSION_PILL_SEPARATOR,
    SESSION_PILL_TRUNCATION,
    type SessionPillLabel,
} from './sessionPillLabel';

/**
 * The one pill on the compact composer's first row (DROVE-83): the permission
 * mode, the short model name and the effort, read left to right. It replaces
 * the two chips that used to share the action row with the voice controls.
 *
 * The three segments are separate Text nodes so the layout, not the string,
 * decides what gets cut: the mode and the effort never shrink, the model
 * takes the slack and ellipsises in the middle if the row is too narrow.
 */
export interface ComposerSessionPillProps {
    label: SessionPillLabel;
    onPress?: () => void;
    disabled?: boolean;
    accessibilityLabel: string;
    /** The sheet this pill opens is showing. */
    open?: boolean;
}

const stylesheet = StyleSheet.create((theme) => ({
    row: {
        height: SESSION_PILL_GEOMETRY.height,
        flexDirection: 'row',
        alignItems: 'center',
    },
    pill: {
        flex: 1,
        minWidth: 0,
        height: SESSION_PILL_GEOMETRY.height,
        borderRadius: SESSION_PILL_GEOMETRY.height / 2,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: SESSION_PILL_GEOMETRY.paddingHorizontal,
        gap: 4,
    },
    fixed: {
        flexShrink: 0,
        fontSize: SESSION_PILL_FONT_SIZE,
        color: theme.colors.text,
        ...Typography.default(),
    },
    model: {
        flexShrink: 1,
        minWidth: 0,
        fontSize: SESSION_PILL_FONT_SIZE,
        color: theme.colors.text,
        ...Typography.default(),
    },
    separator: {
        flexShrink: 0,
        fontSize: SESSION_PILL_FONT_SIZE,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    chevron: {
        flexShrink: 0,
        marginLeft: 2,
    },
}));

const separatorGlyph = SESSION_PILL_SEPARATOR.trim();

export const ComposerSessionPill = React.memo(function ComposerSessionPill(props: ComposerSessionPillProps) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const { label, onPress, disabled, accessibilityLabel, open } = props;
    const segments: React.ReactNode[] = [];
    const push = (node: React.ReactNode, key: string) => {
        if (segments.length > 0) {
            segments.push(<Text key={`${key}-dot`} style={styles.separator}>{separatorGlyph}</Text>);
        }
        segments.push(node);
    };
    if (label.mode) {
        push(<Text key="mode" style={styles.fixed} numberOfLines={1}>{label.mode}</Text>, 'mode');
    }
    if (label.model) {
        push((
            <Text
                key="model"
                style={styles.model}
                numberOfLines={1}
                ellipsizeMode={SESSION_PILL_TRUNCATION.ellipsizeMode}
            >
                {label.model}
            </Text>
        ), 'model');
    }
    if (label.effort) {
        push(<Text key="effort" style={styles.fixed} numberOfLines={1}>{label.effort}</Text>, 'effort');
    }
    if (segments.length === 0) {
        return null;
    }
    return (
        <View style={styles.row}>
            <BubblePressable
                onPress={onPress}
                disabled={disabled || !onPress}
                hitSlop={4}
                style={(p) => [styles.pill, { opacity: p.pressed && onPress && !disabled ? 0.7 : 1 }]}
                accessibilityRole="button"
                accessibilityLabel={accessibilityLabel}
                accessibilityState={{ expanded: !!open, disabled: !!disabled || !onPress }}
                accessibilityValue={{ text: label.text }}
            >
                {segments}
                {onPress && !disabled && (
                    <Ionicons
                        name={open ? 'chevron-down' : 'chevron-up'}
                        size={12}
                        color={theme.colors.textSecondary}
                        style={styles.chevron}
                    />
                )}
            </BubblePressable>
        </View>
    );
});
