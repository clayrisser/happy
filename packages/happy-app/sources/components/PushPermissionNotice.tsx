import * as React from 'react';
import { Linking, Platform, Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Typography } from '@/constants/Typography';
import { usePushPermission } from '@/sync/storage';

/**
 * One line on the session screen when notifications are switched off
 * (DROVE-85).
 *
 * A denied permission is a silent no: the bridge logs "accepted by Expo", the
 * receipt says ok, and the phone shows nothing, because iOS drops the push
 * before the app ever sees it. Nothing on the phone said so. This sits with
 * the gate banner, above the composer, because that is where you are looking
 * when you are waiting on a prompt that never buzzed.
 *
 * It renders ONLY on a measured denial. `undetermined` is asked for on launch
 * by the push-token sync, and web has no permission to speak of.
 */
export function PushPermissionNotice() {
    const { theme } = useUnistyles();
    const permission = usePushPermission();

    if (Platform.OS === 'web' || permission?.status !== 'denied') return null;

    return (
        <Pressable
            style={styles.container}
            onPress={() => { void Linking.openSettings(); }}
            accessibilityRole="button"
            accessibilityLabel="Notifications are off. Open Settings"
        >
            <Ionicons name="notifications-off-outline" size={16} color={theme.colors.box.warning.text} />
            <Text style={styles.text} numberOfLines={1}>
                Notifications are off, so prompts will not buzz this phone.
            </Text>
            <Text style={styles.link}>Settings</Text>
        </Pressable>
    );
}

const styles = StyleSheet.create((theme) => ({
    container: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        marginHorizontal: 12,
        marginBottom: 8,
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 14,
        backgroundColor: theme.colors.surface,
        borderWidth: 1,
        borderColor: theme.colors.box.warning.text,
    },
    text: {
        ...Typography.default(),
        flex: 1,
        minWidth: 0,
        fontSize: 13,
        color: theme.colors.textSecondary,
    },
    link: {
        ...Typography.default('semiBold'),
        fontSize: 13,
        color: theme.colors.box.warning.text,
    },
}));
