import { describe, expect, it } from 'vitest';

import {
    elide,
    sendMessageBody,
    sendMessageFirstLine,
    sendMessageLineCount,
    sendMessageOutcome,
    sendMessageRecipient,
    sendMessageSummaryField,
    sendMessageTitle,
} from './sendMessageCard';

const words = { to: (to: string) => `Message to ${to}`, untitled: 'Message' };

// The shape Claude Code's SendMessage tool really sends (measured from transcripts).
const input = {
    to: 'a76c6ae37c5a5970a',
    summary: 'Recalibrate: every toy must teach',
    message: 'MID-BUILD DIRECTION CHANGE from the owner: "page FEELS like product, not page IS product".\n\nRecalibrate every toy on the page so that it teaches one thing.\n- keep the palette\n- drop the confetti',
};

describe('sendMessageTitle', () => {
    it('names the recipient', () => {
        expect(sendMessageTitle(input, words)).toBe('Message to a76c6ae37c5a5970a');
    });

    it('reads the older recipient key too', () => {
        expect(sendMessageTitle({ recipient: 'uds:/tmp/cc-socks/87373.sock', content: 'hi' }, words))
            .toBe('Message to uds:/tmp/cc-socks/87373.sock');
    });

    it('falls back to a bare Message when nobody is named', () => {
        expect(sendMessageTitle({ message: 'hi' }, words)).toBe('Message');
        expect(sendMessageTitle(null, words)).toBe('Message');
    });
});

describe('sendMessageFirstLine', () => {
    it('takes the first non-empty line and cuts it at about eighty characters on a word boundary', () => {
        const line = sendMessageFirstLine(input);
        expect(line).toBe('MID-BUILD DIRECTION CHANGE from the owner: "page FEELS like product, not page…');
        expect(line!.length).toBeLessThanOrEqual(81);
    });

    it('leaves a short line alone', () => {
        expect(sendMessageFirstLine({ to: 'x', message: 'Done, see the ticket.' })).toBe('Done, see the ticket.');
    });

    it('skips blank leading lines and strips markdown furniture', () => {
        expect(sendMessageFirstLine({ to: 'x', message: '\n\n## Follow-up\nthe body' })).toBe('Follow-up');
        expect(sendMessageFirstLine({ to: 'x', message: '- first bullet\n- second' })).toBe('first bullet');
        expect(sendMessageFirstLine({ to: 'x', message: '> quoted' })).toBe('quoted');
    });

    it('reads content when message is absent, and is undefined with no body at all', () => {
        expect(sendMessageFirstLine({ recipient: 'x', content: 'older shape' })).toBe('older shape');
        expect(sendMessageFirstLine({ to: 'x' })).toBeUndefined();
        expect(sendMessageFirstLine('not an object')).toBeUndefined();
    });
});

describe('elide', () => {
    it('cuts at the last space when one is close enough and hard-cuts otherwise', () => {
        expect(elide('one two three four', 10)).toBe('one two…');
        expect(elide('a'.repeat(30), 10)).toBe(`${'a'.repeat(10)}…`);
        expect(elide('short', 10)).toBe('short');
    });
});

describe('the other fields', () => {
    it('reads recipient, body, summary and line count', () => {
        expect(sendMessageRecipient(input)).toBe('a76c6ae37c5a5970a');
        expect(sendMessageBody(input)).toBe(input.message);
        expect(sendMessageSummaryField(input)).toBe('Recalibrate: every toy must teach');
        expect(sendMessageLineCount(input)).toBe(5);
        expect(sendMessageLineCount({})).toBe(0);
    });
});

describe('sendMessageOutcome', () => {
    it('reads the bus reply object the tool really returns', () => {
        const outcome = sendMessageOutcome({
            success: true,
            message: 'Message queued for delivery to aea31fe782b7bf5d4 at its next tool round.',
            pin: { id: 'aea31fe782b7bf5d4' },
        });
        expect(outcome).toEqual({ ok: true, text: 'Message queued for delivery to aea31fe782b7bf5d4 at its next tool round.' });
    });

    it('reads the same object when it arrives as a JSON string', () => {
        expect(sendMessageOutcome('{"success":true,"message":"Message queued for the main conversation\'s next turn."}'))
            .toEqual({ ok: true, text: "Message queued for the main conversation's next turn." });
    });

    it('marks an error string or a failed object as not ok', () => {
        expect(sendMessageOutcome('Error: no such agent')).toEqual({ ok: false, text: 'Error: no such agent' });
        expect(sendMessageOutcome({ success: false, error: 'message is required' }))
            .toEqual({ ok: false, text: 'message is required' });
    });

    it('is null before a result exists', () => {
        expect(sendMessageOutcome(undefined)).toBeNull();
        expect(sendMessageOutcome('   ')).toBeNull();
    });
});
