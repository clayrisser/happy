import * as React from 'react';
import { Header } from './navigation/Header';
import { useSocketStatus } from '@/sync/storage';
import { Platform, Pressable, Text, View } from 'react-native';
import { Typography } from '@/constants/Typography';
import { StatusDot } from './StatusDot';
import { Ionicons } from '@expo/vector-icons';
import { useRouter, useSegments } from 'expo-router';
import { getServerInfo } from '@/sync/serverConfig';
import { Image } from 'expo-image';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { ShortcutHintBadge, useShortcutHints } from './ShortcutHints';
import { shouldShowHomeConnectionStatus } from './homeConnectionStatus';
import { useInboxCounts } from '@/hooks/usePendingGates';
import { InboxBadges, inboxAccessibilityLabel } from './InboxBadges';

// The longhorn is 1.56:1, so it gets a wide box rather than the square one a
// letterform wanted. Matches HeaderLogo so the mark is the same size on every
// header.
const HEADER_LOGO_WIDTH = 26;
const HEADER_LOGO_HEIGHT = 19;

const stylesheet = StyleSheet.create((theme, runtime) => ({
    headerButton: {
        // marginHorizontal: 4,
        width: 32,
        height: 32,
        alignItems: 'center',
        justifyContent: 'center',
    },
    headerButtonShortcutActive: {
        borderRadius: 8,
        backgroundColor: theme.colors.surfaceSelected,
    },
    headerShortcutBadge: {
        position: 'absolute',
        top: -8,
        right: -12,
    },
    iconButton: {
        color: theme.colors.header.tint,
    },
    logoContainer: {
        // marginHorizontal: 4,
        width: 32,
        height: 32,
        alignItems: 'center',
        justifyContent: 'center',
        tintColor: theme.colors.header.tint,
    },
    titleContainer: {
        flex: 1,
        alignItems: 'center',
    },
    titleText: {
        fontSize: 17,
        color: theme.colors.header.tint,
        fontWeight: '600',
        ...Typography.default('semiBold'),
    },
    subtitleText: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        marginTop: -2,
    },
    statusContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        marginTop: -2,
    },
    statusDot: {
        marginRight: 4,
    },
    statusText: {
        fontSize: 12,
        fontWeight: '500',
        lineHeight: 16,
        ...Typography.default(),
    },
    // Status colors
    statusConnected: {
        color: theme.colors.status.connected,
    },
    statusConnecting: {
        color: theme.colors.status.connecting,
    },
    statusDisconnected: {
        color: theme.colors.status.disconnected,
    },
    statusError: {
        color: theme.colors.status.error,
    },
    statusDefault: {
        color: theme.colors.status.default,
    },
    centeredTitle: {
        textAlign: Platform.OS === 'ios' ? 'center' : 'left',
        alignSelf: Platform.OS === 'ios' ? 'center' : 'flex-start',
        flex: 1,
    },
}));


export const HomeHeader = React.memo(() => {
    const { theme } = useUnistyles();
    const header = (
        <Header
            title={<HeaderTitleWithSubtitle />}
            headerRight={() => <HeaderRight />}
            headerLeft={() => <HeaderLeft />}
            headerLeftGlass={Platform.OS !== 'web'}
            headerShadowVisible={false}
            headerTransparent={true}
            mobileTitleSurface="plain"
            mobileTitleAlignment="center"
        />
    );

    return Platform.OS === 'web'
        ? <View style={{ backgroundColor: theme.colors.groupped.background }}>{header}</View>
        : header;
})

export const HomeHeaderNotAuth = React.memo(() => {
    useSegments(); // Re-rendered automatically when screen navigates back
    const serverInfo = getServerInfo();
    const { theme } = useUnistyles();
    return (
        <Header
            title={<HeaderTitleWithSubtitle subtitle={serverInfo.isCustom ? serverInfo.hostname + (serverInfo.port ? `:${serverInfo.port}` : '') : undefined} />}
            headerRight={() => <HeaderRightNotAuth />}
            // The plain mark, not the inbox button: there is no inbox to open
            // before you are logged in, and a tap that pushes an empty screen
            // is worse than a decoration.
            headerLeft={() => <HeaderLeftMark />}
            headerLeftGlass={Platform.OS !== 'web'}
            headerShadowVisible={false}
            headerBackgroundColor={theme.colors.groupped.background}
            mobileTitleSurface="plain"
            mobileTitleAlignment="center"
        />
    )
});

function HeaderRight() {
    const router = useRouter();
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const { visible: shortcutHintsVisible } = useShortcutHints();

    return (
        <Pressable
            onPress={() => router.navigate('/new')}
            hitSlop={15}
            style={[
                styles.headerButton,
                shortcutHintsVisible && styles.headerButtonShortcutActive,
            ]}
        >
            <Ionicons name="add-outline" size={28} color={theme.colors.header.tint} />
            <ShortcutHintBadge shortcutKey="N" style={styles.headerShortcutBadge} />
        </Pressable>
    );
}

function HeaderRightNotAuth() {
    const router = useRouter();
    const { theme } = useUnistyles();
    const styles = stylesheet;


    return (
        <Pressable
            onPress={() => router.push('/server')}
            hitSlop={15}
            style={styles.headerButton}
        >
            <Ionicons name="server-outline" size={24} color={theme.colors.header.tint} />
        </Pressable>
    );
}

/**
 * The longhorn, which is now the way in to the drover inbox (DROVE-71).
 *
 * It sat in the corner iOS users reach for first, tinted to the header and
 * doing nothing, and Clay circled it and asked whether it should. It should:
 * "use it for todo list AND all active prompts". Tapping it opens the inbox —
 * every pending prompt and every open to-do, this session's and every other
 * machine's.
 *
 * TWO INDICATORS, NOT ONE COUNT. They mean different things. A pending PROMPT
 * is blocking a session right now — a turn is stopped and it can time out — so
 * it gets the loud filled pill in the warning colour. A TO-DO stalls nothing
 * and never expires, so it gets a quiet outlined dot beside it. A single
 * number would let three to-dos hide the one prompt that is actually holding
 * work up. Neither is drawn when its count is zero, so an empty inbox leaves
 * the mark exactly as it was.
 */
function HeaderLeftMark({ children }: { children?: React.ReactNode }) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    return (
        <View style={styles.logoContainer}>
            <Image
                source={require('@/assets/images/logo-drover.png')}
                contentFit="contain"
                style={{ width: HEADER_LOGO_WIDTH, height: HEADER_LOGO_HEIGHT }}
                tintColor={theme.colors.header.tint}
            />
            {children}
        </View>
    );
}

/**
 * The longhorn, which is now the way in to the drover inbox (DROVE-71).
 *
 * It sat in the corner iOS users reach for first, tinted to the header and
 * doing nothing, and Clay circled it and asked whether it should. It should:
 * "use it for todo list AND all active prompts". Tapping it opens the inbox —
 * every pending prompt and every open to-do, this machine's and every other's
 * — and InboxBadges says what is in there without a tap.
 */
function HeaderLeft() {
    const router = useRouter();
    const { prompts, todos } = useInboxCounts();
    return (
        <Pressable
            onPress={() => router.push('/gates')}
            hitSlop={15}
            accessibilityRole="button"
            accessibilityLabel={inboxAccessibilityLabel(prompts, todos)}
        >
            <HeaderLeftMark>
                <InboxBadges prompts={prompts} todos={todos} />
            </HeaderLeftMark>
        </Pressable>
    );
}

function HeaderTitleWithSubtitle({ subtitle }: { subtitle?: string }) {
    const socketStatus = useSocketStatus();
    const styles = stylesheet;

    // Get connection status styling (matching sessionUtils.ts pattern)
    const getConnectionStatus = () => {
        const { status } = socketStatus;
        switch (status) {
            case 'connected':
                return {
                    color: styles.statusConnected.color,
                    isPulsing: false,
                    text: t('status.connected'),
                    textColor: styles.statusConnected.color
                };
            case 'connecting':
                return {
                    color: styles.statusConnecting.color,
                    isPulsing: true,
                    text: t('status.connecting'),
                    textColor: styles.statusConnecting.color
                };
            case 'disconnected':
                return {
                    color: styles.statusDisconnected.color,
                    isPulsing: false,
                    text: t('status.disconnected'),
                    textColor: styles.statusDisconnected.color
                };
            case 'error':
                return {
                    color: styles.statusError.color,
                    isPulsing: false,
                    text: t('status.error'),
                    textColor: styles.statusError.color
                };
            default:
                return {
                    color: styles.statusDefault.color,
                    isPulsing: false,
                    text: '',
                    textColor: styles.statusDefault.color
                };
        }
    };

    const hasCustomSubtitle = !!subtitle;
    const connectionStatus = getConnectionStatus();
    const showConnectionStatus = shouldShowHomeConnectionStatus(socketStatus.status, hasCustomSubtitle)
        && connectionStatus.text;

    return (
        <View style={styles.titleContainer}>
            <Text style={styles.titleText}>
                {t('sidebar.sessionsTitle')}
            </Text>
            {hasCustomSubtitle && (
                <Text style={styles.subtitleText}>
                    {subtitle}
                </Text>
            )}
            {showConnectionStatus && (
                <View style={styles.statusContainer}>
                    <StatusDot
                        color={connectionStatus.color}
                        isPulsing={connectionStatus.isPulsing}
                        size={6}
                        style={styles.statusDot}
                    />
                    <Text style={[
                        styles.statusText,
                        { color: connectionStatus.textColor }
                    ]}>
                        {connectionStatus.text}
                    </Text>
                </View>
            )}
        </View>
    );
}
