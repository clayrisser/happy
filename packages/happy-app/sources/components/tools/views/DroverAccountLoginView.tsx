import * as React from 'react';
import {
    ActivityIndicator,
    Platform,
    Share,
    Text,
    TextInput,
    TouchableOpacity,
    View,
    Linking,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { sessionAllow } from '@/sync/ops';
import { ToolViewProps } from './_all';
import { ToolSectionView } from '../ToolSectionView';
import { isQuestionSettled } from './askUserQuestionState';
import { accountLoginCard, codeToSend, hostOf } from './droverAccountLogin';

/**
 * Adding a Claude account without touching the Mac (DROVE-61).
 *
 * `drover account login` starts Claude Code's own login on the Mac with no
 * terminal, and puts the URL it printed on the bus. That card arrives here.
 * Two things have to happen on this screen and nowhere else:
 *
 *   THE LINK GOES OUT. Tapping it opens the iOS share sheet, which is what
 *   Clay asked for by name — "it opens the link with the little share slide-up
 *   thing so I can choose to copy it or open the browser". Sharing rather than
 *   opening matters: the code has to come back to THIS app, and a copied link
 *   pasted into whichever browser is already signed in is usually the shorter
 *   path than the in-app one.
 *
 *   THE CODE COMES BACK. It is typed here and resolves the bus question as
 *   text, which lands on the waiting login's stdin. It is never stored, never
 *   sent anywhere else, and the field is cleared as soon as it is submitted.
 *
 * The generic question card cannot do either: it renders options as buttons
 * and has nowhere to type, so a login mirrored through it could only ever be
 * cancelled.
 */
export const DroverAccountLoginView = React.memo<ToolViewProps>(({ tool, sessionId }) => {
    const { theme } = useUnistyles();
    const card = React.useMemo(() => accountLoginCard(tool.input), [tool.input]);
    const [code, setCode] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    const [sent, setSent] = React.useState<'code' | 'cancel' | null>(null);

    const settled = isQuestionSettled(tool.permission, tool.state);
    const canInteract = tool.state === 'running' && !settled && sent === null;

    const answer = React.useCallback(async (input: Record<string, unknown>, kind: 'code' | 'cancel') => {
        if (!sessionId || !tool.permission?.id) return;
        setBusy(true);
        setSent(kind);
        try {
            await sessionAllow(sessionId, tool.permission.id, undefined, undefined, 'approved', input);
        } catch {
            // Let it be tried again rather than leaving a card that looks sent.
            setSent(null);
        } finally {
            setBusy(false);
        }
    }, [sessionId, tool.permission?.id]);

    const openLink = React.useCallback(async () => {
        if (!card) return;
        // The share sheet on the platforms that have one; a plain open where
        // there is none, because a web build has no sheet to raise and a link
        // that does nothing at all is worse than one that opens a tab.
        if (Platform.OS === 'ios' || Platform.OS === 'android') {
            await Share.share({ message: card.url, url: card.url });
            return;
        }
        await Linking.openURL(card.url);
    }, [card]);

    const submit = React.useCallback(async () => {
        const value = code && codeToSend(code);
        if (!value) return;
        setCode('');
        await answer({ code: value }, 'code');
    }, [answer, code]);

    if (!card) return null;

    const ready = codeToSend(code) !== null;

    return (
        <ToolSectionView>
            <View style={styles.container}>
                <View style={styles.headerChip}>
                    <Text style={styles.headerText}>{card.header}</Text>
                </View>
                {card.reason ? <Text style={styles.reasonText}>{card.reason}</Text> : null}

                <TouchableOpacity
                    style={styles.linkButton}
                    onPress={openLink}
                    activeOpacity={0.7}
                >
                    <Ionicons name="open-outline" size={18} color={theme.colors.text} />
                    <View style={styles.linkContent}>
                        <Text style={styles.linkLabel}>Open the sign-in link</Text>
                        <Text style={styles.linkHost} numberOfLines={1}>{hostOf(card.url)}</Text>
                    </View>
                    <Ionicons name="share-outline" size={18} color={theme.colors.textSecondary} />
                </TouchableOpacity>

                {sent === 'code' ? (
                    <Text style={styles.reasonText}>Code sent to the Mac.</Text>
                ) : sent === 'cancel' ? (
                    <Text style={styles.reasonText}>Login cancelled.</Text>
                ) : (
                    <>
                        <TextInput
                            style={styles.codeInput}
                            value={code}
                            onChangeText={setCode}
                            editable={canInteract}
                            placeholder="Paste the code from that page"
                            placeholderTextColor={theme.colors.textSecondary}
                            autoCapitalize="none"
                            autoCorrect={false}
                            autoComplete="off"
                            spellCheck={false}
                            // Not `secureTextEntry`: a code that cannot be read
                            // back cannot be checked against the page it came
                            // from, and it is single-use and already on screen
                            // in the browser next door.
                            onSubmitEditing={submit}
                            returnKeyType="send"
                        />
                        <View style={styles.actionsContainer}>
                            <TouchableOpacity
                                style={styles.cancelButton}
                                onPress={() => answer({ optionId: 'cancel' }, 'cancel')}
                                disabled={!canInteract || busy}
                                activeOpacity={0.7}
                            >
                                <Text style={styles.cancelButtonText}>{card.cancelLabel}</Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                                style={[
                                    styles.submitButton,
                                    ready && !busy && styles.submitButtonReady,
                                    (!ready || busy) && styles.submitButtonDisabled,
                                ]}
                                onPress={submit}
                                disabled={!ready || busy || !canInteract}
                                activeOpacity={0.7}
                            >
                                {busy ? (
                                    <ActivityIndicator size="small" color={theme.colors.text} />
                                ) : (
                                    <Text style={styles.submitButtonText}>Send code</Text>
                                )}
                            </TouchableOpacity>
                        </View>
                    </>
                )}
            </View>
        </ToolSectionView>
    );
});

// Deliberately the same vocabulary as InlineQuestionForm: this card sits in the
// same list as every other prompt and must not read as a different app.
const styles = StyleSheet.create((theme) => ({
    container: {
        gap: 12,
    },
    headerChip: {
        alignSelf: 'flex-start',
        backgroundColor: theme.colors.surfaceHighest,
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 4,
    },
    headerText: {
        fontSize: 12,
        fontWeight: '600',
        color: theme.colors.textSecondary,
        textTransform: 'uppercase',
    },
    reasonText: {
        fontSize: 14,
        color: theme.colors.textSecondary,
    },
    linkButton: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingVertical: 12,
        paddingHorizontal: 12,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: Platform.select({ web: 'transparent', default: theme.colors.surface }),
        minHeight: 44,
    },
    linkContent: {
        flex: 1,
    },
    linkLabel: {
        fontSize: 14,
        fontWeight: '500',
        color: theme.colors.text,
    },
    linkHost: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        marginTop: 2,
    },
    codeInput: {
        borderWidth: 1,
        borderColor: theme.colors.divider,
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 12,
        minHeight: 44,
        fontSize: 14,
        color: theme.colors.text,
        backgroundColor: Platform.select({ web: 'transparent', default: theme.colors.surface }),
    },
    actionsContainer: {
        flexDirection: 'row',
        gap: 12,
        justifyContent: 'flex-end',
    },
    cancelButton: {
        paddingHorizontal: 20,
        paddingVertical: 12,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: 44,
    },
    cancelButtonText: {
        color: theme.colors.textSecondary,
        fontSize: 14,
        fontWeight: '600',
    },
    submitButton: {
        backgroundColor: Platform.select({ web: theme.colors.button.primary.background, default: theme.colors.surfaceHighest }),
        borderWidth: Platform.select({ web: 0, default: 1 }),
        borderColor: theme.colors.divider,
        paddingHorizontal: 20,
        paddingVertical: 12,
        borderRadius: 8,
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: 44,
    },
    submitButtonDisabled: {
        opacity: 0.5,
    },
    submitButtonReady: {
        borderColor: theme.colors.radio.active,
    },
    submitButtonText: {
        color: Platform.select({ web: theme.colors.button.primary.tint, default: theme.colors.text }),
        fontSize: 14,
        fontWeight: '600',
    },
}));
