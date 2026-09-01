import { Stack } from 'expo-router';
import 'react-native-reanimated';
import * as React from 'react';
import { Typography } from '@/constants/Typography';
import { createHeader, createPlainHeader } from '@/components/navigation/Header';
import { Platform, TouchableOpacity, Text, View, Image } from 'react-native';
import { isRunningOnMac } from '@/utils/platform';
import { useIsTablet } from '@/utils/responsive';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { MobileGlassBackdrop } from '@/components/MobileGlass';
import { startDroverWatchFeed } from '@/sync/droverWatchFeed';
import { startDroverAnnounce } from '@/sync/droverAnnounce';
import { startDroverAutoAccept } from '@/sync/droverAutoAccept';

export const unstable_settings = {
    initialRouteName: 'index',
};

export default function RootLayout() {
    // Feed the Cattle Drover wrist surface (BASED-98). No-op where the native
    // module is absent, so no Platform check is needed here.
    React.useEffect(() => startDroverWatchFeed(), []);
    // The phone's haptic and audio announce for a new gate (DROVE-72). Reads
    // the card's `delivery` and this phone's switches; never a Mac's.
    React.useEffect(() => startDroverAnnounce(), []);
    // Auto-accept, for the sessions Clay switched it on for (DROVE-277). Above
    // the screen on purpose: a gate arrives whether or not that session is the
    // one on show, and a runtime that only fired while the card was visible
    // would auto-accept the prompts he was already watching and nothing else.
    // It answers only plain Allow / Deny gates off the bus, it can never deny,
    // and every answer it sends is stamped `by auto-accept` on the ledger.
    React.useEffect(() => startDroverAutoAccept(), []);

    // Every phone gets the app's own header (DROVE-161). It used to be
    // Android, Mac and web only, with iPhones left on UIKit's navigation bar,
    // and that is why the agent screen Clay photographed had a flat grey back
    // disc and a bare text title while the session header beside it was in the
    // material: the converted header was never the one being drawn.
    //
    // The iPad still gets UIKit. This header hides its back button on a tablet
    // because the sidebar navigates there, so a pushed screen on an iPad would
    // have no way back out of it.
    const isTablet = useIsTablet();
    const shouldUseCustomHeader = Platform.OS !== 'ios' || isRunningOnMac() || !isTablet;
    const isDesktop = Platform.OS === 'web' || isRunningOnMac();
    const { theme } = useUnistyles();

    return (
        <View
            style={{
                flex: 1,
                backgroundColor: isDesktop
                    ? theme.colors.surface
                    : theme.colors.groupped.background,
            }}
        >
            <MobileGlassBackdrop enabled={!isDesktop} />
        <Stack
            initialRouteName='index'
            screenOptions={{
                header: shouldUseCustomHeader ? createHeader : undefined,
                headerBackTitle: t('common.back'),
                headerBackButtonDisplayMode: Platform.OS === 'ios' ? 'minimal' : undefined,
                headerShadowVisible: false,
                contentStyle: {
                    backgroundColor: isDesktop
                        ? theme.colors.surface
                        : theme.colors.groupped.background,
                },
                headerStyle: {
                    backgroundColor: isDesktop ? theme.colors.header.background : 'transparent',
                },
                headerTintColor: theme.colors.header.tint,
                headerTitleStyle: {
                    color: theme.colors.header.tint,
                    ...Typography.default('semiBold'),
                },

            }}
        >
            <Stack.Screen
                name="index"
                options={{
                    headerShown: false,
                    headerTitle: ''
                }}
            />
            <Stack.Screen
                name="inbox/index"
                options={{
                    headerShown: false,
                    headerTitle: t('tabs.inbox'),
                    headerBackTitle: t('common.home')
                }}
            />
            <Stack.Screen
                name="gates"
                options={{
                    headerShown: true,
                    header: createPlainHeader,
                    headerTitle: 'Waiting on you',
                    headerBackTitle: t('common.home'),
                    headerTransparent: Platform.OS === 'ios',
                    headerStyle: {
                        backgroundColor: theme.colors.groupped.background,
                    },
                }}
            />
            <Stack.Screen
                name="settings/index"
                options={{
                    headerShown: true,
                    header: createPlainHeader,
                    headerTitle: t('settings.title'),
                    headerBackTitle: t('common.home'),
                    headerTransparent: Platform.OS === 'ios',
                    headerStyle: {
                        backgroundColor: theme.colors.groupped.background,
                    },
                }}
            />
            <Stack.Screen
                name="session/[id]"
                options={{
                    headerShown: false
                }}
            />
            <Stack.Screen
                name="session/[id]/message/[messageId]"
                options={{
                    headerShown: true,
                    headerBackTitle: t('common.back'),
                    headerTitle: t('common.message')
                }}
            />
            <Stack.Screen
                name="session/[id]/info"
                options={{
                    headerShown: true,
                    header: createPlainHeader,
                    headerTitle: '',
                    headerBackTitle: t('common.back'),
                    headerTransparent: Platform.OS === 'ios',
                    headerStyle: {
                        backgroundColor: theme.colors.groupped.background,
                    },
                }}
            />
            <Stack.Screen
                name="machine/[id]"
                options={{
                    headerShown: true,
                    header: createPlainHeader,
                    headerTitle: '',
                    headerBackTitle: t('machine.back'),
                    headerTransparent: Platform.OS === 'ios',
                    headerStyle: {
                        backgroundColor: theme.colors.groupped.background,
                    },
                }}
            />
            <Stack.Screen
                name="session/[id]/files"
                options={{
                    headerShown: true,
                    headerTitle: t('common.files'),
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="session/[id]/file"
                options={{
                    headerShown: true,
                    headerTitle: t('common.fileViewer'),
                    headerBackTitle: t('common.files'),
                }}
            />
            <Stack.Screen
                name="settings/account"
                options={{
                    headerTitle: t('settings.account'),
                }}
            />
            <Stack.Screen
                name="settings/appearance"
                options={{
                    headerTitle: t('settings.appearance'),
                }}
            />
            <Stack.Screen
                name="settings/agents"
                options={{
                    headerTitle: 'Agents',
                }}
            />
            <Stack.Screen
                name="terminal/connect"
                options={{
                    headerTitle: t('navigation.connectTerminal'),
                }}
            />
            <Stack.Screen
                name="terminal/index"
                options={{
                    headerTitle: t('navigation.connectTerminal'),
                }}
            />
            <Stack.Screen
                name="restore/index"
                options={{
                    headerShown: true,
                    headerTitle: t('navigation.linkNewDevice'),
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="restore/manual"
                options={{
                    headerShown: true,
                    headerTitle: t('navigation.restoreWithSecretKey'),
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="changelog"
                options={{
                    headerShown: true,
                    header: createPlainHeader,
                    headerTitle: () => (
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                            <Text
                                numberOfLines={1}
                                style={[
                                    {
                                        fontSize: isDesktop ? 17 : 16,
                                        fontWeight: '600',
                                        color: theme.colors.header.tint,
                                    },
                                    Typography.default('semiBold'),
                                ]}
                            >
                                {t('navigation.whatsNew')}
                            </Text>
                            <Image
                                source={require('@/changelog/images/mouse-on-the-phone.webp')}
                                style={{ width: 40, height: 40 }}
                                resizeMode="contain"
                            />
                        </View>
                    ),
                    headerBackTitle: t('common.back'),
                    headerTransparent: Platform.OS === 'ios',
                    headerStyle: {
                        backgroundColor: theme.colors.groupped.background,
                    },
                }}
            />
            <Stack.Screen
                name="artifacts/index"
                options={{
                    headerShown: true,
                    headerTitle: t('artifacts.title'),
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="artifacts/[id]"
                options={{
                    headerShown: false, // We'll set header dynamically
                }}
            />
            <Stack.Screen
                name="artifacts/new"
                options={{
                    headerShown: true,
                    headerTitle: t('artifacts.new'),
                    headerBackTitle: t('common.cancel'),
                }}
            />
            <Stack.Screen
                name="artifacts/edit/[id]"
                options={{
                    headerShown: true,
                    headerTitle: t('artifacts.edit'),
                    headerBackTitle: t('common.cancel'),
                }}
            />
            <Stack.Screen
                name="text-selection"
                options={{
                    headerShown: true,
                    headerTitle: t('textSelection.title'),
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="friends/index"
                options={({ navigation }) => ({
                    headerShown: true,
                    headerTitle: t('navigation.friends'),
                    headerBackTitle: t('common.back'),
                    headerRight: () => (
                        <TouchableOpacity
                            onPress={() => navigation.navigate('friends/search' as never)}
                            style={{ paddingHorizontal: 16 }}
                        >
                            {/* `header.tint`, not `button.primary.tint`
                                (DROVE-161). The primary tint is #FFFFFF on
                                BOTH themes, because it is the colour of text
                                on a black filled button; in a header capsule
                                on the light theme it is white on near-white,
                                which measures 1.06:1. It was invisible in
                                UIKit's white bar before this too. */}
                            <Text style={{ color: theme.colors.header.tint, fontSize: 16 }}>
                                {t('friends.addFriend')}
                            </Text>
                        </TouchableOpacity>
                    ),
                })}
            />
            <Stack.Screen
                name="friends/search"
                options={{
                    headerShown: true,
                    headerTitle: t('friends.addFriend'),
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="user/[id]"
                options={{
                    headerShown: true,
                    headerTitle: '',
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="dev/index"
                options={{
                    headerTitle: 'Developer Tools',
                }}
            />

            <Stack.Screen
                name="dev/list-demo"
                options={{
                    headerTitle: 'List Components Demo',
                }}
            />
            <Stack.Screen
                name="dev/typography"
                options={{
                    headerTitle: 'Typography',
                }}
            />
            <Stack.Screen
                name="dev/colors"
                options={{
                    headerTitle: 'Colors',
                }}
            />
            <Stack.Screen
                name="dev/tools2"
                options={{
                    headerTitle: 'Tool Views Demo',
                }}
            />
            <Stack.Screen
                name="dev/masked-progress"
                options={{
                    headerTitle: 'Masked Progress',
                }}
            />
            <Stack.Screen
                name="dev/shimmer-demo"
                options={{
                    headerTitle: 'Shimmer View Demo',
                }}
            />
            <Stack.Screen
                name="dev/multi-text-input"
                options={{
                    headerTitle: 'Multi Text Input',
                }}
            />
            <Stack.Screen
                name="dev/session-composer"
                options={{
                    headerTitle: 'Session Composer',
                }}
            />
            <Stack.Screen
                name="dev/rig-preview"
                options={{
                    headerTitle: 'Rig Preview',
                }}
            />
            <Stack.Screen
                name="session/recent"
                options={{
                    headerShown: true,
                    headerTitle: t('sessionHistory.title'),
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="settings/connect/claude"
                options={{
                    headerShown: true,
                    headerTitle: 'Connect to Claude',
                    headerBackTitle: t('common.back'),
                    // headerStyle: {
                    //     backgroundColor: Platform.OS === 'web' ? theme.colors.header.background : '#1F1E1C',
                    // },
                    // headerTintColor: Platform.OS === 'web' ? theme.colors.header.tint : '#FFFFFF',
                    // headerTitleStyle: {
                    //     color: Platform.OS === 'web' ? theme.colors.header.tint : '#FFFFFF',
                    // },
                }}
            />
            <Stack.Screen
                name="new/index"
                options={{
                    headerTitle: t('newSession.title'),
                    headerBackTitle: t('common.back'),
                }}
            />
        </Stack>
        </View>
    );
}
