import * as React from 'react';
import { DropdownMenu, DropdownMenuItem } from '@expo/ui/jetpack-compose';
import { useSessionQuickActions } from '@/hooks/useSessionQuickActions';
import { Session } from '@/sync/storageTypes';
import { t } from '@/text';

interface SessionActionsNativeMenuProps {
    children: React.ReactNode;
    onAfterArchive?: () => void;
    onAfterDelete?: () => void;
    session: Session;
}

export function SessionActionsNativeMenu({
    children,
    onAfterArchive,
    onAfterDelete,
    session,
}: SessionActionsNativeMenuProps) {
    const {
        archiveSession,
        canArchive,
        canCopySessionMetadata,
        canFlipAccount,
        canShowResume,
        copySessionMetadata,
        flipAccount,
        openDetails,
        resumeSession,
    } = useSessionQuickActions(session, {
        onAfterArchive,
        onAfterDelete,
    });

    return (
        <DropdownMenu>
            <DropdownMenu.Items>
                <DropdownMenuItem onClick={openDetails}>
                    <DropdownMenuItem.Text>Details</DropdownMenuItem.Text>
                </DropdownMenuItem>
                {canArchive && (
                    <DropdownMenuItem onClick={archiveSession}>
                        <DropdownMenuItem.Text>Archive</DropdownMenuItem.Text>
                    </DropdownMenuItem>
                )}
                {canShowResume && (
                    <DropdownMenuItem onClick={resumeSession}>
                        <DropdownMenuItem.Text>Resume</DropdownMenuItem.Text>
                    </DropdownMenuItem>
                )}
                {/*
                    One row, not a nested submenu of accounts: DropdownMenu has
                    no nested-menu primitive, and `flipAccount` already raises
                    the account picker — the same alert the popover uses.
                */}
                {canFlipAccount && (
                    <DropdownMenuItem onClick={flipAccount}>
                        <DropdownMenuItem.Text>Move to another account</DropdownMenuItem.Text>
                    </DropdownMenuItem>
                )}
                {canCopySessionMetadata && (
                    <DropdownMenuItem onClick={copySessionMetadata}>
                        <DropdownMenuItem.Text>{t('sessionInfo.copyMetadata')}</DropdownMenuItem.Text>
                    </DropdownMenuItem>
                )}
            </DropdownMenu.Items>
            <DropdownMenu.Trigger>{children}</DropdownMenu.Trigger>
        </DropdownMenu>
    );
}
