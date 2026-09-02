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
import { buildWorktreeRows, collapseHome, resolveWorktreeOpen, type WorktreeRow } from '@/utils/worktreeRows';
import {
    isWorktreeSheetTab,
    ownScope,
    paneTargetFor,
    scopeForRow,
    worktreeActions,
    worktreeSheetDefaultTab,
    worktreeSheetTabs,
    type WorktreeScope,
    type WorktreeSheetTab,
} from '@/utils/worktreeSheetTabs';
import { ComposerSheet } from './ComposerSheet';
import { SheetTabs } from './SheetTabs';
import { WorktreeFilesTab } from './WorktreeFilesTab';
import { WorktreeTerminalTab } from './WorktreeTerminalTab';
import { WorktreeTodosTab } from './WorktreeTodosTab';
import { hapticsLight } from './haptics';
import { worktreeSheetBodyPadding, worktreeSheetHeaderHeight } from './worktreeSheetLayout';
import { sheetHeaderRhythm } from './sheetHeaderLayout';
import { Typography } from '@/constants/Typography';

/**
 * The worktrees, opened from the session header's title pill (DROVE-90, moved
 * onto the pill by DROVE-205), and since DROVE-330 a tabbed sheet.
 *
 * Clay: "clicking the middle button that has the title of the session and the
 * name of the worktree below it should open up the list of the worktrees in a
 * sheet." The pill shows the session over its worktree, so the pill is about
 * the worktree. It used to hang off the branch text inside the pill, which is
 * a target the width of a word.
 *
 * Then, from his phone: "in addition to the worktrees that show, we should
 * have a tab there that shows the todo, but also another tab that opens the
 * terminal, and another tab that lets us browse the files; and if I click on
 * a specific worktree it opens the terminal in that worktree, or lets me
 * browse the files in that worktree." So four tabs under the header, on a
 * native segmented control (SheetTabs), and a SCOPE the Terminal and Files
 * tabs look at: this session's own worktree until a row's glyph hands them
 * another. The rules are data in utils/worktreeSheetTabs.
 *
 * WORKTREES. Every worktree of this session's repo, from the daemon's
 * `list-worktrees`, each with its branch, dirty or clean, how many live
 * sessions run there, and the one this session is in marked. Tapping a ROW
 * does what `resolveWorktreeOpen` says (DROVE-205): a worktree with a live
 * session opens THAT session, one without gets a session started in it. The
 * two glyphs at the end of a row are the new part: the terminal opens the
 * Terminal tab on that worktree's pane, the folder opens the Files tab on
 * its tree. Two small targets rather than a menu on the row, because a
 * SwiftUI host per row is a cost nobody has measured (nativeControls) and the
 * row tap already means something.
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
    // The harness's own id for one of the app's sessions, which is how the
    // bus keys a pane. Claude sessions carry it; others fall back to the path.
    const harnessSessionIdOf = React.useCallback((id: string) => (
        allSessions.find((s) => s.id === id)?.metadata?.claudeSessionId
    ), [allSessions]);

    const [tab, setTab] = React.useState<WorktreeSheetTab>(worktreeSheetDefaultTab);
    const [scope, setScope] = React.useState<WorktreeScope | null>(null);
    const [worktrees, setWorktrees] = React.useState<MachineWorktree[] | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const [starting, setStarting] = React.useState<string | null>(null);

    React.useEffect(() => {
        // Asked once per opening, so a sheet reopened after a spawn shows the
        // worktree that spawn created rather than the list from before it.
        // And back on the worktrees, about this session: the pill opens the
        // worktrees (DROVE-205), whatever tab it was left on.
        if (!open) return;
        setTab(worktreeSheetDefaultTab);
        setScope(null);
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

    /** A row's glyph: the Terminal or Files tab, scoped to that worktree. */
    const openScoped = React.useCallback((row: WorktreeRow, to: 'terminal' | 'files') => {
        hapticsLight();
        setScope(scopeForRow(row));
        setTab(to);
    }, []);

    const selectTab = React.useCallback((key: WorktreeSheetTab) => {
        if (!isWorktreeSheetTab(key)) return;
        setTab(key);
    }, []);

    // What the Terminal and Files tabs look at: a row's worktree if one was
    // tapped, else this session's own.
    const own = React.useMemo(() => ownScope({ sessionId, path: currentPath, homeDir }), [sessionId, currentPath, homeDir]);
    const looking = scope ?? own;
    const repoName = currentPath ? currentPath.split(/[/\\]/).filter(Boolean).pop() : '';
    const subtitle = (tab === 'terminal' || tab === 'files') && looking
        ? looking.label
        : currentPath ? collapseHome(currentPath, homeDir) : '';

    // No cap. DROVE-201 landed: a sheet grows to its content and scrolls only
    // once it has filled the screen, which suits a worktree list better than
    // any number would, because a repo has as many as it has. The terminal
    // and file boxes are the exception and size themselves to the cap
    // (worktreeSheetLayout), so the sheet stands still and the text scrolls.
    return (
        <ComposerSheet open={open} onClose={onClose} onClosed={handleClosed}>
            <View style={styles.body}>
                <View style={styles.header}>
                    <Text style={styles.title}>{repoName || 'Worktrees'}</Text>
                    <Text style={styles.subtitle} numberOfLines={1} ellipsizeMode="head">{subtitle}</Text>
                </View>
                <SheetTabs
                    tabs={worktreeSheetTabs}
                    selected={tab}
                    onSelect={selectTab}
                    accessibilityLabel="Worktrees, to-dos, terminal or files"
                />
                {tab === 'todos' ? (
                    <WorktreeTodosTab sessionId={sessionId} />
                ) : tab === 'terminal' ? (
                    looking ? (
                        <WorktreeTerminalTab
                            machineId={machineId}
                            target={paneTargetFor(looking, harnessSessionIdOf)}
                            scopeLabel={looking.label}
                        />
                    ) : <Text style={styles.emptyText}>{t('session.forkErrorMissingMetadata')}</Text>
                ) : tab === 'files' ? (
                    looking ? (
                        <WorktreeFilesTab machineId={machineId} root={looking.path} scopeLabel={looking.label} />
                    ) : <Text style={styles.emptyText}>{t('session.forkErrorMissingMetadata')}</Text>
                ) : worktrees === null ? (
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
                    const actions = worktreeActions(row);
                    return (
                        <View
                            key={row.path}
                            style={[
                                styles.row,
                                row.current && styles.rowCurrent,
                                (starting && !busy) && styles.rowDimmed,
                            ]}
                        >
                            <Pressable
                                onPress={() => { void openRow(row); }}
                                disabled={!!starting || row.bare}
                                accessibilityRole="button"
                                accessibilityLabel={`${row.label}, ${row.branch}, ${row.dirty ? 'dirty' : 'clean'}, ${live} live`}
                                style={({ pressed }) => [styles.rowMain, pressed && styles.rowPressed]}
                            >
                                {/* Two lines, as before: the path with its
                                    state on the right, the branch under it.
                                    The glyphs took the row's right edge, so
                                    the state moved onto the path's line. */}
                                <View style={styles.rowTop}>
                                    <Text style={styles.rowPath} numberOfLines={1} ellipsizeMode="head">
                                        {row.label}
                                    </Text>
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
                                </View>
                                <View style={styles.rowBranchLine}>
                                    <Octicons name="git-branch" size={11} color={theme.colors.textSecondary} />
                                    <Text style={styles.rowBranch} numberOfLines={1} ellipsizeMode="head">
                                        {row.branch}
                                    </Text>
                                </View>
                            </Pressable>
                            {/* The two glyphs (DROVE-330). Disabled rather
                                than hidden where they do not apply, so a row
                                without a session still shows what it would
                                offer. */}
                            <Pressable
                                onPress={() => openScoped(row, 'terminal')}
                                disabled={!actions.terminal || !!starting}
                                hitSlop={6}
                                accessibilityRole="button"
                                accessibilityLabel={actions.terminal
                                    ? `Open the terminal in ${row.label}`
                                    : `No terminal in ${row.label}: nothing is running there`}
                                style={({ pressed }) => [styles.glyph, !actions.terminal && styles.glyphOff, pressed && styles.rowPressed]}
                            >
                                <Octicons name="terminal" size={16} color={theme.colors.text} />
                            </Pressable>
                            <Pressable
                                onPress={() => openScoped(row, 'files')}
                                disabled={!actions.files || !!starting}
                                hitSlop={6}
                                accessibilityRole="button"
                                accessibilityLabel={actions.files
                                    ? `Browse the files in ${row.label}`
                                    : `No files in ${row.label}: it is bare`}
                                style={({ pressed }) => [styles.glyph, !actions.files && styles.glyphOff, pressed && styles.rowPressed]}
                            >
                                <Octicons name="file-directory" size={16} color={theme.colors.text} />
                            </Pressable>
                        </View>
                    );
                })}
            </View>
        </ComposerSheet>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    body: {
        paddingBottom: worktreeSheetBodyPadding,
    },
    /**
     * An EXPLICIT height, not padding around auto-sized text (DROVE-376). The
     * tab control below used to be drawn over the path, because the header was
     * whatever `Text` happened to measure and the 10pt of clear air under the
     * subtitle was split across two views. The height and the line heights
     * both come from `sheetHeaderRhythm`, so what is drawn is what is
     * computed, and the gap to the tabs is inside this box.
     */
    header: {
        height: worktreeSheetHeaderHeight,
        paddingHorizontal: sheetHeaderRhythm.horizontal,
        paddingTop: sheetHeaderRhythm.top,
    },
    /**
     * `Typography.default()` sets a fontFamily and nothing else, and this
     * header was the one in the family that skipped it -- so the title drew in
     * the system font while every other sheet's drew in IBM Plex Sans, at a
     * different leading. With the line heights declared the box no longer
     * depends on which font won, and the sheet matches its neighbours.
     */
    title: {
        fontSize: sheetHeaderRhythm.titleSize,
        lineHeight: sheetHeaderRhythm.titleLine,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    subtitle: {
        marginTop: sheetHeaderRhythm.gap,
        fontSize: sheetHeaderRhythm.subtitleSize,
        lineHeight: sheetHeaderRhythm.subtitleLine,
        color: theme.colors.textSecondary,
        ...Typography.default(),
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
        gap: 4,
        paddingLeft: 20,
        paddingRight: 12,
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
        paddingVertical: 10,
    },
    rowTop: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    rowPath: {
        flex: 1,
        minWidth: 0,
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
    // 44pt targets, the platform's minimum, with the hitSlop on top.
    glyph: {
        width: 40,
        height: 44,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 12,
    },
    glyphOff: {
        opacity: 0.3,
    },
}));
