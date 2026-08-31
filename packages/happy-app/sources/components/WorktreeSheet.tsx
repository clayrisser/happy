import * as React from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';
import { Octicons } from '@expo/vector-icons';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useAllSessions, useMachine, useSession } from '@/sync/storage';
import { machineListWorktrees, machineSpawnNewSession, type MachineWorktree } from '@/sync/ops';
import { sync } from '@/sync/sync';
import { navigateToSession } from '@/hooks/useNavigateToSession';
import { getDuplicateSheetFrame } from '@/utils/duplicateSheetLayout';
import { buildWorktreeRows, type WorktreeRow } from '@/utils/worktreeRows';
import { MobileGlassSurface } from './MobileGlass';

/**
 * The sheet behind the branch in the session header (DROVE-90).
 *
 * Clay: "for the branch, when I click on it, shouldn't it show all
 * worktrees?" So: every worktree of this session's repo, from the daemon's
 * `list-worktrees`, each with its branch, dirty or clean, how many live
 * sessions run there, and the one this session is in marked. Tapping a
 * worktree with a live session goes to that session. Tapping one without
 * asks the daemon for a new session there, through the same spawn RPC the
 * new-session screen uses, which is what opens a tmux window on the right
 * account (DROVE-76, DROVE-87). It behaves like `cd <worktree> && drover`.
 */
export interface WorktreeSheetProps {
    sessionId: string;
    /** Injected by the modal infra. */
    onClose?: () => void;
}

type DaemonAgent = 'claude' | 'codex' | 'gemini';

function agentForSpawn(flavor: string | null | undefined): DaemonAgent {
    return flavor === 'codex' || flavor === 'gemini' ? flavor : 'claude';
}

export const WorktreeSheet = React.memo(function WorktreeSheet(props: WorktreeSheetProps) {
    const { sessionId, onClose } = props;
    const session = useSession(sessionId);
    const router = useRouter();
    const { theme } = useUnistyles();
    const windowSize = useWindowDimensions();
    const sheetFrame = React.useMemo(
        () => getDuplicateSheetFrame(windowSize),
        [windowSize.width, windowSize.height],
    );

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
        let cancelled = false;
        if (!machineId || !currentPath) {
            setError(t('session.forkErrorMissingMetadata'));
            setWorktrees([]);
            return;
        }
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
    }, [machineId, currentPath]);

    const rows = React.useMemo(() => (
        worktrees ? buildWorktreeRows({ worktrees, currentPath, homeDir, sessions: machineSessions }) : []
    ), [worktrees, currentPath, homeDir, machineSessions]);

    const open = React.useCallback(async (row: WorktreeRow) => {
        if (starting) return;
        if (row.liveSessionIds.length > 0) {
            onClose?.();
            navigateToSession(router, row.liveSessionIds[0]);
            return;
        }
        if (!machineId) return;
        setStarting(row.path);
        try {
            const result = await machineSpawnNewSession({
                machineId,
                directory: row.path,
                agent: agentForSpawn(session?.metadata?.flavor),
            });
            if (result.type !== 'success') {
                const message = result.type === 'error'
                    ? result.errorMessage
                    : result.type === 'requestToApproveDirectoryCreation'
                        ? `${row.label} is not on the machine any more`
                        : 'The session was created, but it is still syncing. It should appear shortly.';
                Modal.alert(t('common.error'), message);
                return;
            }
            await sync.refreshSessions().catch(() => { /* the list catches up on its own */ });
            onClose?.();
            navigateToSession(router, result.sessionId);
        } finally {
            setStarting(null);
        }
    }, [starting, machineId, session?.metadata?.flavor, onClose, router]);

    return (
        <MobileGlassSurface
            enabled={Platform.OS !== 'web'}
            nativeEffect
            glassEffectStyle="regular"
            intensity={88}
            tintColor={theme.colors.glass.overlayTint}
            style={[styles.sheet, sheetFrame]}
        >
            <View style={styles.header}>
                <Text style={styles.title}>Worktrees</Text>
                <Text style={styles.subtitle} numberOfLines={1}>
                    {currentPath ? currentPath.split(/[/\\]/).filter(Boolean).pop() : ''}
                </Text>
            </View>

            <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
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
                            onPress={() => { void open(row); }}
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
            </ScrollView>

            <View style={styles.actions}>
                <Pressable
                    onPress={onClose}
                    style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
                >
                    <Text style={styles.buttonText}>{t('common.cancel')}</Text>
                </Pressable>
            </View>
        </MobileGlassSurface>
    );
});

const styles = StyleSheet.create((theme) => ({
    sheet: {
        backgroundColor: Platform.select({
            web: theme.colors.surface,
            ios: theme.colors.glass.overlay,
            android: theme.colors.glass.backgroundStrong,
            default: theme.colors.surface,
        }),
        borderRadius: 16,
        overflow: 'hidden',
        borderWidth: Platform.OS === 'web' ? 0 : StyleSheet.hairlineWidth,
        borderColor: theme.colors.glass.border,
        alignSelf: 'center',
        minWidth: 0,
    },
    header: {
        paddingHorizontal: 20,
        paddingTop: 20,
        paddingBottom: 12,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.divider,
    },
    title: {
        fontSize: 17,
        fontWeight: '600' as const,
        color: theme.colors.text,
    },
    subtitle: {
        marginTop: 4,
        fontSize: 13,
        color: theme.colors.textSecondary,
    },
    list: {
        flexGrow: 0,
        flexShrink: 1,
        maxHeight: 420,
        minHeight: 0,
    },
    listContent: {
        paddingVertical: 8,
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
    actions: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        paddingHorizontal: 16,
        paddingVertical: 12,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.divider,
    },
    button: {
        paddingHorizontal: 16,
        paddingVertical: 8,
        borderRadius: 10,
    },
    buttonPressed: {
        opacity: 0.7,
    },
    buttonText: {
        fontSize: 15,
        color: theme.colors.text,
    },
}));
