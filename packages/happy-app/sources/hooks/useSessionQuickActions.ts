import * as React from 'react';
import { useHappyAction } from '@/hooks/useHappyAction';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { Modal } from '@/modal';
import { machineResumeSession, sessionArchive, sessionKill, sessionSetAgentModes, forkAndSpawn, cloneIntoHarness, type CloneTargetHarness, type ForkSource } from '@/sync/ops';
import { cloneRefusal, cloneTargetOptions, type CloneRefusal } from '@/utils/cloneTargets';
import { spawnFailureMessage } from '@/utils/spawnFailure';
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
import { collectDroverAccountsFromSessions } from '@/utils/droverAccounts';
import { confirmDroverSwitch } from '@/utils/droverAccountSwitch';

/**
 * Menu rows are keyed by their keyboard shortcut where one exists.
 * `flip-account` and `clone-harness` have none — both are Cattle Drover
 * actions, not part of the stock shortcut set — so surfaces that render a
 * chord must treat the lookup as optional.
 */
export type SessionActionId = SessionActionShortcutId | 'flip-account' | 'clone-harness';

/**
 * The sentences the failure helper needs, built here because `@/text` cannot
 * be imported by a module a vitest spec loads (DROVE-337).
 */
const forkCopy = () => ({
    generic: t('session.forkErrorGeneric'),
    directoryMissing: (directory: string) => t('session.forkErrorDirectoryMissing', { directory }),
});

const cloneCopy = () => ({
    generic: t('session.cloneErrorGeneric'),
    directoryMissing: (directory: string) => t('session.forkErrorDirectoryMissing', { directory }),
});

/** One refusal code, said out loud. */
function cloneRefusalMessage(refusal: CloneRefusal): string {
    switch (refusal) {
        case 'not-claude': return t('session.cloneErrorNotClaude');
        case 'no-conversation': return t('session.forkErrorMissingMetadata');
        case 'machine-offline': return t('session.forkErrorOffline');
    }
}

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

    // Cattle Drover account switch (BASED-133). There is no flip RPC and there
    // must not be one: happy-cli intercepts `/flip` in the message stream
    // before the queue, so moving a session to another account is an ordinary
    // chat message. The watch sends the identical string
    // (sync/droverWatchFeed.ts), and so does the quota sheet (DROVE-160). The
    // user-facing word is "switch"; `flip` is the mechanism's own name.
    const droverAccounts = useDroverAccounts();
    const currentDroverAccount = session.metadata?.droverAccount ?? null;
    // Flip shows on ANY Cattle Drover session, not only once the app has itself
    // seen two accounts (BASED-133 gated on that, which hid the button from
    // anyone who had only ever run on one — the common case). The account
    // roster lives in the CLI, not here: a bare `/flip` asks it to pick the
    // next account with headroom, so the action is useful with a single KNOWN
    // account too, and specific-account rows fill in as more are seen. A flip
    // with nowhere to go is refused gracefully now (BASED-113), so offering it
    // can never strand the session. The signal that this IS a drover session is
    // metadata.droverAccount, which the CLI now works out from the config dir
    // the session is running on rather than reading DROVER_ACCOUNT alone
    // (DROVE-31) — a bare `drover` sets no stamp, so gating on the stamp hid
    // this row from most sessions.
    const canFlipAccount = currentDroverAccount != null;

    // DROVE-37's warning is said BEFORE the switch rather than after it, and
    // both it and the send live in utils/droverAccountSwitch.ts (DROVE-160), so
    // the menu here and the quota sheet cannot drift into two paths.
    const confirmFlip = React.useCallback((account: string | null) => {
        confirmDroverSwitch({ sessionId: session.id, account, from: currentDroverAccount });
    }, [currentDroverAccount, session.id]);

    const flipAccount = React.useCallback(() => {
        if (!canFlipAccount) return;
        // Always confirm through the picker, even when this app only knows the
        // one account it is on: "Next available" is a real choice the CLI
        // resolves, and a silent immediate switch reads as the button doing
        // nothing. Any OTHER accounts the app has seen become named rows.
        const targets = droverAccounts.filter((account) => account !== currentDroverAccount);
        const buttons: Array<{ text: string; onPress?: () => void; style?: 'cancel' | 'destructive' | 'default' }> = [
            { text: 'Next available', onPress: () => confirmFlip(null) },
            ...targets.map((account) => ({ text: account, onPress: () => confirmFlip(account) })),
        ];
        buttons.push({ text: t('common.cancel'), style: 'cancel' });
        Modal.alert(
            'Switch account',
            currentDroverAccount ? `Now on ${currentDroverAccount}` : undefined,
            buttons,
        );
    }, [canFlipAccount, confirmFlip, currentDroverAccount, droverAccounts]);

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
            // The daemon's own sentence, whenever it gave one. Before
            // DROVE-337 anything that was not a tagged `error` -- including
            // the `{ error }` envelope a THROWN daemon handler answers with --
            // landed on "Failed to fork the session." and Clay was left
            // guessing at a tmux failure the log had already named.
            throw new HappyError(spawnFailureMessage(result, forkCopy()), false);
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

    // CLONE into another harness (DROVE-58, DROVE-337).
    //
    // Not a second spelling of fork. A fork copies the transcript and resumes
    // it, which only works while the target harness reads the same file; no
    // harness but Claude Code can read a Claude Code transcript. So a clone
    // exports the conversation and starts a NEW session that is told it. Two
    // sessions, both real, and the menu says "clone" so nobody expects the
    // source to move.
    const refusal = React.useMemo(() => cloneRefusal({
        flavor: session.metadata?.flavor,
        claudeSessionId: session.metadata?.claudeSessionId,
        machineOnline: Boolean(machine && isMachineOnline(machine)),
    }), [machine, session.metadata?.claudeSessionId, session.metadata?.flavor]);
    const canClone = refusal === null;
    const cloneRefusalText = refusal === null ? null : cloneRefusalMessage(refusal);

    // The chosen harness rides in a ref because `useHappyAction` takes no
    // arguments -- it exists to own the loading flag and the error alert, and
    // widening its signature for one caller would touch every action in the
    // app for no gain.
    const cloneTargetRef = React.useRef<CloneTargetHarness>('cursor');
    const [cloning, performClone] = useHappyAction(async () => {
        const harness = cloneTargetRef.current;
        if (refusal !== null) {
            throw new HappyError(cloneRefusalMessage(refusal), false);
        }
        const source = forkSource;
        if (!source || source.kind !== 'claude') {
            throw new HappyError(t('session.cloneErrorNotClaude'), false);
        }
        const result = await cloneIntoHarness(source, harness);
        if (result.type !== 'success') {
            throw new HappyError(spawnFailureMessage(result, cloneCopy()), false);
        }
        navigateToSession(result.sessionId);
    });

    const cloneSession = React.useCallback(() => {
        if (cloneRefusalText !== null) {
            // The refusal is the useful half. A row that does nothing when
            // tapped teaches nothing; a row that says "only a Claude session
            // can be cloned" is an answer.
            Modal.alert(t('common.error'), cloneRefusalText);
            return;
        }
        // One alert with the harnesses on it, the same shape the account
        // switch uses. A target this machine cannot run stays ON the list and
        // says why when tapped, rather than vanishing: a missing row reads as
        // a broken app, and "Not installed on this machine" reads as a thing
        // to go and fix.
        const options = cloneTargetOptions(machine?.metadata?.cliAvailability);
        const buttons: Array<{ text: string; onPress?: () => void; style?: 'cancel' | 'destructive' | 'default' }> =
            options.map((option) => ({
                text: option.available
                    ? option.name
                    : `${option.name} — ${t('session.cloneHarnessUnavailable')}`,
                onPress: option.available
                    ? () => { cloneTargetRef.current = option.key; performClone(); }
                    : () => Modal.alert(option.name, t('session.cloneHarnessUnavailable')),
            }));
        buttons.push({ text: t('common.cancel'), style: 'cancel' });
        Modal.alert(t('session.cloneSheetTitle'), t('session.cloneSheetSubtitle'), buttons);
    }, [cloneRefusalText, machine?.metadata?.cliAvailability, performClone]);

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

        if (canClone) {
            items.push({ id: 'clone-harness', icon: 'swap-vertical-outline', label: t('session.cloneAction'), onPress: cloneSession });
        }

        if (canFlipAccount) {
            items.push({ id: 'flip-account', icon: 'swap-horizontal-outline', label: 'Switch account', onPress: flipAccount });
        }

        if (canCopySessionMetadata) {
            items.push({ id: 'copy-metadata', icon: 'bug-outline', label: t('sessionInfo.copyMetadata'), onPress: copySessionMetadata });
            items.push({ id: 'copy-metadata-and-logs', icon: 'document-text-outline', label: t('sessionInfo.copyMetadata') + ' & Client Logs', onPress: copySessionMetadataAndLogs });
        }

        items.push({ id: 'archive', icon: 'archive-outline', label: 'Archive', onPress: archiveSession, destructive: true });

        return items;
    }, [
        archiveSession,
        canClone,
        canCopySessionMetadata,
        canFlipAccount,
        canFork,
        cloneSession,
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
        canClone,
        canFlipAccount,
        canFork,
        cloneRefusal: cloneRefusalText,
        cloneSession,
        cloning,
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
