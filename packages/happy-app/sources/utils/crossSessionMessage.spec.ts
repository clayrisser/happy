import { describe, it, expect } from 'vitest';

import { markerStem, parsePhoneMessage } from './crossSessionMessage';

/**
 * The exact bytes Claude Code recorded for the message in DROVE-234, lifted
 * from the `queue-operation` record in the session transcript. Everything here
 * is measured against this rather than against a paraphrase of it.
 */
const realMessage = '<cross-session-message from-name="phone" from-mode="bypass">\n'
    + 'Move the bottom row up and collapse boss mode and reading mode into a single button.'
    + ' Long press for boss mode. Single press to reading mode.\n'
    + '\n'
    + 'An image was attached from the phone. Read it with the Read tool before answering:\n'
    + '[Image 1: /Users/clayrisser/.claude-accounts/jamrizzi/uploads/19c2f0a8-f803-4cb8-8bee-c68b6773e412/d82a4d2f1e1c-IMG_0483.jpg]\n'
    + '</cross-session-message>';

describe('parsePhoneMessage: the real envelope', () => {
    it('reads the sender, the body and the picture out of the message Clay saw', () => {
        const parsed = parsePhoneMessage(realMessage);
        expect(parsed.sender).toEqual({ name: 'phone', mode: 'bypass' });
        expect(parsed.body).toBe(
            'Move the bottom row up and collapse boss mode and reading mode into a single button.'
            + ' Long press for boss mode. Single press to reading mode.',
        );
        expect(parsed.images).toHaveLength(1);
        expect(parsed.images[0].index).toBe(1);
        expect(parsed.images[0].stem).toBe('IMG_0483');
    });

    it('keeps neither tag nor instruction line anywhere in the body', () => {
        const { body } = parsePhoneMessage(realMessage);
        expect(body).not.toContain('cross-session-message');
        expect(body).not.toContain('Read tool');
        expect(body).not.toContain('[Image 1:');
        expect(body).not.toContain('/Users/');
    });

    it('carries the marker line so an unresolved picture still shows something', () => {
        const { images } = parsePhoneMessage(realMessage);
        expect(images[0].raw).toBe(
            '[Image 1: /Users/clayrisser/.claude-accounts/jamrizzi/uploads/'
            + '19c2f0a8-f803-4cb8-8bee-c68b6773e412/d82a4d2f1e1c-IMG_0483.jpg]',
        );
    });

    it('takes a wrapper with no attachments at all', () => {
        const parsed = parsePhoneMessage('<cross-session-message from-name="phone" from-mode="bypass">\nship it\n</cross-session-message>');
        expect(parsed.sender).toEqual({ name: 'phone', mode: 'bypass' });
        expect(parsed.body).toBe('ship it');
        expect(parsed.images).toEqual([]);
    });

    it('takes a wrapper that attested no mode', () => {
        const parsed = parsePhoneMessage('<cross-session-message from-name="shc">\nnote\n</cross-session-message>');
        expect(parsed.sender).toEqual({ name: 'shc', mode: null });
    });

    it('takes the peer attributes a relayed note carries, in the order the parser accepts', () => {
        const parsed = parsePhoneMessage(
            '<cross-session-message from="uds:/tmp/cc-socks/2558.sock" from-name="shc" from-mode="bypass">\nrelayed\n</cross-session-message>',
        );
        expect(parsed.sender).toEqual({ name: 'shc', mode: 'bypass' });
        expect(parsed.body).toBe('relayed');
    });
});

/**
 * The bound. This is a renderer for ONE envelope, and the app shows a lot of
 * code, so everything below has to survive verbatim.
 */
describe('parsePhoneMessage: nothing else is touched', () => {
    it('does not eat a message that merely contains angle brackets', () => {
        const text = 'Compare `Array<string>` with `Map<string, number>` and see if <div> renders.';
        const parsed = parsePhoneMessage(text);
        expect(parsed.sender).toBeNull();
        expect(parsed.images).toEqual([]);
        expect(parsed.body).toBe(text);
    });

    it('does not eat a code block full of tags', () => {
        const text = [
            'Here is the fix:',
            '',
            '```tsx',
            '<View style={styles.row}>',
            '  <Text>{"<cross-session-message>"}</Text>',
            '</View>',
            '```',
        ].join('\n');
        expect(parsePhoneMessage(text).body).toBe(text);
        expect(parsePhoneMessage(text).sender).toBeNull();
    });

    it('does not eat a message that quotes the wrapper without being one', () => {
        const text = 'The bug is that <cross-session-message from-name="phone" from-mode="bypass"> shows up raw.';
        const parsed = parsePhoneMessage(text);
        expect(parsed.sender).toBeNull();
        expect(parsed.body).toBe(text);
    });

    it('refuses an unclosed wrapper', () => {
        const text = '<cross-session-message from-name="phone" from-mode="bypass">\nship it';
        expect(parsePhoneMessage(text).sender).toBeNull();
        expect(parsePhoneMessage(text).body).toBe(text);
    });

    it('refuses a wrapper with anything after the closing tag', () => {
        const text = '<cross-session-message from-name="phone">\nship it\n</cross-session-message>\n\nand one more thing';
        expect(parsePhoneMessage(text).sender).toBeNull();
        expect(parsePhoneMessage(text).body).toBe(text);
    });

    it('refuses a different element with the same shape', () => {
        const text = '<peer-message from-name="phone" from-mode="bypass">\nship it\n</peer-message>';
        expect(parsePhoneMessage(text).sender).toBeNull();
        expect(parsePhoneMessage(text).body).toBe(text);
    });

    it('refuses attributes that do not round trip byte for byte', () => {
        const doubleSpaced = '<cross-session-message  from-name="phone">\nship it\n</cross-session-message>';
        expect(parsePhoneMessage(doubleSpaced).sender).toBeNull();
        const singleQuoted = "<cross-session-message from-name='phone'>\nship it\n</cross-session-message>";
        expect(parsePhoneMessage(singleQuoted).sender).toBeNull();
    });

    it('refuses an attribute the parser does not know', () => {
        const text = '<cross-session-message from-name="phone" from-colour="red">\nship it\n</cross-session-message>';
        expect(parsePhoneMessage(text).sender).toBeNull();
        expect(parsePhoneMessage(text).body).toBe(text);
    });

    it('refuses known attributes in the wrong order', () => {
        const text = '<cross-session-message from-mode="bypass" from-name="phone">\nship it\n</cross-session-message>';
        expect(parsePhoneMessage(text).sender).toBeNull();
    });

    it('refuses a mode outside the two the receiver classes', () => {
        const text = '<cross-session-message from-name="phone" from-mode="yolo">\nship it\n</cross-session-message>';
        expect(parsePhoneMessage(text).sender).toBeNull();
    });

    it('refuses a wrapper with no from-name', () => {
        const text = '<cross-session-message from-mode="bypass">\nship it\n</cross-session-message>';
        expect(parsePhoneMessage(text).sender).toBeNull();
    });
});

describe('parsePhoneMessage: the attachment note is matched whole or not at all', () => {
    it('leaves a bracket line Clay typed himself alone', () => {
        const text = 'Rename it to [Image 1: /tmp/a.png] and see what breaks.';
        const parsed = parsePhoneMessage(text);
        expect(parsed.images).toEqual([]);
        expect(parsed.body).toBe(text);
    });

    it('leaves a marker with no lead sentence above it alone', () => {
        const text = 'look at this\n[Image 1: /tmp/aaaaaaaaaaaa-shot.png]';
        expect(parsePhoneMessage(text).images).toEqual([]);
        expect(parsePhoneMessage(text).body).toBe(text);
    });

    it('leaves the singular lead alone when two markers follow it', () => {
        const text = 'hi\n\nAn image was attached from the phone. Read it with the Read tool before answering:\n'
            + '[Image 1: /u/a.png]\n[Image 2: /u/b.png]';
        expect(parsePhoneMessage(text).images).toEqual([]);
        expect(parsePhoneMessage(text).body).toBe(text);
    });

    it('leaves markers that are misnumbered alone', () => {
        const text = 'hi\n\n2 images were attached from the phone. Read each with the Read tool before answering:\n'
            + '[Image 1: /u/a.png]\n[Image 3: /u/b.png]';
        expect(parsePhoneMessage(text).images).toEqual([]);
        expect(parsePhoneMessage(text).body).toBe(text);
    });

    it('leaves a marker whose path is not an image alone', () => {
        const text = 'hi\n\nAn image was attached from the phone. Read it with the Read tool before answering:\n'
            + '[Image 1: /u/notes.txt]';
        expect(parsePhoneMessage(text).images).toEqual([]);
        expect(parsePhoneMessage(text).body).toBe(text);
    });

    it('leaves a relative path alone', () => {
        const text = 'hi\n\nAn image was attached from the phone. Read it with the Read tool before answering:\n'
            + '[Image 1: uploads/a.png]';
        expect(parsePhoneMessage(text).images).toEqual([]);
    });

    it('reads all three markers of a three-image message', () => {
        const text = '<cross-session-message from-name="phone" from-mode="bypass">\n'
            + 'three shots\n'
            + '\n'
            + '3 images were attached from the phone. Read each with the Read tool before answering:\n'
            + '[Image 1: /u/aaaaaaaaaaaa-one.jpg]\n'
            + '[Image 2: /u/bbbbbbbbbbbb-two.png]\n'
            + '[Image 3: /u/cccccccccccc-three.webp]\n'
            + '</cross-session-message>';
        const parsed = parsePhoneMessage(text);
        expect(parsed.body).toBe('three shots');
        expect(parsed.images.map((image) => image.index)).toEqual([1, 2, 3]);
        expect(parsed.images.map((image) => image.stem)).toEqual(['one', 'two', 'three']);
    });

    it('reads a note that arrived without a wrapper', () => {
        const text = 'look\n\nAn image was attached from the phone. Read it with the Read tool before answering:\n'
            + '[Image 1: /u/aaaaaaaaaaaa-shot.png]';
        const parsed = parsePhoneMessage(text);
        expect(parsed.sender).toBeNull();
        expect(parsed.body).toBe('look');
        expect(parsed.images).toHaveLength(1);
    });

    it('reads a note that is the whole message', () => {
        const text = '<cross-session-message from-name="phone" from-mode="bypass">\n'
            + 'An image was attached from the phone. Read it with the Read tool before answering:\n'
            + '[Image 1: /u/aaaaaaaaaaaa-shot.png]\n'
            + '</cross-session-message>';
        const parsed = parsePhoneMessage(text);
        expect(parsed.body).toBe('');
        expect(parsed.images).toHaveLength(1);
    });
});

describe('markerStem: the path is a key, not a location', () => {
    it('reads the same name whichever account directory the file landed in', () => {
        const flipped = markerStem('/Users/clayrisser/.claude-accounts/jamrizzi/uploads/s/d82a4d2f1e1c-IMG_0483.jpg');
        const ambient = markerStem('/Users/clayrisser/.claude/uploads/s/d82a4d2f1e1c-IMG_0483.jpg');
        const elsewhere = markerStem('/var/folders/xyz/d82a4d2f1e1c-IMG_0483.jpg');
        expect(flipped).toBe('IMG_0483');
        expect(ambient).toBe('IMG_0483');
        expect(elsewhere).toBe('IMG_0483');
    });

    it('strips only the hash the CLI prepends, not a name that looks like one', () => {
        expect(markerStem('/u/aaaaaaaaaaaa-bbbbbbbbbbbb-shot.png')).toBe('bbbbbbbbbbbb-shot');
    });

    it('leaves a name with no hash prefix as it is', () => {
        expect(markerStem('/u/screenshot.png')).toBe('screenshot');
    });
});
