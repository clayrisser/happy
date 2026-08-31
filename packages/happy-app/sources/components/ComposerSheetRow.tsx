import * as React from 'react';
import { Switch, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { Typography } from '@/constants/Typography';
import { BubblePressable } from './BubblePressable';

/**
 * One row of a composer sheet (DROVE-83): a title on the left and, on the
 * right, either the current value with a chevron (the row opens a picker) or
 * a switch (the row is the setting).
 *
 * The session sheet uses the picker shape for permission mode, model and
 * effort; the channels sheet uses the switch shape for audio.
 */
export type ComposerSheetRowProps = {
    title: string;
    icon?: React.ComponentProps<typeof Ionicons>['name'];
} & ({
    kind: 'picker';
    value: string;
    onPress?: () => void;
} | {
    kind: 'toggle';
    value: boolean;
    onValueChange: (value: boolean) => void;
});

const stylesheet = StyleSheet.create((theme) => ({
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        minHeight: 48,
        paddingHorizontal: 16,
        paddingVertical: 8,
        marginHorizontal: 8,
        borderRadius: 14,
        gap: 10,
    },
    icon: {
        flexShrink: 0,
    },
    title: {
        flex: 1,
        minWidth: 0,
        fontSize: 15,
        color: theme.colors.text,
        ...Typography.default(),
    },
    value: {
        flexShrink: 1,
        minWidth: 0,
        fontSize: 15,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    chevron: {
        flexShrink: 0,
    },
}));

export const ComposerSheetRow = React.memo(function ComposerSheetRow(props: ComposerSheetRowProps) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const icon = props.icon ? (
        <Ionicons name={props.icon} size={16} color={theme.colors.textSecondary} style={styles.icon} />
    ) : null;
    if (props.kind === 'toggle') {
        return (
            <View style={styles.row} accessibilityRole="switch" accessibilityState={{ checked: props.value }}>
                {icon}
                <Text style={styles.title} numberOfLines={1}>{props.title}</Text>
                <Switch
                    value={props.value}
                    onValueChange={props.onValueChange}
                    accessibilityLabel={props.title}
                />
            </View>
        );
    }
    return (
        <BubblePressable
            onPress={props.onPress}
            disabled={!props.onPress}
            style={({ pressed }) => [
                styles.row,
                { backgroundColor: pressed ? theme.colors.surfacePressedOverlay : 'transparent' },
            ]}
            accessibilityRole="button"
            accessibilityLabel={props.title}
            accessibilityValue={{ text: props.value }}
        >
            {icon}
            <Text style={styles.title} numberOfLines={1}>{props.title}</Text>
            <Text style={styles.value} numberOfLines={1} ellipsizeMode="middle">{props.value}</Text>
            <Ionicons name="chevron-forward" size={14} color={theme.colors.textSecondary} style={styles.chevron} />
        </BubblePressable>
    );
});
