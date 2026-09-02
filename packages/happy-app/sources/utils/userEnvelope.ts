/**
 * The envelopes Claude Code injects into a session as USER turns, read into
 * their parts (DROVE-392).
 *
 * Clay, with a screenshot of the transcript: "when there's an agent message
 * you can see it is using some XML there, so that means this should be
 * formatted special somewhere." The bubble read
 *
 *   <agent-message from="aaefbd4ef38db65e9">
 *   build 21 in the group: ASC build 373ba868-...
 *
 * verbatim, because the app drew the turn as prose Clay had typed. He had
 * not. None of these are his words:
 *
 *   agent-message            a subagent reporting to its parent
 *   cross-session-message    another session (the phone relay, or a real
 *                            Claude peer with `from` / `from-session`)
 *   task-notification        a background agent, command or workflow stopped
 *   system-reminder          a harness note to the model
 *   command-message + skill-format   a skill invocation's receipt
 *
 * WHERE THEY COME FROM, measured on this session's transcript rather than
 * assumed. The two message envelopes reach the model with a lead line above
 * and a paragraph below, both written by Claude Code and not by the sender:
 *
 *   Another Claude session sent a message:
 *   <agent-message from="a96b1228ff4b3c7e7">
 *   Drover main is pushed at 094b47a ...
 *   </agent-message>
 *
 *   That "other Claude session" is an agent working inside this same
 *   session — ... that's permission laundering.
 *
 * The app also sees the BARE envelope, because Claude Code writes the enqueue
 * the instant the text lands and the CLI relays that record (DROVE-41), which
 * is why Clay's screenshot starts at the tag. So both shapes are accepted here:
 * the lead line is optional, the trailer is optional, and neither ever
 * reaches the screen or the voice.
 *
 * HOW IT IS BOUNDED, because the transcript is mostly code and a reader that
 * quietly swallowed angle brackets would eat real content (DROVE-234 set the
 * rule; this keeps it):
 *
 *   1. The open tag must be at COLUMN 0 OF THE FIRST LINE, or of the second
 *      line under the exact lead sentence. `<agent-message>` in the middle
 *      of a sentence, or under a line Clay typed, is text.
 *   2. The close tag must be at column 0 of its own line, and it is the LAST
 *      such line. Everything between is the body, verbatim, however many
 *      `<` and `>` it holds. The body is never scanned for tags of its own.
 *   3. After the close tag, only the known harness trailer is dropped. Any
 *      other trailing text stays with the body rather than being lost.
 *   4. Attributes must round-trip: what was parsed has to re-serialise to the
 *      bytes that arrived, the same test Claude Code's own receiver applies.
 *   5. Unknown tags are not envelopes. A message that starts with
 *      `<something-else>` comes back `null` and is drawn as it always was.
 *
 * A user message that is nothing like an envelope costs one character test
 * and one `startsWith`, so this runs on every user turn without a cache.
 */

export type AgentMessageEnvelope = {
    kind: 'agent-message';
    /** The sender's agent id, as `from="..."` spells it. */
    from: string;
    body: string;
};

export type CrossSessionEnvelope = {
    kind: 'cross-session-message';
    /** `from-name`, e.g. `phone`, or the peer's name. */
    fromName: string;
    /** `from-mode`, absent on a wrapper that attested none. */
    fromMode: string | null;
    /**
     * True when the wrapper carries `from` or `from-session`: a real Claude
     * peer wrote it. The phone relay writes neither (`wrapForPane`), and its
     * message is Clay's own, which DROVE-234 draws as his bubble.
     */
    peer: boolean;
    body: string;
};

export type TaskNotificationStatus = 'completed' | 'failed' | 'killed' | 'stopped';

export type TaskNotificationEnvelope = {
    kind: 'task-notification';
    /** One per agent. A "no completion record" notice can carry several. */
    taskIds: string[];
    /** The four words Claude Code writes, or whatever else it wrote. */
    status: TaskNotificationStatus | string;
    /** The harness's one line about what happened. Always present. */
    summary: string;
    /**
     * The first quoted name in the summary: `Agent "DROVE-13 phone Stop"`,
     * `Background command "Publish OTA"`, `Dynamic workflow "..."`. Null for
     * a notice that names several agents or none.
     */
    name: string | null;
    /** What the agent said last, when the notification carries it. */
    result: string | null;
    failures: string | null;
    diagnostics: string | null;
};

export type SystemReminderEnvelope = {
    kind: 'system-reminder';
    body: string;
};

export type CommandEnvelope = {
    kind: 'command';
    /** Without the slash. */
    name: string;
};

export type UserEnvelope =
    | AgentMessageEnvelope
    | CrossSessionEnvelope
    | TaskNotificationEnvelope
    | SystemReminderEnvelope
    | CommandEnvelope;

/** The exact line Claude Code writes above a peer or agent message. */
export const crossSessionLead = 'Another Claude session sent a message:';

/**
 * How the trailing paragraph starts, per envelope. Matched at the start of
 * the paragraph and nowhere else; the rest of it is dropped with it.
 */
const trailerLeads: Record<string, string[]> = {
    'agent-message': ['That "other Claude session" is an agent'],
    'cross-session-message': ['This came from another Claude session'],
};

const attributeRe = /[ \t]([a-z-]+)="([^"<>\r\n]*)"/g;

/**
 * The attribute names Claude Code's peer parser accepts, in its order. Kept
 * from DROVE-234 so a wrapper the phone accepts is a wrapper this accepts.
 */
const crossSessionAttributeOrder = ['from', 'from-session', 'hop-chain', 'from-name', 'from-mode'];

const taskNotificationChildren = [
    'task-id', 'tool-use-id', 'output-file', 'status', 'summary', 'note',
    'result', 'usage', 'diagnostics', 'failures', 'worktree',
] as const;

/**
 * Read `name="value"` pairs, or refuse the lot.
 *
 * Refuses on a failed round trip, on a name outside `order`, and on names
 * out of `order` or repeated. Null means "not this envelope", never "some of
 * the attributes".
 */
function parseAttributes(raw: string, order: readonly string[]): Map<string, string> | null {
    const parsed: Array<[string, string]> = [];
    for (const match of raw.matchAll(attributeRe)) {
        parsed.push([match[1], match[2]]);
    }
    const reserialised = parsed.map(([name, value]) => ` ${name}="${value}"`).join('');
    if (reserialised !== raw) return null;
    let position = -1;
    for (const [name] of parsed) {
        const at = order.indexOf(name);
        if (at <= position) return null;
        position = at;
    }
    return new Map(parsed);
}

type Framed = {
    tag: string;
    /** The attribute bytes between the tag name and `>`. */
    attributes: string;
    body: string;
    /** Text after the close tag that was not the known trailer. */
    trailing: string;
};

/**
 * Find the envelope's frame: the open tag on its own line at the top, the
 * close tag on its own line below, and what is left over after it.
 *
 * `null` when the text is not framed that way, which is what keeps this off a
 * user's own angle brackets: a tag has to OWN the first line to count.
 */
function frame(text: string): Framed | null {
    let rest = text;
    let led = false;
    if (rest.startsWith(`${crossSessionLead}\n`)) {
        rest = rest.slice(crossSessionLead.length + 1);
        led = true;
    }
    if (rest.charCodeAt(0) !== 60 /* < */) return null;

    const open = rest.match(/^<([a-z][a-z-]*)((?:[ \t][a-z-]+="[^"<>\r\n]*")*)>/);
    if (!open) return null;
    const tag = open[1];
    // The lead line belongs to the two message envelopes and to nothing else.
    if (led && !(tag in trailerLeads)) return null;

    const afterOpen = rest.slice(open[0].length);
    const closeTag = `</${tag}>`;

    // A one-line envelope: `<system-reminder>text</system-reminder>`.
    // Otherwise the close tag must open a line of its own, and the last one
    // that does wins, so a body quoting the close tag mid-line keeps it.
    let body: string;
    let after: string;
    const closeAtLineStart = afterOpen.lastIndexOf(`\n${closeTag}`);
    if (closeAtLineStart >= 0) {
        body = afterOpen.slice(0, closeAtLineStart);
        after = afterOpen.slice(closeAtLineStart + 1 + closeTag.length);
    } else if (afterOpen.includes(closeTag) && !afterOpen.slice(0, afterOpen.indexOf(closeTag)).includes('\n')) {
        const at = afterOpen.indexOf(closeTag);
        body = afterOpen.slice(0, at);
        after = afterOpen.slice(at + closeTag.length);
    } else {
        return null;
    }
    // The close tag must end its line.
    if (after.length > 0 && after[0] !== '\n' && after[0] !== '\r') return null;

    if (body.startsWith('\n')) body = body.slice(1);
    if (body.endsWith('\r')) body = body.slice(0, -1);

    let trailing = after.replace(/^\s+/, '');
    const leads = trailerLeads[tag] ?? [];
    if (leads.some((lead) => trailing.startsWith(lead))) trailing = '';
    return { tag, attributes: open[2], body, trailing: trailing.replace(/\s+$/, '') };
}

/** The body plus whatever followed the close tag that was not the trailer. */
function bodyWith(framed: Framed): string {
    const body = framed.body.replace(/\s+$/, '');
    return framed.trailing.length > 0 ? `${body}\n\n${framed.trailing}` : body;
}

/**
 * One child element of a task notification, or null when it is absent.
 *
 * Scalar children close on their own line and the FIRST close is the right
 * one. `result`, `diagnostics` and `failures` are free text and may quote a
 * close tag, so for those the LAST close wins.
 */
function child(body: string, name: string, free = false): string | null {
    const open = `<${name}>`;
    const close = `</${name}>`;
    let start: number;
    if (body.startsWith(open)) {
        start = 0;
    } else {
        const at = body.indexOf(`\n${open}`);
        if (at < 0) return null;
        start = at + 1;
    }
    const from = start + open.length;
    const end = free ? body.lastIndexOf(close) : body.indexOf(close, from);
    if (end < from) return null;
    return body.slice(from, end);
}

function children(body: string, name: string): string[] {
    const re = new RegExp(`^<${name}>([^<\\r\\n]*)</${name}>$`, 'gm');
    return [...body.matchAll(re)].map((match) => match[1]);
}

function parseTaskNotification(framed: Framed): TaskNotificationEnvelope | null {
    const body = framed.body;
    // Every line that opens a tag must open one of the children we know;
    // anything else is not the notification Claude Code writes.
    for (const line of body.split('\n')) {
        const opened = line.match(/^<([a-z-]+)>/);
        if (opened && !(taskNotificationChildren as readonly string[]).includes(opened[1])) return null;
    }
    const summary = child(body, 'summary')?.trim();
    const status = child(body, 'status')?.trim();
    if (!summary || !status) return null;
    const trim = (value: string | null) => {
        const clean = value?.trim();
        return clean && clean.length > 0 ? clean : null;
    };
    const taskIds = children(body, 'task-id');
    return {
        kind: 'task-notification',
        taskIds,
        status,
        summary,
        // A notice about several agents quotes each of them; the first is not
        // the notice's name, so it gets none and the card counts them.
        name: taskIds.length > 1 ? null : summary.match(/"([^"]+)"/)?.[1] ?? null,
        result: trim(child(body, 'result', true)),
        failures: trim(child(body, 'failures', true)),
        diagnostics: trim(child(body, 'diagnostics', true)),
    };
}

/**
 * A skill's receipt: `<command-message>x</command-message>`,
 * `<command-name>x</command-name>`, `<skill-format>true</skill-format>`, one
 * per line and nothing else. The slash-command chip (`<command-name>/foo`
 * with `<command-args>`) is `parseLocalCommandMessage`'s and is left to it.
 */
function parseCommand(text: string): CommandEnvelope | null {
    const lines = text.replace(/\s+$/, '').split('\n').map((line) => line.trim());
    if (!lines.some((line) => /^<skill-format>[^<]*<\/skill-format>$/.test(line))) return null;
    let name: string | null = null;
    for (const line of lines) {
        const match = line.match(/^<(command-message|command-name|command-args|skill-format)>([^<]*)<\/\1>$/);
        if (!match) return null;
        if (match[1] === 'command-name') name = match[2].trim().replace(/^\//, '');
    }
    return name && name.length > 0 ? { kind: 'command', name } : null;
}

/**
 * Read a user turn as the envelope it is, or `null` for prose and for every
 * envelope this file does not know.
 */
export function parseUserEnvelope(text: string): UserEnvelope | null {
    if (typeof text !== 'string' || text.length === 0) return null;
    const first = text.charCodeAt(0);
    if (first !== 60 /* < */ && first !== 65 /* A */) return null;

    const framed = frame(text);
    if (!framed) return null;

    switch (framed.tag) {
        case 'agent-message': {
            const attributes = parseAttributes(framed.attributes, ['from']);
            const from = attributes?.get('from');
            if (!from) return null;
            return { kind: 'agent-message', from, body: bodyWith(framed) };
        }
        case 'cross-session-message': {
            const attributes = parseAttributes(framed.attributes, crossSessionAttributeOrder);
            const fromName = attributes?.get('from-name');
            if (!attributes || !fromName) return null;
            return {
                kind: 'cross-session-message',
                fromName,
                fromMode: attributes.get('from-mode') ?? null,
                peer: attributes.has('from') || attributes.has('from-session'),
                body: bodyWith(framed),
            };
        }
        case 'task-notification':
            if (framed.attributes.length > 0) return null;
            return parseTaskNotification(framed);
        case 'system-reminder':
            if (framed.attributes.length > 0) return null;
            return { kind: 'system-reminder', body: bodyWith(framed) };
        case 'command-message':
        case 'command-name':
            return parseCommand(text);
        default:
            return null;
    }
}

/** Long enough to say what the message is about; short enough to stay one line. */
export const envelopePreviewLimit = 140;

/**
 * The first line of a body, as a preview: markdown furniture off the front,
 * whitespace collapsed, cut at a word.
 */
export function envelopePreview(body: string, limit = envelopePreviewLimit): string {
    const line = body
        .split('\n')
        .map((candidate) => candidate.replace(/^\s*(?:[#>*\-+]+\s*|\d+\.\s+)?/, '').replace(/\s+/g, ' ').trim())
        .find((candidate) => candidate.length > 0) ?? '';
    const clean = line.replace(/\*\*|__|`/g, '');
    if (clean.length <= limit) return clean;
    return `${clean.slice(0, limit).replace(/\s\S*$/, '')}…`;
}

/** What the first eight characters of an agent id look like as a name. */
export function shortAgentId(id: string): string {
    return id.slice(0, 8);
}

/**
 * The status, as one lowercase word for the header and the voice. A word
 * this file has not seen is passed through rather than guessed at.
 */
export function taskStatusWord(status: string): 'finished' | 'failed' | 'stopped' | string {
    switch (status) {
        case 'completed': return 'finished';
        case 'failed': return 'failed';
        case 'killed':
        case 'stopped': return 'stopped';
        default: return status;
    }
}

/**
 * True when the summary says nothing the header does not: `Agent "X"
 * finished`, `Background command "X" completed (exit code 0)`. The preview
 * and the voice then take the result's first line instead, because "X
 * finished. Agent X finished" is the redundancy Clay would hear.
 */
export function taskSummaryIsTerse(envelope: TaskNotificationEnvelope): boolean {
    if (!envelope.name) return false;
    const remainder = envelope.summary.replace(`"${envelope.name}"`, '').replace(/\s+/g, ' ').trim();
    return /^(?:Agent|Background command|Dynamic workflow)?\s*(?:finished|completed(?: \(exit code \d+\))?|was stopped by user)\.?$/.test(remainder);
}

/** The one line under a task notification's header, or nothing. */
export function taskPreview(envelope: TaskNotificationEnvelope): string {
    if (taskSummaryIsTerse(envelope)) {
        return envelope.result ? envelopePreview(envelope.result) : '';
    }
    return envelopePreview(envelope.summary);
}
