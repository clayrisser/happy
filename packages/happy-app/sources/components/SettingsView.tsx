import { NativeScrollEvent, NativeSyntheticEvent, View, ScrollView, Pressable, Platform } from 'react-native';
import { openExternalUrl } from '@/utils/openExternalUrl';
import * as React from 'react';
import { Text } from '@/components/StyledText';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import { Typography } from "@/constants/Typography";
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useConnectTerminal } from '@/hooks/useConnectTerminal';
import { useLocalSettingMutable, useSetting } from '@/sync/storage';
import { isUsingCustomServer } from '@/sync/serverConfig';
import { Modal } from '@/modal';
import { useMultiClick } from '@/hooks/useMultiClick';
import { useUnistyles } from 'react-native-unistyles';
import { layout } from '@/components/layout';
import { useProfile } from '@/sync/storage';
import { getDisplayName, getAvatarUrl, getBio } from '@/sync/profile';
import { Avatar } from '@/components/Avatar';
import { Wordmark } from '@/components/Wordmark';
import { t } from '@/text';

type BuildConfig = {
    buildCommitSha?: unknown;
    buildCommitTimestamp?: unknown;
};

function getBuildConfig(): BuildConfig {
    const appConfig = Constants.expoConfig?.extra?.app;
    return appConfig && typeof appConfig === 'object' ? appConfig as BuildConfig : {};
}

function formatUtcTimestamp(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return value;
    }

    return date.toISOString()
        .replace(/\.\d{3}Z$/, 'Z')
        .replace(/:\d{2}Z$/, 'Z')
        .replace('T', ' ')
        .replace('Z', ' UTC');
}

function formatBuildSubtitle(buildConfig: BuildConfig): string | undefined {
    const commitTimestamp = typeof buildConfig.buildCommitTimestamp === 'string'
        ? formatUtcTimestamp(buildConfig.buildCommitTimestamp)
        : undefined;
    const commitSha = typeof buildConfig.buildCommitSha === 'string'
        ? buildConfig.buildCommitSha.slice(0, 7)
        : undefined;

    if (!commitTimestamp && !commitSha) {
        return undefined;
    }

    return [
        commitTimestamp ? `Commit ${commitTimestamp}` : 'Commit',
        commitSha,
    ].filter(Boolean).join(' / ');
}

export const SettingsView = React.memo(function SettingsView({
    topContentInset = 0,
    bottomContentInset = 0,
    onScroll,
}: {
    topContentInset?: number;
    bottomContentInset?: number;
    onScroll?: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
}) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const appVersion = Constants.expoConfig?.version || '1.0.0';
    const runtimeVersion = typeof Constants.expoConfig?.runtimeVersion === 'string'
        ? Constants.expoConfig.runtimeVersion
        : undefined;
    const versionDetail = [
        appVersion,
        runtimeVersion ? `runtime ${runtimeVersion}` : undefined,
    ].filter(Boolean).join(' / ');
    const versionSubtitle = formatBuildSubtitle(getBuildConfig());
    const [devModeEnabled, setDevModeEnabled] = useLocalSettingMutable('devModeEnabled');
    const experiments = useSetting('experiments');
    const isCustomServer = isUsingCustomServer();
    const profile = useProfile();
    const displayName = getDisplayName(profile);
    const avatarUrl = getAvatarUrl(profile);
    const bio = getBio(profile);

    const { connectTerminal, connectWithUrl, isLoading } = useConnectTerminal();

    // Use the multi-click hook for version clicks
    const handleVersionClick = useMultiClick(() => {
        // Toggle dev mode
        const newDevMode = !devModeEnabled;
        setDevModeEnabled(newDevMode);
        Modal.alert(
            t('modals.developerMode'),
            newDevMode ? t('modals.developerModeEnabled') : t('modals.developerModeDisabled')
        );
    }, {
        requiredClicks: 10,
        resetTimeout: 2000
    });

    return (

        <ItemList
            style={{ paddingTop: 0 }}
            containerStyle={{ paddingTop: topContentInset, paddingBottom: bottomContentInset }}
            onScroll={onScroll}
            scrollEventThrottle={16}
        >
            {/* App Info Header */}
            <View style={{ maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%' }}>
                <View
                    style={{
                    alignItems: 'center',
                    paddingVertical: 24,
                    backgroundColor: theme.colors.surface,
                    marginTop: 16,
                    borderRadius: Platform.select({ web: 12, default: 16 }),
                    marginHorizontal: 16,
                    borderWidth: Platform.OS === 'web' ? 0 : 0.5,
                    borderColor: theme.colors.divider,
                }}>
                    {profile.firstName ? (
                        // Profile view: Avatar + name + version
                        <>
                            <View style={{ marginBottom: 12 }}>
                                <Avatar
                                    id={profile.id}
                                    size={90}
                                    imageUrl={avatarUrl}
                                    thumbhash={profile.avatar?.thumbhash}
                                />
                            </View>
                            <Text style={{ fontSize: 20, fontWeight: '600', color: theme.colors.text, marginBottom: bio ? 4 : 8 }}>
                                {displayName}
                            </Text>
                            {bio && (
                                <Text style={{ fontSize: 14, color: theme.colors.textSecondary, textAlign: 'center', marginBottom: 8, paddingHorizontal: 16 }}>
                                    {bio}
                                </Text>
                            )}
                        </>
                    ) : (
                        // Logo view: Original logo + version
                        <>
                            <View style={{ marginBottom: 12 }}>
                                <Wordmark width={170} />
                            </View>
                        </>
                    )}
                </View>
            </View>

            {/* Connect Terminal - Only show on native platforms */}
            {Platform.OS !== 'web' && (
                <ItemGroup>
                    <Item
                        title={t('settings.scanQrCodeToAuthenticate')}
                        icon={<Ionicons name="qr-code-outline" size={29} color="#007AFF" />}
                        onPress={connectTerminal}
                        loading={isLoading}
                        showChevron={false}
                    />
                    <Item
                        title={t('connect.enterUrlManually')}
                        icon={<Ionicons name="link-outline" size={29} color="#007AFF" />}
                        onPress={async () => {
                            const url = await Modal.prompt(
                                t('modals.authenticateTerminal'),
                                t('modals.pasteUrlFromTerminal'),
                                {
                                    placeholder: 'happy://terminal?...',
                                    confirmText: t('common.authenticate')
                                }
                            );
                            if (url?.trim()) {
                                connectWithUrl(url.trim());
                            }
                        }}
                        showChevron={false}
                    />
                </ItemGroup>
            )}

            {/* Social */}
            {/* <ItemGroup title={t('settings.social')}>
                <Item
                    title={t('navigation.friends')}
                    subtitle={t('friends.manageFriends')}
                    icon={<Ionicons name="people-outline" size={29} color="#007AFF" />}
                    onPress={() => router.push('/friends')}
                />
            </ItemGroup> */}

            {/* Features */}
            <ItemGroup title={t('settings.features')}>
                <Item
                    title={t('settings.account')}
                    subtitle={t('settings.accountSubtitle')}
                    icon={<Ionicons name="person-circle-outline" size={29} color="#007AFF" />}
                    onPress={() => router.push('/settings/account')}
                />
                <Item
                    title={t('settings.appearance')}
                    subtitle={t('settings.appearanceSubtitle')}
                    icon={<Ionicons name="color-palette-outline" size={29} color="#5856D6" />}
                    onPress={() => router.push('/settings/appearance')}
                />
                <Item
                    title={t('settings.voiceAssistant')}
                    subtitle={t('settings.voiceAssistantSubtitle')}
                    icon={<Ionicons name="mic-outline" size={29} color="#34C759" />}
                    onPress={() => router.push('/settings/voice')}
                />
                <Item
                    title="Agents"
                    subtitle="Connected machines and agent defaults"
                    icon={<Ionicons name="options-outline" size={29} color="#5AC8FA" />}
                    onPress={() => router.push('/settings/agents' as any)}
                />
                {/* Every Claude account, under the machine it is logged in on
                    (DROVE-165 / DROVE-136). Above Flip policy because it is the
                    page that says WHERE work can go; the policy below decides
                    which of them it picks. */}
                <Item
                    title="Accounts"
                    subtitle="Claude accounts on each machine"
                    icon={<Ionicons name="people-circle-outline" size={29} color="#007AFF" />}
                    onPress={() => router.push('/settings/accounts' as any)}
                />
                {/* Cattle Drover's flip and model-fallback defaults (DROVE-3).
                    Reachable without a session, because the case it exists for
                    is setting what the NEXT session starts with. */}
                <Item
                    title="Account switching"
                    subtitle="When an account runs out"
                    icon={<Ionicons name="swap-horizontal-outline" size={29} color="#FF9500" />}
                    onPress={() => router.push('/settings/flip-policy' as any)}
                />
                {/* The three feedback channels and the four ways of working
                    (DROVE-72). The composer's long-press sheet is the
                    shortcut; this is the page. */}
                <Item
                    title="Channels"
                    subtitle="Visual, audio, and haptic feedback"
                    icon={<Ionicons name="notifications-outline" size={29} color="#AF52DE" />}
                    onPress={() => router.push('/settings/channels' as any)}
                />
                {/* Every channel on demand (DROVE-75): each wrist buzz, the
                    voices, every card shape, and a real push, without waiting
                    for a gate. Shown once on first run; this is the way back. */}
                <Item
                    title="Demo every channel"
                    subtitle="Try every cue on demand"
                    icon={<Ionicons name="pulse-outline" size={29} color="#AF52DE" />}
                    onPress={() => router.push('/settings/demo' as any)}
                />
                {experiments && (
                    <Item
                        title={t('settings.usage')}
                        subtitle={t('settings.usageSubtitle')}
                        icon={<Ionicons name="analytics-outline" size={29} color="#007AFF" />}
                        onPress={() => router.push('/settings/usage')}
                    />
                )}
            </ItemGroup>

            {/* Developer */}
            {(__DEV__ || devModeEnabled) && (
                <ItemGroup title={t('settings.developer')}>
                    <Item
                        title={t('settings.developerTools')}
                        icon={<Ionicons name="construct-outline" size={29} color="#5856D6" />}
                        onPress={() => router.push('/dev')}
                    />
                </ItemGroup>
            )}

            {/* About */}
            <ItemGroup title={t('settings.about')} footer={t('settings.aboutFooter')}>
                <Item
                    title={t('settings.privacyPolicy')}
                    icon={<Ionicons name="shield-checkmark-outline" size={29} color="#007AFF" />}
                    onPress={() => openExternalUrl('https://happy.engineering/privacy/')}
                />
                <Item
                    title={t('settings.termsOfService')}
                    icon={<Ionicons name="document-text-outline" size={29} color="#007AFF" />}
                    onPress={() => openExternalUrl('https://github.com/slopus/happy/blob/main/TERMS.md')}
                />
                {Platform.OS === 'ios' && (
                    <Item
                        title={t('settings.eula')}
                        icon={<Ionicons name="document-text-outline" size={29} color="#007AFF" />}
                        onPress={() => openExternalUrl('https://www.apple.com/legal/internet-services/itunes/dev/stdeula/')}
                    />
                )}
                <Item
                    title={t('common.version')}
                    subtitle={versionSubtitle}
                    subtitleLines={2}
                    detail={versionDetail}
                    icon={<Ionicons name="information-circle-outline" size={29} color={theme.colors.textSecondary} />}
                    onPress={handleVersionClick}
                    showChevron={false}
                />
            </ItemGroup>

        </ItemList>
    );
});
