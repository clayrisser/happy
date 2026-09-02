import React, { useState } from 'react';
import { View, TextInput, KeyboardAvoidingView, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Stack, useRouter } from 'expo-router';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { RoundButton } from '@/components/RoundButton';
import { Switch } from '@/components/Switch';
import { Modal } from '@/modal';
import { layout } from '@/components/layout';
import { t } from '@/text';
import {
    getServerUrl,
    setServerUrl,
    validateServerUrl,
    getServerInfo,
    getDefaultServerUrl,
    setUseCustomServerForVoice,
    shouldUseCustomServerForVoice,
} from '@/sync/serverConfig';
import { switchServer } from '@/sync/serverSwitch';
import { authGetToken } from '@/auth/authGetToken';
import { decodeBase64 } from '@/encryption/base64';
import { TokenStorage } from '@/auth/tokenStorage';
import * as Updates from 'expo-updates';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

const stylesheet = StyleSheet.create((theme) => ({
    keyboardAvoidingView: {
        flex: 1,
    },
    itemListContainer: {
        flex: 1,
    },
    contentContainer: {
        backgroundColor: Platform.select({ web: theme.colors.surface, default: 'transparent' }),
        paddingHorizontal: 16,
        paddingVertical: 12,
        width: '100%',
        maxWidth: layout.maxWidth,
        alignSelf: 'center',
    },
    labelText: {
        ...Typography.default('semiBold'),
        fontSize: 12,
        color: theme.colors.textSecondary,
        textTransform: 'uppercase',
        letterSpacing: 0.5,
        marginBottom: 8,
    },
    textInput: {
        backgroundColor: Platform.select({ web: theme.colors.input.background, default: theme.colors.glass.backgroundSubtle }),
        padding: 12,
        borderRadius: 8,
        marginBottom: 8,
        ...Typography.mono(),
        fontSize: 14,
        color: theme.colors.input.text,
    },
    textInputValidating: {
        opacity: 0.6,
    },
    errorText: {
        ...Typography.default(),
        fontSize: 12,
        color: theme.colors.textDestructive,
        marginBottom: 12,
    },
    validatingText: {
        ...Typography.default(),
        fontSize: 12,
        color: theme.colors.status.connecting,
        marginBottom: 12,
    },
    buttonRow: {
        flexDirection: 'row',
        gap: 12,
        marginBottom: 12,
    },
    buttonWrapper: {
        flex: 1,
    },
    statusText: {
        ...Typography.default(),
        fontSize: 12,
        color: theme.colors.textSecondary,
        textAlign: 'center',
    },
}));

export default function ServerConfigScreen() {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const router = useRouter();
    const serverInfo = getServerInfo();
    const [inputUrl, setInputUrl] = useState(serverInfo.isCustom ? getServerUrl() : '');
    const [isCustomServer, setIsCustomServer] = useState(serverInfo.isCustom);
    const [useCustomServerForVoice, setUseCustomServerForVoiceState] = useState(shouldUseCustomServerForVoice());
    const [error, setError] = useState<string | null>(null);
    const [isValidating, setIsValidating] = useState(false);
    const [isSwitching, setIsSwitching] = useState(false);

    /**
     * The switch itself (DROVE-332). Identity is the secret key on this device,
     * so the same key on another relay is the same account there — which makes
     * changing servers a re-auth rather than the logout-and-pair-again this
     * screen used to require. `switchServer` asks the new server for a token
     * FIRST and writes nothing until it answers, so a bad URL or a relay that
     * is down leaves the app exactly where it was.
     */
    const moveTo = async (target: string | null): Promise<boolean> => {
        setIsSwitching(true);
        try {
            const result = await switchServer(target, {
                authGetToken,
                decodeSecret: (secret) => decodeBase64(secret, 'base64url'),
                readCredentials: () => TokenStorage.getCredentials(),
                writeCredentials: (next) => TokenStorage.setCredentials(next),
                getServerUrl,
                setServerUrl,
                defaultServerUrl: getDefaultServerUrl(),
                reload: async () => {
                    if (Platform.OS === 'web') {
                        window.location.reload();
                        return;
                    }
                    try {
                        await Updates.reloadAsync();
                    } catch {
                        // Dev builds throw ERR_UPDATES_DISABLED. The credentials
                        // and the URL are already written, so the next start
                        // lands on the new server either way.
                    }
                },
            });
            if (!result.ok) {
                setError(t('server.reauthFailed'));
                return false;
            }
            return true;
        } finally {
            setIsSwitching(false);
        }
    };

    const validateServer = async (url: string): Promise<boolean> => {
        try {
            setIsValidating(true);
            setError(null);
            
            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Accept': 'text/plain'
                }
            });
            
            if (!response.ok) {
                setError(t('server.serverReturnedError'));
                return false;
            }
            
            const text = await response.text();
            if (!text.includes('Welcome to Happy Server!')) {
                setError(t('server.notValidHappyServer'));
                return false;
            }
            
            return true;
        } catch (err) {
            setError(t('server.failedToConnectToServer'));
            return false;
        } finally {
            setIsValidating(false);
        }
    };

    const handleSave = async () => {
        if (!inputUrl.trim()) {
            Modal.alert(t('common.error'), t('server.enterServerUrl'));
            return;
        }

        const validation = validateServerUrl(inputUrl);
        if (!validation.valid) {
            setError(validation.error || t('errors.invalidFormat'));
            return;
        }

        // Validate the server
        const isValid = await validateServer(inputUrl);
        if (!isValid) {
            return;
        }

        const confirmed = await Modal.confirm(
            t('server.changeServer'),
            t('server.continueWithServer'),
            { confirmText: t('common.continue'), destructive: true }
        );

        if (confirmed) {
            if (!await moveTo(inputUrl)) {
                return;
            }
            const nextIsCustomServer = getServerInfo().isCustom;
            setIsCustomServer(nextIsCustomServer);
            if (!nextIsCustomServer) {
                setUseCustomServerForVoice(false);
                setUseCustomServerForVoiceState(false);
            }
        }
    };

    const handleReset = async () => {
        const confirmed = await Modal.confirm(
            t('server.resetToDefault'),
            t('server.resetServerDefault'),
            { confirmText: t('common.reset'), destructive: true }
        );

        if (confirmed) {
            if (!await moveTo(null)) {
                return;
            }
            setUseCustomServerForVoice(false);
            setInputUrl('');
            setIsCustomServer(getServerInfo().isCustom);
            setUseCustomServerForVoiceState(false);
        }
    };

    const handleUseCustomServerForVoice = (enabled: boolean) => {
        setUseCustomServerForVoice(enabled);
        setUseCustomServerForVoiceState(enabled);
    };

    return (
        <>
            <Stack.Screen
                options={{
                    headerShown: true,
                    headerTitle: t('server.serverConfiguration'),
                    headerBackTitle: t('common.back'),
                }}
            />

            <KeyboardAvoidingView 
                style={styles.keyboardAvoidingView}
                behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            >
                <ItemList style={styles.itemListContainer}>
                    <ItemGroup footer={t('server.advancedFeatureFooter')}>
                        <View style={styles.contentContainer}>
                            <Text style={styles.labelText}>{t('server.customServerUrlLabel').toUpperCase()}</Text>
                            <TextInput
                                style={[
                                    styles.textInput,
                                    isValidating && styles.textInputValidating
                                ]}
                                value={inputUrl}
                                onChangeText={(text) => {
                                    setInputUrl(text);
                                    setError(null);
                                }}
                                placeholder={t('common.urlPlaceholder')}
                                placeholderTextColor={theme.colors.input.placeholder}
                                autoCapitalize="none"
                                autoCorrect={false}
                                keyboardType="url"
                                editable={!isValidating}
                            />
                            {error && (
                                <Text style={styles.errorText}>
                                    {error}
                                </Text>
                            )}
                            {isValidating && (
                                <Text style={styles.validatingText}>
                                    {t('server.validatingServer')}
                                </Text>
                            )}
                            {isSwitching && (
                                <Text style={styles.validatingText}>
                                    {t('server.reauthenticating')}
                                </Text>
                            )}
                            <View style={styles.buttonRow}>
                                <View style={styles.buttonWrapper}>
                                    <RoundButton
                                        title={t('server.resetToDefault')}
                                        size="normal"
                                        display="inverted"
                                        onPress={handleReset}
                                        disabled={isValidating || isSwitching}
                                    />
                                </View>
                                <View style={styles.buttonWrapper}>
                                    <RoundButton
                                        title={isValidating || isSwitching ? t('server.validating') : t('common.save')}
                                        size="normal"
                                        action={handleSave}
                                        disabled={isValidating || isSwitching}
                                    />
                                </View>
                            </View>
                            {isCustomServer && (
                                <Text style={styles.statusText}>
                                    {t('server.currentlyUsingCustomServer')}
                                </Text>
                            )}
                        </View>
                    </ItemGroup>

                    {isCustomServer && (
                        <ItemGroup
                            title={t('server.services')}
                            footer={t('server.customServerVoiceFooter')}
                        >
                            <Item
                                title={t('server.useCustomServerForVoice')}
                                subtitle={useCustomServerForVoice
                                    ? t('server.customServerVoiceEnabled')
                                    : t('server.customServerVoiceDisabled')}
                                icon={<Ionicons name="mic-outline" size={29} color="#34C759" />}
                                rightElement={
                                    <Switch
                                        value={useCustomServerForVoice}
                                        onValueChange={handleUseCustomServerForVoice}
                                    />
                                }
                                showChevron={false}
                            />
                        </ItemGroup>
                    )}

                    </ItemList>
            </KeyboardAvoidingView>
        </>
    );
}
