import * as React from 'react';
import { ActivityIndicator, Text, TouchableOpacity, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Typography } from '@/constants/Typography';
import { sessionAllow } from '@/sync/ops';
import { ToolViewProps } from './_all';
import { ToolSectionView } from '../ToolSectionView';
import { isQuestionSettled } from './askUserQuestionState';
import { droverTodoCard, type DroverTodoCard } from './droverTodoCard';

/**
 * A job an agent asked Clay to do, in the transcript (DROVE-69, DROVE-71).
 *
 * `drover needs` raises one and it stays open until a human closes it. That is
 * the whole difference from a gate, and the reason this card exists at all: a
 * to-do used to be mirrored onto the Bash permission card, where any generic
 * approve path closed it. Bus event 4c3f5082 went to
 * `{"action":"ack","optionId":"done","by":"happy"}` 257 seconds after it was
 * raised, while Clay was asking where the to-do list was.
 *
 * So the answer names the BUTTON. happy-cli's busResolutionFor refuses a to-do
 * answer that names neither, which means nothing can close one by approving it
 * generically: not this screen, not the wrist, not the voice tool.
 *
 * Both buttons go through sessionAllow because the bus reads the OPTION and
 * not the verb. Dropping a to-do is not denying anything; it is choosing not
 * to do the job.
 */
export const DroverTodoView = React.memo<ToolViewProps>(({ tool, sessionId }) => {
    const card = React.useMemo(() => droverTodoCard(tool.input), [tool.input]);
    const permissionId = tool.permission?.id;

    const settled = isQuestionSettled(tool.permission, tool.state);
    const canInteract = tool.state === 'running' && !settled && !!sessionId && !!permissionId;

    const close = React.useCallback(async (optionId: string) => {
        if (!sessionId || !permissionId) return;
        await sessionAllow(sessionId, permissionId, undefined, undefined, 'approved', { optionId });
    }, [sessionId, permissionId]);

    if (!card) return null;

    return (
        <ToolSectionView>
            <DroverTodoBody card={card} canInteract={canInteract} onClose={close} />
        </ToolSectionView>
    );
});

DroverTodoView.displayName = 'DroverTodoView';

/**
 * The to-do card itself, apart from where it sits (DROVE-89).
 *
 * The transcript wraps it in a ToolSectionView; the session banner draws it
 * directly above the composer. One body, so the two cannot drift: the banner
 * used to render a to-do through the permission footer as Deny / Allow, and
 * the bridge refused every one of the eight Allows Clay pressed on it.
 *
 * `onClose` is handed the option id that was pressed and nothing else. It
 * sends NOTHING until a button is named; there is no effect, no timer and no
 * unmount handler here.
 */
export const DroverTodoBody = React.memo(({ card, canInteract, onClose, chip = true }: {
    card: DroverTodoCard;
    canInteract: boolean;
    onClose: (optionId: string) => Promise<void>;
    /** The "Needs you" chip. Off where the heading above already says so. */
    chip?: boolean;
}) => {
    const { theme } = useUnistyles();
    const [sent, setSent] = React.useState<string | null>(null);
    const [busy, setBusy] = React.useState(false);

    const close = React.useCallback(async (optionId: string) => {
        setBusy(true);
        setSent(optionId);
        try {
            await onClose(optionId);
        } catch {
            // Let it be pressed again rather than leaving a card that looks
            // closed while the to-do is still open on the bus.
            setSent(null);
        } finally {
            setBusy(false);
        }
    }, [onClose]);

    return (
        <View style={styles.container}>
            {chip && (
                <View style={styles.headerChip}>
                    <Text style={styles.headerText}>Needs you</Text>
                </View>
            )}
            <Text style={styles.title}>{card.title}</Text>
            {!!card.reason && <Text style={styles.reason}>{card.reason}</Text>}
            {!!card.command && <Text style={styles.command}>{card.command}</Text>}
            {sent !== null ? (
                <Text style={styles.reason}>
                    {sent === 'drop' ? 'Dropped.' : 'Marked done.'}
                </Text>
            ) : (
                <View style={styles.actions}>
                    {card.options.map((option) => {
                        const primary = option.id !== 'drop';
                        return (
                            <TouchableOpacity
                                key={option.id}
                                style={[styles.action, primary ? styles.primary : styles.secondary]}
                                onPress={() => close(option.id)}
                                disabled={!canInteract || busy}
                                activeOpacity={0.7}
                            >
                                {busy ? (
                                    <ActivityIndicator
                                        size="small"
                                        color={primary ? theme.colors.button.primary.tint : theme.colors.text}
                                    />
                                ) : (
                                    <Text style={primary ? styles.primaryText : styles.secondaryText}>
                                        {option.label}
                                    </Text>
                                )}
                            </TouchableOpacity>
                        );
                    })}
                </View>
            )}
        </View>
    );
});

DroverTodoBody.displayName = 'DroverTodoBody';

// The same vocabulary as DroverAccountLoginView and InlineQuestionForm: this
// card sits in the same list as every other prompt and must not read as a
// different app.
const styles = StyleSheet.create((theme) => ({
    container: {
        gap: 10,
    },
    headerChip: {
        alignSelf: 'flex-start',
        backgroundColor: theme.colors.surfaceHighest,
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 4,
    },
    headerText: {
        ...Typography.default('semiBold'),
        fontSize: 11,
        color: theme.colors.textSecondary,
    },
    title: {
        ...Typography.default('semiBold'),
        fontSize: 15,
        color: theme.colors.text,
    },
    reason: {
        ...Typography.default(),
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.textSecondary,
    },
    command: {
        ...Typography.mono(),
        fontSize: 12,
        lineHeight: 17,
        color: theme.colors.text,
    },
    actions: {
        flexDirection: 'row',
        gap: 8,
    },
    action: {
        flex: 1,
        minHeight: 44,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 10,
        borderWidth: 1,
    },
    primary: {
        backgroundColor: theme.colors.button.primary.background,
        borderColor: theme.colors.button.primary.background,
    },
    primaryText: {
        ...Typography.default('semiBold'),
        fontSize: 15,
        color: theme.colors.button.primary.tint,
    },
    secondary: {
        backgroundColor: 'transparent',
        borderColor: theme.colors.divider,
    },
    secondaryText: {
        ...Typography.default('semiBold'),
        fontSize: 15,
        color: theme.colors.text,
    },
}));
