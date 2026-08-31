/**
 * The agent tree, in the sheet (DROVE-111).
 *
 * It used to unfold under the status row, which meant it had to fit the
 * composer's furniture: a 180pt scroll box that shoved the chat down when it
 * opened. Clay, right after asking for the quota to slide up: "just like
 * agents should show in a sheet, right?" So it uses the same sheet the quota
 * uses, dismissed the same two ways, with room to be read.
 *
 * It owns its own subscription because the CLI republishes the snapshot up to
 * once a second while working, and the status row that mounts it must not
 * reconcile the whole tree on every tick.
 */
import * as React from 'react';
import { Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { ComposerAnchoredSheet } from './ComposerAnchoredSheet';
import { SessionLiveStatusTree } from './SessionLiveStatus';
import type { LiveStatusSummary } from '@/utils/liveStatus';

export function SessionAgentsSheet(props: {
    sessionId: string;
    summary: LiveStatusSummary | null;
    open: boolean;
    onClose: () => void;
    horizontalInset?: number;
}) {
    const { theme } = useUnistyles();
    const rows = props.summary?.rows ?? [];
    return (
        <ComposerAnchoredSheet
            open={props.open && rows.length > 0}
            onClose={props.onClose}
            horizontalInset={props.horizontalInset}
        >
            {props.summary ? (
                <View style={{ paddingHorizontal: 18, paddingTop: 2, paddingBottom: 4 }}>
                    <Text
                        numberOfLines={1}
                        style={{
                            fontSize: 10,
                            color: theme.colors.textSecondary,
                            marginBottom: 2,
                            ...Typography.default(),
                        }}
                    >
                        {props.summary.headline}
                    </Text>
                </View>
            ) : null}
            {/* The sheet is the cap now, so the tree stops capping itself at
                the 180pt the composer's furniture allowed. */}
            <SessionLiveStatusTree sessionId={props.sessionId} rows={rows} maxHeight={260} />
        </ComposerAnchoredSheet>
    );
}
