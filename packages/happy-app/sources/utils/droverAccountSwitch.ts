/**
 * Switching a session onto another account, from wherever it is asked for
 * (DROVE-160).
 *
 * There is one mechanism and there must not be a second: happy-cli parses
 * `/flip` out of the message stream before the queue, so the move is an
 * ordinary chat message (utils/droverAccounts.ts). DROVE-28 built it, DROVE-137
 * reached it from the session info screen, the watch sends the identical
 * string, and now the quota sheet sends it too. That is four surfaces, so the
 * confirm and the send live here rather than being written out a fourth time
 * in the sheet.
 *
 * `flip` stays the internal name everywhere below the UI: it is the CLI's
 * command and the wire word. The USER only ever reads "switch".
 */
import { Modal } from '@/modal';
import { storage } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import { droverFlipMessage } from '@/utils/droverAccounts';
import { flipRiskWarning, sessionsLosingRemoteControl } from '@/utils/droverSessionAccount';
import { getSessionName } from '@/utils/sessionUtils';

/** Fire and forget: a refused switch is answered in the transcript, not here. */
export function sendDroverSwitch(sessionId: string, account?: string | null): void {
    void Promise.resolve(sync.sendMessage(sessionId, droverFlipMessage(account))).catch(() => {});
}

/**
 * DROVE-37's sentence, read from the store at press time rather than
 * subscribed: the callers run once per row in the session lists, and a list of
 * every session per row is a real cost for a sentence nobody sees until they
 * tap. Null when nothing else is at risk.
 */
export function droverSwitchRiskWarning(sessionId: string, account: string | null): string | null {
    const state = storage.getState();
    const sessions = state.isDataReady
        // Side chats are hidden children of a session, not panes of their own,
        // so they are not sessions that can lose Remote Control.
        ? Object.values(state.sessions).filter((s) => !s.metadata?.isSideChat)
        : [];
    return flipRiskWarning(
        sessionsLosingRemoteControl({
            sessions,
            selfId: sessionId,
            target: account,
            nameOf: getSessionName,
        }),
        account,
    );
}

export type DroverSwitchRequest = {
    sessionId: string;
    /** Where it is going; null asks the CLI for the next account with headroom. */
    account: string | null;
    /** The account it is on, for the sentence. Null when nothing stamped it. */
    from?: string | null;
    /**
     * Ask even when nothing else is at risk. The quota sheet sets this: a tap
     * on a block in a column of five while reading bars is easy to get wrong,
     * and a switch is not undoable in one gesture — reversing it is a second
     * full teardown and relaunch. One alert before beats two switches after.
     * The menu leaves it off, because it has already asked which account.
     */
    always?: boolean;
};

/**
 * Confirm, then send. Never blocks: a switch is usually asked for BECAUSE an
 * account ran out, so refusing one would strand the session that asked.
 */
export function confirmDroverSwitch(req: DroverSwitchRequest): void {
    const warning = droverSwitchRiskWarning(req.sessionId, req.account);
    if (!warning && !req.always) {
        sendDroverSwitch(req.sessionId, req.account);
        return;
    }
    const title = warning
        ? 'Other sessions will go quiet'
        : req.account
            ? `Switch to ${req.account}?`
            : 'Switch account?';
    const body = warning
        ?? (req.from ? `This session moves off ${req.from}.` : undefined);
    const confirm = warning
        ? (req.account ? `Switch to ${req.account}` : 'Switch anyway')
        : 'Switch';
    // Next tick: this runs from the account picker's or the sheet's own press
    // handler, so that surface is still tearing down. Presenting straight into
    // that is the classic way a second alert never appears at all.
    setTimeout(() => {
        Modal.alert(title, body, [
            { text: t('common.cancel'), style: 'cancel' },
            { text: confirm, onPress: () => sendDroverSwitch(req.sessionId, req.account) },
        ]);
    }, 0);
}
