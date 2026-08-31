/**
 * Turning a tap on a notification button into a bus answer (DROVE-207).
 *
 * Two halves, kept apart so the decision is testable without a phone:
 *
 *   PARSE   `parseGateNotificationAction` reads the response iOS hands back and
 *           says which option was chosen, or null when this tap is not one of
 *           ours. Pure.
 *   QUEUE   the answer is written to disk BEFORE anything is sent, and removed
 *           only when the send is acknowledged. That is what makes it survive a
 *           cold app: iOS gives a background action handler seconds, not a
 *           guarantee, and an answer lost between the tap and the socket is an
 *           agent left blocked with a banner that says it was answered.
 *
 * SINGLE RESOLUTION, and this is the rule the whole eyes-free layer already
 * runs on rather than a second one invented here. The BUS is the arbiter: the
 * first resolve wins, the loser gets 409, and the terminal frame it broadcasts
 * is what dismisses the card on the phone, the wrist and the popup
 * (DROVE-198's watcher cancels the event when the terminal answers, and
 * droverBridge's removeCard retires the card when it does). This file adds one
 * local guarantee on top: a gate is queued AT MOST ONCE, keyed by its id, so a
 * double tap or a re-delivered response cannot become two sends. Everything
 * beyond that is the bus's 409, which is why a stale banner is safe to tap.
 */

import { MMKV } from 'react-native-mmkv';

import { slotForActionIdentifier } from './droverNotificationCategories';

const mmkv = new MMKV();
const QUEUE_KEY = 'drover-gate-answers-v1';

/** How long a queued answer is still worth sending. */
const ANSWER_TTL_MS = 6 * 60 * 60 * 1000;

/** One tap, in the shape the delivery needs. */
export interface GateNotificationAnswer {
    /** The bus event id, which is also the request id on the card. */
    gateId: string;
    /** The session HOLDING the card — the bridge session, not the raising one. */
    sessionId: string;
    /** The bus option id this button answers with. */
    optionId: string;
    /** The bus kind, so a permission is answered as one and a question as one. */
    kind: 'permission' | 'question' | 'todo';
    /** When the button was pressed. */
    at: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
}

function parseJson(value: string): unknown {
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

/**
 * The push payload, whichever way it arrived.
 *
 * Expo delivers `data` as an object on iOS and, on some paths, as a JSON
 * string; notificationRouting.ts already normalises the same way for the tap
 * route, and a banner button must not be pickier than a tap.
 */
function notificationData(response: unknown): Record<string, unknown> | null {
    const content = asRecord(
        asRecord(asRecord(asRecord(response)?.notification)?.request)?.content
    );
    const raw = content?.data;
    if (typeof raw === 'string') return asRecord(parseJson(raw));
    return asRecord(raw);
}

function stringField(data: Record<string, unknown>, key: string): string {
    const value = data[key];
    return typeof value === 'string' ? value.trim() : '';
}

/**
 * The option ids each button slot answers with, as the CLI packed them.
 *
 * A JSON array of strings. An empty string is a slot that answers nothing —
 * the "More in the app" button on an overflowing gate.
 */
export function actionsFromData(data: Record<string, unknown>): string[] {
    const raw = data.actions;
    const parsed = typeof raw === 'string' ? parseJson(raw) : raw;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((entry) => (typeof entry === 'string' ? entry : ''));
}

function kindFromData(data: Record<string, unknown>): 'permission' | 'question' | 'todo' {
    const kind = stringField(data, 'kind');
    return kind === 'question' || kind === 'todo' ? kind : 'permission';
}

/**
 * Which option a notification response chose, or null when it chose none.
 *
 * Null covers every non-answer: the default tap (which notificationRouting.ts
 * routes instead), a dismiss, the More button, a slot the payload has no
 * option for, and a push from before this feature that carries no `actions` at
 * all. Returning null rather than guessing is the point — an answer invented
 * from an ambiguous tap resolves a gate nobody decided.
 */
export function parseGateNotificationAction(
    response: unknown,
    at: number = Date.now()
): GateNotificationAnswer | null {
    const slot = slotForActionIdentifier(asRecord(response)?.actionIdentifier);
    if (slot === null) return null;

    const data = notificationData(response);
    if (!data) return null;

    const gateId = stringField(data, 'gateId');
    // The session HOLDING the card. `sessionId` on the payload is the session
    // that RAISED the gate (DROVE-94) and answering it would address the RPC
    // to an agent that has no such request.
    const sessionId = stringField(data, 'answerSessionId');
    if (!gateId || !sessionId) return null;

    const optionId = actionsFromData(data)[slot] ?? '';
    if (!optionId) return null;

    return { gateId, sessionId, optionId, kind: kindFromData(data), at };
}

function readQueue(): GateNotificationAnswer[] {
    const raw = mmkv.getString(QUEUE_KEY);
    if (!raw) return [];
    const parsed = parseJson(raw);
    if (!Array.isArray(parsed)) return [];
    const out: GateNotificationAnswer[] = [];
    for (const entry of parsed) {
        const record = asRecord(entry);
        if (!record) continue;
        const gateId = typeof record.gateId === 'string' ? record.gateId : '';
        const sessionId = typeof record.sessionId === 'string' ? record.sessionId : '';
        const optionId = typeof record.optionId === 'string' ? record.optionId : '';
        const kind = record.kind;
        const at = typeof record.at === 'number' ? record.at : 0;
        if (!gateId || !sessionId || !optionId) continue;
        if (kind !== 'permission' && kind !== 'question' && kind !== 'todo') continue;
        out.push({ gateId, sessionId, optionId, kind, at });
    }
    return out;
}

function writeQueue(entries: GateNotificationAnswer[]): void {
    if (entries.length === 0) {
        mmkv.delete(QUEUE_KEY);
        return;
    }
    mmkv.set(QUEUE_KEY, JSON.stringify(entries));
}

/**
 * Record an answer, at most once per gate.
 *
 * Returns false when this gate is already queued, which is the local half of
 * single resolution: a double tap on the same banner, or a response iOS
 * re-delivers after a background launch, must not become two sends.
 */
export function enqueueGateAnswer(answer: GateNotificationAnswer, now: number = Date.now()): boolean {
    const fresh = readQueue().filter((entry) => now - entry.at < ANSWER_TTL_MS);
    if (fresh.some((entry) => entry.gateId === answer.gateId)) {
        writeQueue(fresh);
        return false;
    }
    writeQueue([...fresh, answer]);
    return true;
}

export function pendingGateAnswers(now: number = Date.now()): GateNotificationAnswer[] {
    return readQueue().filter((entry) => now - entry.at < ANSWER_TTL_MS);
}

/** Forget one answer, once the RPC for it was acknowledged. */
export function forgetGateAnswer(gateId: string): void {
    writeQueue(readQueue().filter((entry) => entry.gateId !== gateId));
}

/** Only for the specs, and for a signed-out app with nothing to deliver to. */
export function clearGateAnswers(): void {
    mmkv.delete(QUEUE_KEY);
}

/**
 * How one answer is sent, split out so the spec can assert the SHAPE without a
 * socket.
 *
 * A permission is allowed or denied, because that is what `busResolutionFor`
 * reads for that kind — the bus injects [{allow},{deny}] and the bridge's Bash
 * card carries no options, so an `optionId` on a permission would be ignored
 * and the answer would come out as a bare allow whichever button was pressed.
 * A question and a to-do are answered by NAMING the option, because those two
 * kinds refuse anything else: a question resolves with `action: option` or
 * not at all, and a to-do that could be closed by a generic approve is what
 * DROVE-69 fixed.
 *
 * `via: 'push'` is stamped on every one so the bus ledger says which surface
 * answered. Without it a banner tap is indistinguishable from a thumb on the
 * app, and "which surface won the race" is the one question the ledger exists
 * to answer.
 */
export type GateAnswerCall =
    | { call: 'allow'; sessionId: string; requestId: string; updatedInput: Record<string, unknown> }
    | { call: 'deny'; sessionId: string; requestId: string }
    | {
          call: 'answer';
          sessionId: string;
          requestId: string;
          updatedInput: Record<string, unknown>;
      };

export function gateAnswerCall(answer: GateNotificationAnswer): GateAnswerCall {
    const via = { via: 'push', channel: 'visual' };
    if (answer.kind === 'permission') {
        if (answer.optionId === 'deny') {
            return { call: 'deny', sessionId: answer.sessionId, requestId: answer.gateId };
        }
        return {
            call: 'allow',
            sessionId: answer.sessionId,
            requestId: answer.gateId,
            updatedInput: via,
        };
    }
    return {
        call: 'answer',
        sessionId: answer.sessionId,
        requestId: answer.gateId,
        updatedInput: { optionId: answer.optionId, ...via },
    };
}
