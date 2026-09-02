/**
 * The Terminal tab of the worktree sheet (DROVE-330): the session's pane.
 *
 * Clay: "another tab that opens the terminal ... if I click on a specific
 * worktree it opens the terminal in that worktree." The pane is what tmux
 * shows in it, captured by the drover through `tmux capture-pane`, run
 * through the redactor twice (once on the bus, once in the daemon), and
 * asked for again every couple of seconds while this tab is up. A poll, not
 * a stream: the machine RPC is request and answer, and two seconds is the
 * cadence a person reads a terminal at from a phone.
 *
 * The box has an explicit height from worktreeSheetLayout and scrolls its
 * own text, pinned to the bottom on every capture, so the sheet stands still
 * at the cap and the prompt is where a prompt is. Read-only: nothing here
 * types into the pane. The composer already does that.
 */
import * as React from 'react';
import { ActivityIndicator, ScrollView, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { ageLabel } from '@/sync/droverGates';
import { machineDroverPane, type DroverPane } from '@/sync/machineFiles';
import { paneTrouble, type PaneTarget } from '@/utils/worktreeSheetTabs';
import {
    paneLines,
    paneRefreshMs,
    terminalBodyHeight,
    terminalLineHeight,
    terminalMetaHeight,
    terminalPadding,
} from './worktreeSheetLayout';

const stylesheet = StyleSheet.create((theme) => ({
    meta: {
        height: terminalMetaHeight,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 20,
    },
    metaText: {
        flex: 1,
        fontSize: 12,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    box: {
        marginHorizontal: 12,
        borderRadius: 12,
        backgroundColor: theme.colors.surfaceHigh,
    },
    boxContent: {
        paddingVertical: terminalPadding,
        paddingHorizontal: 12,
    },
    line: {
        fontSize: 12,
        lineHeight: terminalLineHeight,
        color: theme.colors.text,
        ...Typography.mono(),
    },
    trouble: {
        padding: 16,
        fontSize: 13,
        lineHeight: 19,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
}));

export interface WorktreeTerminalTabProps {
    machineId: string | null;
    target: PaneTarget;
    /** The worktree the pane belongs to, home collapsed, for the status line. */
    scopeLabel: string;
}

export function WorktreeTerminalTab(props: WorktreeTerminalTabProps) {
    const { machineId, target, scopeLabel } = props;
    const styles = stylesheet;
    const window = useWindowDimensions();
    const safeArea = useSafeAreaInsets();
    const height = terminalBodyHeight({
        windowHeight: window.height,
        safeAreaTop: safeArea.top,
        safeAreaBottom: safeArea.bottom,
    });
    const [pane, setPane] = React.useState<DroverPane | null>(null);
    const [trouble, setTrouble] = React.useState<string | null>(null);
    const scroll = React.useRef<ScrollView>(null);
    // The target as a key, so a scope change restarts the poll from nothing
    // rather than showing the old worktree's pane under the new one's label.
    const targetKey = 'sessionId' in target ? `s:${target.sessionId}` : `c:${target.cwd}`;

    React.useEffect(() => {
        setPane(null);
        setTrouble(null);
        if (!machineId) {
            setTrouble('This session is not on a machine the app knows.');
            return;
        }
        let cancelled = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const request = 'sessionId' in target
            ? { sessionId: target.sessionId, lines: paneLines }
            : { cwd: target.cwd, lines: paneLines };
        const tick = async () => {
            const result = await machineDroverPane(machineId, request);
            if (cancelled) return;
            if (result.ok) {
                setPane(result.pane);
                setTrouble(null);
            } else {
                setTrouble(paneTrouble(result.error));
            }
            timer = setTimeout(() => { void tick(); }, paneRefreshMs);
        };
        void tick();
        return () => {
            cancelled = true;
            if (timer) clearTimeout(timer);
        };
    // targetKey stands in for `target`, whose object identity changes on
    // every render of the sheet.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [machineId, targetKey]);

    // Pinned to the bottom on every capture, which is where the prompt is.
    React.useEffect(() => {
        if (pane) scroll.current?.scrollToEnd({ animated: false });
    }, [pane]);

    const status = pane
        ? `${scopeLabel} · pane ${pane.pane} · ${ageLabel(pane.capturedAt)} ago${pane.redacted ? ` · ${pane.redacted} masked` : ''}`
        : trouble
            ? scopeLabel
            : `${scopeLabel} · capturing`;

    return (
        <View>
            <View style={styles.meta}>
                <Text style={styles.metaText} numberOfLines={1} ellipsizeMode="head">{status}</Text>
                {!pane && !trouble ? <ActivityIndicator size="small" /> : null}
            </View>
            <View style={[styles.box, { height }]}>
                {trouble ? (
                    <Text style={styles.trouble}>{trouble}</Text>
                ) : (
                    <ScrollView
                        ref={scroll}
                        style={{ height }}
                        contentContainerStyle={styles.boxContent}
                        nestedScrollEnabled
                        showsVerticalScrollIndicator
                    >
                        {(pane?.lines ?? []).map((line, i) => (
                            // ` ` so an empty line keeps its height: a
                            // Text with nothing in it collapses.
                            <Text key={i} style={styles.line} selectable>{line || ' '}</Text>
                        ))}
                    </ScrollView>
                )}
            </View>
        </View>
    );
}
