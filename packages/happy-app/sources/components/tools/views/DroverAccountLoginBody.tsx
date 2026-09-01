import * as React from 'react';
import {
    ActivityIndicator,
    Linking,
    Platform,
    Share,
    Text,
    TextInput,
    TouchableOpacity,
    View,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { accountLoginCard, clipboardCode, codeToSend, hostOf, type AccountLoginCard } from './droverAccountLogin';

/**
 * The account-login card's BODY, with no idea where it is drawn (DROVE-212).
 *
 * It was born inside the transcript's tool view, and that is where it stayed —
 * so every other surface that shows a pending gate drew this card through the
 * generic permission path instead. Clay got a card headed "Run
 * DroverAccountLogin", its body the literal string `{"url":"https://…"}`, and
 * Deny / Allow underneath. He pressed Allow and said "it's not doing anything",
 * which was the truth: a bare allow carries no code, so the login on the Mac
 * went on waiting for one. Even a perfectly delivered link was unusable.
 *
 * So the body moved out here and the gate surfaces render it. Two things, and
 * they are the only two a login needs:
 *
 *   THE LINK OPENS. Tapping it opens the phone's BROWSER. That is the whole
 *   complaint DROVE-212 started from — "Happen when I did this I should've
 *   opened my browser" — and a share sheet is not a browser. The sheet is still
 *   one tap away on the icon beside it, for when the link wants to go somewhere
 *   other than the default browser, which is what Clay asked for in DROVE-61.
 *
 *   THE CODE COMES BACK. It is typed here and sent as the question's text
 *   answer, which lands on the waiting `claude auth login`'s stdin. Nothing
 *   stores it, nothing else is sent it, and the field is cleared on submit.
 *
 * ONE TAP FOR THE CODE (DROVE-335). Clay: "for the login I was kinda expecting
 * a paste and submit button instead of having to paste in a field and submit."
 * He is right — the code is already on the clipboard when he comes back from
 * the browser, and long-press, wait, Paste, Send is four gestures to move a
 * string the phone is already holding. Paste and send does it in one. The field
 * stays exactly as it was, because a code read aloud or typed from a laptop has
 * nowhere else to go.
 *
 * What the button does NOT do is send whatever it finds. The answer goes to a
 * `claude auth login` blocked on stdin with two tries, so a clipboard holding
 * the sign-in link — one tap away on the row above, and what was on the
 * clipboard a minute ago — would spend one of them and come back "Invalid
 * code". `clipboardCode` judges it first and says why in a sentence.
 */
export interface DroverAccountLoginBodyProps {
    /** The mirrored card's arguments, straight off the request. */
    args: unknown;
    /** False once the card is settled, so a sent card cannot be sent again. */
    canInteract: boolean;
    /**
     * Send the answer. `{ code }` for a code, `{ optionId: 'cancel' }` for the
     * cancel button — the two shapes the bus takes for this question.
     */
    onAnswer: (input: Record<string, unknown>) => Promise<void>;
}

export const DroverAccountLoginBody = React.memo<DroverAccountLoginBodyProps>((
    { args, canInteract, onAnswer },
) => {
    const { theme } = useUnistyles();
    const card = React.useMemo<AccountLoginCard | null>(() => accountLoginCard(args), [args]);
    const [code, setCode] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    const [sent, setSent] = React.useState<'code' | 'cancel' | null>(null);
    /** Why the last one-tap paste was not sent, in one sentence (DROVE-335). */
    const [refused, setRefused] = React.useState<string | null>(null);

    const answer = React.useCallback(async (input: Record<string, unknown>, kind: 'code' | 'cancel') => {
        if (busy) return;
        setBusy(true);
        setSent(kind);
        try {
            await onAnswer(input);
        } catch {
            // Let it be tried again rather than leaving a card that looks sent.
            setSent(null);
        } finally {
            setBusy(false);
        }
    }, [busy, onAnswer]);

    /** His browser. Not the share sheet — that is the icon on the right. */
    const openLink = React.useCallback(() => {
        if (!card) return;
        void Linking.openURL(card.url).catch(() => {});
    }, [card]);

    const shareLink = React.useCallback(async () => {
        if (!card) return;
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
        setRefused(null);
        await answer({ code: value }, 'code');
    }, [answer, code]);

    /**
     * The clipboard, read and sent in one tap (DROVE-335).
     *
     * A refusal fills the field rather than throwing the paste away, so the bad
     * value is visible, fixable and sendable by hand — Clay can see what his
     * clipboard actually had instead of being told no by a button.
     *
     * A clipboard that cannot be read at all (web without permission, a
     * platform that refuses) is refused in the same place and the same voice,
     * because from where he is standing it is the same thing: the tap did not
     * send a code.
     */
    const pasteAndSend = React.useCallback(async () => {
        if (busy) return;
        let raw: string | null = null;
        try {
            raw = await Clipboard.getStringAsync();
        } catch {
            setRefused('The clipboard could not be read here, so paste the code into the box below instead.');
            return;
        }
        const judged = clipboardCode(raw);
        if ('refused' in judged) {
            setRefused(judged.refused);
            setCode(typeof raw === 'string' ? raw.trim() : '');
            return;
        }
        setRefused(null);
        setCode('');
        await answer({ code: judged.code }, 'code');
    }, [answer, busy]);

    // Null rather than a fallback: the bridge only mints this card from a bus
    // event whose preview is already an https link, so anything else here is a
    // malformed card, and a "sign in" button onto an unknown scheme is the one
    // outcome worth refusing outright.
    if (!card) return null;

    const ready = codeToSend(code) !== null;
    const live = canInteract && sent === null;

    return (
        <View style={styles.container}>
            <View style={styles.headerChip}>
                <Text style={styles.headerText}>{card.header}</Text>
            </View>
            {card.reason ? <Text style={styles.reasonText}>{card.reason}</Text> : null}

            <View style={styles.linkRow}>
                <TouchableOpacity
                    style={styles.linkButton}
                    onPress={openLink}
                    activeOpacity={0.7}
                    accessibilityRole="button"
                >
                    <Ionicons name="open-outline" size={18} color={theme.colors.text} />
                    <View style={styles.linkContent}>
                        <Text style={styles.linkLabel}>Open the sign-in page</Text>
                        <Text style={styles.linkHost} numberOfLines={1}>{hostOf(card.url)}</Text>
                    </View>
                </TouchableOpacity>
                <TouchableOpacity
                    style={styles.shareButton}
                    onPress={shareLink}
                    activeOpacity={0.7}
                    accessibilityRole="button"
                    accessibilityLabel="Send the sign-in link somewhere else"
                >
                    <Ionicons name="share-outline" size={18} color={theme.colors.textSecondary} />
                </TouchableOpacity>
            </View>

            {sent === 'code' ? (
                <Text style={styles.reasonText}>Code sent to the Mac.</Text>
            ) : sent === 'cancel' ? (
                <Text style={styles.reasonText}>Login cancelled.</Text>
            ) : (
                <>
                    <TouchableOpacity
                        style={styles.pasteButton}
                        onPress={pasteAndSend}
                        disabled={!live || busy}
                        activeOpacity={0.7}
                        accessibilityRole="button"
                        accessibilityLabel="Paste the code from the clipboard and send it"
                    >
                        <Ionicons name="clipboard-outline" size={18} color={theme.colors.text} />
                        <Text style={styles.pasteButtonText}>Paste and send</Text>
                    </TouchableOpacity>
                    {refused ? <Text style={styles.refusedText}>{refused}</Text> : null}
                    <TextInput
                        style={styles.codeInput}
                        value={code}
                        onChangeText={(next) => { setCode(next); setRefused(null); }}
                        editable={live}
                        placeholder="Paste the code from that page"
                        placeholderTextColor={theme.colors.textSecondary}
                        autoCapitalize="none"
                        autoCorrect={false}
                        autoComplete="off"
                        spellCheck={false}
                        // Not `secureTextEntry`: a code that cannot be read back
                        // cannot be checked against the page it came from, and it
                        // is single-use and already on screen in the browser.
                        onSubmitEditing={submit}
                        returnKeyType="send"
                    />
                    <View style={styles.actionsContainer}>
                        <TouchableOpacity
                            style={styles.cancelButton}
                            onPress={() => answer({ optionId: 'cancel' }, 'cancel')}
                            disabled={!live || busy}
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
                            disabled={!ready || busy || !live}
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
    );
});

DroverAccountLoginBody.displayName = 'DroverAccountLoginBody';

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
    linkRow: {
        flexDirection: 'row',
        alignItems: 'stretch',
        gap: 8,
    },
    linkButton: {
        flex: 1,
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
    shareButton: {
        width: 44,
        minHeight: 44,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: Platform.select({ web: 'transparent', default: theme.colors.surface }),
    },
    pasteButton: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        paddingVertical: 12,
        paddingHorizontal: 12,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: Platform.select({ web: 'transparent', default: theme.colors.surface }),
        minHeight: 44,
    },
    pasteButtonText: {
        fontSize: 14,
        fontWeight: '500',
        color: theme.colors.text,
    },
    refusedText: {
        fontSize: 13,
        color: theme.colors.textDestructive,
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
