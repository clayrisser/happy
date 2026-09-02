/**
 * What the paired watch can do right now, and what this phone has spent on
 * waking it today (DROVE-86, DROVE-391). One hook behind the session info
 * screen and the Playground, so the two never disagree.
 *
 * Re-read whenever the app comes back to the foreground, because the numbers
 * that matter here move while the phone is in a pocket: the daily wake
 * budget, the ledger of what was spent in a background launch whose JS
 * context is gone before anyone looks, and whether the watch app is open.
 * Also re-read on the watch app coming forward or going away, which the
 * native side reports as it happens from build 22; older binaries never send
 * it and fall back to the foreground re-read alone.
 *
 * `status` is null where there is no WatchConnectivity at all (Android, web,
 * a build without the module), which every caller draws as "no wrist".
 */

import * as React from 'react';
import { AppState } from 'react-native';
import { addDroverReachabilityListener, getDroverWatchStatus, type DroverWatchStatus } from 'drover-watch';

import { wakeLedger, type WakeLedger } from '@/sync/droverWakeLedger';

export interface DroverWatchStatusModel {
    status: DroverWatchStatus | null;
    ledger: WakeLedger;
    /** Read both again now; the Playground calls it after every tap. */
    refresh: () => void;
}

function readStatus(): DroverWatchStatus | null {
    const status = getDroverWatchStatus();
    return status.supported ? status : null;
}

export function useDroverWatchStatus(): DroverWatchStatusModel {
    const [status, setStatus] = React.useState<DroverWatchStatus | null>(readStatus);
    const [ledger, setLedger] = React.useState<WakeLedger>(() => wakeLedger());
    const refresh = React.useCallback(() => {
        setStatus(readStatus());
        setLedger(wakeLedger());
    }, []);
    React.useEffect(() => {
        const app = AppState.addEventListener('change', (state) => {
            if (state === 'active') refresh();
        });
        const reach = addDroverReachabilityListener(() => refresh());
        return () => {
            app.remove();
            reach.remove();
        };
    }, [refresh]);
    return { status, ledger, refresh };
}
