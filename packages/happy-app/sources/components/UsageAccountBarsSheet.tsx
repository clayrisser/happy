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
 *
 * DROVE-248 made it the thing that HOLDS the order. The accounts are ranked
 * best-first upstream (`rankUsageAccounts`), which re-ranks on every snapshot,
 * and this is the one component that knows when the sheet is open and can
 * therefore pin it. See `holdUsageGroupOrder` for why a list of tap targets
 * must not re-sort under a thumb.
 */
import * as React from 'react';
import { ComposerSheet } from './ComposerSheet';
import { UsageAccountBars } from './UsageAccountBars';
import { holdUsageGroupOrder, type UsageBarGroup } from './agentInputUsage';

export function UsageAccountBarsSheet(props: {
    groups: UsageBarGroup[];
    /** The zone and the window the numbers skipped (DROVE-230). */
    footer?: string;
    /** When the snapshot was taken, so the caption can age it (DROVE-230). */
    capturedAt?: number | null;
    open: boolean;
    onClose: () => void;
    /** Tapping an account block switches the session onto it (DROVE-160). */
    onSwitchAccount?: (account: string) => void;
    /** The add row that ends the list (DROVE-208). */
    addAccount?: { machineName: string; onPress: () => void } | null;
}) {
    // The key order as it stood when the sheet opened, empty while it is shut.
    // Captured in an effect keyed on `open` ALONE: re-running it when `groups`
    // changes is exactly the re-sort this prevents, and the sweep changes
    // `groups` every ten minutes. The first frame of an opening renders the
    // fresh ranking and the effect pins that same order, so nothing moves.
    const [held, setHeld] = React.useState<string[]>([]);
    const open = props.open;
    const groups = props.groups;
    React.useEffect(() => {
        setHeld(open ? groups.map((group) => group.key) : []);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);
    return (
        <ComposerSheet
            open={props.open}
            onClose={props.onClose}
        >
            <UsageAccountBars
                groups={holdUsageGroupOrder(groups, held)}
                footer={props.footer}
                capturedAt={props.capturedAt}
                onSwitchAccount={props.onSwitchAccount}
                addAccount={props.addAccount}
            />
        </ComposerSheet>
    );
}
