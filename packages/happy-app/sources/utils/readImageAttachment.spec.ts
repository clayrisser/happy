import { describe, expect, it } from 'vitest';

import type { Message } from '@/sync/typesMessage';

import {
    readImageAttachment,
    toolReadPath,
    uploadedImageStem,
} from './readImageAttachment';

let clock = 1_000;

/** A `file` tool call, the row the app writes when it uploads a picture. */
function upload(name: string, ref: string, image?: { width: number; height: number; thumbhash?: string }): Message {
    clock += 1;
    return {
        kind: 'tool-call',
        id: `file-${ref}`,
        localId: null,
        createdAt: clock,
        children: [],
        tool: {
            name: 'file',
            state: 'completed',
            input: { ref, name, size: 1234, ...(image ? { image } : {}) },
            createdAt: clock,
            startedAt: clock,
            completedAt: clock,
            description: `Attached image: ${name}`,
        },
    };
}

/** The CLI's Read of the path that upload landed on. */
function read(filePath: string): Message {
    clock += 1;
    return {
        kind: 'tool-call',
        id: `read-${clock}`,
        localId: null,
        createdAt: clock,
        children: [],
        tool: {
            name: 'Read',
            state: 'completed',
            input: { file_path: filePath },
            createdAt: clock,
            startedAt: clock,
            completedAt: clock,
            description: 'Read call',
        },
    };
}

/** Storage keeps the transcript newest-first. */
function transcript(...oldestFirst: Message[]): Message[] {
    return [...oldestFirst].reverse();
}

const ambient = '/Users/clayrisser/.claude/uploads/s/d82a4d2f1e1c-IMG_0608.jpg';
const flipped = '/Users/clayrisser/.claude-accounts/jamrizzi/uploads/s/d82a4d2f1e1c-IMG_0608.jpg';

describe('uploadedImageStem', () => {
    it('reads the stem out of a landed upload path', () => {
        expect(uploadedImageStem(ambient)).toBe('IMG_0608');
    });

    it('does not read the directory, so a flip mid-session changes nothing', () => {
        // The account dir moved from ~/.claude to ~/.claude-accounts/<account>/
        // and the join has to survive it (DROVE-234).
        expect(uploadedImageStem(flipped)).toBe(uploadedImageStem(ambient));
    });

    it('takes an uppercase extension', () => {
        expect(uploadedImageStem('/x/uploads/s/d82a4d2f1e1c-IMG_0608.JPG')).toBe('IMG_0608');
    });

    it('refuses a path outside an uploads directory', () => {
        // A repo screenshot is NOT a phone upload, and claiming it would
        // promise a picture this cannot supply.
        expect(uploadedImageStem('/Users/clayrisser/Projects/app/d82a4d2f1e1c-IMG_0608.jpg')).toBeNull();
    });

    it('refuses a name with no hash prefix', () => {
        expect(uploadedImageStem('/x/uploads/s/IMG_0608.jpg')).toBeNull();
    });

    it('refuses a hash prefix that is not 12 hex', () => {
        expect(uploadedImageStem('/x/uploads/s/zzzzzzzzzzzz-IMG_0608.jpg')).toBeNull();
        expect(uploadedImageStem('/x/uploads/s/d82a4d2f1e1-IMG_0608.jpg')).toBeNull();
    });

    it('refuses a file that is not an image', () => {
        expect(uploadedImageStem('/x/uploads/s/d82a4d2f1e1c-notes.txt')).toBeNull();
    });

    it('refuses nothing at all', () => {
        expect(uploadedImageStem(undefined)).toBeNull();
        expect(uploadedImageStem(null)).toBeNull();
        expect(uploadedImageStem('')).toBeNull();
        expect(uploadedImageStem('IMG_0608.jpg')).toBeNull();
    });
});

describe('toolReadPath', () => {
    it('takes the path a read names', () => {
        expect(toolReadPath({ file_path: '/a/b.png' })).toBe('/a/b.png');
        expect(toolReadPath({ path: '/a/b.png' })).toBe('/a/b.png');
    });

    it('prefers file_path when a tool carries both', () => {
        expect(toolReadPath({ file_path: '/a/b.png', path: '/c/d.png' })).toBe('/a/b.png');
    });

    it('is null for an input that names no path', () => {
        expect(toolReadPath({ pattern: '*.png' })).toBeNull();
        expect(toolReadPath(null)).toBeNull();
        expect(toolReadPath('a string')).toBeNull();
        expect(toolReadPath(['/a/b.png'])).toBeNull();
    });
});

describe('readImageAttachment', () => {
    it('maps a Read of a landed path back to the upload the phone made', () => {
        const messages = transcript(
            upload('IMG_0608.jpg', 'ref-608', { width: 1179, height: 2556, thumbhash: 'abc' }),
            read(ambient),
        );
        const attachment = readImageAttachment(toolReadPath({ file_path: ambient }), messages);
        expect(attachment).toEqual({
            ref: 'ref-608',
            name: 'IMG_0608.jpg',
            stem: 'IMG_0608',
            width: 1179,
            height: 2556,
            thumbhash: 'abc',
        });
    });

    it('maps it after a flip moved the uploads dir', () => {
        const messages = transcript(
            upload('IMG_0608.jpg', 'ref-608'),
            read(flipped),
        );
        expect(readImageAttachment(flipped, messages)?.ref).toBe('ref-608');
    });

    it('takes the most recent upload of that name', () => {
        const messages = transcript(
            upload('IMG_0608.jpg', 'ref-old'),
            upload('IMG_0608.jpg', 'ref-new'),
            read(ambient),
        );
        expect(readImageAttachment(ambient, messages)?.ref).toBe('ref-new');
    });

    it('is null when no upload in the session carries that name', () => {
        const messages = transcript(
            upload('IMG_0483.jpg', 'ref-483'),
            read(ambient),
        );
        expect(readImageAttachment(ambient, messages)).toBeNull();
    });

    it('is null for a read of anything that is not a landed upload', () => {
        const messages = transcript(upload('IMG_0608.jpg', 'ref-608'));
        expect(readImageAttachment('/Users/clayrisser/Projects/app/shot.png', messages)).toBeNull();
    });
});
