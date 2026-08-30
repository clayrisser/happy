/**
 * Background wake receiver for the Cattle Drover wrist surface (BASED-98).
 *
 * The CLI sends a silent content-available push every time the set of gates
 * waiting on a human changes — see happy-cli's `sendBackgroundWake`, which is
 * what droverBridge calls on a raise and on a dismiss. iOS launches the app's
 * JS to handle one. Nothing claimed that launch until this file existed:
 * app.config.js already declared `UIBackgroundModes: remote-notification`
 * through the expo-notifications plugin's `enableBackgroundRemoteNotifications`,
 * so the mode was declared, the push arrived, the bundle loaded, and no task
 * ran. Measured on 2026-08-29: `expo-task-manager` was not in package.json and
 * this file did not exist, so the entire send half was inert on iOS.
 *
 * Delivery is best effort and nothing here should be read as a guarantee.
 * Apple documents roughly two or three background pushes per user per hour and
 * promises none of them; low power mode, a locked idle device and its own
 * delivery heuristics all drop them with no error anywhere. The wrist's
 * reliable path is still the foreground feed in droverWatchFeed.ts. This is a
 * nudge on top of it, never a replacement for it.
 *
 * The task is defined at MODULE scope on purpose. A headless background launch
 * runs the bundle without ever mounting the React tree, so a task registered
 * from a component effect does not exist at the moment iOS looks for it — that
 * is the same shape of bug as the unclaimed background mode above. It also
 * means this module has to be imported for its side effect from the app entry
 * (index.ts), before `expo-router/entry`.
 *
 * expo-task-manager is a new native module. This needs `expo prebuild` and a
 * real rebuild, and cannot ship as an OTA update.
 *
 * It is deliberately NOT listed in app.config.js `plugins`. Autolinking picks
 * the native module up from its expo-module.config.json on its own; the config
 * plugin's only job is pushing `fetch` into UIBackgroundModes, and this app
 * runs no background fetch. `remote-notification` is already there from
 * expo-notifications, and an unused background mode is something App Review
 * asks about.
 */

import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';
import {
    getDroverWatchStatus,
    isDroverWatchAvailable,
    publishDroverSnapshot,
} from 'drover-watch';
import { collectAccounts, collectGates, collectSessions } from './droverWatchFeed';
import { storage } from './storage';

export const DROVER_BG_TASK = 'drover-background-wake';

/**
 * Push what the phone currently knows to the wrist, and nothing else.
 *
 * The iOS background execution budget for a content-available push is seconds,
 * so this does no network work: it reads the store the app already holds and
 * hands one WatchConnectivity application context over. Anything that waits on
 * a socket belongs in the foreground feed.
 *
 * It duplicates the publish inside `startDroverWatchFeed` rather than calling
 * it because that one lives in a closure with the feed's change-detection
 * state, and this path must publish unconditionally — the wrist is stale by
 * definition or the wake would not have been sent. Collapse the two the day
 * droverWatchFeed exports a republish of its own.
 */
async function republishWatchSnapshot(): Promise<boolean> {
    if (!isDroverWatchAvailable()) return false;

    // An empty store means "not hydrated yet", not "nothing is pending". The
    // watch REPLACES its snapshot with whatever arrives (GateStore.apply in
    // watch/DroverWatch/Model/GateStore.swift assigns `snapshot = decoded`), so
    // publishing an empty one on a cold background launch would clear the wrist
    // of the very gate the wake was announcing. A store with sessions in it and
    // no gates is a real all-clear and does get published — that is what a
    // gate-resolved wake is for.
    const sessions = storage.getState().sessions;
    if (!sessions || Object.keys(sessions).length === 0) return false;

    const watchSessions = collectSessions();
    const status = getDroverWatchStatus();
    return publishDroverSnapshot({
        gates: collectGates(),
        sessions: watchSessions,
        accounts: collectAccounts(watchSessions),
        updatedAt: new Date().toISOString(),
        connected: !!status.activated && status.paired && status.installed,
    });
}

// iOS only. drover-watch is a watchOS bridge with no counterpart on Android or
// web, so a task registered there would wake the app to publish into nothing.
if (Platform.OS === 'ios') {
    TaskManager.defineTask<Notifications.NotificationTaskPayload>(
        DROVER_BG_TASK,
        async ({ error }) => {
            if (error) return Notifications.BackgroundNotificationTaskResult.Failed;
            // The payload is not inspected. Every remote notification this app
            // receives means a gate changed — the alert for a raise, the silent
            // wake for either — and the republish is the same work in both
            // cases. Reading `data.dataString` to decide would only add a way
            // to get it wrong.
            const published = await republishWatchSnapshot();
            return published
                ? Notifications.BackgroundNotificationTaskResult.NewData
                : Notifications.BackgroundNotificationTaskResult.NoData;
        },
    );

    // Registration is per launch and cheap. It throws where the native module
    // is absent (Expo Go, or any build without the notifications plugin), and a
    // wrist that cannot be fed is not worth failing a launch over.
    void Notifications.registerTaskAsync(DROVER_BG_TASK).catch(() => {});
}
