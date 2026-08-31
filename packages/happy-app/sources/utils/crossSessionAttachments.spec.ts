import { describe, it, expect } from 'vitest';

import type { Message } from '@/sync/typesMessage';

import {
    attachmentStem,
    crossSessionIndexFor,
    indexCrossSessionMessages,
    isClaimedAttachmentRow,
} from './crossSessionAttachments';

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

function userText(id: string, text: string): Message {
    clock += 1;
    return { kind: 'user-text', id, localId: null, createdAt: clock, text };
}

/** Storage keeps the transcript newest-first; every index call gets that order. */
function transcript(...oldestFirst: Message[]): Message[] {
    return [...oldestFirst].reverse();
}

const note = (...paths: string[]) => (paths.length === 1
    ? `An image was attached from the phone. Read it with the Read tool before answering:\n[Image 1: ${paths[0]}]`
    : `${paths.length} images were attached from the phone. Read each with the Read tool before answering:\n`
        + paths.map((path, at) => `[Image ${at + 1}: ${path}]`).join('\n'));

const wrapped = (body: string) => `<cross-session-message from-name="phone" from-mode="bypass">\n${body}\n</cross-session-message>`;

describe('attachmentStem', () => {
    it('is safeStem from the CLI, so a file event maps back to the name on disk', () => {
        expect(attachmentStem('IMG_0483.jpg')).toBe('IMG_0483');
        expect(attachmentStem('my photo (1).HEIC')).toBe('my-photo-1');
        expect(attachmentStem('')).toBe('image');
        expect(attachmentStem('....jpg')).toBe('...');
    });
});

describe('indexCrossSessionMessages', () => {
    it('pairs the marker with the upload the app made for it', () => {
        const messages = transcript(
            upload('IMG_0483.jpg', 'ref-483', { width: 1179, height: 2556, thumbhash: 'abc' }),
            userText('m1', wrapped(`look at this\n\n${note('/Users/clayrisser/.claude-accounts/jamrizzi/uploads/s/d82a4d2f1e1c-IMG_0483.jpg')}`)),
        );
        const index = indexCrossSessionMessages(messages);
        const render = index.byMessageId.get('m1');
        expect(render?.sender).toEqual({ name: 'phone', mode: 'bypass' });
        expect(render?.body).toBe('look at this');
        expect(render?.images).toHaveLength(1);
        expect(render?.images[0].attachment).toMatchObject({ ref: 'ref-483', width: 1179, height: 2556, thumbhash: 'abc' });
        expect([...index.claimedRefs]).toEqual(['ref-483']);
    });

    it('pairs every marker of a three-image message in order', () => {
        const messages = transcript(
            upload('one.jpg', 'ref-1'),
            upload('two.png', 'ref-2'),
            upload('three.heic', 'ref-3'),
            userText('m1', wrapped(note(
                '/u/aaaaaaaaaaaa-one.jpg',
                '/u/bbbbbbbbbbbb-two.png',
                '/u/cccccccccccc-three.jpg',
            ))),
        );
        const render = indexCrossSessionMessages(messages).byMessageId.get('m1');
        expect(render?.images.map((image) => image.attachment?.ref)).toEqual(['ref-1', 'ref-2', 'ref-3']);
    });

    it('matches on the filename alone, so a flipped account directory changes nothing', () => {
        const ambient = transcript(
            upload('IMG_0483.jpg', 'ref-483'),
            userText('m1', wrapped(note('/Users/clayrisser/.claude/uploads/s/d82a4d2f1e1c-IMG_0483.jpg'))),
        );
        const flipped = transcript(
            upload('IMG_0483.jpg', 'ref-483'),
            userText('m1', wrapped(note('/Users/clayrisser/.claude-accounts/jamrizzi/uploads/s/d82a4d2f1e1c-IMG_0483.jpg'))),
        );
        expect(indexCrossSessionMessages(ambient).byMessageId.get('m1')?.images[0].attachment?.ref).toBe('ref-483');
        expect(indexCrossSessionMessages(flipped).byMessageId.get('m1')?.images[0].attachment?.ref).toBe('ref-483');
    });

    it('matches an image whose extension changed when the CLI read its magic bytes', () => {
        const messages = transcript(
            upload('IMG_0483.heic', 'ref-483'),
            userText('m1', wrapped(note('/u/d82a4d2f1e1c-IMG_0483.jpg'))),
        );
        expect(indexCrossSessionMessages(messages).byMessageId.get('m1')?.images[0].attachment?.ref).toBe('ref-483');
    });

    it('takes the nearest uploads when the same filename was sent twice', () => {
        const messages = transcript(
            upload('shot.png', 'ref-old'),
            userText('m0', wrapped(note('/u/aaaaaaaaaaaa-shot.png'))),
            upload('shot.png', 'ref-new'),
            userText('m1', wrapped(note('/u/bbbbbbbbbbbb-shot.png'))),
        );
        const index = indexCrossSessionMessages(messages);
        expect(index.byMessageId.get('m0')?.images[0].attachment?.ref).toBe('ref-old');
        expect(index.byMessageId.get('m1')?.images[0].attachment?.ref).toBe('ref-new');
    });

    it('gives two markers with one filename two different uploads', () => {
        const messages = transcript(
            upload('shot.png', 'ref-a'),
            upload('shot.png', 'ref-b'),
            userText('m1', wrapped(note('/u/aaaaaaaaaaaa-shot.png', '/u/bbbbbbbbbbbb-shot.png'))),
        );
        const render = indexCrossSessionMessages(messages).byMessageId.get('m1');
        expect(render?.images.map((image) => image.attachment?.ref)).toEqual(['ref-a', 'ref-b']);
    });

    it('never pairs a marker with an upload that came after it', () => {
        const messages = transcript(
            userText('m1', wrapped(note('/u/aaaaaaaaaaaa-shot.png'))),
            upload('shot.png', 'ref-later'),
        );
        const render = indexCrossSessionMessages(messages).byMessageId.get('m1');
        expect(render?.images[0].attachment).toBeNull();
        expect(indexCrossSessionMessages(messages).claimedRefs.size).toBe(0);
    });

    it('keeps the marker line when nothing matches, so no picture is silently lost', () => {
        const messages = transcript(userText('m1', wrapped(note('/u/aaaaaaaaaaaa-missing.png'))));
        const render = indexCrossSessionMessages(messages).byMessageId.get('m1');
        expect(render?.images[0].attachment).toBeNull();
        expect(render?.images[0].marker.raw).toBe('[Image 1: /u/aaaaaaaaaaaa-missing.png]');
    });

    it('indexes a wrapped message with no attachments', () => {
        const messages = transcript(userText('m1', wrapped('ship it')));
        const render = indexCrossSessionMessages(messages).byMessageId.get('m1');
        expect(render).toEqual({ sender: { name: 'phone', mode: 'bypass' }, body: 'ship it', images: [] });
    });

    it('indexes nothing for ordinary prose, angle brackets and all', () => {
        const messages = transcript(
            userText('m1', 'does `Array<string>` work here? <div> too?'),
            userText('m2', 'plain'),
        );
        const index = indexCrossSessionMessages(messages);
        expect(index.byMessageId.size).toBe(0);
        expect(index.claimedRefs.size).toBe(0);
    });
});

describe('isClaimedAttachmentRow', () => {
    it('stands the upload row down once its picture is drawn inside the message', () => {
        const row = upload('IMG_0483.jpg', 'ref-483');
        const messages = transcript(row, userText('m1', wrapped(note('/u/d82a4d2f1e1c-IMG_0483.jpg'))));
        const { claimedRefs } = indexCrossSessionMessages(messages);
        expect(isClaimedAttachmentRow(row, claimedRefs)).toBe(true);
    });

    it('leaves the upload row alone when no marker resolved to it', () => {
        const row = upload('IMG_0483.jpg', 'ref-483');
        const messages = transcript(row, userText('m1', 'no envelope here'));
        const { claimedRefs } = indexCrossSessionMessages(messages);
        expect(isClaimedAttachmentRow(row, claimedRefs)).toBe(false);
    });

    it('leaves every other message alone', () => {
        expect(isClaimedAttachmentRow(userText('m1', 'hi'), new Set(['ref-483']))).toBe(false);
    });
});

describe('crossSessionIndexFor', () => {
    it('answers with the same object for the same array, so the selector stays stable', () => {
        const messages = transcript(userText('m1', wrapped('ship it')));
        expect(crossSessionIndexFor(messages)).toBe(crossSessionIndexFor(messages));
    });

    it('recomputes for a new array', () => {
        const first = transcript(userText('m1', wrapped('ship it')));
        const second = [...first];
        expect(crossSessionIndexFor(second)).not.toBe(crossSessionIndexFor(first));
    });
});
