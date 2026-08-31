/**
 * The session's task list, in the sheet (DROVE-167).
 *
 * Same shell as the agent tree and the quota (DROVE-147): everything that
 * expands out of the status row slides up through ComposerSheet, so this draws
 * no backdrop, no card and no grabber of its own.
 */
import * as React from 'react';
import { Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { ComposerSheet } from './ComposerSheet';
import { SessionTasksList, useSessionTasks } from './SessionTasksList';

export function SessionTasksSheet(props: {
    sessionId: string;
    open: boolean;
    onClose: () => void;
}) {
    const { theme } = useUnistyles();
    const tasks = useSessionTasks(props.sessionId);
    return (
        <ComposerSheet open={props.open} onClose={props.onClose}>
            <View style={{ paddingHorizontal: 18, paddingTop: 2, paddingBottom: 10, gap: 8 }}>
                <Text
                    numberOfLines={1}
                    style={{
                        fontSize: 10,
                        color: theme.colors.textSecondary,
                        ...Typography.default(),
                    }}
                >
                    {tasks.headline}
                </Text>
                <SessionTasksList tasks={tasks} />
            </View>
        </ComposerSheet>
    );
}
