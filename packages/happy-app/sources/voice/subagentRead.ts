import type { Message } from '@/sync/typesMessage';
import type { ReadAloudDetourSentence } from './readAloud';
import { sameSentence } from './sentenceMatch';
import { speakableChunks } from './speakable';

/**
 * Turning a tap on a SUBAGENT's sentence into something the reader can say
 * (DROVE-195).
 *
 * Clay: "if you go to a subagent and tap a sentence from it while I'm in
 * reading mode it will read it."
 *
 * The agent screen draws a transcript the reader has never seen. It arrives
 * over its own RPC poll (DROVE-93) and is published for the rows under it
 * (DROVE-166); it is never in `storage.sessionMessages` and so never reaches
 * `readAloud.onMessages`. That is why the tap could not work before and why it
 * cannot be made to work by seeking: there is nothing in the timeline to seek
 * to. What the reader needs is the sentences themselves.
 *
 * So this is the same two steps the session's tap takes, done against a
 * transcript held somewhere else: cut the messages into the sentences the
 * speaker would have said, then find the one under the finger. Same splitter,
 * same matcher, so a tap on an agent's reply resolves exactly as a tap on the
 * session's does.
 *
 * FROM THE TAP TO THE END, not just the one sentence. Tapping in the session
 * means "start reading here", and an agent's transcript is a transcript: the
 * gesture has to mean the same thing on both screens or it is two gestures
 * that look alike.
 */

/** Every sentence a subagent transcript is worth, in the order it was written. */
export function subagentSentences(messages: readonly Message[]): ReadAloudDetourSentence[] {
    const ordered = [...messages].sort((a, b) => a.createdAt - b.createdAt);
    const out: ReadAloudDetourSentence[] = [];
    for (const message of ordered) {
        for (const text of speakableChunks(message)) {
            out.push({ messageId: message.id, text, createdAt: message.createdAt });
        }
    }
    return out;
}

/**
 * The tapped sentence and everything after it, or an empty list.
 *
 * Three answers, narrowest first, and each is the fallback for the one above:
 *
 *   1. The sentence itself.
 *   2. The top of the tapped MESSAGE, when the renderer and the splitter
 *      disagree about where that sentence ended. DROVE-146's behaviour, which
 *      is the worst case of a failed hit test everywhere else too.
 *   3. The first prose at or after the tapped message's place in the
 *      transcript, when the message has no prose of its own. A thinking block
 *      is the case that matters: it is drawn with sentence targets on an agent
 *      screen exactly as in the session, and a target that does nothing is the
 *      failure this ticket was filed about. Same rule as `seekTo`: start from
 *      the first sayable thing at or after here.
 *
 * Empty means there is genuinely nothing left to read — the row is the last
 * thing in the transcript and it is not prose. That is nothing to say, not a
 * refusal, and the caller leaves the voice where it is rather than inventing a
 * position for it.
 */
export function subagentDetourFrom(
    messages: readonly Message[],
    messageId: string,
    sentence: string,
): ReadAloudDetourSentence[] {
    const all = subagentSentences(messages);
    let block = -1;
    for (let i = 0; i < all.length; i++) {
        if (all[i].messageId !== messageId) continue;
        if (block === -1) block = i;
        if (sameSentence(all[i].text, sentence)) return all.slice(i);
    }
    if (block !== -1) return all.slice(block);

    const tapped = messages.find((message) => message.id === messageId);
    if (tapped === undefined) return [];
    const after = all.findIndex((at) => at.createdAt >= tapped.createdAt);
    return after === -1 ? [] : all.slice(after);
}
