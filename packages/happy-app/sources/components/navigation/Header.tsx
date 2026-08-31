import * as React from 'react';
import { Animated, View, Text, Platform, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackHeaderProps } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import { layout } from '../layout';
import { isRunningOnMac } from '@/utils/platform';
import { useHeaderHeight, useIsTablet } from '@/utils/responsive';
import { Typography } from '@/constants/Typography';
import { StyleSheet } from 'react-native-unistyles';
import { GlassChromeButton, GlassChromeSurface } from '../GlassChromeControl';
import {
    MobileHeaderScrim,
    MOBILE_HOME_SCRIM_OVERLAY_OPACITY,
    MOBILE_STRONG_HEADER_SCRIM_RESTING_OPACITY,
    MOBILE_STRONG_HEADER_SCRIM_UNDERLAP_OPACITY,
    type MobileHeaderScrimVariant,
} from './MobileHeaderScrim';
import {
    MOBILE_GLASS_CONTROL_RADIUS,
    MOBILE_GLASS_CONTROL_SIZE,
    MOBILE_GLASS_HEADER_HEIGHT,
} from './headerMetrics';

/**
 * The header every screen that is not the session gets, drawn in the same
 * material as the session's (DROVE-161).
 *
 * Clay, with the session header and the agent header side by side: "See how
 * some places are using Liquid Glass and others aren't". The session header
 * had been converted by DROVE-153; this one had not, so its back button was a
 * flat grey disc and its title sat as bare text.
 *
 * TWO THINGS WERE WRONG, and only one of them was here. The controls were on
 * `MobileGlassSurface material="static"`, which is expo-blur with a flat
 * colour painted over it rather than `UIGlassEffect`, and a blur of a black
 * chat is black. They are `GlassChromeSurface` / `GlassChromeButton` now, the
 * same two objects the session header uses, so the material, the `regular`
 * style, the forced `colorScheme` and the fallback all come from one place.
 *
 * The other half was reach: `(app)/_layout.tsx` handed iPhones to UIKit's own
 * navigation bar, so most screens never rendered this component at all. That
 * is where the agent screen's header came from. The layout now routes every
 * phone here, and the iPad keeps UIKit because this header hides its back
 * button on a tablet.
 */
interface HeaderProps {
    title?: React.ReactNode;
    subtitle?: string;
    headerLeft?: (() => React.ReactNode) | null;
    headerLeftGlass?: boolean;
    headerRight?: (() => React.ReactNode) | null;
    headerRightGlass?: boolean;
    headerStyle?: any;
    headerTitleStyle?: any;
    headerSubtitleStyle?: any;
    headerTintColor?: string;
    headerBackgroundColor?: string;
    headerShadowVisible?: boolean;
    headerTransparent?: boolean;
    headerBackdropVisible?: boolean;
    headerBackdropAlwaysVisible?: boolean;
    headerBackdropVariant?: MobileHeaderScrimVariant;
    mobileTitleSurface?: 'glass' | 'plain';
    mobileTitleAlignment?: 'start' | 'center';
    safeAreaEnabled?: boolean;
}

export const Header = React.memo((props: HeaderProps) => {
    const styles = stylesheet;

    const {
        title,
        subtitle,
        headerLeft,
        headerLeftGlass = false,
        headerRight,
        headerRightGlass = true,
        headerStyle,
        headerTitleStyle,
        headerSubtitleStyle,
        headerTintColor, // Accept but ignore - using theme instead
        headerBackgroundColor, // Accept but ignore - using theme instead
        headerShadowVisible = true,
        headerTransparent = false,
        headerBackdropVisible = false,
        headerBackdropAlwaysVisible = false,
        headerBackdropVariant = 'subtle',
        mobileTitleSurface = 'glass',
        mobileTitleAlignment = 'start',
        safeAreaEnabled = true,
    } = props;

    const insets = useSafeAreaInsets();
    const paddingTop = safeAreaEnabled ? insets.top : 0;
    const headerHeight = useHeaderHeight();
    const isTablet = useIsTablet();
    const isDesktop = Platform.OS === 'web' || isRunningOnMac();
    const isNativePhone = !isDesktop && !isTablet;
    const glassControlsEnabled = isNativePhone && Platform.OS === 'ios';
    const isAndroidHeader = isNativePhone && Platform.OS === 'android';
    const headerLeftUsesGlass = headerLeftGlass && glassControlsEnabled;
    const headerRightUsesGlass = headerRightGlass && glassControlsEnabled;
    const contentHeight = glassControlsEnabled ? Math.max(headerHeight, MOBILE_GLASS_HEADER_HEIGHT) : headerHeight;
    const centerMobileTitle = isNativePhone && mobileTitleAlignment === 'center';
    const homeBackdrop = headerBackdropVariant === 'home';
    const strongBackdrop = headerBackdropVariant !== 'subtle';
    // Mount/unmount fade only - it must land on exactly 1, because a
    // translucent ancestor kills the native blur underneath it. How heavy the
    // scrim reads is carried by backdropStrength, which the scrim applies to
    // its dim gradient alone.
    const backdropShouldBeVisible = glassControlsEnabled && (
        headerBackdropAlwaysVisible || (!homeBackdrop && headerBackdropVisible)
    );
    const backdropStrengthTarget = homeBackdrop
        ? MOBILE_HOME_SCRIM_OVERLAY_OPACITY
        : strongBackdrop
            ? headerBackdropVisible
                ? MOBILE_STRONG_HEADER_SCRIM_UNDERLAP_OPACITY
                : MOBILE_STRONG_HEADER_SCRIM_RESTING_OPACITY
            : 1;
    const backdropOpacity = React.useRef(new Animated.Value(backdropShouldBeVisible ? 1 : 0)).current;
    const backdropStrength = React.useRef(new Animated.Value(backdropStrengthTarget)).current;
    const [backdropMounted, setBackdropMounted] = React.useState(backdropShouldBeVisible);

    React.useEffect(() => {
        if (!glassControlsEnabled) {
            setBackdropMounted(false);
            return;
        }

        if (backdropShouldBeVisible) {
            setBackdropMounted(true);
        }
        Animated.timing(backdropStrength, {
            toValue: backdropStrengthTarget,
            duration: 200,
            useNativeDriver: true,
        }).start();
        Animated.timing(backdropOpacity, {
            toValue: backdropShouldBeVisible ? 1 : 0,
            duration: 200,
            useNativeDriver: true,
        }).start(({ finished }) => {
            if (finished && !backdropShouldBeVisible) {
                setBackdropMounted(false);
            }
        });
    }, [backdropOpacity, backdropShouldBeVisible, backdropStrength, backdropStrengthTarget, glassControlsEnabled]);

    const containerStyle = [
        styles.container,
        headerTransparent && !isAndroidHeader && styles.containerTransparent,
        (!headerTransparent || isAndroidHeader) && styles.containerNormal,
        isAndroidHeader && headerBackdropVisible && styles.containerAndroidScrolled,
        {
            paddingTop,
        },
        headerShadowVisible && styles.shadow,
        headerStyle,
        isAndroidHeader && (headerBackdropVisible ? styles.containerAndroidScrolled : styles.containerNormal),
        // Transparent because the screen ASKED to be, not because the phone is
        // an iPhone (DROVE-161). It used to be unconditional, which was
        // harmless while the only iPhone screens reaching this component were
        // the five that set `headerTransparent` anyway. Now that every phone
        // screen renders here, an unconditional override would strip the
        // agent screen's own tinted bar and leave a tone break across the top
        // of it. `headerStyle` above already carries `transparent` from the
        // navigator's screenOptions, so screens that said nothing are
        // unchanged.
        glassControlsEnabled && headerTransparent && styles.containerTransparent,
    ];

    const subtitleStyle = [
        styles.subtitle,
        isDesktop && styles.desktopSubtitle,
        headerSubtitleStyle,
    ];
    const titleContent = (
        <>
            {title}
            {subtitle && <Text style={subtitleStyle} numberOfLines={1}>{subtitle}</Text>}
        </>
    );

    return (
        <View style={containerStyle}>
            {glassControlsEnabled && backdropMounted && (
                <Animated.View
                    pointerEvents="none"
                    style={[
                        styles.headerBackdrop,
                        homeBackdrop
                            ? styles.headerBackdropHome
                            : strongBackdrop && styles.headerBackdropStrong,
                        { opacity: backdropOpacity },
                    ]}
                >
                    <MobileHeaderScrim
                        variant={headerBackdropVariant}
                        overlayOpacity={backdropStrength}
                    />
                </Animated.View>
            )}
            <View style={styles.contentWrapper}>
                <View style={[
                    styles.content,
                    isDesktop && styles.desktopContent,
                    centerMobileTitle && styles.mobileCenteredContent,
                    { height: contentHeight },
                ]}>
                    {/* Neither slot is `interactive` (DROVE-202). They take
                        whatever a screen puts in them and `headerRightGlass`
                        defaults to on, so one of them is a ToolStatusIndicator
                        rather than a button; a capsule that answers a press it
                        cannot act on is worse than one that sits still. Which
                        slots earn it is a per-screen decision, not a default.
                        The clip is gone either way, so the day one does it can
                        grow. */}
                    <View style={styles.leftContainer}>
                        {headerLeft && headerLeftUsesGlass && (
                            <GlassChromeSurface
                                radius={MOBILE_GLASS_CONTROL_RADIUS}
                                style={styles.leftControlGlass}
                            >
                                <View style={styles.leftControlContent}>
                                    {headerLeft()}
                                </View>
                            </GlassChromeSurface>
                        )}
                        {headerLeft && !headerLeftUsesGlass && (
                            isAndroidHeader
                                ? <View style={styles.androidControlSlot}>{headerLeft()}</View>
                                : headerLeft()
                        )}
                    </View>

                    <View style={[
                        styles.centerContainer,
                        isDesktop && styles.desktopCenterContainer,
                        centerMobileTitle && styles.mobileCenteredTitleContainer,
                    ]}>
                        {glassControlsEnabled && mobileTitleSurface === 'glass' && title ? (
                            <GlassChromeSurface
                                radius={MOBILE_GLASS_CONTROL_RADIUS}
                                style={styles.mobileTitlePill}
                            >
                                {titleContent}
                            </GlassChromeSurface>
                        ) : titleContent}
                    </View>

                    <View style={styles.rightContainer}>
                        {headerRight && headerRightUsesGlass && (
                            <GlassChromeSurface
                                radius={MOBILE_GLASS_CONTROL_RADIUS}
                                style={styles.rightControlGlass}
                            >
                                <View style={styles.rightControlContent}>
                                    {headerRight()}
                                </View>
                            </GlassChromeSurface>
                        )}
                        {headerRight && !headerRightUsesGlass && (
                            isAndroidHeader
                                ? <View style={styles.androidControlSlot}>{headerRight()}</View>
                                : headerRight()
                        )}
                    </View>
                </View>
            </View>
        </View>
    );
});

// Extended navigation options to support subtitle
interface ExtendedNavigationOptions extends Partial<NativeStackHeaderProps['options']> {
    headerSubtitle?: string;
    headerSubtitleStyle?: any;
}

// Default back button component
const DefaultBackButton: React.FC<{ tintColor?: string; onPress: () => void }> = ({ tintColor = '#000', onPress }) => {
    const styles = stylesheet;
    if (Platform.OS === 'web' || isRunningOnMac()) {
        return (
            <Pressable onPress={onPress} hitSlop={15}>
                <Ionicons name={Platform.OS === 'ios' ? 'chevron-back' : 'arrow-back'} size={24} color={tintColor} />
            </Pressable>
        );
    }

    if (Platform.OS === 'android') {
        return (
            <Pressable
                onPress={onPress}
                hitSlop={8}
                style={({ pressed }) => [styles.androidBackButton, pressed && styles.controlPressed]}
            >
                <Ionicons name="arrow-back" size={24} color={tintColor} />
            </Pressable>
        );
    }

    // Drawn and tapped on the same 44pt disc, in the real material
    // (DROVE-161). The Pressable used to sit OUTSIDE the surface with 10pt of
    // hitSlop; GlassChromeButton puts it inside and fills it, so what is drawn
    // and what answers a touch are one rectangle.
    return (
        <GlassChromeButton
            onPress={onPress}
            size={MOBILE_GLASS_CONTROL_SIZE}
            accessibilityRole="button"
            accessibilityLabel="Back"
            style={styles.backButton}
        >
            <Ionicons name="chevron-back" size={24} color={tintColor} />
        </GlassChromeButton>
    );
};

// Component wrapper for navigation header
type NavigationHeaderComponentProps = NativeStackHeaderProps & {
    mobileTitleSurfaceOverride?: HeaderProps['mobileTitleSurface'];
};

const NavigationHeaderComponent: React.FC<NavigationHeaderComponentProps> = React.memo((props) => {
    const { options, route, back, navigation } = props;
    const extendedOptions = options as ExtendedNavigationOptions;
    const isTablet = useIsTablet();
    const isDesktop = Platform.OS === 'web' || isRunningOnMac();

    // Hide back button on tablet — navigation is handled via sidebar and persistent header
    const shouldHideBackButton = isTablet;

    // Extract title - handle both string and function types
    let title: React.ReactNode | null = null;
    if (options.headerTitle) {
        if (typeof options.headerTitle === 'string') {
            title = (
                <Text
                    numberOfLines={1}
                    ellipsizeMode="tail"
                    style={[
                        {
                            fontSize: isDesktop ? 17 : 16,
                            fontWeight: '600',
                            textAlign: Platform.OS === 'ios' ? 'center' : 'left',
                            color: options.headerTintColor || '#000',
                            maxWidth: '100%',
                            flexShrink: 1,
                        },
                        Typography.default('semiBold'),
                        options.headerTitleStyle
                    ]}
                >
                    {options.headerTitle}
                </Text>
            );
        } else if (typeof options.headerTitle === 'function') {
            // Handle function type headerTitle
            title = options.headerTitle({ children: route.name, tintColor: options.headerTintColor });
        }
    } else if (typeof options.title === 'string') {
        title = (
            <Text
                numberOfLines={1}
                ellipsizeMode="tail"
                style={[
                    { fontSize: 17, fontWeight: '600', textAlign: Platform.OS === 'ios' ? 'center' : 'left', color: options.headerTintColor || '#000', maxWidth: '100%', flexShrink: 1 },
                    Typography.default('semiBold'),
                    options.headerTitleStyle
                ]}
            >
                {options.title}
            </Text>
        );
    }

    // Determine header left content
    let headerLeftContent: (() => React.ReactNode) | undefined | null = null;
    if (options.headerLeft) {
        // Use custom headerLeft if provided
        headerLeftContent = () => options.headerLeft!({ canGoBack: !!back, tintColor: options.headerTintColor });
    } else if (back && options.headerBackVisible !== false && !shouldHideBackButton) {
        // Show default back button if can go back and not explicitly hidden
        // Also hide on tablet when at first or second screen
        headerLeftContent = () => (
            <DefaultBackButton
                tintColor={options.headerTintColor}
                onPress={() => navigation.goBack()}
            />
        );
    }

    return (
        <Header
            title={title}
            subtitle={extendedOptions.headerSubtitle}
            headerLeft={headerLeftContent}
            headerRight={options.headerRight ?
                () => options.headerRight!({ canGoBack: !!back, tintColor: options.headerTintColor }) :
                undefined
            }
            headerStyle={options.headerStyle}
            headerTitleStyle={options.headerTitleStyle}
            headerSubtitleStyle={extendedOptions.headerSubtitleStyle}
            headerShadowVisible={options.headerShadowVisible}
            headerTransparent={options.headerTransparent}
            headerBackdropAlwaysVisible={Platform.OS === 'ios'}
            headerBackdropVariant="strong"
            mobileTitleSurface={props.mobileTitleSurfaceOverride}
            mobileTitleAlignment={Platform.OS === 'ios' ? 'center' : 'start'}
        />
    );
});

// Export a render function for React Navigation
export const createHeader = (props: NativeStackHeaderProps) => {
    if (props.options.headerShown === false) {
        return null;
    }
    return <NavigationHeaderComponent {...props} />;
};

// Detail screens keep the same centered geometry as Home, but the title is
// ordinary text rather than another control.
export const createPlainHeader = (props: NativeStackHeaderProps) => {
    if (props.options.headerShown === false) {
        return null;
    }
    return <NavigationHeaderComponent {...props} mobileTitleSurfaceOverride="plain" />;
};

const stylesheet = StyleSheet.create((theme, runtime) => ({
    container: {
        position: 'relative',
        zIndex: 100,
    },
    containerTransparent: {
        backgroundColor: 'transparent',
    },
    containerNormal: {
        backgroundColor: theme.colors.header.background,
    },
    containerAndroidScrolled: {
        backgroundColor: theme.colors.surfaceHigh,
    },
    // Backdrops are material layers behind floating controls. The Home variant
    // stays stable while content scrolls; other headers may still opt into a
    // stronger underlap state.
    headerBackdrop: {
        ...StyleSheet.absoluteFillObject,
    },
    headerBackdropStrong: {
        bottom: -8,
    },
    headerBackdropHome: {
        bottom: -8,
    },
    contentWrapper: {
        width: '100%',
        alignItems: 'center',
    },
    content: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: Platform.OS === 'web' ? 0 : 8,
        paddingHorizontal: 16,
        width: '100%',
        maxWidth: layout.headerMaxWidth,
    },
    mobileCenteredContent: {
        justifyContent: 'space-between',
    },
    desktopContent: {
        gap: 0,
        paddingHorizontal: Platform.select({ ios: 8, default: 16 }),
    },
    leftContainer: {
        flexGrow: 0,
        flexShrink: 0,
        alignItems: 'flex-start',
    },
    centerContainer: {
        flexGrow: 1,
        flexBasis: 0,
        alignSelf: 'stretch',
        flexDirection: Platform.OS === 'web' ? 'row' : 'column',
        alignItems: Platform.OS === 'web' ? 'center' : 'flex-start',
        justifyContent: Platform.OS === 'web' ? 'flex-start' : 'center',
        paddingHorizontal: Platform.OS === 'web' ? 12 : 0,
        minWidth: Platform.OS === 'web' ? undefined : 0,
    },
    mobileCenteredTitleContainer: {
        position: 'absolute',
        top: 0,
        bottom: 0,
        left: 64,
        right: 64,
        alignItems: 'center',
        paddingHorizontal: 0,
    },
    desktopCenterContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: Platform.OS === 'ios' ? 'center' : 'flex-start',
        paddingHorizontal: 12,
        minWidth: undefined,
    },
    // No backgroundColor and no hand-drawn rim (DROVE-161). Both belong to
    // GlassChromeSurface now: on the material UIGlassEffect draws its own
    // specular edge, and off it the surface paints an opaque fill with a
    // hairline. A `backgroundColor: transparent` here used to win over that
    // fallback, which is how an iOS without the material got an invisible
    // control instead of a plain one.
    mobileTitlePill: {
        maxWidth: '100%',
        height: MOBILE_GLASS_CONTROL_SIZE,
        minWidth: 0,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 14,
        borderRadius: MOBILE_GLASS_CONTROL_RADIUS,
        shadowColor: '#000000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: theme.dark ? 0.24 : 0.06,
        shadowRadius: 20,
    },
    rightContainer: {
        flexGrow: 0,
        flexShrink: 0,
        alignItems: 'flex-end',
    },
    rightControlGlass: {
        minWidth: Platform.select({ web: 0, default: MOBILE_GLASS_CONTROL_SIZE }),
        minHeight: Platform.select({ web: 0, default: MOBILE_GLASS_CONTROL_SIZE }),
        borderRadius: MOBILE_GLASS_CONTROL_RADIUS,
        alignItems: 'center',
        justifyContent: 'center',
        // The clip belongs to GlassChromeSurface (DROVE-202): on the material
        // it has to be `visible` so the press swell can leave the frame, and
        // `masksToBounds` was eating this shadow as well.
        shadowColor: '#000000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: Platform.select({ ios: theme.dark ? 0.24 : 0.06, default: 0 }),
        shadowRadius: 20,
        elevation: 0,
    },
    leftControlGlass: {
        width: Platform.select({ web: 36, default: MOBILE_GLASS_CONTROL_SIZE }),
        height: Platform.select({ web: 36, default: MOBILE_GLASS_CONTROL_SIZE }),
        borderRadius: MOBILE_GLASS_CONTROL_RADIUS,
        alignItems: 'center',
        justifyContent: 'center',
        // The clip belongs to GlassChromeSurface (DROVE-202): on the material
        // it has to be `visible` so the press swell can leave the frame, and
        // `masksToBounds` was eating this shadow as well.
        shadowColor: '#000000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: Platform.select({ ios: theme.dark ? 0.24 : 0.06, default: 0 }),
        shadowRadius: 20,
        elevation: 0,
    },
    leftControlContent: {
        width: '100%',
        height: '100%',
        alignItems: 'center',
        justifyContent: 'center',
    },
    rightControlContent: {
        minHeight: Platform.select({ web: 0, default: MOBILE_GLASS_CONTROL_SIZE }),
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 0,
    },
    androidControlSlot: {
        minWidth: 48,
        height: 48,
        alignItems: 'center',
        justifyContent: 'center',
    },
    title: {
        fontSize: Platform.OS === 'web' ? 17 : 16,
        fontWeight: '600',
        textAlign: 'center',
        color: theme.colors.header.tint,
        ...Typography.default('semiBold'),
    },
    subtitle: {
        fontSize: Platform.OS === 'web' ? 13 : 12,
        fontWeight: '400',
        textAlign: 'left',
        marginTop: Platform.OS === 'web' ? 2 : 1,
        color: theme.colors.header.tint,
        ...Typography.default('regular'),
    },
    desktopSubtitle: {
        fontSize: 13,
        textAlign: Platform.OS === 'ios' ? 'center' : 'left',
        marginTop: 2,
    },
    shadow: {
        shadowColor: theme.colors.shadow.color,
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: theme.colors.shadow.opacity,
        shadowRadius: 3,
        elevation: 4,
        boxShadow: '0 1px 3px rgba(0, 0, 0, 0.15)',
    },
    backButton: {
        borderRadius: MOBILE_GLASS_CONTROL_RADIUS,
        shadowColor: '#000000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: theme.dark ? 0.24 : 0.06,
        shadowRadius: 20,
    },
    androidBackButton: {
        width: 48,
        height: 48,
        alignItems: 'center',
        justifyContent: 'center',
    },
    controlPressed: {
        opacity: 0.68,
        transform: [{ scale: 0.97 }],
    },
}));
