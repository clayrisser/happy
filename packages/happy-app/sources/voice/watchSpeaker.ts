import { sendDroverWatchVoice } from 'drover-watch';
import type { SpeechEngine } from './readAloud';

/**
 * The watch as a speech engine, seen from the phone (DROVE-92).
 *
 * The read-aloud queue speaks one sentence at a time and waits for each to
 * settle before the next, and that pacing is what makes stopping land
 * mid-sentence and skip-ahead work at all. So a sentence sent to the wrist
 * carries an id, the wrist speaks it with its own AVSpeechSynthesizer and
 * answers `{kind:"spoken", id}` when the utterance ends, and the promise
 * here settles on that answer. An answer that never comes (the watch went
 * out of reach mid-sentence) settles on a deadline scaled to the text, so
 * one lost acknowledgement cannot wedge every later sentence.
 *
 * `sendMessage` reaches only a frontmost watch. When it does not, the send
 * resolves false and the queue hears "over", which is the same thing a cut
 * utterance says; the speaker pick happens per sentence, so the next one
 * goes to the phone.
 */

/** Milliseconds allowed per character before an unacknowledged sentence is written off. */
const msPerCharacter = 90;
const minimumDeadlineMs = 3_000;
const maximumDeadlineMs = 60_000;

interface Pending {
    settle: (finished: boolean) => void;
    timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, Pending>();
let counter = 0;
/** What the wrist last said about its route. False until it says. */
let headphones = false;

export function watchRouteHasHeadphones(): boolean {
    return headphones;
}

/** The wrist's audio route, as the feed forwards it (DROVE-92). */
export function setWatchRoute(hasHeadphones: boolean): void {
    headphones = hasHeadphones;
}

/** Deadline for an unacknowledged sentence; exported for the tests. */
export function watchSpeakDeadlineMs(text: string): number {
    return Math.min(maximumDeadlineMs, Math.max(minimumDeadlineMs, text.length * msPerCharacter));
}

function settle(id: string, finished: boolean): void {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    entry.settle(finished);
}

/** The wrist finished or cut a sentence; called by the feed's onSpoken listener. */
export function settleWatchUtterance(id: string, finished: boolean): void {
    settle(id, finished);
}

function settleAll(): void {
    for (const id of [...pending.keys()]) settle(id, false);
}

/**
 * Send one sentence to the wrist and resolve when it has been spoken, cut, or
 * written off. False when nothing was sent, so the caller can speak it itself.
 */
export async function speakOnWatch(text: string): Promise<boolean> {
    counter += 1;
    const id = `${Date.now().toString(36)}-${counter}`;
    const spoken = new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => settle(id, false), watchSpeakDeadlineMs(text));
        pending.set(id, { settle: resolve, timer });
    });
    const sent = await sendDroverWatchVoice({ kind: 'speak', id, text });
    if (!sent) {
        settle(id, false);
        return false;
    }
    return spoken;
}

/** Cut whatever the wrist is speaking, and write off every sentence in flight. */
export async function stopWatchSpeech(): Promise<void> {
    settleAll();
    await sendDroverWatchVoice({ kind: 'speak', stop: true });
}

/**
 * The reply-start haptic (DROVE-62's cue path, DROVE-92): the wrist buzzes
 * once when a reply begins to be spoken, whichever device speaks it, so a
 * silent watch still tells the wrist a reply began.
 */
export function cueWatchReplyStart(): void {
    void sendDroverWatchVoice({ kind: 'cue', cue: 'reply' });
}

/** The wrist as a SpeechEngine, for the routed engine to hand sentences to. */
export const watchSpeechEngine: SpeechEngine = {
    speak: speakOnWatch,
    stop: stopWatchSpeech,
};
