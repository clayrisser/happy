/**
 * The banner that can be answered, wired up (DROVE-207).
 *
 * Three side effects, all of them at MODULE scope and imported from index.ts
 * before expo-router, for the same reason droverBackgroundNotification.ts is:
 * iOS delivers a notification-action response by launching the bundle WITHOUT
 * mounting the React tree, so anything registered from a component effect does
 * not exist at the moment the response arrives. That is the difference between
 * "answer from the lock screen with the app killed" and "answer, but only if
 * the app happened to be running".
 *
 *   1. REGISTER the categories, so iOS has buttons to draw.
 *   2. LISTEN for a button press, queue the answer, and deliver it.
 *   3. DISMISS a banner whose gate is already settled, so the lock screen
 *      never offers buttons for a decision somebody else already made.
 *
 * The tap is NOT handled here. `_layout.tsx` routes the default action, and
 * the one button that is a tap by another name ("More in the app"), to the
 * gate through notificationRouting.ts (DROVE-94). Every ANSWERING button is
 * this file's, and every button whose job is to open something is that one's,
 * so the two listeners never act on the same press.
 *
 * Every import that pulls in the sync engine is DYNAMIC. A headless launch
 * that only has to write one answer should not evaluate the whole app graph
 * to get there, and the module has to load even where the notification native
 * module is absent (web, Expo Go).
 */

import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { gateNotificationCategories } from './droverNotificationCategories';
import {
    enqueueGateAnswer,
    forgetGateAnswer,
    gateAnswerCall,
    parseGateNotificationAction,
    pendingGateAnswers,
    type GateNotificationAnswer,
} from './droverNotificationAnswer';
import { storage } from './storage';
import { collectGateEntries } from './droverGates';

/** How long to wait for the socket before giving up and leaving it queued. */
const CONNECT_TIMEOUT_MS = 12000;

/**
 * How stale a banner has to be before an absent gate is taken as proof it was
 * settled rather than proof the card has not synced yet.
 *
 * The push and the card race: the alert goes direct to Expo while the card
 * travels through the session sync, so a banner one second old whose gate is
 * not in the store is normal. A banner a minute old whose gate is not in the
 * store is a decision somebody already made somewhere else.
 */
const STALE_BANNER_MS = 60000;

let started = false;
let delivering = false;

function log(line: string): void {
    console.log(`[drover-actions] ${line}`);
}

/**
 * Tell iOS what buttons each category has.
 *
 * Registration is per launch and idempotent. It throws where the native module
 * is absent, and a banner without buttons is not worth failing a launch over —
 * the tap still opens the gate, which is exactly the behaviour that shipped
 * before this file.
 */
export async function registerDroverNotificationCategories(): Promise<number> {
    if (Platform.OS === 'web') return 0;
    let registered = 0;
    for (const category of gateNotificationCategories()) {
        try {
            await Notifications.setNotificationCategoryAsync(
                category.identifier,
                category.actions.map((action) => ({
                    identifier: action.identifier,
                    buttonTitle: action.buttonTitle,
                    options: {
                        isDestructive: action.options.isDestructive,
                        isAuthenticationRequired: action.options.isAuthenticationRequired,
                        opensAppToForeground: action.options.opensAppToForeground,
                    },
                }))
            );
            registered++;
        } catch (error) {
            log(`category ${category.identifier} not registered: ${String(error)}`);
        }
    }
    log(`${registered} notification categories registered`);
    return registered;
}

/**
 * Bring the sync engine up far enough to send one RPC, without the UI.
 *
 * `syncRestore` is a plain async function rather than a hook, which is what
 * makes this possible at all, and it guards itself against a second call — so
 * a background launch that initialises sync and then goes on to mount the UI
 * does not initialise twice.
 *
 * Returns false when there is nothing to connect with (signed out) or the
 * socket never came up inside the budget. The answer stays queued either way.
 */
async function ensureSyncForAnswer(): Promise<boolean> {
    const ready = () =>
        storage.getState().isDataReady && storage.getState().socketStatus === 'connected';
    if (ready()) return true;

    try {
        const { TokenStorage } = await import('@/auth/tokenStorage');
        const credentials = await TokenStorage.getCredentials();
        if (!credentials) {
            log('no credentials; the answer stays queued for the next launch');
            return false;
        }
        const { syncRestore } = await import('./sync');
        await syncRestore(credentials);
    } catch (error) {
        log(`could not start sync headlessly: ${String(error)}`);
        return false;
    }

    const deadline = Date.now() + CONNECT_TIMEOUT_MS;
    while (Date.now() < deadline) {
        if (ready()) return true;
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    log('socket did not come up in time; the answer stays queued');
    return false;
}

async function sendOne(answer: GateNotificationAnswer): Promise<void> {
    const call = gateAnswerCall(answer);
    const { sessionAllow, sessionDeny } = await import('./ops');
    if (call.call === 'deny') {
        await sessionDeny(call.sessionId, call.requestId);
        return;
    }
    if (call.call === 'allow') {
        await sessionAllow(call.sessionId, call.requestId, undefined, undefined, undefined, call.updatedInput);
        return;
    }
    await sessionAllow(
        call.sessionId,
        call.requestId,
        undefined,
        undefined,
        'approved',
        call.updatedInput
    );
}

/**
 * Send everything queued, oldest first, and forget each one the moment it is
 * acknowledged.
 *
 * A failed send is LEFT queued on purpose. The bus is the arbiter of who won
 * the race, so a late answer for a gate somebody else already settled costs a
 * 409 and nothing else — which is a far cheaper failure than an answer that
 * evaporated because the phone had no signal at the moment of the tap.
 */
export async function deliverPendingGateAnswers(): Promise<void> {
    // THREE things call this — the launch, the button press, and the socket
    // coming up — and two of them can land inside the twelve seconds the first
    // spends waiting for a connection. Without this the same queued answer is
    // read twice and sent twice, which is the local double-answer this file
    // exists to prevent.
    if (delivering) return;
    const queued = pendingGateAnswers();
    if (queued.length === 0) return;
    delivering = true;
    try {
        log(`${queued.length} queued answer(s) to deliver`);
        if (!(await ensureSyncForAnswer())) return;
        for (const answer of queued) {
            try {
                await sendOne(answer);
                forgetGateAnswer(answer.gateId);
                log(`answered ${answer.kind} ${answer.gateId} with ${answer.optionId} from the banner`);
            } catch (error) {
                log(`answer for ${answer.gateId} not delivered, still queued: ${String(error)}`);
            }
        }
    } finally {
        delivering = false;
    }
}

/**
 * One button press.
 *
 * Written to disk BEFORE anything is sent, and the write is what makes the
 * answer survive the process dying a second later. Exported so a spec can
 * drive it with a fabricated response.
 */
export async function handleGateNotificationAction(response: unknown): Promise<void> {
    const answer = parseGateNotificationAction(response);
    if (!answer) return;
    if (!enqueueGateAnswer(answer)) {
        log(`${answer.gateId} is already queued; this tap changes nothing`);
        return;
    }
    log(`queued ${answer.kind} ${answer.gateId} -> ${answer.optionId}`);
    await deliverPendingGateAnswers();
}

/**
 * Take down a banner whose gate is settled.
 *
 * The other half of "every surface drops it". The card, the wrist and the gum
 * popup all retire on the bus's terminal broadcast; a delivered iOS
 * notification does not, so a lock screen would go on offering Allow and Deny
 * for a gate answered in the terminal ten minutes ago. Tapping one is harmless
 * — the bus answers 409 — but a banner that lies about what is waiting is the
 * thing this whole layer exists to stop.
 *
 * Two ways in, and both are needed. A gate this process WATCHED go from
 * pending to gone is dismissed at once. A gate that was never pending here,
 * because the app was not running when it was answered, is dismissed once its
 * banner is old enough that the alternative — a card that simply has not
 * synced yet — is no longer plausible.
 *
 * It carries the queue's retry too, because it is already the one place
 * watching the store: an answer that could not be sent at the moment of the
 * tap goes out when the socket comes up rather than waiting for a relaunch.
 */
export function startDroverBannerCleanup(): () => void {
    if (Platform.OS === 'web') return () => {};
    let known = new Set<string>();

    /**
     * `live` is what the store says is still pending; `watched` is what this
     * process has seen pending at any point. A banner is taken down when its
     * gate is not live AND either this process watched it go away, or the
     * banner is old enough that "the card has not synced yet" is no longer a
     * plausible explanation.
     */
    const sweep = async (live: Set<string>, watched: Set<string>) => {
        try {
            const presented = await Notifications.getPresentedNotificationsAsync();
            if (presented.length === 0) return;
            const now = Date.now();
            for (const notification of presented) {
                const data = notification.request.content.data as Record<string, unknown> | undefined;
                const gateId = typeof data?.gateId === 'string' ? data.gateId : '';
                if (!gateId || live.has(gateId)) continue;
                // `date` is seconds on iOS and milliseconds on Android. Both
                // are far in the past for a stale banner, so normalising is
                // only about not mistaking a fresh one for an old one.
                const at = notification.date > 1e12 ? notification.date : notification.date * 1000;
                if (!watched.has(gateId) && now - at < STALE_BANNER_MS) continue;
                await Notifications.dismissNotificationAsync(notification.request.identifier);
                log(`dismissed the banner for settled gate ${gateId}`);
            }
        } catch (error) {
            log(`banner sweep failed: ${String(error)}`);
        }
    };

    let swept = false;
    let connected = false;

    const same = (a: Set<string>, b: Set<string>) =>
        a.size === b.size && [...a].every((id) => b.has(id));

    const check = () => {
        const state = storage.getState();

        // A queued answer that could not be sent — no signal at the moment of
        // the tap — goes out the moment the socket comes up, rather than
        // waiting for the next launch. Edge-triggered: the store publishes on
        // every message, and re-sending on each of those would be a flood.
        const nowConnected = state.socketStatus === 'connected';
        if (nowConnected && !connected) void deliverPendingGateAnswers();
        connected = nowConnected;

        if (!state.isDataReady) return;
        const live = new Set(
            collectGateEntries(state.sessions ?? {}).map((entry) => entry.requestId)
        );
        // The store publishes on every streamed token. Asking iOS for the
        // presented notifications that often would be a native round trip per
        // character, so the sweep runs only when the pending set actually
        // moved — and once at the start, which is the cold launch where the
        // stale banners are.
        if (swept && same(live, known)) return;
        swept = true;
        void sweep(live, known);
        known = live;
    };

    const unsubscribe = storage.subscribe(check);
    check();
    return () => {
        unsubscribe();
        known = new Set();
        swept = false;
        connected = false;
    };
}

/**
 * Arm everything. Idempotent, and safe to call from module scope.
 *
 * The listener is attached FIRST. expo-notifications holds a response that
 * arrived before any listener existed and delivers it on subscribe, so
 * attaching before the awaits below is what catches the launch that a button
 * press caused.
 */
export function startDroverNotificationActions(): void {
    if (started) return;
    if (Platform.OS === 'web') return;
    started = true;

    try {
        Notifications.addNotificationResponseReceivedListener((response) => {
            void handleGateNotificationAction(response);
        });
    } catch (error) {
        log(`could not listen for notification actions: ${String(error)}`);
        started = false;
        return;
    }

    void registerDroverNotificationCategories();
    startDroverBannerCleanup();
    // Anything queued by a tap the last launch could not deliver. Fire and
    // forget: a launch must never wait on the network to show a screen.
    void deliverPendingGateAnswers();
}

if (Platform.OS === 'ios' || Platform.OS === 'android') {
    startDroverNotificationActions();
}
