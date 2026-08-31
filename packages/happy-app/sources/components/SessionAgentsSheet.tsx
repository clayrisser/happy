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
import { ComposerSheet } from './ComposerSheet';
import { SessionLiveStatusTree } from './SessionLiveStatus';
import type { LiveStatusSummary, LiveStatusTally } from '@/utils/liveStatus';

/**
 * `Session 1.4M · main 210k · agents 1.2M · this turn 312k`.
 *
 * The session total first, because that is the question the row cannot answer:
 * the strip resets its number at every prompt and Clay's is "what has this
 * cost me". Then the split, so main is legible against the fan-out, and the
 * turn last since it is the one already on the row.
 */
function sessionTallyLine(tally: LiveStatusTally): string {
    return [
        `Session ${tally.session}`,
        `main ${tally.sessionMain}`,
        `agents ${tally.sessionAgents}`,
        `this turn ${tally.turn}`,
    ].join(' · ');
}

export function SessionAgentsSheet(props: {
    sessionId: string;
    summary: LiveStatusSummary | null;
    open: boolean;
    onClose: () => void;
}) {
    const { theme } = useUnistyles();
    const rows = props.summary?.rows ?? [];
    return (
        <ComposerSheet
            open={props.open && rows.length > 0}
            onClose={props.onClose}
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
                    {/* The tally spelled out, one tap from the strip
                        (DROVE-184). The row has room for one number and it
                        spends it on the turn's total; the two things it cannot
                        say are what the SESSION has cost and how much of that
                        was the main thread rather than the fan-out. Both are
                        here, and the session line is the one that keeps
                        finished agents. */}
                    {props.summary.tally ? (
                        <Text
                            numberOfLines={2}
                            style={{
                                fontSize: 10,
                                color: theme.colors.textSecondary,
                                ...Typography.default(),
                            }}
                        >
                            {sessionTallyLine(props.summary.tally)}
                        </Text>
                    ) : null}
                </View>
            ) : null}
            {/* The sheet is the cap, and since DROVE-201 the sheet's cap is
                the screen. So the tree caps itself at nothing: it grows, the
                sheet grows with it, and the sheet is what scrolls. */}
            <SessionLiveStatusTree sessionId={props.sessionId} rows={rows} maxHeight={null} />
        </ComposerSheet>
    );
}
