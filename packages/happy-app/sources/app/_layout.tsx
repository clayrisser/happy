import 'react-native-quick-base64';
import '../theme.css';
import * as React from 'react';
import * as SplashScreen from 'expo-splash-screen';
import * as Fonts from 'expo-font';
import * as Notifications from 'expo-notifications';
import { FontAwesome } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { AuthCredentials, TokenStorage } from '@/auth/tokenStorage';
import { AuthProvider } from '@/auth/AuthContext';
import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { initialWindowMetrics, SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SidebarNavigator } from '@/components/SidebarNavigator';
import sodium from '@/encryption/libsodium.lib';
import { View, Platform, AppState } from 'react-native';
import { ModalProvider } from '@/modal';
import { PostHogProvider } from 'posthog-react-native';
import { tracking } from '@/track/tracking';
import { syncRestore } from '@/sync/sync';
import { useTrackScreens } from '@/track/useTrackScreens';
import { RealtimeProvider } from '@/realtime/RealtimeProvider';
import { FaviconPermissionIndicator } from '@/components/web/FaviconPermissionIndicator';
import { CommandPaletteProvider } from '@/components/CommandPalette/CommandPaletteProvider';
import { StatusBarProvider } from '@/components/StatusBarProvider';
// import * as SystemUI from 'expo-system-ui';
import { initConsoleLogging, setConsoleOutputEnabled } from '@/utils/consoleLogging';
import { useLocalSetting } from '@/sync/storage';
import { useUnistyles } from 'react-native-unistyles';
import { AsyncLock } from '@/utils/lock';
import { getRouteFromNotificationResponse, isGatePushData, parsePushRoute } from '@/utils/notificationRouting';
import { moreActionIdentifier } from '@/sync/droverNotificationCategories';
import { navigateToSession } from '@/hooks/useNavigateToSession';
import { applyVoiceUpsellOverride } from '@/realtime/voiceExperiment';
import { useTauriZoom } from '@/hooks/useTauriZoom';
import { useTauriDrag } from '@/hooks/useTauriDrag';
import { BrowserNavigationShortcuts } from '@/hooks/useBrowserNavigationShortcuts';

// Configure notification handler. A push is hidden while the app is in the
// foreground, EXCEPT a gate (permission, question, to-do): that one must
// banner and sound wherever the app is, because it is the thing the user is
// waiting on (DROVE-85). shouldShowBanner/shouldShowList are the current API;
// shouldShowAlert is kept for the older native side.
Notifications.setNotificationHandler({
    handleNotification: async (notification) => {
        const isForeground = AppState.currentState === 'active';
        const present = !isForeground || isGatePushData(notification.request.content.data);
        return {
            shouldShowAlert: present,
            shouldPlaySound: present,
            shouldSetBadge: true,
            shouldShowBanner: present,
            shouldShowList: true,
        };
    },
});

// Setup Android notification channels (required for Android 8.0+)
if (Platform.OS === 'android') {
    Notifications.setNotificationChannelAsync('default', {
        name: 'Default',
        importance: Notifications.AndroidImportance.MAX,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: '#FF231F7C',
    });
    Notifications.setNotificationChannelAsync('messages', {
        name: 'Messages',
        importance: Notifications.AndroidImportance.HIGH,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: '#FF231F7C',
    });
}

export {
    // Catch any errors thrown by the Layout component.
    ErrorBoundary,
} from 'expo-router';

// Configure splash screen
SplashScreen.setOptions({
    fade: true,
    duration: 300,
})
SplashScreen.preventAutoHideAsync();

// Set window background color - now handled by Unistyles
// SystemUI.setBackgroundColorAsync('white');

// Remote logging to local log server (configured via Dev > Log Server setting)
initConsoleLogging()

// Component to apply horizontal safe area padding
function HorizontalSafeAreaWrapper({ children }: { children: React.ReactNode }) {
    const insets = useSafeAreaInsets();
    return (
        <View style={{
            flex: 1,
            paddingLeft: insets.left,
            paddingRight: insets.right
        }}>
            {children}
        </View>
    );
}

let lock = new AsyncLock();
let loaded = false;

function stringifyNotificationPayload(value: unknown): string {
    try {
        const serialized = JSON.stringify(value, null, 2);
        return serialized ?? String(value);
    } catch (error) {
        return `[unserializable notification payload: ${error instanceof Error ? error.message : 'Unknown error'}]`;
    }
}

async function loadFonts() {
    await lock.inLock(async () => {
        if (loaded) {
            return;
        }
        loaded = true;
        // Check if running in Tauri
        const isTauri = Platform.OS === 'web' &&
            typeof window !== 'undefined' &&
            (window as any).__TAURI_INTERNALS__ !== undefined;

        if (!isTauri) {
            // Normal font loading for non-Tauri environments (native and regular web)
            await Fonts.loadAsync({
                // Keep existing font
                SpaceMono: require('@/assets/fonts/SpaceMono-Regular.ttf'),

                // IBM Plex Sans family
                'IBMPlexSans-Regular': require('@/assets/fonts/IBMPlexSans-Regular.ttf'),
                'IBMPlexSans-Italic': require('@/assets/fonts/IBMPlexSans-Italic.ttf'),
                'IBMPlexSans-SemiBold': require('@/assets/fonts/IBMPlexSans-SemiBold.ttf'),

                // IBM Plex Mono family  
                'IBMPlexMono-Regular': require('@/assets/fonts/IBMPlexMono-Regular.ttf'),
                'IBMPlexMono-Italic': require('@/assets/fonts/IBMPlexMono-Italic.ttf'),
                'IBMPlexMono-SemiBold': require('@/assets/fonts/IBMPlexMono-SemiBold.ttf'),

                // Bricolage Grotesque  
                'BricolageGrotesque-Bold': require('@/assets/fonts/BricolageGrotesque-Bold.ttf'),

                ...FontAwesome.font,
            });
        } else {
            // For Tauri, skip Font Face Observer as fonts are loaded via CSS
            console.log('Do not wait for fonts to load');
            (async () => {
                try {
                    await Fonts.loadAsync({
                        // Keep existing font
                        SpaceMono: require('@/assets/fonts/SpaceMono-Regular.ttf'),

                        // IBM Plex Sans family
                        'IBMPlexSans-Regular': require('@/assets/fonts/IBMPlexSans-Regular.ttf'),
                        'IBMPlexSans-Italic': require('@/assets/fonts/IBMPlexSans-Italic.ttf'),
                        'IBMPlexSans-SemiBold': require('@/assets/fonts/IBMPlexSans-SemiBold.ttf'),

                        // IBM Plex Mono family  
                        'IBMPlexMono-Regular': require('@/assets/fonts/IBMPlexMono-Regular.ttf'),
                        'IBMPlexMono-Italic': require('@/assets/fonts/IBMPlexMono-Italic.ttf'),
                        'IBMPlexMono-SemiBold': require('@/assets/fonts/IBMPlexMono-SemiBold.ttf'),

                        // Bricolage Grotesque  
                        'BricolageGrotesque-Bold': require('@/assets/fonts/BricolageGrotesque-Bold.ttf'),

                        ...FontAwesome.font,
                    });
                } catch (e) {
                    // Ignore
                }
            })();
        }
    });
}

function getDevEnvironmentCredentials(): AuthCredentials | null {
    if (!__DEV__) {
        return null;
    }

    const token = process.env.EXPO_PUBLIC_DEV_TOKEN;
    const secret = process.env.EXPO_PUBLIC_DEV_SECRET;
    if (!token || !secret) {
        return null;
    }

    return { token, secret };
}

function getDevWebQueryCredentials(): AuthCredentials | null {
    if (!__DEV__ || Platform.OS !== 'web' || typeof window === 'undefined') {
        return null;
    }

    const params = new URLSearchParams(window.location.search);
    const token = params.get('dev_token');
    const secret = params.get('dev_secret');
    if (!token || !secret) {
        return null;
    }

    return { token, secret };
}

export default function RootLayout() {
    useTauriZoom();
    useTauriDrag();
    const router = useRouter();
    const { theme } = useUnistyles();
    const navigationTheme = React.useMemo(() => {
        if (theme.dark) {
            return {
                ...DarkTheme,
                colors: {
                    ...DarkTheme.colors,
                    background: theme.colors.groupped.background,
                }
            }
        }
        return {
            ...DefaultTheme,
            colors: {
                ...DefaultTheme.colors,
                background: theme.colors.groupped.background,
            }
        };
    }, [theme.dark]);

    //
    // Init sequence
    //
    const [initState, setInitState] = React.useState<{ credentials: AuthCredentials | null } | null>(null);
    React.useEffect(() => {
        (async () => {
            try {
                await loadFonts();
                await sodium.ready;

                let credentials = await TokenStorage.getCredentials();
                const devCredentials = getDevWebQueryCredentials() ?? getDevEnvironmentCredentials();

                if (devCredentials) {
                    const credentialsChanged = credentials?.token !== devCredentials.token
                        || credentials?.secret !== devCredentials.secret;

                    if (credentialsChanged) {
                        const saved = await TokenStorage.setCredentials(devCredentials);
                        if (saved) {
                            credentials = devCredentials;
                        }
                    }

                    if (Platform.OS === 'web' && typeof window !== 'undefined') {
                        window.history.replaceState({}, '', window.location.pathname);
                    }
                }

                if (credentials) {
                    await syncRestore(credentials);
                }

                setInitState({ credentials });
            } catch (error) {
                console.error('Error initializing:', error);
            }
        })();
    }, []);

    React.useEffect(() => {
        if (initState) {
            setTimeout(() => {
                SplashScreen.hideAsync();
            }, 100);
        }
    }, [initState]);

    const handledNotificationIds = React.useRef<Set<string>>(new Set());
    const handleNotificationResponse = React.useCallback(async (response: Notifications.NotificationResponse | null) => {
        if (!response) {
            console.log('[PUSH ROUTING] Notification response is null');
            return;
        }

        console.log('[PUSH ROUTING] Full notification response:\n' + stringifyNotificationPayload(response));

        const responseId = response.notification.request.identifier;
        if (handledNotificationIds.current.has(responseId)) {
            console.log(`[PUSH ROUTING] Duplicate notification response ignored: ${responseId}`);
            return;
        }

        handledNotificationIds.current.add(responseId);

        try {
            // This listener owns the TAP, and the one button that is a tap by
            // another name. An ANSWERING button on the banner is handled by
            // sources/sync/droverNotificationActions.ts, registered at module
            // scope so it also exists on the headless launch a button press
            // causes (DROVE-207); routing one from here would defeat the whole
            // point, which is answering without the app coming forward.
            //
            // "More in the app" is the exception and the reason the check is
            // not a bare inequality: it is the overflow escape on a gate with
            // more options than iOS will draw, it opens the app on purpose,
            // and landing on the home screen instead of the gate would make it
            // useless.
            const isTap =
                response.actionIdentifier === Notifications.DEFAULT_ACTION_IDENTIFIER ||
                response.actionIdentifier === moreActionIdentifier;
            if (!isTap) {
                console.log(`[PUSH ROUTING] Ignoring non-default action: ${response.actionIdentifier}`);
                return;
            }

            console.log(
                '[PUSH ROUTING] notification.request.content.data:\n' +
                stringifyNotificationPayload(response.notification.request.content.data)
            );
            // One decision for a tap while running and for the cold-start
            // read below: a gate push lands on the gate that raised it, in
            // its session when the push names one and in the inbox when it
            // does not (DROVE-94). Anything else keeps the session route.
            const route = getRouteFromNotificationResponse(response);
            console.log(`[PUSH ROUTING] Computed route: ${route ?? 'null'}`);
            const destination = route ? parsePushRoute(route) : null;
            if (!destination) {
                console.log('[PUSH ROUTING] No route found in notification.request.content.data');
                return;
            }

            if (destination.kind === 'inbox') {
                console.log(`[PUSH ROUTING] Navigating to inbox, gate: ${destination.gateId}`);
                router.push(`/gates?focus=${encodeURIComponent(destination.gateId)}`);
                return;
            }
            console.log(`[PUSH ROUTING] Navigating to session: ${destination.sessionId}, gate: ${destination.gateId ?? 'none'}`);
            navigateToSession(router, destination.sessionId, { gate: destination.gateId });
        } finally {
            try {
                await Notifications.clearLastNotificationResponseAsync();
            } catch (error) {
                console.log('Failed to clear last notification response:', error);
            }
        }
    }, [router]);

    React.useEffect(() => {
        if (!initState) {
            return;
        }

        let active = true;
        const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
            void handleNotificationResponse(response);
        });

        void (async () => {
            try {
                const response = await Notifications.getLastNotificationResponseAsync();
                if (active) {
                    await handleNotificationResponse(response);
                }
            } catch (error) {
                console.log('Failed to read last notification response:', error);
            }
        })();

        return () => {
            active = false;
            subscription.remove();
        };
    }, [handleNotificationResponse, initState]);


    // Track the screens
    useTrackScreens()

    // Sync console output toggle from Dev screen
    const consoleLoggingEnabled = useLocalSetting('consoleLoggingEnabled');
    const devModeEnabled = __DEV__ || useLocalSetting('devModeEnabled');
    const voiceUpsellOverride = useLocalSetting('voiceUpsellOverride');
    React.useEffect(() => {
        setConsoleOutputEnabled(consoleLoggingEnabled);
    }, [consoleLoggingEnabled]);

    React.useEffect(() => {
        if (!devModeEnabled || !voiceUpsellOverride) {
            return;
        }
        applyVoiceUpsellOverride(voiceUpsellOverride);
    }, [devModeEnabled, voiceUpsellOverride]);

    //
    // Not inited
    //

    if (!initState) {
        return null;
    }

    //
    // Boot
    //

    let providers = (
        <SafeAreaProvider initialMetrics={initialWindowMetrics}>
            <KeyboardProvider preload={false}>
                <GestureHandlerRootView
                    style={Platform.OS === 'web'
                        ? { flex: 1 }
                        : { flex: 1, backgroundColor: theme.colors.groupped.background }}
                >
                    <AuthProvider initialCredentials={initState.credentials}>
                        <ThemeProvider value={navigationTheme}>
                            <StatusBarProvider />
                            <ModalProvider>
                                <BrowserNavigationShortcuts />
                                <CommandPaletteProvider>
                                    <RealtimeProvider>
                                        <HorizontalSafeAreaWrapper>
                                            <SidebarNavigator />
                                        </HorizontalSafeAreaWrapper>
                                    </RealtimeProvider>
                                </CommandPaletteProvider>
                            </ModalProvider>
                        </ThemeProvider>
                    </AuthProvider>
                </GestureHandlerRootView>
            </KeyboardProvider>
        </SafeAreaProvider>
    );
    if (tracking) {
        providers = (
            <PostHogProvider client={tracking}>
                {providers}
            </PostHogProvider>
        );
    }

    return (
        <>
            <FaviconPermissionIndicator />
            {providers}
        </>
    );
}
