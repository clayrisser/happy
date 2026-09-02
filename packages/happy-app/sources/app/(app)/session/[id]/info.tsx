import React, { useCallback } from 'react';
import { View, Text, AppState, Platform } from 'react-native';
import { Stack, useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Typography } from '@/constants/Typography';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Avatar } from '@/components/Avatar';
import { useSession, useIsDataReady, useSessionProjectAvatar, useAllSessions, useSetting } from '@/sync/storage';
import { getSessionName, useSessionStatus, formatOSPlatform, formatPathRelativeToHome, getSessionAvatarId, getResumeCommand } from '@/utils/sessionUtils';
import * as Clipboard from 'expo-clipboard';
import { Modal } from '@/modal';
import { sessionArchive, sessionKill, sessionDelete, sessionSetAgentModes } from '@/sync/ops';
import { maybeCleanupWorktree } from '@/hooks/useWorktreeCleanup';
import { useUnistyles } from 'react-native-unistyles';
import { layout } from '@/components/layout';
import { t } from '@/text';
import { isVersionSupported, MINIMUM_CLI_VERSION } from '@/utils/versionUtils';
import { CodeView } from '@/components/CodeView';
import { Session } from '@/sync/storageTypes';
import { useHappyAction } from '@/hooks/useHappyAction';
import { useSessionQuickActions } from '@/hooks/useSessionQuickActions';
import { copySessionMetadataToClipboard, copySessionMetadataAndLogsToClipboard } from '@/utils/copySessionMetadataToClipboard';
import { HappyError } from '@/utils/errors';
import { MobileGlassSurface } from '@/components/MobileGlass';
import { getRigIdentity, isRigMetadata } from '@/sync/rig';
import { droverPolicySummary } from '@/utils/droverPolicySummary';
import { harnessName } from '@/utils/harnessName';
import { cloneLineageRows } from '@/utils/droverClone';
import { MOBILE_GLASS_HEADER_HEIGHT } from '@/components/navigation/headerMetrics';
import { Switch } from '@/components/Switch';
import { findSessionForAtRisk, isAtRiskListFresh, resolveRemoteControlState, supportsRemoteControlToggle } from '@/components/remoteControlToggle';
import { UsageAccountBars } from '@/components/UsageAccountBars';
import type { UsageBarRow } from '@/components/agentInputUsage';
import { flipRiskFooter, flipRiskSubtitle, resolveSessionAccount, sessionsLosingRemoteControl } from '@/utils/droverSessionAccount';
import type { DroverWatchStatus } from 'drover-watch';
import { describeDroverComplication, describeDroverWakesLeft } from '@/utils/droverWatchStatus';
import { useDroverWatchStatus } from '@/hooks/useDroverWatchStatus';
import { wakeLedgerLines } from '@/sync/droverWakeLedger';
import { wristRelayLine } from '@/sync/droverWristRelay';
import { SessionTasksList, useSessionTasks } from '@/components/SessionTasksList';
import { StatusDot } from '@/components/StatusDot';

// The session card's dot is the shared one (DROVE-243). A private copy lived
// here: the same 1000ms half-cycle, but its own `Animated.Value`, no
// `useReducedMotion`, and a colour handed to it by a table that has since gone.
// Deleting it is how the card starts honouring reduced motion and stops being a
// fourth place the dot could drift.

/**
 * The last cue the phone could not carry to the wrist (DROVE-224).
 *
 * Re-read on every return to the foreground, like the budget above and for
 * the same reason: the refusal that matters most is written during a
 * background launch whose JS context is gone before anyone looks at a screen.
 */
function useWristRefusal(): string | null {
    const [line, setLine] = React.useState<string | null>(() => wristRelayLine());
    React.useEffect(() => {
        const sub = AppState.addEventListener('change', (state) => {
            if (state === 'active') setLine(wristRelayLine());
        });
        return () => sub.remove();
    }, []);
    return line;
}

/**
 * One line: pairing state, or whether the watch app is open. The wake budget
 * used to ride this line too, and 0 there meant two different things; it is
 * two rows of its own now, under this one (DROVE-62, DROVE-86, DROVE-391).
 */
function describeDroverWatch(status: DroverWatchStatus): string {
    if (!status.paired) return 'No watch paired';
    if (!status.installed) return 'Paired, Cattle Drover not installed on the watch';
    return status.reachable ? 'Watch app open' : 'Watch app closed';
}

/** A wrist that can be reached at all, which is when the wake rows mean anything. */
function wristPresent(status: DroverWatchStatus): boolean {
    return status.paired && status.installed;
}

/**
 * The account's headroom, drawn with DROVE-117's row rather than a third
 * variant of a bar. ItemGroup hands every child a `showDivider`, which a bare
 * View would pass down to the DOM, so it is swallowed here.
 *
 * It carries the capture stamp so this screen ages its reading the same way
 * the composer sheet does (DROVE-230). This is the CURRENT account's line, and
 * the current account is precisely where the ticket asks for the age.
 */
function AccountBar({ row, capturedAt }: {
    row: UsageBarRow;
    capturedAt?: number | null;
    showDivider?: boolean;
}) {
    return (
        <UsageAccountBars
            groups={[{ key: 'account', title: '', rows: [row] }]}
            capturedAt={capturedAt}
        />
    );
}

function formatSandboxMetadata(sandbox: unknown, homeDir?: string): string {
    if (sandbox === null || sandbox === undefined) {
        return 'Disabled';
    }

    if (typeof sandbox === 'string') {
        return sandbox;
    }

    if (typeof sandbox !== 'object') {
        return String(sandbox);
    }

    const value = sandbox as Record<string, unknown>;
    if (value.enabled === false) {
        return 'Disabled';
    }

    const parts: string[] = ['Enabled'];
    const isolation = typeof value.sessionIsolation === 'string' ? value.sessionIsolation : undefined;
    const networkMode = typeof value.networkMode === 'string' ? value.networkMode : undefined;
    const workspaceRoot = typeof value.workspaceRoot === 'string' ? value.workspaceRoot : undefined;

    if (isolation) {
        parts.push(`isolation=${isolation}`);
    }
    if (networkMode) {
        parts.push(`network=${networkMode}`);
    }
    if (workspaceRoot) {
        parts.push(`workspace=${formatPathRelativeToHome(workspaceRoot, homeDir)}`);
    }

    return parts.join(' | ');
}

function formatDangerouslySkipPermissionsMetadata(
    value: unknown,
    flavor: string | null | undefined,
    permissionMode: Session['permissionMode'],
    sandbox: unknown,
): string {
    if (typeof value === 'boolean') {
        return value ? 'Enabled' : 'Disabled';
    }

    if (permissionMode === 'bypassPermissions' || permissionMode === 'yolo') {
        return 'Enabled';
    }

    if (flavor === 'claude' && sandbox && typeof sandbox === 'object') {
        const sandboxValue = sandbox as Record<string, unknown>;
        if (sandboxValue.enabled === true) {
            return 'Enabled';
        }
    }

    return 'Unknown';
}

function SessionInfoContent({ session }: { session: Session }) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const projectAvatar = useSessionProjectAvatar(session.id);
    const devModeEnabled = __DEV__;
    const sessionName = getSessionName(session);
    const droverPolicySubtitle = droverPolicySummary(session.metadata?.droverPolicy);
    const { status: watchStatus, ledger: wakeLedgerToday } = useDroverWatchStatus();
    const wristRefusalLine = useWristRefusal();
    const sessionStatus = useSessionStatus(session);
    // The same derivation the sheet and the wrist read (DROVE-167).
    const sessionTasks = useSessionTasks(session.id);
    const {
        canClone,
        canFlipAccount,
        canShowResume,
        canFork,
        cloneRefusal,
        cloneSession,
        cloning,
        flipAccount,
        forking,
        forkSession,
        openDuplicateSheet,
        resumeSession,
        resumeSessionSubtitle,
    } = useSessionQuickActions(session);

    // DROVE-137: which account this session is ON, and what leaving it costs.
    // The screen talked about a flip POLICY without ever printing the value the
    // policy applies to, so "Flip policy: prefer jamrizzi" sat above nothing
    // that said where the session actually was. The name, the headroom and the
    // bar are the composer popup's, not a second derivation (DROVE-129), and
    // they follow metadata, so a flip from the Mac moves this line too.
    const sessionAccount = React.useMemo(() => resolveSessionAccount({
        droverUsage: session.metadata?.droverUsage,
        droverAccount: session.metadata?.droverAccount,
    }), [session.metadata?.droverUsage, session.metadata?.droverAccount]);

    // Clone lineage (DROVE-58), and the map from the CLAUDE session ids the
    // ledger names to the HAPPY ids this app routes by. Only sessions this
    // device already holds can be linked to; the rest still show their line,
    // because "cloned into a session you have not opened" is true and useful.
    const cloneRows = React.useMemo(
        () => cloneLineageRows(session.metadata?.droverClone),
        [session.metadata?.droverClone],
    );
    const allSessions = useAllSessions();
    const cloneTargets = React.useMemo(() => {
        if (cloneRows.length === 0) return {} as Record<string, string>;
        const wanted = new Set(cloneRows.map((r) => r.claudeSessionId).filter((v): v is string => !!v));
        const found: Record<string, string> = {};
        for (const s of allSessions) {
            const claudeId = s.metadata?.claudeSessionId;
            if (claudeId && wanted.has(claudeId)) found[claudeId] = s.id;
        }
        return found;
    }, [cloneRows, allSessions]);

    // Check if CLI version is outdated
    const isCliOutdated = session.metadata?.version && !isVersionSupported(session.metadata.version, MINIMUM_CLI_VERSION);

    // DROVE-63: Claude Code's own Remote Control, on or off for THIS pane.
    // The value shown is what the CLI read off the transcript, never the last
    // tap — see remoteControlToggle.ts for why that distinction is the whole
    // point of the control.
    const canToggleRemoteControl = supportsRemoteControlToggle(session);
    const remoteControl = resolveRemoteControlState(session);
    const handleRemoteControlToggle = useCallback(() => {
        const next = resolveRemoteControlState(session).next;
        if (!next) return;
        sessionSetAgentModes(session.id, { remoteControl: next });
    }, [session]);

    // DROVE-37 + DROVE-63: the sessions this one's last flip knocked off
    // Remote Control, each with the button that turns it back on. The flip
    // already said their names out loud; this is the same list somewhere a
    // thumb can reach. allSessions is the same hook the clone rows above use.
    const atRisk = isAtRiskListFresh(session.metadata?.remoteControlAtRiskAt, Date.now())
        ? session.metadata?.remoteControlAtRisk ?? []
        : [];
    const handleWakeAtRisk = useCallback((sessionId: string) => {
        sessionSetAgentModes(sessionId, { remoteControl: 'on' });
    }, []);

    // The same cost, said BEFORE the flip. `atRisk` above is the fallout of a
    // flip that already happened; this is the list of live sessions a flip from
    // here WOULD silence, computed by the rule the CLI uses. Target is unknown
    // until an account is picked, so nothing is ruled safe: the confirm sheet
    // narrows it once there is a target.
    const flipRisk = React.useMemo(() => sessionsLosingRemoteControl({
        sessions: allSessions,
        selfId: session.id,
        target: null,
        nameOf: getSessionName,
    }), [allSessions, session.id]);

    const handleCopySessionId = useCallback(async () => {
        if (!session) return;
        try {
            await Clipboard.setStringAsync(session.id);
            Modal.alert(t('common.success'), t('sessionInfo.happySessionIdCopied'));
        } catch (error) {
            Modal.alert(t('common.error'), t('sessionInfo.failedToCopySessionId'));
        }
    }, [session]);

    const handleCopyMetadata = useCallback(() => {
        void copySessionMetadataToClipboard(session);
    }, [session]);

    const handleCopyMetadataAndLogs = useCallback(() => {
        void copySessionMetadataAndLogsToClipboard(session);
    }, [session]);

    // Use HappyAction for archiving - it handles errors automatically
    const [archivingSession, performArchive] = useHappyAction(async () => {
        // Prompt for worktree cleanup before killing (needs an active machine connection)
        await maybeCleanupWorktree(session.id, session.metadata?.path, session.metadata?.machineId);

        // Try to kill the CLI process; if it's already dead, force-archive via server
        const killResult = await sessionKill(session.id);
        if (!killResult.success) {
            await sessionArchive(session.id);
        }
        // Success - navigate back
        router.back();
        router.back();
    });

    const handleArchiveSession = useCallback(() => {
        performArchive();
    }, [performArchive]);

    // Use HappyAction for deletion - kills session first if needed, then deletes
    const [deletingSession, performDelete] = useHappyAction(async () => {
        // Prompt for worktree cleanup before killing (needs an active machine connection)
        await maybeCleanupWorktree(session.id, session.metadata?.path, session.metadata?.machineId);

        // Navigate back optimistically
        router.back();
        router.back();

        // Kill session first if it's still active (best-effort)
        if (sessionStatus.isConnected || session.active) {
            await sessionKill(session.id).catch(() => {});
        }

        const result = await sessionDelete(session.id);
        if (!result.success) {
            throw new HappyError(result.message || t('sessionInfo.failedToDeleteSession'), false);
        }
    });

    const handleDeleteSession = useCallback(() => {
        Modal.alert(
            t('sessionInfo.deleteSession'),
            t('sessionInfo.deleteSessionWarning'),
            [
                { text: t('common.cancel'), style: 'cancel' },
                {
                    text: t('sessionInfo.deleteSession'),
                    style: 'destructive',
                    onPress: performDelete
                }
            ]
        );
    }, [performDelete]);

    const formatDate = useCallback((timestamp: number) => {
        return new Date(timestamp).toLocaleString();
    }, []);

    const handleCopyUpdateCommand = useCallback(async () => {
        const updateCommand = 'npm install -g happy@latest';
        try {
            await Clipboard.setStringAsync(updateCommand);
            Modal.alert(t('common.success'), updateCommand);
        } catch (error) {
            Modal.alert(t('common.error'), t('common.error'));
        }
    }, []);

    return (
        <>
            <ItemList
                containerStyle={{
                    paddingTop: Platform.OS === 'ios' ? MOBILE_GLASS_HEADER_HEIGHT : 0,
                }}
            >
                {/* Session Header */}
                <View style={{ maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%' }}>
                    <MobileGlassSurface
                        enabled={Platform.OS !== 'web'}
                        intensity={68}
                        style={{
                            alignItems: 'center',
                            paddingVertical: 24,
                            backgroundColor: Platform.select({
                                web: theme.colors.surface,
                                android: theme.colors.glass.backgroundStrong,
                                default: 'transparent',
                            }),
                            marginBottom: 8,
                            borderRadius: Platform.select({ web: 12, default: 22 }),
                            marginHorizontal: 16,
                            marginTop: 16,
                            overflow: 'hidden',
                            borderWidth: Platform.OS === 'web' ? 0 : 0.5,
                            borderColor: theme.colors.glass.border,
                            shadowColor: theme.colors.glass.shadow,
                            shadowOffset: { width: 0, height: 10 },
                            shadowOpacity: Platform.OS === 'web' ? 0 : 1,
                            shadowRadius: 24,
                        }}
                    >
                        <Avatar id={getSessionAvatarId(session)} size={80} monochrome={!sessionStatus.isConnected} flavor={session.metadata?.flavor} clientId={session.metadata?.client?.id} imageUrl={projectAvatar?.uri} thumbhash={projectAvatar?.thumbhash} />
                        <Text style={{
                            fontSize: 20,
                            fontWeight: '600',
                            marginTop: 12,
                            textAlign: 'center',
                            color: theme.colors.text,
                            ...Typography.default('semiBold')
                        }}>
                            {sessionName}
                        </Text>
                        <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 8 }}>
                            <StatusDot
                                color={sessionStatus.statusDotColor}
                                isPulsing={sessionStatus.isPulsing}
                                size={10}
                                accessibilityLabel={sessionStatus.dotLabel}
                                style={{ marginRight: 4 }}
                            />
                            <Text style={{
                                fontSize: 15,
                                color: sessionStatus.statusColor,
                                fontWeight: '500',
                                ...Typography.default()
                            }}>
                                {sessionStatus.statusText}
                            </Text>
                        </View>
                    </MobileGlassSurface>
                </View>

                {/* CLI Version Warning */}
                {isCliOutdated && (
                    <ItemGroup>
                        <Item
                            title={t('sessionInfo.cliVersionOutdated')}
                            subtitle={t('sessionInfo.updateCliInstructions')}
                            icon={<Ionicons name="warning-outline" size={29} color="#FF9500" />}
                            showChevron={false}
                            onPress={handleCopyUpdateCommand}
                        />
                    </ItemGroup>
                )}

                {/* Session Details */}
                <ItemGroup>
                    <Item
                        title={t('sessionInfo.happySessionId')}
                        subtitle={`${session.id.substring(0, 8)}...${session.id.substring(session.id.length - 8)}`}
                        icon={<Ionicons name="finger-print-outline" size={29} color="#007AFF" />}
                        onPress={handleCopySessionId}
                    />
                    {session.metadata?.claudeSessionId && (
                        <Item
                            title={t('sessionInfo.claudeCodeSessionId')}
                            subtitle={`${session.metadata.claudeSessionId.substring(0, 8)}...${session.metadata.claudeSessionId.substring(session.metadata.claudeSessionId.length - 8)}`}
                            icon={<Ionicons name="code-outline" size={29} color="#9C27B0" />}
                            onPress={async () => {
                                try {
                                    await Clipboard.setStringAsync(session.metadata!.claudeSessionId!);
                                    Modal.alert(t('common.success'), t('sessionInfo.claudeCodeSessionIdCopied'));
                                } catch (error) {
                                    Modal.alert(t('common.error'), t('sessionInfo.failedToCopyClaudeCodeSessionId'));
                                }
                            }}
                        />
                    )}
                    {session.metadata?.codexThreadId && (
                        <Item
                            title={t('sessionInfo.codexThreadId')}
                            subtitle={`${session.metadata.codexThreadId.substring(0, 8)}...${session.metadata.codexThreadId.substring(session.metadata.codexThreadId.length - 8)}`}
                            icon={<Ionicons name="terminal-outline" size={29} color="#10A37F" />}
                            onPress={async () => {
                                try {
                                    await Clipboard.setStringAsync(session.metadata!.codexThreadId!);
                                    Modal.alert(t('common.success'), t('sessionInfo.codexThreadIdCopied'));
                                } catch (error) {
                                    Modal.alert(t('common.error'), t('sessionInfo.failedToCopyCodexThreadId'));
                                }
                            }}
                        />
                    )}
                    {/* Clone lineage (DROVE-58). A flip is one session on
                        another account and needs no line; a clone is TWO
                        sessions, because no harness but Claude Code can read a
                        Claude Code transcript. Without this the app shows two
                        unrelated rows and nothing says which came from which. */}
                    {cloneRows.map((row) => (
                        <Item
                            key={`${row.direction}-${row.claudeSessionId ?? 'pending'}`}
                            title={row.title}
                            subtitle={row.subtitle}
                            icon={<Ionicons name="git-branch-outline" size={29} color="#FF9500" />}
                            showChevron={!!cloneTargets[row.claudeSessionId ?? '']}
                            onPress={row.claudeSessionId ? () => {
                                // The ledger names CLAUDE session ids and the
                                // app routes by HAPPY ones, so a link is only
                                // offered when this device actually holds the
                                // other session. Otherwise the id is copied,
                                // which is what `drover clone --list` wants.
                                const happyId = cloneTargets[row.claudeSessionId!];
                                if (happyId) {
                                    router.push(`/session/${happyId}`);
                                } else {
                                    Clipboard.setStringAsync(row.claudeSessionId!);
                                }
                            } : undefined}
                        />
                    ))}
                    {/* Resume command — shown for disconnected sessions with a backend session ID */}
                    {/* TODO: migrate to `happy resume <happy-session-id>` once it works without happy-agent auth */}
                    {!sessionStatus.isConnected && getResumeCommand(session) && (
                        <CopyableItem
                            title="Resume Command"
                            subtitle={getResumeCommand(session)!}
                            icon={<Ionicons name="play-circle-outline" size={29} color="#30D158" />}
                            copyText={getResumeCommand(session)!}
                        />
                    )}
                    <Item
                        title={t('sessionInfo.connectionStatus')}
                        detail={sessionStatus.isConnected ? t('status.online') : t('status.offline')}
                        icon={<Ionicons name="pulse-outline" size={29} color={sessionStatus.isConnected ? "#34C759" : "#8E8E93"} />}
                        showChevron={false}
                    />
                    <Item
                        title={t('sessionInfo.created')}
                        subtitle={formatDate(session.createdAt)}
                        icon={<Ionicons name="calendar-outline" size={29} color="#007AFF" />}
                        showChevron={false}
                    />
                    <Item
                        title={t('sessionInfo.lastUpdated')}
                        subtitle={formatDate(session.updatedAt)}
                        icon={<Ionicons name="time-outline" size={29} color="#007AFF" />}
                        showChevron={false}
                    />
                    <Item
                        title={t('sessionInfo.sequence')}
                        detail={session.seq.toString()}
                        icon={<Ionicons name="git-commit-outline" size={29} color="#007AFF" />}
                        showChevron={false}
                    />
                </ItemGroup>

                {/* Cattle Drover's per-session flip policy (DROVE-3). Shown
                    only when the CLI has reported one, which it does whenever
                    the machine has a drover account registry — a session on a
                    machine without one has no policy to set. */}
                {(session.metadata?.droverPolicy || watchStatus || sessionAccount.name) && (
                    <ItemGroup title="Cattle Drover" footer={canFlipAccount ? flipRiskFooter(flipRisk) : undefined}>
                        {/* The account first, because Flip policy underneath it
                            is a rule about this value and reads as nothing
                            without it. Same line the composer popup heads its
                            quota rows with. */}
                        {sessionAccount.name && (
                            <Item
                                title="Account"
                                subtitle={sessionAccount.label}
                                icon={<Ionicons name="person-circle-outline" size={29} color="#FF9500" />}
                                showChevron={false}
                            />
                        )}
                        {sessionAccount.row && (
                            <AccountBar
                                row={sessionAccount.row}
                                capturedAt={session.metadata?.droverUsage?.capturedAt ?? null}
                            />
                        )}
                        {/* One flip path, not two. This is DROVE-28's action,
                            the same `/flip` message the popover and the watch
                            send, reached from the screen that now names the
                            account. The confirm inside it carries DROVE-37's
                            warning. */}
                        {canFlipAccount && (
                            <Item
                                title="Switch account"
                                subtitle={flipRiskSubtitle(flipRisk) ?? 'Switch this session to another account'}
                                icon={<Ionicons name="swap-horizontal-outline" size={29} color="#FF9500" />}
                                onPress={flipAccount}
                            />
                        )}
                        {session.metadata?.droverPolicy && (
                            <Item
                                title="Account switching"
                                subtitle={droverPolicySubtitle}
                                subtitleLines={0}
                                icon={<Ionicons name="swap-horizontal-outline" size={29} color="#FF9500" />}
                                onPress={() => router.push(`/session/${session.id}/policy` as any)}
                            />
                        )}
                        {/* The wrist, and whether it can be woken (DROVE-86).
                            A wrist that cannot be woken looked identical to
                            one that can until this line existed. */}
                        {watchStatus && (
                            <Item
                                title="Watch"
                                subtitle={describeDroverWatch(watchStatus)}
                                subtitleLines={1}
                                icon={<Ionicons name="watch-outline" size={29} color="#FF9500" />}
                                showChevron={false}
                            />
                        )}
                        {/* The two causes of a wrist that cannot be woken,
                            as two rows (DROVE-391). The complication on no
                            face is fixed on the watch and no amount of
                            waiting helps; the day's 50 spent is fixed by
                            tomorrow. One line said both and Clay could not
                            tell which he had. */}
                        {watchStatus && wristPresent(watchStatus) && (
                            <Item
                                title="Complication on a face"
                                subtitle={describeDroverComplication(watchStatus)}
                                subtitleLines={0}
                                icon={<Ionicons name="apps-outline" size={29} color="#FF9500" />}
                                showChevron={false}
                            />
                        )}
                        {watchStatus && wristPresent(watchStatus) && (
                            <Item
                                title="Wakes left today"
                                subtitle={describeDroverWakesLeft(watchStatus)}
                                subtitleLines={0}
                                icon={<Ionicons name="flash-outline" size={29} color="#FF9500" />}
                                showChevron={false}
                            />
                        )}
                        {/* What THIS phone spent, and the last reason it
                            refused, off the per-day ledger: the wake that
                            matters most is spent in a background launch
                            nobody watched (DROVE-391). */}
                        {watchStatus && wristPresent(watchStatus) && (
                            <Item
                                title="Wakes used today"
                                subtitle={wakeLedgerLines(wakeLedgerToday).join('\n')}
                                subtitleLines={0}
                                icon={<Ionicons name="receipt-outline" size={29} color="#FF9500" />}
                                showChevron={false}
                            />
                        )}
                        {/* The last cue that could NOT be carried to the wrist
                            (DROVE-224). With the app open no push can reach
                            the watch, so a refused wake is a wrist that stayed
                            silent outright, and a silent refusal is the whole
                            complaint this line answers. */}
                        {watchStatus && wristRefusalLine && (
                            <Item
                                title="Wrist"
                                subtitle={wristRefusalLine}
                                subtitleLines={0}
                                icon={<Ionicons name="notifications-off-outline" size={29} color="#FF9500" />}
                                showChevron={false}
                            />
                        )}
                    </ItemGroup>
                )}

                {/* DROVE-63: Claude Code's Remote Control for this pane. */}
                {canToggleRemoteControl && (
                    <ItemGroup
                        title={t('sessionInfo.remoteControlTitle')}
                        footer={remoteControl.value === null
                            ? t('sessionInfo.remoteControlUnknownFooter')
                            : t('sessionInfo.remoteControlFooter')}
                    >
                        <Item
                            title={t('sessionInfo.remoteControl')}
                            subtitle={remoteControl.pending
                                ? t('sessionInfo.remoteControlPending')
                                : remoteControl.value === null
                                    ? t('sessionInfo.remoteControlUnknown')
                                    : remoteControl.value
                                        ? t('sessionInfo.remoteControlOn')
                                        : t('sessionInfo.remoteControlOff')}
                            icon={<Ionicons name="phone-portrait-outline" size={29} color="#007AFF" />}
                            showChevron={false}
                            rightElement={
                                <Switch
                                    value={remoteControl.value === true}
                                    disabled={remoteControl.value === null}
                                    onValueChange={handleRemoteControlToggle}
                                />
                            }
                        />
                    </ItemGroup>
                )}

                {/* DROVE-37 + DROVE-63: who this session's flip silenced, and the
                    button that wakes them. */}
                {atRisk.length > 0 && (
                    <ItemGroup
                        title={t('sessionInfo.remoteControlAtRiskTitle')}
                        footer={t('sessionInfo.remoteControlAtRiskFooter')}
                    >
                        {atRisk.map((row) => {
                            const target = findSessionForAtRisk(allSessions, row);
                            const state = resolveRemoteControlState(target);
                            return (
                                <Item
                                    key={row.id}
                                    title={row.label}
                                    subtitle={state.value === true
                                        ? t('sessionInfo.remoteControlOn')
                                        : state.pending
                                            ? t('sessionInfo.remoteControlPending')
                                            : row.account}
                                    icon={<Ionicons name="notifications-off-outline" size={29} color="#FF9500" />}
                                    detail={state.value === true ? undefined : t('sessionInfo.remoteControlTurnOn')}
                                    showChevron={false}
                                    disabled={!target || state.value === true}
                                    onPress={() => target && handleWakeAtRisk(target.id)}
                                />
                            );
                        })}
                    </ItemGroup>
                )}

                {/* Quick Actions */}
                <ItemGroup title={t('sessionInfo.quickActions')}>
                    {session.metadata?.machineId && (
                        <Item
                            title={t('sessionInfo.viewMachine')}
                            subtitle={t('sessionInfo.viewMachineSubtitle')}
                            icon={<Ionicons name="server-outline" size={29} color="#007AFF" />}
                            onPress={() => router.push(`/machine/${session.metadata?.machineId}`)}
                        />
                    )}
                    {canShowResume && (
                        <Item
                            title={t('sessionInfo.resumeSession')}
                            subtitle={resumeSessionSubtitle}
                            icon={<Ionicons name="play-circle-outline" size={29} color="#007AFF" />}
                            onPress={resumeSession}
                        />
                    )}
                    {canFork && (
                        <Item
                            title={t('session.forkAction')}
                            subtitle={t('session.forkSubtitle')}
                            icon={<Ionicons name="git-branch-outline" size={29} color="#007AFF" />}
                            onPress={forkSession}
                            loading={forking}
                        />
                    )}
                    {canFork && (
                        <Item
                            title={t('session.duplicateAction')}
                            subtitle={t('session.duplicateSubtitle')}
                            icon={<Ionicons name="time-outline" size={29} color="#007AFF" />}
                            onPress={openDuplicateSheet}
                        />
                    )}
                    {/*
                        Clone, beside fork and never instead of it (DROVE-337).
                        The subtitle carries the difference that matters: a
                        fork continues this conversation, a clone RETELLS it to
                        a harness that cannot read it. When the session cannot
                        be cloned at all the row still shows, with the refusal
                        as its subtitle, because "only a Claude session can be
                        cloned" is worth reading and a missing row is not.
                    */}
                    <Item
                        title={t('session.cloneAction')}
                        subtitle={canClone ? t('session.cloneSubtitle') : (cloneRefusal ?? t('session.cloneSubtitle'))}
                        icon={<Ionicons name="swap-vertical-outline" size={29} color={canClone ? '#007AFF' : '#8E8E93'} />}
                        onPress={cloneSession}
                        loading={cloning}
                    />
                    {session.metadata?.parentSessionId && (
                        <Item
                            title={t('session.forkedFromLabel')}
                            subtitle={t('session.forkedFromSubtitle')}
                            icon={<Ionicons name="return-up-back-outline" size={29} color="#5856D6" />}
                            onPress={() => router.push(`/session/${session.metadata!.parentSessionId}`)}
                        />
                    )}
                    <Item
                        title={t('sessionInfo.archiveSession')}
                        subtitle={t('sessionInfo.archiveSessionSubtitle')}
                        icon={<Ionicons name="archive-outline" size={29} color="#FF3B30" />}
                        onPress={handleArchiveSession}
                    />
                    <Item
                        title={t('sessionInfo.deleteSession')}
                        subtitle={t('sessionInfo.deleteSessionSubtitle')}
                        icon={<Ionicons name="trash-outline" size={29} color="#FF3B30" />}
                        onPress={handleDeleteSession}
                    />
                </ItemGroup>

                {/* Metadata */}
                {session.metadata && (
                    <ItemGroup title={t('sessionInfo.metadata')}>
                        <Item
                            title={t('sessionInfo.host')}
                            subtitle={session.metadata.host}
                            icon={<Ionicons name="desktop-outline" size={29} color="#5856D6" />}
                            showChevron={false}
                        />
                        <Item
                            title={t('sessionInfo.path')}
                            subtitle={formatPathRelativeToHome(session.metadata.path, session.metadata.homeDir)}
                            icon={<Ionicons name="folder-outline" size={29} color="#5856D6" />}
                            showChevron={false}
                        />
                        {session.metadata.version && (
                            <Item
                                title={t('sessionInfo.cliVersion')}
                                subtitle={session.metadata.version}
                                detail={isCliOutdated ? '⚠️' : undefined}
                                icon={<Ionicons name="git-branch-outline" size={29} color={isCliOutdated ? "#FF9500" : "#5856D6"} />}
                                showChevron={false}
                            />
                        )}
                        {session.metadata.os && (
                            <Item
                                title={t('sessionInfo.operatingSystem')}
                                subtitle={formatOSPlatform(session.metadata.os)}
                                icon={<Ionicons name="hardware-chip-outline" size={29} color="#5856D6" />}
                                showChevron={false}
                            />
                        )}
                        {isRigMetadata(session.metadata) && (
                            <Item
                                title="Client"
                                subtitle={`${session.metadata.client?.name ?? 'Rig'}${session.metadata.client?.version ? ` ${session.metadata.client.version}` : ''}`}
                                icon={<Ionicons name="terminal-outline" size={29} color="#5856D6" />}
                                showChevron={false}
                            />
                        )}
                        <Item
                            title={t('sessionInfo.aiProvider')}
                            subtitle={(() => {
                                const rigIdentity = getRigIdentity(session.metadata);
                                if (rigIdentity) return rigIdentity.providerName;
                                return harnessName(session.metadata.flavor);
                            })()}
                            icon={<Ionicons name="sparkles-outline" size={29} color="#5856D6" />}
                            showChevron={false}
                        />
                        {getRigIdentity(session.metadata)?.modelName && (
                            <Item
                                title="Model"
                                subtitle={getRigIdentity(session.metadata)!.modelName!}
                                icon={<Ionicons name="hardware-chip-outline" size={29} color="#5856D6" />}
                                showChevron={false}
                            />
                        )}
                        {!isRigMetadata(session.metadata) && <Item
                            title="Sandbox"
                            subtitle={formatSandboxMetadata(session.metadata.sandbox, session.metadata.homeDir)}
                            icon={<Ionicons name="shield-outline" size={29} color="#5856D6" />}
                            showChevron={false}
                        />}
                        {!isRigMetadata(session.metadata) && <Item
                            title="Dangerously Skip Permissions"
                            subtitle={formatDangerouslySkipPermissionsMetadata(
                                session.metadata.dangerouslySkipPermissions,
                                session.metadata.flavor,
                                session.permissionMode,
                                session.metadata.sandbox,
                            )}
                            icon={<Ionicons name="warning-outline" size={29} color="#5856D6" />}
                            showChevron={false}
                        />}
                        {session.metadata.hostPid && (
                            <Item
                                title={t('sessionInfo.processId')}
                                subtitle={session.metadata.hostPid.toString()}
                                icon={<Ionicons name="terminal-outline" size={29} color="#5856D6" />}
                                showChevron={false}
                            />
                        )}
                        {session.metadata.happyHomeDir && (
                            <Item
                                title={t('sessionInfo.happyHome')}
                                subtitle={formatPathRelativeToHome(session.metadata.happyHomeDir, session.metadata.homeDir)}
                                icon={<Ionicons name="home-outline" size={29} color="#5856D6" />}
                                showChevron={false}
                            />
                        )}
                        <Item
                            title={t('sessionInfo.copyMetadata')}
                            icon={<Ionicons name="copy-outline" size={29} color="#007AFF" />}
                            onPress={handleCopyMetadata}
                        />
                        <Item
                            title={t('sessionInfo.copyMetadata') + '\n& Client Logs'}
                            icon={<Ionicons name="document-text-outline" size={29} color="#007AFF" />}
                            onPress={handleCopyMetadataAndLogs}
                        />
                    </ItemGroup>
                )}

                {/* Agent State */}
                {session.agentState && session.metadata?.client?.id !== 'rig' && (
                    <ItemGroup title={t('sessionInfo.agentState')}>
                        <Item
                            title={t('sessionInfo.controlledByUser')}
                            detail={session.agentState.controlledByUser ? t('common.yes') : t('common.no')}
                            icon={<Ionicons name="person-outline" size={29} color="#FF9500" />}
                            showChevron={false}
                        />
                        {session.agentState.requests && Object.keys(session.agentState.requests).length > 0 && (
                            <Item
                                title={t('sessionInfo.pendingRequests')}
                                detail={Object.keys(session.agentState.requests).length.toString()}
                                icon={<Ionicons name="hourglass-outline" size={29} color="#FF9500" />}
                                showChevron={false}
                            />
                        )}
                    </ItemGroup>
                )}

                {/* The session's task list (DROVE-167). Always here, empty or
                    not: a session that never kept one says so, because a
                    missing group and an empty list look identical and that is
                    the confusion this ticket is about. */}
                <ItemGroup title="Tasks" footer={sessionTasks.headline}>
                    <>
                        <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
                            <SessionTasksList tasks={sessionTasks} />
                        </View>
                    </>
                </ItemGroup>

                {/* Activity */}
                <ItemGroup title={t('sessionInfo.activity')}>
                    <Item
                        title={t('sessionInfo.thinking')}
                        detail={session.thinking ? t('common.yes') : t('common.no')}
                        icon={<Ionicons name="bulb-outline" size={29} color={session.thinking ? "#FFCC00" : "#8E8E93"} />}
                        showChevron={false}
                    />
                    {session.thinking && (
                        <Item
                            title={t('sessionInfo.thinkingSince')}
                            subtitle={formatDate(session.thinkingAt)}
                            icon={<Ionicons name="timer-outline" size={29} color="#FFCC00" />}
                            showChevron={false}
                        />
                    )}
                    {(session.metadata?.activity?.subagents.running ?? 0) + (session.metadata?.activity?.subagents.queued ?? 0) > 0 && (
                        <Item
                            title="Subagents"
                            detail={`${session.metadata!.activity!.subagents.running} running · ${session.metadata!.activity!.subagents.queued} queued`}
                            icon={<Ionicons name="people-outline" size={29} color="#5856D6" />}
                            showChevron={false}
                        />
                    )}
                    {(session.metadata?.activity?.workflows.running ?? 0) > 0 && (
                        <Item title="Workflows" detail={`${session.metadata!.activity!.workflows.running} running`} icon={<Ionicons name="git-network-outline" size={29} color="#5856D6" />} showChevron={false} />
                    )}
                    {(session.metadata?.activity?.processes.running ?? 0) > 0 && (
                        <Item title="Background processes" detail={`${session.metadata!.activity!.processes.running} running`} icon={<Ionicons name="terminal-outline" size={29} color="#5856D6" />} showChevron={false} />
                    )}
                    {(session.metadata?.activity?.tasks.pending ?? 0) + (session.metadata?.activity?.tasks.inProgress ?? 0) > 0 && (
                        <Item title="Tasks" detail={`${session.metadata!.activity!.tasks.inProgress} in progress · ${session.metadata!.activity!.tasks.pending} pending`} icon={<Ionicons name="checkbox-outline" size={29} color="#5856D6" />} showChevron={false} />
                    )}
                </ItemGroup>

                {/* Raw JSON (Dev Mode Only) */}
                {devModeEnabled && (
                    <ItemGroup title="Raw JSON (Dev Mode)">
                        {session.agentState && (
                            <>
                                <Item
                                    title="Agent State"
                                    icon={<Ionicons name="code-working-outline" size={29} color="#FF9500" />}
                                    showChevron={false}
                                />
                                <View style={{ marginHorizontal: 16, marginBottom: 12 }}>
                                    <CodeView 
                                        code={JSON.stringify(session.agentState, null, 2)}
                                        language="json"
                                    />
                                </View>
                            </>
                        )}
                        {session.metadata && (
                            <>
                                <Item
                                    title="Metadata"
                                    icon={<Ionicons name="information-circle-outline" size={29} color="#5856D6" />}
                                    showChevron={false}
                                />
                                <View style={{ marginHorizontal: 16, marginBottom: 12 }}>
                                    <CodeView 
                                        code={JSON.stringify(session.metadata, null, 2)}
                                        language="json"
                                    />
                                </View>
                            </>
                        )}
                        {sessionStatus && (
                            <>
                                <Item
                                    title="Session Status"
                                    icon={<Ionicons name="analytics-outline" size={29} color="#007AFF" />}
                                    showChevron={false}
                                />
                                <View style={{ marginHorizontal: 16, marginBottom: 12 }}>
                                    <CodeView 
                                        code={JSON.stringify({
                                            isConnected: sessionStatus.isConnected,
                                            statusText: sessionStatus.statusText,
                                            statusColor: sessionStatus.statusColor,
                                            statusDotColor: sessionStatus.statusDotColor,
                                            isPulsing: sessionStatus.isPulsing
                                        }, null, 2)}
                                        language="json"
                                    />
                                </View>
                            </>
                        )}
                        {/* Full Session Object */}
                        <Item
                            title="Full Session Object"
                            icon={<Ionicons name="document-text-outline" size={29} color="#34C759" />}
                            showChevron={false}
                        />
                        <View style={{ marginHorizontal: 16, marginBottom: 12 }}>
                            <CodeView 
                                code={JSON.stringify(session, null, 2)}
                                language="json"
                            />
                        </View>
                    </ItemGroup>
                )}
            </ItemList>
        </>
    );
}

export default React.memo(() => {
    const { theme } = useUnistyles();
    const { id } = useLocalSearchParams<{ id: string }>();
    const session = useSession(id);
    const isDataReady = useIsDataReady();
    const screenTitle = session
        ? getSessionName(session)
        : isDataReady
            ? t('errors.sessionDeleted')
            : '';
    const screenOptions = <Stack.Screen options={{ headerTitle: screenTitle }} />;

    // Handle three states: loading, deleted, and exists
    if (!isDataReady) {
        // Still loading data
        return (
            <>
                {screenOptions}
                <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.groupped.background }}>
                    <Ionicons name="hourglass-outline" size={48} color={theme.colors.textSecondary} />
                    <Text style={{ color: theme.colors.textSecondary, fontSize: 17, marginTop: 16, ...Typography.default('semiBold') }}>{t('common.loading')}</Text>
                </View>
            </>
        );
    }

    if (!session) {
        // Session has been deleted or doesn't exist
        return (
            <>
                {screenOptions}
                <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.groupped.background }}>
                    <Ionicons name="trash-outline" size={48} color={theme.colors.textSecondary} />
                    <Text style={{ color: theme.colors.text, fontSize: 20, marginTop: 16, ...Typography.default('semiBold') }}>{t('errors.sessionDeleted')}</Text>
                    <Text style={{ color: theme.colors.textSecondary, fontSize: 15, marginTop: 8, textAlign: 'center', paddingHorizontal: 32, ...Typography.default() }}>{t('errors.sessionDeletedDescription')}</Text>
                </View>
            </>
        );
    }

    return (
        <>
            {screenOptions}
            <SessionInfoContent session={session} />
        </>
    );
});

function CopyableItem({ title, subtitle, icon, copyText }: { title: string; subtitle: string; icon: React.ReactNode; copyText: string }) {
    const [copied, setCopied] = React.useState(false);
    return (
        <Item
            title={title}
            subtitle={subtitle}
            icon={icon}
            showChevron={false}
            rightElement={<Ionicons name={copied ? 'checkmark' : 'copy-outline'} size={18} color={copied ? '#30D158' : '#8E8E93'} />}
            onPress={async () => {
                await Clipboard.setStringAsync(copyText);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
            }}
        />
    );
}
