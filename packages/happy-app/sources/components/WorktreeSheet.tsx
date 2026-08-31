import * as React from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Octicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useAllSessions, useMachine, useSession } from '@/sync/storage';
import { machineListWorktrees, machineSpawnNewSession, type MachineWorktree } from '@/sync/ops';
import { sync } from '@/sync/sync';
import { navigateToSession } from '@/hooks/useNavigateToSession';
import { buildWorktreeRows, resolveWorktreeOpen, type WorktreeRow } from '@/utils/worktreeRows';
import { ComposerSheet } from './ComposerSheet';

/**
 * The worktrees, opened from the session header's title pill (DROVE-90, moved
 * onto the pill by DROVE-205).
 *
 * Clay: "clicking the middle button that has the title of the session and the
 * name of the worktree below it should open up the list of the worktrees in a
 * sheet." The pill shows the session over its worktree, so the pill is about
 * the worktree. It used to hang off the branch text inside the pill, which is
 * a target the width of a word.
 *
 * Every worktree of this session's repo, from the daemon's `list-worktrees`,
 * each with its branch, dirty or clean, how many live sessions run there, and
 * the one this session is in marked. What tapping one does is
 * `resolveWorktreeOpen`, written down there rather than here: a worktree with
 * a live session opens THAT session, the way the sessions list does, and this
 * session is left where it is; one without gets a session started in it
 * through the same spawn RPC the new-session screen uses (DROVE-76, DROVE-87),
 * which behaves like `cd <worktree> && drover`.
 *
 * On ComposerSheet, the one shell everything slides up through (DROVE-147),
 * and it closes before it navigates (DROVE-183). It used to draw its own
 * floating card, which is exactly what DROVE-147 exists to stop.
 */
export interface WorktreeSheetProps {
    sessionId: string;
    open: boolean;
    onClose: () => void;
}

type DaemonAgent = 'claude' | 'codex' | 'gemini';

function agentForSpawn(flavor: string | null | undefined): DaemonAgent {
    return flavor === 'codex' || flavor === 'gemini' ? flavor : 'claude';
}

export const WorktreeSheet = React.memo(function WorktreeSheet(props: WorktreeSheetProps) {
    const { sessionId, open, onClose } = props;
    const session = useSession(sessionId);
    const router = useRouter();
    const { theme } = useUnistyles();
    const styles = stylesheet;

    const machineId = session?.metadata?.machineId ?? null;
    const currentPath = session?.metadata?.path ?? null;
    const machine = useMachine(machineId ?? '');
    const homeDir = machine?.metadata?.homeDir ?? null;
    const allSessions = useAllSessions();
    // The sessions the app already has for this machine, by cwd: that is
    // the live count. No second round trip to ask the daemon what it runs.
    const machineSessions = React.useMemo(() => allSessions
        .filter((s) => s.metadata?.machineId === machineId && !!s.metadata?.path)
        .map((s) => ({ id: s.id, path: s.metadata!.path, live: s.active, updatedAt: s.updatedAt })),
    [allSessions, machineId]);

    const [worktrees, setWorktrees] = React.useState<MachineWorktree[] | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const [starting, setStarting] = React.useState<string | null>(null);

    React.useEffect(() => {
        // Asked once per opening, so a sheet reopened after a spawn shows the
        // worktree that spawn created rather than the list from before it.
        if (!open) return;
        let cancelled = false;
        if (!machineId || !currentPath) {
            setError(t('session.forkErrorMissingMetadata'));
            setWorktrees([]);
            return;
        }
        setWorktrees(null);
        void machineListWorktrees(machineId, currentPath).then((result) => {
            if (cancelled) return;
            if (result.ok) {
                setWorktrees(result.worktrees);
                setError(null);
            } else {
                setWorktrees([]);
                setError(result.error);
            }
        });
        return () => { cancelled = true; };
    }, [open, machineId, currentPath]);

    const rows = React.useMemo(() => (
        worktrees ? buildWorktreeRows({ worktrees, currentPath, homeDir, sessions: machineSessions }) : []
    ), [worktrees, currentPath, homeDir, machineSessions]);

    /**
     * Held until the sheet is off the screen (DROVE-183, on AddContextSheet's
     * mechanism). The sheet is a Modal and owns the presentation context for
     * the length of its slide down, so a push fired on the tap arrives under a
     * sheet still sliding, and so does an alert.
     */
    const pending = React.useRef<(() => void) | null>(null);
    const closeThen = React.useCallback((action: () => void) => {
        pending.current = action;
        onClose();
    }, [onClose]);
    const handleClosed = React.useCallback(() => {
        const action = pending.current;
        pending.current = null;
        action?.();
    }, []);
    React.useEffect(() => {
        if (open) pending.current = null;
    }, [open]);

    const openRow = React.useCallback(async (row: WorktreeRow) => {
        if (starting) return;
        const target = resolveWorktreeOpen(row);
        if (target.type === 'none') return;
        if (target.type === 'session') {
            const id = target.sessionId;
            closeThen(() => navigateToSession(router, id));
            return;
        }
        if (!machineId) return;
        // The spawn happens with the sheet still up, because it is a round
        // trip to the machine and closing first would leave him back on the
        // session with nothing happening.
        setStarting(row.path);
        try {
            const result = await machineSpawnNewSession({
                machineId,
                directory: target.directory,
                agent: agentForSpawn(session?.metadata?.flavor),
            });
            if (result.type !== 'success') {
                const message = result.type === 'error'
                    ? result.errorMessage
                    : result.type === 'requestToApproveDirectoryCreation'
                        ? `${row.label} is not on the machine any more`
                        : 'The session was created, but it is still syncing. It should appear shortly.';
                closeThen(() => Modal.alert(t('common.error'), message));
                return;
            }
            await sync.refreshSessions().catch(() => { /* the list catches up on its own */ });
            const id = result.sessionId;
            closeThen(() => navigateToSession(router, id));
        } finally {
            setStarting(null);
        }
    }, [starting, machineId, session?.metadata?.flavor, closeThen, router]);

    // The pickers' cap, not the agent tree's: a repo has more worktrees than
    // either, and 400 is what DROVE-90's own list was capped at. DROVE-201 is
    // replacing the cap with "grow to content, scroll only at full screen",
    // and when it lands this number goes with it.
    return (
        <ComposerSheet open={open} onClose={onClose} onClosed={handleClosed} maxHeight={400}>
            <View style={styles.body}>
                <View style={styles.header}>
                    <Text style={styles.title}>Worktrees</Text>
                    <Text style={styles.subtitle} numberOfLines={1}>
                        {currentPath ? currentPath.split(/[/\\]/).filter(Boolean).pop() : ''}
                    </Text>
                </View>
                {worktrees === null ? (
                    <View style={styles.loadingContainer}>
                        <ActivityIndicator />
                    </View>
                ) : error ? (
                    <Text style={styles.emptyText}>{error}</Text>
                ) : rows.length === 0 ? (
                    <Text style={styles.emptyText}>No worktrees</Text>
                ) : rows.map((row) => {
                    const live = row.liveSessionIds.length;
                    const busy = starting === row.path;
                    return (
                        <Pressable
                            key={row.path}
                            onPress={() => { void openRow(row); }}
                            disabled={!!starting || row.bare}
                            accessibilityRole="button"
                            accessibilityLabel={`${row.label}, ${row.branch}, ${row.dirty ? 'dirty' : 'clean'}, ${live} live`}
                            style={({ pressed }) => [
                                styles.row,
                                row.current && styles.rowCurrent,
                                pressed && styles.rowPressed,
                                (starting && !busy) && styles.rowDimmed,
                            ]}
                        >
                            <View style={styles.rowMain}>
                                <Text style={styles.rowPath} numberOfLines={1} ellipsizeMode="head">
                                    {row.label}
                                </Text>
                                <View style={styles.rowBranchLine}>
                                    <Octicons name="git-branch" size={11} color={theme.colors.textSecondary} />
                                    <Text style={styles.rowBranch} numberOfLines={1} ellipsizeMode="head">
                                        {row.branch}
                                    </Text>
                                </View>
                            </View>
                            <View style={styles.rowMeta}>
                                {busy ? <ActivityIndicator size="small" /> : null}
                                <Text style={[styles.rowMetaText, row.dirty && styles.rowDirty]}>
                                    {row.bare ? 'bare' : row.dirty ? 'dirty' : 'clean'}
                                </Text>
                                <Text style={[styles.rowMetaText, live > 0 && styles.rowLive]}>
                                    {live === 1 ? '1 live' : `${live} live`}
                                </Text>
                                {row.current ? (
                                    <Octicons name="check" size={14} color={theme.colors.text} accessibilityLabel="current" />
                                ) : null}
                            </View>
                        </Pressable>
                    );
                })}
            </View>
        </ComposerSheet>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    body: {
        paddingBottom: 6,
    },
    header: {
        paddingHorizontal: 20,
        paddingTop: 2,
        paddingBottom: 8,
    },
    title: {
        fontSize: 15,
        fontWeight: '600' as const,
        color: theme.colors.text,
    },
    subtitle: {
        marginTop: 2,
        fontSize: 12,
        color: theme.colors.textSecondary,
    },
    loadingContainer: {
        paddingVertical: 32,
        alignItems: 'center',
    },
    emptyText: {
        paddingHorizontal: 20,
        paddingVertical: 24,
        fontSize: 14,
        color: theme.colors.textSecondary,
        textAlign: 'center',
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingHorizontal: 20,
        paddingVertical: 10,
    },
    rowCurrent: {
        backgroundColor: theme.colors.surfaceHigh,
    },
    rowPressed: {
        opacity: 0.7,
    },
    rowDimmed: {
        opacity: 0.4,
    },
    rowMain: {
        flex: 1,
        minWidth: 0,
        gap: 2,
    },
    rowPath: {
        fontSize: 14,
        color: theme.colors.text,
    },
    rowBranchLine: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
    },
    rowBranch: {
        flexShrink: 1,
        fontSize: 12,
        color: theme.colors.textSecondary,
    },
    rowMeta: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        flexShrink: 0,
    },
    rowMetaText: {
        fontSize: 12,
        color: theme.colors.textSecondary,
    },
    rowDirty: {
        color: theme.colors.warning,
    },
    rowLive: {
        color: theme.colors.success,
    },
}));
