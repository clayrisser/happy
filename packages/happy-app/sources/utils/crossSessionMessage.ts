/**
 * The one envelope a phone message comes back in, read into its parts
 * (DROVE-234).
 *
 * Clay, looking at his own message in the transcript: "Doesn't the xml and the
 * image in brackets mean something here that can make it display better on the
 * phone?" It does. All three pieces were being printed as literal text:
 *
 *   <cross-session-message from-name="phone" from-mode="bypass">
 *   Move the bottom row up and collapse boss mode ...
 *
 *   An image was attached from the phone. Read it with the Read tool before answering:
 *   [Image 1: /Users/clayrisser/.claude-accounts/jamrizzi/uploads/<session>/<hash>-IMG_0483.jpg]
 *   </cross-session-message>
 *
 * The wrapper says who sent it, the middle line is addressed to the model, and
 * the marker names a picture. None of it is prose Clay wrote.
 *
 * WHERE IT COMES FROM. happy-cli wraps a phone message with `wrapForPane` and
 * writes it into Claude Code's inbox socket; Claude Code records the enqueue
 * verbatim and the CLI relays that record to the app. `withAttachmentNote`
 * adds the lead line and the markers before the wrapping. So both shapes here
 * are bytes THIS repo writes, and both are matched exactly rather than
 * approximately.
 *
 * HOW IT IS BOUNDED. This is a renderer for one known envelope, not an XML
 * reader. The app shows a lot of code, and a transcript that quietly swallowed
 * angle brackets would eat real content, so every rule below fails CLOSED.
 * Anything that is not byte-for-byte the envelope comes back as `sender: null`
 * with the text untouched:
 *
 *   1. One tag name, `cross-session-message`. No other element is looked at,
 *      and the body between the tags is never scanned for tags.
 *   2. Anchored at BOTH ends. The text must start with the open tag and end
 *      with the close tag. A message that merely mentions the wrapper is text.
 *   3. The attributes must ROUND TRIP: re-serialising what was parsed has to
 *      reproduce the attribute bytes exactly. That is the same test Claude
 *      Code's own receiver applies (`SM` in 2.1.251), so a wrapper one space
 *      off is text here for the same reason it is text there.
 *   4. Only the five attribute names Claude Code's parser accepts, in its
 *      order, `from-name` required, and `from-mode` only ever `bypass` or
 *      `prompting`.
 *   5. The attachment note is recognised only as the WHOLE tail of the body:
 *      the exact lead sentence the CLI writes, then markers numbered 1..n in
 *      order, then nothing. A `[Image 1: ...]` Clay typed himself has no lead
 *      line above it and is left alone.
 *
 * THE PATH IS A KEY, NOT A LOCATION. The marker names an absolute path on the
 * Mac, which the phone cannot open. Only the BASENAME is read, and only to
 * match the attachment the app itself uploaded (see crossSessionAttachments).
 * The directory is never parsed, so it does not matter that a `/flip` moved
 * the account from `~/.claude` to `~/.claude-accounts/<account>/` mid-session.
 */

/** The two permission-mode classes Claude Code's wrapper accepts (`_M`). */
export type CrossSessionMode = 'bypass' | 'prompting';

export type CrossSessionSender = {
    /** `from-name`, e.g. `phone`. Always present when the envelope matched. */
    name: string;
    /** `from-mode`, absent on a wrapper that did not attest one. */
    mode: CrossSessionMode | null;
};

export type CrossSessionImageMarker = {
    /** The number the marker spells, 1-based. */
    index: number;
    /** The absolute path on the machine. Used as a key, never opened. */
    path: string;
    /** Basename with the CLI's content-hash prefix and extension removed. */
    stem: string;
    /** The literal marker line, kept so an unresolved marker loses nothing. */
    raw: string;
};

export type ParsedPhoneMessage = {
    /** Non-null only when the exact envelope matched. */
    sender: CrossSessionSender | null;
    /** What is left to render as prose. */
    body: string;
    /** Empty unless the whole attachment note matched. */
    images: CrossSessionImageMarker[];
};

/**
 * The attribute names Claude Code's parser accepts, in the order it accepts
 * them. `wrapForPane` emits the last two; the first three are addresses of a
 * real Claude peer and arrive on a relayed note.
 */
const attributeOrder = ['from', 'from-session', 'hop-chain', 'from-name', 'from-mode'] as const;

const envelopeRe = /^<cross-session-message((?:[ \t][a-z-]+="[^"<>\r\n]*")*)>\r?\n([\s\S]*)\r?\n<\/cross-session-message>$/;
const attributeRe = /[ \t]([a-z-]+)="([^"<>\r\n]*)"/g;

/** The exact bytes `withAttachmentNote` writes above the markers. */
const singularLead = 'An image was attached from the phone. Read it with the Read tool before answering:';
const pluralLead = (count: number) => `${count} images were attached from the phone. Read each with the Read tool before answering:`;

/** `[Image 1: /abs/path.jpg]`, and nothing looser. */
const markerRe = /^\[Image (\d+): (\/[^\]\r\n]*\.(?:jpg|jpeg|png|gif|webp))\]$/;

/** The 12 hex characters `stageAttachments` puts in front of every name. */
const hashPrefixRe = /^[0-9a-f]{12}-/;

/**
 * The basename with the CLI's hash prefix and extension taken off.
 *
 * Only the part after the last `/` is read. The directory is deliberately
 * ignored: the uploads dir follows whichever account the session is on, and
 * assuming `~/.claude` is exactly the bug a `/flip` creates.
 */
export function markerStem(path: string): string {
    const base = path.slice(path.lastIndexOf('/') + 1);
    const withoutHash = base.replace(hashPrefixRe, '');
    const dot = withoutHash.lastIndexOf('.');
    return dot > 0 ? withoutHash.slice(0, dot) : withoutHash;
}

/**
 * Read the wrapper, or say it is not there.
 *
 * Fails closed on anything that is not byte-for-byte what `wrapForPane`
 * writes, including a wrapper whose attributes do not re-serialise to the
 * bytes that arrived.
 */
function parseEnvelope(text: string): { sender: CrossSessionSender; body: string } | null {
    const match = envelopeRe.exec(text);
    if (!match) return null;

    const rawAttributes = match[1];
    const parsed: Array<[string, string]> = [];
    attributeRe.lastIndex = 0;
    let attribute: RegExpExecArray | null;
    while ((attribute = attributeRe.exec(rawAttributes)) !== null) {
        parsed.push([attribute[1], attribute[2]]);
    }

    // Round trip. What we understood has to reproduce what arrived, or the
    // wrapper is ordinary text, the same rule Claude Code's receiver applies.
    const reserialised = parsed.map(([name, value]) => ` ${name}="${value}"`).join('');
    if (reserialised !== rawAttributes) return null;

    // Known names only, in the order the parser accepts them, no repeats.
    let position = -1;
    for (const [name] of parsed) {
        const at = attributeOrder.indexOf(name as (typeof attributeOrder)[number]);
        if (at <= position) return null;
        position = at;
    }

    const attributes = new Map(parsed);
    const name = attributes.get('from-name');
    if (!name) return null;

    const rawMode = attributes.get('from-mode');
    if (rawMode !== undefined && rawMode !== 'bypass' && rawMode !== 'prompting') return null;

    return {
        sender: { name, mode: (rawMode as CrossSessionMode | undefined) ?? null },
        body: match[2],
    };
}

/**
 * Take the CLI's attachment note off the end of a body.
 *
 * The whole tail has to match: the exact lead sentence for the count, then
 * markers numbered 1..n in order, then end of text. Anything else and the
 * body comes back untouched with no images.
 */
function parseAttachmentNote(body: string): { body: string; images: CrossSessionImageMarker[] } {
    const lines = body.split('\n');

    // Walk back over the trailing markers.
    let first = lines.length;
    const reversed: CrossSessionImageMarker[] = [];
    while (first > 0) {
        const match = markerRe.exec(lines[first - 1]);
        if (!match) break;
        reversed.push({
            index: Number(match[1]),
            path: match[2],
            stem: markerStem(match[2]),
            raw: lines[first - 1],
        });
        first -= 1;
    }
    const images = reversed.reverse();
    if (images.length === 0) return { body, images: [] };

    // Numbered 1..n, in order, or this is not the note we wrote.
    if (images.some((image, at) => image.index !== at + 1)) return { body, images: [] };

    // The line above them is the lead sentence for exactly this count.
    const lead = images.length === 1 ? singularLead : pluralLead(images.length);
    if (first === 0 || lines[first - 1] !== lead) return { body, images: [] };

    return { body: lines.slice(0, first - 1).join('\n').replace(/\s+$/, ''), images };
}

/**
 * Read a user message the phone sent through the pane.
 *
 * The two halves are independent on purpose. A wrapped message with no
 * attachments keeps its whole body; an attachment note that arrived unwrapped
 * (a name that scrubbed to empty leaves `wrapForPane` returning the body as
 * it stands) still resolves its pictures.
 */
export function parsePhoneMessage(text: string): ParsedPhoneMessage {
    const envelope = parseEnvelope(text);
    const note = parseAttachmentNote(envelope ? envelope.body : text);
    return {
        sender: envelope ? envelope.sender : null,
        body: note.body,
        images: note.images,
    };
}

/** True when this message is nothing but ordinary prose. */
export function isPlainPhoneMessage(parsed: ParsedPhoneMessage): boolean {
    return parsed.sender === null && parsed.images.length === 0;
}
