import * as React from 'react';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Typography } from '@/constants/Typography';

/**
 * What the longhorn says without being tapped (DROVE-71).
 *
 * TWO INDICATORS, NOT ONE COUNT. They mean different things. A pending PROMPT
 * — a permission gate, a question — is blocking a session right now: a turn is
 * stopped waiting on an answer and it can time out. A TO-DO is a job Clay does
 * when he can; nothing is stalled on it and it never expires. A single number
 * would let three to-dos hide the one prompt that is actually holding work up,
 * so nothing in this feature ever adds them together.
 *
 * The prompt is the loud one: a filled pill in the warning colour. The to-do
 * is outlined and neutral, because it is waiting on Clay rather than holding
 * anything up, and a to-do that reads as an alarm is an alarm you learn to
 * ignore. Neither is drawn when its count is zero, and nothing at all is drawn
 * when both are — a badge that is always there is a badge nobody reads.
 *
 * Its own file rather than a block inside HomeHeader, because the mark it sits
 * on is a `require`d PNG that node cannot load, so this is the only way the
 * counts and the zero states get a test.
 */
export const InboxBadges = React.memo(({ prompts, todos }: { prompts: number; todos: number }) => {
    if (prompts <= 0 && todos <= 0) return null;
    return (
        <View style={styles.badges} pointerEvents="none">
            {prompts > 0 && (
                <View style={[styles.badge, styles.prompt]}>
                    <Text style={styles.promptText}>{cap(prompts)}</Text>
                </View>
            )}
            {todos > 0 && (
                <View style={[styles.badge, styles.todo]}>
                    <Text style={styles.todoText}>{cap(todos)}</Text>
                </View>
            )}
        </View>
    );
});

InboxBadges.displayName = 'InboxBadges';

/** Three characters is all a 15pt pill holds, and 100 waiting reads the same as 99. */
function cap(count: number): string {
    return count > 99 ? '99+' : String(count);
}

/**
 * The same two counts, for a screen reader, which cannot see a badge.
 *
 * Spelled out rather than read as "2 3", and kept apart here for the same
 * reason the badges are: "2 prompts waiting" and "3 to-dos" are two facts.
 */
export function inboxAccessibilityLabel(prompts: number, todos: number): string {
    if (prompts <= 0 && todos <= 0) return 'Drover inbox, nothing waiting';
    const parts: string[] = [];
    if (prompts > 0) parts.push(`${prompts} prompt${prompts === 1 ? '' : 's'} waiting`);
    if (todos > 0) parts.push(`${todos} to-do${todos === 1 ? '' : 's'}`);
    return `Drover inbox, ${parts.join(' and ')}`;
}

const styles = StyleSheet.create((theme) => ({
    badges: {
        position: 'absolute',
        top: -4,
        left: 14,
        flexDirection: 'row',
        gap: 2,
    },
    badge: {
        minWidth: 15,
        height: 15,
        borderRadius: 8,
        paddingHorizontal: 3,
        alignItems: 'center',
        justifyContent: 'center',
    },
    prompt: {
        backgroundColor: theme.colors.box.warning.text,
    },
    promptText: {
        fontSize: 9,
        lineHeight: 12,
        color: theme.colors.box.warning.background,
        ...Typography.default('semiBold'),
    },
    todo: {
        backgroundColor: theme.colors.groupped.background,
        borderWidth: 1,
        borderColor: theme.colors.header.tint,
    },
    todoText: {
        fontSize: 9,
        lineHeight: 12,
        color: theme.colors.header.tint,
        ...Typography.default('semiBold'),
    },
}));
