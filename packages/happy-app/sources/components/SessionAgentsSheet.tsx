import * as React from 'react';
import { StyleProp, Text, TextStyle, View, ViewStyle } from 'react-native';
import { useLiveStatusSummary } from './AgentInputStatusRow';
import { SessionLiveStatusTree } from './SessionLiveStatus';

/**
 * The agent tree, in the sheet (DROVE-111).
 *
 * It used to unfold under the status line, which meant it had to fit the
 * composer's furniture: a 180pt scroll box that shoved the chat down when it
 * opened. Clay, right after asking for the same of the quota: "just like
 * agents should show in a sheet, right?" So it opens where the session pill's
 * sheet opens, dismissed the same way, with room to be read.
 *
 * It owns its own subscription because the CLI republishes the snapshot up to
 * once a second while working, and the composer that hosts the sheet must not
 * reconcile on every tick.
 */
export function SessionAgentsSheet(props: {
    sessionId: string;
    sectionStyle?: StyleProp<ViewStyle>;
    titleStyle?: StyleProp<TextStyle>;
}) {
    const summary = useLiveStatusSummary(props.sessionId);
    if (!summary || summary.rows.length === 0) {
        return null;
    }
    return (
        <View style={props.sectionStyle}>
            <Text style={props.titleStyle}>{summary.headline}</Text>
            <SessionLiveStatusTree
                sessionId={props.sessionId}
                rows={summary.rows}
                // The sheet's own cap is 400; leave room for the heading.
                maxHeight={340}
            />
        </View>
    );
}
