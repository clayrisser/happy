import * as React from 'react';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';

import { DisclosureFooter, useInlineDisclosure } from '@/components/DisclosureFooter';

interface ToolCollapsibleSectionProps {
    title: string;
    lineCount: number;
    children: React.ReactNode;
}

/**
 * A tool section that keeps a large payload behind a disclosure row, so a
 * multi-screen script (a Workflow input, say) does not flood the transcript.
 */
export const ToolCollapsibleSection = React.memo<ToolCollapsibleSectionProps>(({ title, lineCount, children }) => {
    const { theme } = useUnistyles();
    const { expanded, toggle, collapse, headerRef, footerRef } = useInlineDisclosure();
    const label = `${title} · ${lineCount} lines`;

    return (
        <View style={styles.section}>
            <Pressable
                ref={headerRef}
                collapsable={false}
                onPress={toggle}
                style={({ pressed }) => [
                    styles.header,
                    pressed && styles.headerPressed,
                ]}
            >
                <Text style={styles.headerTitle} numberOfLines={1}>
                    {label}
                </Text>
                <Ionicons
                    name={expanded ? 'chevron-down' : 'chevron-forward'}
                    size={14}
                    color={theme.colors.textSecondary}
                />
            </Pressable>
            {expanded ? (
                <View>
                    {children}
                    <DisclosureFooter
                        label={label}
                        onPress={collapse}
                        innerRef={footerRef}
                        iconSize={14}
                        textStyle={styles.headerTitle}
                    />
                </View>
            ) : null}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    section: {
        marginBottom: 12,
        overflow: 'visible',
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        alignSelf: 'flex-start',
        gap: 4,
        maxWidth: '100%',
        marginBottom: 6,
    },
    headerPressed: {
        opacity: 0.6,
    },
    headerTitle: {
        flexShrink: 1,
        fontSize: 13,
        fontWeight: '600',
        color: theme.colors.textSecondary,
        textTransform: 'uppercase',
    },
}));
