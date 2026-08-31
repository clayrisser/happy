import * as React from 'react';
import { View, Text } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

interface CommandSuggestionProps {
    command: string;
    description?: string;
    /**
     * A skill and a slash command are different things and the row says so
     * (DROVE-170). One flat list of a few hundred names reads as noise; the
     * badge is what lets you tell your own `/huly-ticket` skill from the
     * harness's `/compact` at a glance.
     */
    kind?: 'command' | 'skill';
}

export const CommandSuggestion = React.memo(({ command, description, kind = 'command' }: CommandSuggestionProps) => {
    return (
        <View style={styles.suggestionContainer}>
            <Text 
                style={[styles.commandText, { marginRight: 8 }]}
            >
                /{command}
            </Text>
            <View style={kind === 'skill' ? styles.skillBadge : styles.commandBadge}>
                <Text style={kind === 'skill' ? styles.skillBadgeText : styles.commandBadgeText}>
                    {kind === 'skill'
                        ? t('agentInput.suggestion.skillLabel')
                        : t('agentInput.suggestion.commandLabel')}
                </Text>
            </View>
            {description && (
                <Text
                    style={styles.descriptionText}
                    numberOfLines={1}
                >
                    {description}
                </Text>
            )}
        </View>
    );
});

interface FileMentionProps {
    fileName: string;
    filePath: string;
    fileType?: 'file' | 'folder';
}

export const FileMentionSuggestion = React.memo(({ fileName, filePath, fileType = 'file' }: FileMentionProps) => {
    return (
        <View style={styles.suggestionContainer}>
            <View style={styles.iconContainer}>
                <Ionicons
                    name={fileType === 'folder' ? 'folder' : 'document-text'}
                    size={18}
                    color={styles.iconColor.color}
                />
            </View>
            <Text 
                style={styles.fileNameText}
                numberOfLines={1}
            >
                {filePath}{fileName}
            </Text>
            <Text style={styles.labelText}>
                {fileType === 'folder' ? t('agentInput.suggestion.folderLabel') : t('agentInput.suggestion.fileLabel')}
            </Text>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    suggestionContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 12,
        height: 48,
    },
    commandText: {
        fontSize: 14,
        color: theme.colors.text,
        fontWeight: '600',
        ...Typography.default('semiBold'),
    },
    descriptionText: {
        flex: 1,
        fontSize: 13,
        color: theme.colors.textSecondary,
        marginLeft: 8,
        ...Typography.default(),
    },
    commandBadge: {
        paddingHorizontal: 6,
        paddingVertical: 2,
        borderRadius: 4,
        backgroundColor: theme.colors.surfaceHigh,
    },
    commandBadgeText: {
        fontSize: 10,
        letterSpacing: 0.5,
        color: theme.colors.textSecondary,
        ...Typography.default('semiBold'),
    },
    skillBadge: {
        paddingHorizontal: 6,
        paddingVertical: 2,
        borderRadius: 4,
        backgroundColor: theme.colors.surfaceSelected,
    },
    skillBadgeText: {
        fontSize: 10,
        letterSpacing: 0.5,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    iconContainer: {
        width: 32,
        height: 32,
        borderRadius: 16,
        backgroundColor: theme.colors.surfaceHigh,
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: 12,
    },
    iconColor: {
        color: theme.colors.textSecondary,
    },
    fileNameText: {
        flex: 1,
        fontSize: 14,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    labelText: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        marginLeft: 8,
        ...Typography.default(),
    },
}));
