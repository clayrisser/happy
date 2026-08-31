import * as React from 'react';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { ComposerSheet } from './ComposerSheet';
import { ComposerSheetRow } from './ComposerSheetRow';
import { sessionSettingsRows } from '@/utils/sessionHeaderRouting';

/**
 * What the avatar opens (DROVE-205).
 *
 * Clay: "If you want to go to the settings you use the right hand profile
 * icon, not the name of your session." So the avatar carries settings, and
 * the title pill beside it stops carrying them.
 *
 * Three rows rather than a jump straight to one screen, and the reason is
 * that the avatar is the only header control left once the pill goes to the
 * worktrees. Session settings needs a home; he calls this the PROFILE icon,
 * so the account belongs on it as well; and app settings was two screens away
 * from inside a session. A sheet is what makes one control honest about all
 * three. Accounts is DROVE-165's screen, linked, not redrawn: an account is a
 * login on a machine and that screen is where the machines are.
 *
 * On ComposerSheet like every other sheet (DROVE-147), and it closes before it
 * navigates (DROVE-183) using the same banked-intent mechanism AddContextSheet
 * built for the system pickers: the sheet is a Modal that owns the
 * presentation context for the length of its slide down, so a push fired on
 * the tap lands under a sheet still on screen.
 */

const stylesheet = StyleSheet.create((theme) => ({
    heading: {
        paddingHorizontal: 18,
        paddingTop: 2,
        paddingBottom: 6,
        fontSize: 10,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    body: {
        paddingBottom: 6,
    },
}));

export function SessionSettingsSheet(props: {
    sessionId: string;
    /** The session's name, so the sheet says which session it is about. */
    sessionName?: string;
    open: boolean;
    onClose: () => void;
    onNavigate: (route: string) => void;
}) {
    const styles = stylesheet;
    const { onClose, onNavigate } = props;
    const rows = React.useMemo(() => sessionSettingsRows(props.sessionId), [props.sessionId]);
    // Banked until the sheet is off the screen; see the note above.
    const pending = React.useRef<string | null>(null);
    const handlePress = React.useCallback((route: string) => {
        pending.current = route;
        onClose();
    }, [onClose]);
    const handleClosed = React.useCallback(() => {
        const route = pending.current;
        pending.current = null;
        if (route) onNavigate(route);
    }, [onNavigate]);
    // Reopened inside the slide down: he changed his mind, so the banked row
    // must not push under the sheet he just opened.
    React.useEffect(() => {
        if (props.open) pending.current = null;
    }, [props.open]);
    return (
        <ComposerSheet open={props.open} onClose={onClose} onClosed={handleClosed}>
            <View style={styles.body}>
                <Text style={styles.heading} numberOfLines={1}>
                    {props.sessionName ? props.sessionName : 'Settings'}
                </Text>
                {rows.map((row) => (
                    <ComposerSheetRow
                        key={row.key}
                        kind="picker"
                        icon={row.icon}
                        title={row.title}
                        value={row.value}
                        onPress={() => handlePress(row.route)}
                    />
                ))}
            </View>
        </ComposerSheet>
    );
}
