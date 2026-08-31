import type { DroverGateEntry } from '@/sync/droverGates';

/**
 * A gate waiting on Clay is SPOKEN, not merely beeped (DROVE-188).
 *
 * Clay, with a screenshot of an unanswered permission card and eight agents
 * running: "Why are you not making sounds for every tool call and agent spawn
 * and question that comes in. When a question comes in you need to read it to
 * me."
 *
 * This is the point of the whole eyes-free layer, and it is the one place a
 * cue is not enough. A cue says SOMETHING happened. Only speech says WHAT is
 * waiting and whether it matters, and permission to run `git diff` and
 * permission to run `rm -rf /` are the same beep.
 *
 * WHAT IS SAID, and this is judgement rather than a payload dump:
 *
 *   - The KIND. "Permission to", "Question", "Needs you". It is the first
 *     thing said because it decides how urgently he has to look.
 *   - Enough SUBSTANCE to decide. The tool and the gist of what it wants,
 *     summarised the way the card's own title summarises it. `git diff` is
 *     worth saying; the 200-character path it writes to is not, so the
 *     preview is cut at a phrase rather than read out whole.
 *   - The SESSION it came from, last, because several run at once and the
 *     answer depends on which — but it is the least urgent half of the
 *     sentence, so it goes at the end where it can be talked over.
 *   - The OPTIONS, only when there are more than the two everything has. Two
 *     options are allow and deny and saying so every time is noise.
 *
 * WHAT IS NOT SAID: the reason line, the full command, the arguments, the
 * request id. All of them are on the card, which is one glance away, and none
 * of them can be held in the head while a voice reads them out.
 *
 * REMINDERS. A gate is spoken ONCE (DROVE-126). One reminder follows if it is
 * still unanswered after `reminderAfterMs`, and then never again. The reason
 * for exactly one: the failure this ticket describes is a gate going unheard,
 * and the failure a loop creates is Clay switching read-aloud off, which
 * loses every gate after it. One repeat covers the case where the first line
 * was missed under a mic press or a passing bus; a second repeat only ever
 * teaches him to ignore the voice. The waiting HEARTBEAT is already the thing
 * that repeats forever, and it costs nothing to keep hearing.
 *
 * Pure, apart from the small amount of memory a "once" needs. The service
 * drives it; nothing here touches the reader, storage or the clock.
 */

/** One reminder, this long after the first line, and then silence. */
export const gateReminderAfterMs = 60_000;

/** Long enough to name a command, short enough not to be a paragraph. */
const substanceLimit = 60;

/** One line to say about one gate, and the key that cancels it. */
export interface GateUtterance {
    /** `${sessionId}:${requestId}`, which is the gate's own id. */
    key: string;
    text: string;
}

function tidy(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
}

/**
 * The gist of what a gate wants, cut at a word.
 *
 * A path or a command longer than the limit is truncated rather than
 * summarised, because there is nothing intelligent to say about the tail of a
 * path and pretending otherwise would invent detail. The card has the whole
 * of it.
 */
export function gateSubstance(entry: DroverGateEntry): string {
    const raw = tidy(entry.gate.preview || entry.gate.title || '');
    if (raw.length === 0) return '';
    if (raw.length <= substanceLimit) return raw;
    return `${raw.slice(0, substanceLimit).replace(/\s\S*$/, '')}, and more`;
}

/** How a kind opens the sentence. */
function opening(entry: DroverGateEntry): string {
    switch (entry.gate.kind) {
        case 'question': return 'Question';
        case 'todo': return 'Needs you';
        default: return 'Permission';
    }
}

/**
 * The one line for a gate.
 *
 * `sessionName` is what the session is CALLED on screen — a lane name, a
 * folder — and is left out when there is nothing better than an id to say.
 * Reading a uuid aloud is worse than saying nothing.
 */
export function gateSpeechLine(entry: DroverGateEntry, sessionName: string | null): string {
    const parts: string[] = [];
    const substance = gateSubstance(entry);
    const title = tidy(entry.gate.title || '');

    if (entry.gate.kind === 'question') {
        parts.push(substance.length > 0 ? `Question: ${substance}` : 'A question is waiting');
    } else if (entry.gate.kind === 'todo') {
        parts.push(substance.length > 0 ? `Needs you: ${substance}` : 'Something needs you');
    } else {
        // `title` on a permission is "Run Bash"; the preview is the command.
        // Both together is how the card reads and how a person would say it.
        const what = substance.length > 0
            ? (title.length > 0 ? `${title}, ${substance}` : substance)
            : title;
        parts.push(what.length > 0 ? `Permission to ${what}` : 'A permission is waiting');
    }

    // Only when there is a real choice to make. Two options are allow and
    // deny, which he already knows.
    const options = entry.gate.options ?? [];
    if (options.length > 2) {
        parts.push(`${options.length} options`);
    }

    if (sessionName !== null && sessionName.length > 0) {
        parts.push(`in ${sessionName}`);
    }

    const line = parts.join(', ');
    return line.endsWith('.') ? line : `${line}.`;
}

/** Kinds this speaks. `expiry` and `idle` are not decisions he has to make. */
function speakable(entry: DroverGateEntry): boolean {
    return entry.gate.kind === 'permission'
        || entry.gate.kind === 'question'
        || entry.gate.kind === 'todo';
}

/**
 * The memory that makes "spoken once, with one reminder" true.
 *
 * One instance per focused session; `reset()` when focus moves, because
 * another session's gates were never this session's to speak.
 */
export class GateSpeechTracker {
    /** When each gate was first spoken. */
    private said = new Map<string, number>();
    /** Which gates have had their one reminder. */
    private reminded = new Set<string>();

    reset(): void {
        this.said.clear();
        this.reminded.clear();
    }

    /** Gates currently owed a line, for the tests. */
    get spokenCount(): number {
        return this.said.size;
    }

    /**
     * What to say about this session's gates now, and what to un-say.
     *
     * `gone` is every key that has stopped being pending since the last look:
     * answered, dismissed or expired. The caller cancels any speech still
     * queued under those keys, which is the acceptance criterion "answering it
     * cancels any pending speech about it" — a gate answered in the two
     * seconds between arriving and being reached is never read out.
     */
    observe(entries: readonly DroverGateEntry[], at: number): {
        say: GateUtterance[];
        gone: string[];
        } {
        const live = new Set<string>();
        const say: GateUtterance[] = [];
        for (const entry of entries) {
            if (!speakable(entry)) continue;
            const key = entry.gate.id;
            live.add(key);
            const first = this.said.get(key);
            if (first === undefined) {
                this.said.set(key, at);
                say.push({ key, text: gateSpeechLine(entry, sessionNameOf(entry)) });
                continue;
            }
            // The one reminder, and only the one.
            if (!this.reminded.has(key) && at - first >= gateReminderAfterMs) {
                this.reminded.add(key);
                say.push({ key, text: `Still waiting. ${gateSpeechLine(entry, sessionNameOf(entry))}` });
            }
        }
        const gone: string[] = [];
        for (const key of [...this.said.keys()]) {
            if (live.has(key)) continue;
            gone.push(key);
            this.said.delete(key);
            this.reminded.delete(key);
        }
        return { say, gone };
    }
}

/**
 * What to call the session a gate came from.
 *
 * The gate's ORIGIN is the useful name when the bridge mirrored it, because
 * every drover gate is held by one bridge session and raised by another
 * (DROVE-19): saying the holder's name for all of them would name the same
 * thing every time and answer nothing. Null when neither has a name worth
 * reading, and a uuid is never worth reading.
 */
export function sessionNameOf(entry: DroverGateEntry): string | null {
    const origin = entry.origin as { name?: unknown; path?: unknown } | undefined;
    const name = typeof origin?.name === 'string' ? origin.name.trim() : '';
    if (name.length > 0) return name;
    const path = typeof origin?.path === 'string' ? origin.path.trim() : '';
    if (path.length > 0) {
        const last = path.split('/').filter((part) => part.length > 0).pop();
        if (last) return last;
    }
    return null;
}
