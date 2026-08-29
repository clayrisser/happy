import * as React from 'react';
import { useHappyAction } from '@/hooks/useHappyAction';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { Modal } from '@/modal';
import { machineResumeSession, sessionArchive, sessionKill, sessionSetAgentModes, forkAndSpawn, type ForkSource } from '@/sync/ops';
import { maybeCleanupWorktree } from '@/hooks/useWorktreeCleanup';
import { storage, useLocalSetting, useMachine, useSetting } from '@/sync/storage';
import { useShallow } from 'zustand/react/shallow';
import { Machine, Session } from '@/sync/storageTypes';
import { sync } from '@/sync/sync';
import { resolveMessageModeMeta, UnsupportedPermissionModeError } from '@/sync/messageMeta';
import { t } from '@/text';
import { HappyError } from '@/utils/errors';
import { copySessionMetadataToClipboard, copySessionMetadataAndLogsToClipboard } from '@/utils/copySessionMetadataToClipboard';
import { useSessionStatus } from '@/utils/sessionUtils';
import { isMachineOnline } from '@/utils/machineUtils';
import { getSessionForkSource } from '@/utils/sessionFork';
import { useRouter } from 'expo-router';
import { useSession } from '@/sync/storage';
import { DuplicateSheet } from '@/components/DuplicateSheet';
import type { SessionActionShortcutId } from '@/keyboard/shortcuts';
import { isRigMetadata } from '@/sync/rig';
import { collectDroverAccountsFromSessions, droverFlipMessage } from '@/utils/droverAccounts';

/**
 * Menu rows are keyed by their keyboard shortcut where one exists. `flip-account`
 * has none — it is a Cattle Drover action, not part of the stock shortcut set —
 * so surfaces that render a chord must treat the lookup as optional.
 */
export type SessionActionId = SessionActionShortcutId | 'flip-account';

export interface SessionActionItem {
    id: SessionActionId;
    label: string;
    icon: string;
    onPress: () => void;
    destructive?: boolean;
}

interface UseSessionQuickActionsOptions {
    onAfterArchive?: () => void;
    onAfterDelete?: () => void;
    onAfterCopySessionMetadata?: () => void;
}

type ResumeAvailability = {
    canResume: boolean;
    canShowResume: boolean;
    subtitle: string;
    message: string;
};

function getResumeAvailability(session: Session, machine: Machine | null | undefined, isConnected: boolean): ResumeAvailability {
    if (isRigMetadata(session.metadata) || session.metadata?.capabilities?.resume === false) {
        return {
            canResume: false,
            canShowResume: false,
            subtitle: '',
            message: '',
        };
    }
    if (isConnected) {
        return {
            canResume: false,
            canShowResume: false,
            subtitle: '',
            message: '',
        };
    }

    const machineId = session.metadata?.machineId;
    if (!machineId) {
        const message = t('sessionInfo.resumeSessionMissingMachine');
        return {
            canResume: false,
            canShowResume: true,
            subtitle: message,
            message,
        };
    }

    const hasBackendResumeId = Boolean(session.metadata?.claudeSessionId || session.metadata?.codexThreadId);
    if (!hasBackendResumeId) {
        const message = t('sessionInfo.resumeSessionMissingBackendId');
        return {
            canResume: false,
            canShowResume: true,
            subtitle: message,
            message,
        };
    }

    if (!machine) {
        const message = t('sessionInfo.resumeSessionSameMachineOnly');
        return {
            canResume: false,
            canShowResume: true,
            subtitle: message,
            message,
        };
    }

    if (!isMachineOnline(machine)) {
        return {
            canResume: false,
            canShowResume: true,
            subtitle: t('sessionInfo.resumeSessionMachineOffline'),
            message: t('sessionInfo.resumeSessionMachineOffline'),
        };
    }

    // Older daemons do not publish resumeSupport and do not implement the
    // resume RPC. Capability presence is the compatibility check; the UI is
    // hidden instead of offering an action that the machine cannot execute.
    if (machine.metadata?.resumeSupport?.rpcAvailable !== true) {
        return {
            canResume: false,
            canShowResume: false,
            subtitle: '',
            message: '',
        };
    }

    return {
        canResume: true,
        canShowResume: true,
        subtitle: t('sessionInfo.resumeSessionSubtitle'),
        message: t('sessionInfo.resumeSessionSubtitle'),
    };
}

/**
 * Drover accounts across every known session.
 *
 * Read straight off the session map rather than the built list view: this hook
 * runs once per row in the session lists, and recomputing the view per row
 * would be far more work than a shallow-compared array of names.
 */
function useDroverAccounts(): string[] {
    return storage(useShallow((state) => (
        state.isDataReady ? collectDroverAccountsFromSessions(Object.values(state.sessions)) : []
    )));
}

export function useSessionQuickActions(
    session: Session,
    options: UseSessionQuickActionsOptions = {},
) {
    const {
        onAfterArchive,
        onAfterCopySessionMetadata,
    } = options;
    const router = useRouter();
    const navigateToSession = useNavigateToSession();
    const sessionStatus = useSessionStatus(session);
    const machineId = session.metadata?.machineId ?? '';
    const machine = useMachine(machineId);
    const devModeEnabled = useLocalSetting('devModeEnabled');
    const continuationExperimentsEnabled = useSetting('expResumeSession');
    const resumeAvailability = React.useMemo(
        () => getResumeAvailability(session, machine, sessionStatus.isConnected),
        [machine, session, sessionStatus.isConnected],
    );

    // Fork eligibility — separate from resume because fork works on both
    // active AND inactive provider sessions. Fork/duplicate still use the
    // legacy rollout flag because resumeSupport does not prove that the daemon
    // implements the newer fork RPC.
    const forkSource = React.useMemo(() => getSessionForkSource(session), [
        session.id,
        session.metadata?.flavor,
        session.metadata?.machineId,
        session.metadata?.path,
        session.metadata?.claudeSessionId,
        session.metadata?.codexThreadId,
    ]);
    const canFork = Boolean(
        continuationExperimentsEnabled
        && !isRigMetadata(session.metadata)
        && forkSource
        && machine
        && isMachineOnline(machine)
    );

    // Cattle Drover flip (BASED-133). There is no flip RPC and there must not
    // be one: happy-cli intercepts `/flip` in the message stream before the
    // queue, so moving a session to another account is an ordinary chat
    // message. The watch sends the identical string (sync/droverWatchFeed.ts).
    const droverAccounts = useDroverAccounts();
    const currentDroverAccount = session.metadata?.droverAccount ?? null;
    // Same rule as the account chips on the sessions list: with one account
    // there is nowhere to flip to, so the row stays hidden.
    const canFlipAccount = droverAccounts.length >= 2;

    const sendFlip = React.useCallback((account?: string | null) => {
        void Promise.resolve(sync.sendMessage(session.id, droverFlipMessage(account))).catch(() => {});
    }, [session.id]);

    const flipAccount = React.useCallback(() => {
        if (!canFlipAccount) return;
        const targets = droverAccounts.filter((account) => account !== currentDroverAccount);
        if (targets.length === 0) {
            sendFlip();
            return;
        }
        const buttons: Array<{ text: string; onPress?: () => void; style?: 'cancel' | 'destructive' | 'default' }> = [
            { text: 'Next available', onPress: () => sendFlip() },
            ...targets.map((account) => ({ text: account, onPress: () => sendFlip(account) })),
        ];
        buttons.push({ text: t('common.cancel'), style: 'cancel' });
        Modal.alert(
            'Move to another account',
            currentDroverAccount ? `Now on ${currentDroverAccount}` : undefined,
            buttons,
        );
    }, [canFlipAccount, currentDroverAccount, droverAccounts, sendFlip]);

    const openDetails = React.useCallback(() => {
        router.push(`/session/${session.id}/info`);
    }, [router, session.id]);

    const copySessionMetadata = React.useCallback(() => {
        void (async () => {
            const copied = await copySessionMetadataToClipboard(session);
            if (copied) {
                onAfterCopySessionMetadata?.();
            }
        })();
    }, [onAfterCopySessionMetadata, session]);

    const copySessionMetadataAndLogs = React.useCallback(() => {
        void (async () => {
            const copied = await copySessionMetadataAndLogsToClipboard(session);
            if (copied) {
                onAfterCopySessionMetadata?.();
            }
        })();
    }, [onAfterCopySessionMetadata, session]);

    const [resumingSession, performResume] = useHappyAction(async () => {
        if (!resumeAvailability.canResume) {
            throw new HappyError(resumeAvailability.message, false);
        }

        if (!machineId) {
            throw new HappyError(t('sessionInfo.resumeSessionMissingMachine'), false);
        }

        let modeMeta: ReturnType<typeof resolveMessageModeMeta>;
        try {
            modeMeta = resolveMessageModeMeta(session, storage.getState().settings);
        } catch (error) {
            if (error instanceof UnsupportedPermissionModeError) {
                // Refuse loudly instead of substituting a mode: swapping in a
                // default would silently change what the agent may do.
                throw new HappyError(error.message, false);
            }
            throw error;
        }
        const result = await machineResumeSession({
            machineId,
            sessionId: session.id,
            model: modeMeta.model ?? undefined,
            permissionMode: modeMeta.permissionMode,
        });

        switch (result.type) {
            case 'success': {
                // Session reconnects to the same ID, so messages are preserved.
                // Refresh to pick up the updated session state.
                await sync.refreshSessions();

                if (session.permissionMode) {
                    sessionSetAgentModes(result.sessionId, { permissionMode: session.permissionMode });
                }
                // Model / effort picks survive resume on their own — they live
                // in the session's synced metadata (#1492).

                navigateToSession(result.sessionId);
                return;
            }
            case 'requestToApproveDirectoryCreation':
                throw new HappyError(t('sessionInfo.resumeSessionUnexpectedDirectoryPrompt'), false);
            case 'error':
                throw new HappyError(result.errorMessage, false);
        }
    });

    const [archivingSession, performArchive] = useHappyAction(async () => {
        await maybeCleanupWorktree(session.id, session.metadata?.path, session.metadata?.machineId);

        // Try to kill the CLI process; if it's already dead, force-archive via server
        const killResult = await sessionKill(session.id);
        if (!killResult.success) {
            await sessionArchive(session.id);
        }
        onAfterArchive?.();
    });

    const archiveSession = React.useCallback(() => {
        performArchive();
    }, [performArchive]);

    const resumeSession = React.useCallback(() => {
        performResume();
    }, [performResume]);

    // Fork the session (no truncation) — copies the on-disk Claude JSONL
    // and spawns a fresh Happy session on the same machine. Works for
    // both active and inactive sessions; the source row stays untouched.
    const [forking, performFork] = useHappyAction(async () => {
        if (!canFork) {
            throw new HappyError(t('session.forkErrorMissingMetadata'), false);
        }
        if (!forkSource) {
            throw new HappyError(t('session.forkErrorMissingMetadata'), false);
        }
        const result = await forkAndSpawn(forkSource as ForkSource);
        if (result.type !== 'success') {
            throw new HappyError(result.type === 'error' ? result.errorMessage : t('session.forkErrorGeneric'), false);
        }
        navigateToSession(result.sessionId);
    });

    const forkSession = React.useCallback(() => {
        performFork();
    }, [performFork]);

    const openDuplicateSheet = React.useCallback(() => {
        if (!canFork) return;
        Modal.show({
            component: DuplicateSheet,
            props: { sessionId: session.id },
        } as any);
    }, [canFork, session.id]);

    const canCopySessionMetadata = __DEV__ || devModeEnabled;

    const actionItems = React.useMemo<SessionActionItem[]>(() => {
        const items: SessionActionItem[] = [
            { id: 'details', icon: 'information-circle-outline', label: t('profile.details'), onPress: openDetails },
        ];

        if (resumeAvailability.canShowResume) {
            items.push({ id: 'resume', icon: 'play-circle-outline', label: t('sessionInfo.resumeSession'), onPress: resumeSession });
        }

        if (canFork) {
            items.push({ id: 'fork', icon: 'git-branch-outline', label: t('session.forkAction'), onPress: forkSession });
            items.push({ id: 'duplicate', icon: 'time-outline', label: t('session.duplicateAction'), onPress: openDuplicateSheet });
        }

        if (canFlipAccount) {
            items.push({ id: 'flip-account', icon: 'swap-horizontal-outline', label: 'Move to another account', onPress: flipAccount });
        }

        if (canCopySessionMetadata) {
            items.push({ id: 'copy-metadata', icon: 'bug-outline', label: t('sessionInfo.copyMetadata'), onPress: copySessionMetadata });
            items.push({ id: 'copy-metadata-and-logs', icon: 'document-text-outline', label: t('sessionInfo.copyMetadata') + ' & Client Logs', onPress: copySessionMetadataAndLogs });
        }

        items.push({ id: 'archive', icon: 'archive-outline', label: 'Archive', onPress: archiveSession, destructive: true });

        return items;
    }, [
        archiveSession,
        canCopySessionMetadata,
        canFlipAccount,
        canFork,
        copySessionMetadata,
        copySessionMetadataAndLogs,
        flipAccount,
        forkSource,
        forkSession,
        openDetails,
        openDuplicateSheet,
        resumeAvailability.canShowResume,
        resumeSession,
    ]);

    const showActionAlert = React.useCallback(() => {
        const buttons: Array<{ text: string; onPress?: () => void; style?: 'cancel' | 'destructive' | 'default' }> = actionItems.map(item => ({
            text: item.label,
            onPress: item.onPress,
            style: item.destructive ? 'destructive' as const : undefined,
        }));
        buttons.push({ text: t('common.cancel'), style: 'cancel' });
        Modal.alert('Session', undefined, buttons);
    }, [actionItems]);

    return {
        actionItems,
        showActionAlert,
        archiveSession,
        archivingSession,
        canArchive: true,
        canCopySessionMetadata,
        canResume: resumeAvailability.canResume,
        canShowResume: resumeAvailability.canShowResume,
        canFlipAccount,
        canFork,
        copySessionMetadata,
        copySessionMetadataAndLogs,
        droverAccounts,
        flipAccount,
        forkSession,
        forking,
        openDetails,
        openDuplicateSheet,
        resumeSession,
        resumeSessionSubtitle: resumeAvailability.subtitle,
        resumingSession,
    };
}

/**
 * Lightweight hook for list items that only have a sessionId.
 * Returns a long-press handler that shows the action alert on mobile.
 */
export function useSessionActionAlert(sessionId: string) {
    const session = useSession(sessionId);
    const { showActionAlert } = useSessionQuickActions(session!, {});
    return session ? showActionAlert : undefined;
}
