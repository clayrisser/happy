/**
 * The quota sheet (DROVE-117).
 *
 * Clay: "and actually have it show on a sheet that slides up, right?" It also
 * settles a compromise DROVE-107 was stuck with. The quota used to be a native
 * menu, and a NativeSettingsMenuOption is a plain label string rendered by a
 * SwiftUI Button, so a menu row can hold a sentence but never a bar. That lane
 * fell back to unfolding the bars inline under the status row, which squeezed
 * a list of accounts into the composer's furniture and capped it at whatever
 * fitted. A sheet is the container this content wanted: it draws anything, it
 * scrolls on its own, and its width is known, which is what lets the columns
 * be fixed instead of fighting the composer for space.
 *
 * The chrome moved out to ComposerSheet when DROVE-111 gave the agent
 * tree the same treatment, so the two are one sheet rather than two that look
 * alike. This is now just what goes in it.
 *
 * DROVE-208 added the way in at the end of it: an add row, on the machine this
 * session runs on. The row is drawn by UsageAccountBars and the machine is
 * decided by the caller, which is the only place a session is known.
 */
import * as React from 'react';
import { ComposerSheet } from './ComposerSheet';
import { UsageAccountBars } from './UsageAccountBars';
import type { UsageBarGroup } from './agentInputUsage';

export function UsageAccountBarsSheet(props: {
    groups: UsageBarGroup[];
    /** The zone and the model the numbers are for (DROVE-173). */
    footer?: string;
    open: boolean;
    onClose: () => void;
    /** Tapping an account block switches the session onto it (DROVE-160). */
    onSwitchAccount?: (account: string) => void;
    /** The add row that ends the list (DROVE-208). */
    addAccount?: { machineName: string; onPress: () => void } | null;
}) {
    return (
        <ComposerSheet
            open={props.open}
            onClose={props.onClose}
        >
            <UsageAccountBars
                groups={props.groups}
                footer={props.footer}
                onSwitchAccount={props.onSwitchAccount}
                addAccount={props.addAccount}
            />
        </ComposerSheet>
    );
}
